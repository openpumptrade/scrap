import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { createBurnCheckedInstruction } from "@solana/spl-token";
import { config } from "./config.js";
import { connection, sendTx } from "./solana.js";
import { amm, pumpswapBuy, mintProgramId, tokenBalanceRaw, canonicalPumpPoolPda } from "./pumpfun.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PUMP_AMM_SDK } = require("@pump-fun/pump-swap-sdk");

/// The liquidity reserve, put to work. The reserve wallet is a dedicated wallet: it only ever holds
/// the liquidity share of the creator fees (SOL) and the coin it bought to pair with it. Once the coin
/// trades on PumpSwap and the reserve is big enough, one round does:
///   1. buy the coin with a bit under half of the available SOL
///   2. deposit the coin it holds, paired with SOL, into the coin's canonical PumpSwap pool
///   3. burn every LP token the deposit returned, so that liquidity can never be withdrawn
/// Anything a round could not pair (coin or SOL) stays in the reserve wallet and is used by the next
/// round, which also makes a round that failed halfway heal itself. The reserve never sells.

const lamports = (sol) => BigInt(Math.floor(sol * 1e9));

async function rawTokenBalance(account) {
  try { return BigInt((await connection.getTokenAccountBalance(account)).value.amount); }
  catch { return 0n; }
}

/// Returns { status, note, spentSol, baseDeposited, lpBurned, txs: { buy, deposit, burnLp } }.
/// `status`: "done" | "skipped" | "partial" (the note says what is left for the next round).
export async function runLiquidity({ wallet, mint = config.mint, pool = null, maxSol = Infinity }) {
  const me = wallet.publicKey.toBase58();
  const mintPk = new PublicKey(mint);
  const poolPk = pool ? new PublicKey(pool) : canonicalPumpPoolPda(mintPk);
  const programId = await mintProgramId(mint);
  const txs = {};
  const out = (status, note, extra = {}) => ({ status, note, spentSol: 0, baseDeposited: 0, lpBurned: 0, txs, ...extra });

  const reserve = lamports(config.liquidity.reserveSol);
  const sol0 = BigInt(await connection.getBalance(wallet.publicKey));
  let available = sol0 - reserve;
  if (maxSol !== Infinity && available > lamports(maxSol)) available = lamports(maxSol);
  // keep each round small against the pool: a buy that moves the price too far fails on slippage, and
  // the reserve would only pile up. Rounds run after every dive, so a large reserve drains over a few.
  const depth = BigInt((await amm.liquiditySolanaState(poolPk, wallet.publicKey)).poolQuoteTokenAccount.amount.toString());
  const cap = (depth * BigInt(config.liquidity.maxPoolBps)) / 10_000n;
  if (available > cap) available = cap;
  const held0 = await tokenBalanceRaw(me, mint, programId);
  if (available < lamports(config.liquidity.minDepositSol) && held0 === 0n) return out("skipped", `reserve holds ${Number(sol0) / 1e9} SOL, under the ${config.liquidity.minDepositSol} SOL minimum for a deposit`);

  // 1. buy the coin with a bit under half: the buy itself moves the price, so pairing what it
  //    returns needs slightly more SOL than the buy cost
  if (available >= lamports(config.liquidity.minDepositSol)) {
    const buyLamports = (available * BigInt(config.liquidity.buyBps)) / 10_000n;
    // a buy that fails (slippage on a fast market) is not fatal: tokens already held are still deposited
    try { ({ sig: txs.buy } = await pumpswapBuy({ wallet, mint, quote: { isSol: true }, quoteAmountRaw: buyLamports, pool: poolPk.toBase58() })); }
    catch (err) { console.warn(`[liquidity] buy failed (${String(err?.message || JSON.stringify(err)).slice(0, 120)})`); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  let held = await tokenBalanceRaw(me, mint, programId);
  for (let i = 0; i < 4 && txs.buy && held <= held0; i++) { await new Promise((r) => setTimeout(r, 1500)); held = await tokenBalanceRaw(me, mint, programId); }
  if (held <= 0n) return out("partial", "the reserve holds no tokens to pair");

  // 2. deposit the coin, paired with SOL. A hair under the full balance: the pool rounds the amount it
  //    takes up, and asking for every last unit fails with "insufficient funds".
  const state = await amm.liquiditySolanaState(poolPk, wallet.publicKey);
  let depositBase = (held * 995n) / 1000n;
  let dep = PUMP_AMM_SDK.depositBaseInput(state, new BN(depositBase.toString()), config.rules.slippagePct);
  let room = BigInt(await connection.getBalance(wallet.publicKey)) - reserve;
  if (maxSol !== Infinity && room > lamports(maxSol)) room = lamports(maxSol);
  if (BigInt(dep.maxQuote.toString()) > room) {
    // not enough SOL to pair everything: deposit what the SOL covers, the rest waits for the next round
    depositBase = room > 0n ? (depositBase * room * 98n) / (BigInt(dep.maxQuote.toString()) * 100n) : 0n;
    if (depositBase <= 0n) return out("partial", "no SOL left to pair the tokens; they wait in the reserve wallet for the next round");
    dep = PUMP_AMM_SDK.depositBaseInput(state, new BN(depositBase.toString()), config.rules.slippagePct);
  }
  const lpAccount = state.userPoolTokenAccount;
  const lpBefore = await rawTokenBalance(lpAccount);
  const instructions = await PUMP_AMM_SDK.depositInstructionsInternal(state, dep.lpToken, dep.maxBase, dep.maxQuote);
  txs.deposit = await sendTx({ instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 400_000 });
  await new Promise((r) => setTimeout(r, 1500));

  // 3. burn the LP tokens the deposit returned
  let lpGot = 0n;
  for (let i = 0; i < 4 && lpGot <= 0n; i++) {
    const now = await rawTokenBalance(lpAccount);
    lpGot = now > lpBefore ? now - lpBefore : 0n;
    if (lpGot <= 0n) await new Promise((r) => setTimeout(r, 1500));
  }
  let lpBurned = 0n;
  if (lpGot > 0n) {
    const lpMint = state.pool.lpMint;
    const info = await connection.getParsedAccountInfo(lpMint);
    const lpProgram = info.value.owner, lpDecimals = info.value.data.parsed.info.decimals;
    txs.burnLp = await sendTx({ instructions: [createBurnCheckedInstruction(lpAccount, lpMint, wallet.publicKey, lpGot, lpDecimals, [], lpProgram)], payer: wallet.publicKey, signers: [wallet], computeUnits: 60_000 });
    lpBurned = lpGot;
  }

  const solEnd = BigInt(await connection.getBalance(wallet.publicKey));
  const heldEnd = await tokenBalanceRaw(me, mint, programId);
  const spentSol = Number(sol0 - solEnd) / 1e9;
  const baseDeposited = Number(held - heldEnd) / 1e6;
  return out(lpBurned > 0n ? "done" : "partial", lpBurned > 0n
    ? `added ${spentSol.toFixed(4)} SOL of liquidity (${Math.round(baseDeposited).toLocaleString()} tokens paired) and burned the LP tokens`
    : "deposit sent but no LP tokens were found to burn", { spentSol, baseDeposited, lpBurned: Number(lpBurned) });
}

// ------------------------------------------------------------- the engine's liquidity loop
export const lpState = { enabled: false, rounds: 0, depositedSol: 0, tokensPaired: 0, last: null };

async function loadLpTotals(sql) {
  const [agg] = await sql`select count(*)::int as n, coalesce(sum(spent_sol), 0) as sol, coalesce(sum(base_deposited), 0) as base from lp_rounds where status = 'done'`;
  lpState.rounds = agg.n; lpState.depositedSol = Number(agg.sol); lpState.tokensPaired = Number(agg.base);
  const last = await sql`select * from lp_rounds order by id desc limit 1`;
  lpState.last = last.length ? { t: last[0].ts, status: last[0].status, spentSol: last[0].spent_sol, buyTx: last[0].buy_tx, depositTx: last[0].deposit_tx, burnTx: last[0].burn_tx, note: last[0].note } : null;
}

export async function startLiquidity(sql) {
  lpState.enabled = Boolean(config.lpKeypair);
  await loadLpTotals(sql);
  if (!lpState.enabled) console.warn("[liquidity] LP_WALLET_PRIVATE_KEY not set — the liquidity reserve only accumulates");
}

/// One round after a dive. Never throws: liquidity must not break the dive loop.
export async function liquidityRound(sql, { graduated, pool }) {
  if (!lpState.enabled || !graduated) return;
  let res;
  try { res = await runLiquidity({ wallet: config.lpKeypair, pool }); }
  catch (err) { res = { status: "failed", note: String(err?.message || JSON.stringify(err)).slice(0, 200), spentSol: 0, baseDeposited: 0, lpBurned: 0, txs: {} }; }
  if (res.status === "skipped") return;
  const ts = Math.floor(Date.now() / 1000);
  await sql`insert into lp_rounds (ts, status, spent_sol, base_deposited, lp_burned, buy_tx, deposit_tx, burn_tx, note) values (${ts}, ${res.status}, ${res.spentSol}, ${res.baseDeposited}, ${res.lpBurned}, ${res.txs.buy || null}, ${res.txs.deposit || null}, ${res.txs.burnLp || null}, ${res.note})`;
  await loadLpTotals(sql);
  console.log(`[liquidity] ${res.status}: ${res.note}`);
}
