import { config, mode } from "./config.js";
import { sql, getMeta, setMeta } from "./db.js";
import { getSolBalance, getSolUsd, sendSol } from "./solana.js";
import { allocate, splitBought } from "./split.js";
import { startLiquidity, liquidityRound } from "./liquidity.js";
import { communityTick } from "./community.js";
import { distributeSharedFees, burnAmount, topHolders, airdropTokens, claimCreatorFees, curveBuy, pumpswapBuy, jupiterBuy, mintProgramId, tokenBalanceRaw, tokenBalanceRawSettled, totalSupply, isGraduated, creatorVaultBalancesRaw, quoteBalance, toRaw } from "./pumpfun.js";
import { coin, pot, readPot } from "./tracker.js";

/// The burner (SCRAP). Every DIVE_INTERVAL_SEC (3 minutes), on a fixed clock:
///   1. claim 100% of the unclaimed creator fees (curve + PumpSwap) into the engine wallet
///   2. ONE market buy of the coin with all of the quote asset in the wallet
///      — on the bonding curve, or on the PumpSwap pool once graduated
///   3. burn exactly what that buy brought in (plus anything a failed burn still owes) → supply goes down
///      — never the whole wallet balance: tokens the wallet held before the buy are not touched
/// Nothing is kept: no ops cut, no team share. A dive too small to be worth
/// a tx rolls into the next one (the quote asset stays in the wallet). A failed
/// buy or burn is retried on the next dive — the asset/tokens are still there.

export const state = {
  nextDiveAt: 0,
  progress: null,      // {status, diveId, dry, pot, claimed, spent, tokens, txs:{claim,buy,burn}, note, at}
  lastNote: null,      // {at, msg}
  divesRun: 0,
  totalSpentQuote: 0,
  totalSpentUsd: 0,
  totalBurned: 0,
  totalLp: 0, totalTreasury: 0, totalAirdropped: 0,
  lastDive: null,
  genesis: 0,
  dryTotals: { dives: 0, spentQuote: 0, spentUsd: 0, burned: 0 },
};

let firing = false;
const now = () => Math.floor(Date.now() / 1000);

export async function startDiver() {
  await startLiquidity(sql);
  state.genesis = Number(await getMeta("genesis", 0));
  if (!state.genesis) { state.genesis = now(); await setMeta("genesis", state.genesis); }
  state.nextDiveAt = Number(await getMeta("next_dive_at", 0));
  const note = await getMeta("last_note");
  state.lastNote = note ? JSON.parse(note) : null;
  // a dive interrupted by a restart: close it, the next one picks up whatever is left in the wallet
  await sql`update dives set status = 'failed', note = coalesce(note, 'interrupted by restart'), finished_at = ${now()} where status in ('claiming', 'buying', 'burning')`;
  await loadHistory();
  if (state.lastNote && state.lastDive?.status === "done" && state.lastDive.t > state.lastNote.at) { state.lastNote = null; await setMeta("last_note", ""); }
  if (!state.nextDiveAt || state.nextDiveAt < now() - config.rules.intervalSec) await schedule();
  setInterval(tick, 2_000);
  console.log(`[diver] ${mode()} mode · every ${config.rules.intervalSec}s · next dive at ${new Date(state.nextDiveAt * 1000).toISOString()}`);
}

async function loadHistory() {
  const [agg] = await sql`select count(*)::int as n, coalesce(sum(spent_quote), 0) as spent, coalesce(sum(spent_quote * coalesce(quote_usd, 0)), 0) as usd, coalesce(sum(tokens_burned), 0) as burned, coalesce(sum(claimed_quote), 0) as claimed, coalesce(sum(claimed_quote * coalesce(quote_usd, 0)), 0) as claimed_usd, coalesce(sum(airdrop_recipients), 0) as drops, coalesce(sum(lp_quote), 0) as lp, coalesce(sum(treasury_quote), 0) as treasury, coalesce(sum(tokens_airdropped), 0) as airdropped from dives where status = 'done' and dry = false`;
  const [dry] = await sql`select count(*)::int as n, coalesce(sum(spent_quote), 0) as spent, coalesce(sum(spent_quote * coalesce(quote_usd, 0)), 0) as usd, coalesce(sum(tokens_burned), 0) as burned from dives where status = 'done' and dry = true`;
  state.divesRun = agg.n;
  state.totalSpentQuote = Number(agg.spent);
  state.totalSpentUsd = Number(agg.usd);
  state.totalBurned = Number(agg.burned);
  state.totalClaimed = Number(agg.claimed); state.totalClaimedUsd = Number(agg.claimed_usd); state.totalAirdropTransfers = Number(agg.drops);
  state.totalLp = Number(agg.lp); state.totalTreasury = Number(agg.treasury); state.totalAirdropped = Number(agg.airdropped);
  state.dryTotals = { dives: dry.n, spentQuote: Number(dry.spent), spentUsd: Number(dry.usd), burned: Number(dry.burned) };
  const last = await sql`select * from dives where status in ('done', 'skipped', 'failed') order by id desc limit 1`;
  state.lastDive = last.length ? rowToJson(last[0]) : null;
}

/// fixed cadence: the next dive is always genesis + k·interval, so the countdown is predictable
async function schedule() {
  const iv = config.rules.intervalSec;
  const k = Math.floor((now() - state.genesis) / iv) + 1;
  state.nextDiveAt = state.genesis + k * iv;
  await setMeta("next_dive_at", state.nextDiveAt);
}

async function tick() {
  if (firing || !coin.loaded) return;
  if (now() < state.nextDiveAt) return;
  if (!config.schedulerEnabled) { await schedule(); return; }
  firing = true;
  try { await runDive(); if (mode() === "bot" && !config.dryRun) await liquidityRound(sql, { graduated: (await isGraduated(config.mint)) ?? coin.graduated, pool: coin.pool || null }); if (mode() === "bot" && !config.dryRun) await communityTick(); }
  catch (err) {
    const msg = String(err.message).slice(0, 160);
    console.error("[diver] dive failed:", msg);
    await note(`Dive failed: ${msg}`);
    await sql`update dives set status = 'failed', note = ${msg}, finished_at = ${now()} where status in ('claiming', 'buying', 'burning')`;
    if (state.progress) state.progress = { ...state.progress, status: "failed", note: msg, at: now() };
    await loadHistory();
  }
  finally { await schedule(); firing = false; }
}

async function note(msg) {
  state.lastNote = { at: now(), msg };
  await setMeta("last_note", JSON.stringify(state.lastNote));
}

export function rowToJson(r) {
  return {
    id: r.id, t: r.ts, status: r.status, dry: r.dry, potQuote: r.pot_quote, claimedQuote: r.claimed_quote, spentQuote: r.spent_quote,
    tokensBurned: r.tokens_burned, quoteUsd: r.quote_usd, priceUsd: r.price_usd, solUsd: r.sol_usd, supplyAfter: r.supply_after, venue: r.venue,
    claimTx: r.claim_tx, buyTx: r.buy_tx, burnTx: r.burn_tx, note: r.note, finishedAt: r.finished_at,
    lpQuote: r.lp_quote, treasuryQuote: r.treasury_quote, tokensAirdropped: r.tokens_airdropped, airdropRecipients: r.airdrop_recipients, splitTx: r.split_tx, airdropTx: r.airdrop_tx,
  };
}

const setProgress = (patch) => { state.progress = { ...(state.progress || {}), ...patch, at: now() }; };

export async function runDive() {
  const dry = mode() !== "bot" || config.dryRun;
  const q = coin.quote;
  const sym = q.symbol;
  await readPot().catch(() => {});
  const unclaimed = pot.unclaimed;
  const leftover = pot.spendable;          // quote asset already in the wallet from a previous small/failed dive

  const potTotal = unclaimed + (dry ? 0 : leftover);
  const quoteUsd = coin.quoteUsd;
  const ts = now();
  const [{ id }] = await sql`insert into dives (ts, status, dry, pot_quote, quote_usd, price_usd, sol_usd) values (${ts}, 'claiming', ${dry}, ${potTotal}, ${quoteUsd}, ${coin.priceUsd}, ${coin.solUsd}) returning id`;
  setProgress({ status: "claiming", diveId: id, dry, pot: potTotal, claimed: 0, spent: 0, tokens: 0, txs: {}, note: null });
  console.log(`[diver] dive #${id} · pot ${unclaimed} ${sym} unclaimed + ${leftover} ${sym} in wallet${dry ? " · DRY" : ""}`);

  if (dry) {
    const wouldSpend = unclaimed;
    const est = pot.estTokens || (coin.priceUsd > 0 && quoteUsd > 0 ? (wouldSpend * quoteUsd) / coin.priceUsd : 0);
    const status = wouldSpend * quoteUsd >= config.rules.minBuyUsd ? "done" : "skipped";
    const msg = status === "done" ? `would claim ${wouldSpend} ${sym}, buy ≈ ${Math.round(est).toLocaleString()} $${coin.symbol} and burn them` : `pot ${wouldSpend} ${sym} (~$${(wouldSpend * quoteUsd).toFixed(2)}) under the $${config.rules.minBuyUsd} minimum — rolls over`;
    await sql`update dives set status = ${status}, claimed_quote = ${wouldSpend}, spent_quote = ${wouldSpend}, tokens_burned = ${est}, venue = ${coin.graduated ? "pumpswap" : "curve"}, note = ${msg}, finished_at = ${now()} where id = ${id}`;
    setProgress({ status, claimed: wouldSpend, spent: wouldSpend, tokens: est, note: msg });
    await loadHistory();
    console.log(`[diver] (dry) ${msg}`);
    return;
  }

  const wallet = config.wallet;
  const me = wallet.publicKey.toBase58();
  const programId = await mintProgramId(config.mint);
  const txs = {};

  // 0. the engine needs SOL for fees, whatever the coin is quoted in
  if (pot.walletSol < config.rules.minGasSol) {
    const msg = `engine wallet has ${pot.walletSol.toFixed(4)} SOL — needs at least ${config.rules.minGasSol} SOL for fees. Top it up.`;
    await sql`update dives set status = 'failed', note = ${msg}, finished_at = ${now()} where id = ${id}`;
    setProgress({ status: "failed", note: msg });
    await note(msg); await loadHistory();
    console.warn(`[diver] ${msg}`);
    return;
  }

  // 1. claim — everything pump.fun owes the engine, in the quote asset ($PUMP).
  //    fee sharing on: distribute the coin's fees to its shareholders (the engine wallet is one);
  //    no sharing: the engine wallet is the creator and claims its vaults (+ the v3 curve bucket sweep).
  let claimed = 0;
  if (unclaimed * quoteUsd >= config.rules.minClaimUsd) {
    const before = await quoteBalance(me, q);
    let sig = "";
    if (coin.sharing) ({ sig } = await distributeSharedFees(wallet, config.mint, q));
    else if (me === coin.creator) ({ sig } = await claimCreatorFees(wallet, q, await creatorVaultBalancesRaw(me, q, config.mint), config.mint));
    if (sig) {
      txs.claim = sig;
      await new Promise((r) => setTimeout(r, 1500));
      const after = await quoteBalance(me, q);
      claimed = Math.max(0, after - before);
      console.log(`[diver] ${coin.sharing ? "distributed" : "claimed"} → ${claimed} ${sym} into the engine · ${sig}`);
    }
  }
  let walletQuote = await quoteBalance(me, q);
  let spend = walletQuote;
  // 1b. split the claim (SOL-quoted coins): LP reserve + treasury leave as SOL, the rest is the buy budget.
  //     A coin quoted in another asset keeps the simple path: everything buys and burns.
  const bps = q.isSol ? config.split : { lp: 0, treasury: 0, airdrop: 0, burn: 10_000 };
  let sentLp = 0, sentTreasury = 0;
  if (q.isSol) {
    const L = (k) => getMeta(k, "0").then((v) => BigInt(v || "0"));
    const ledger0 = { lp: await L("owed_lp"), treasury: await L("owed_treasury"), buy: await L("buy_budget") };
    const { ledger, add } = allocate({ claimed: toRaw(claimed, 9), wallet: toRaw(walletQuote, 9), reserve: toRaw(config.rules.gasReserveSol, 9), ledger: ledger0, bps });
    await setMeta("owed_lp", ledger.lp.toString()); await setMeta("owed_treasury", ledger.treasury.toString()); await setMeta("buy_budget", ledger.buy.toString());
    if (claimed > 0) console.log(`[diver] split → LP ${Number(add.lp) / 1e9} · treasury ${Number(add.treasury) / 1e9} · buy ${Number(add.buy) / 1e9} SOL`);
    const min = toRaw(config.rules.minTransferSol, 9);
    const out = [];
    if (config.lpWallet && ledger.lp >= min) out.push({ key: "owed_lp", to: config.lpWallet, lamports: ledger.lp });
    if (config.treasuryWallet && ledger.treasury >= min) out.push({ key: "owed_treasury", to: config.treasuryWallet, lamports: ledger.treasury });
    if (out.length) {
      try {
        txs.split = await sendSol({ wallet, transfers: out });
        for (const o of out) await setMeta(o.key, "0");
        sentLp = Number(out.find((o) => o.key === "owed_lp")?.lamports || 0n) / 1e9;
        sentTreasury = Number(out.find((o) => o.key === "owed_treasury")?.lamports || 0n) / 1e9;
        console.log(`[diver] sent ${sentLp} SOL to the LP reserve and ${sentTreasury} SOL to the treasury · ${txs.split}`);
        await new Promise((r) => setTimeout(r, 1500));
        walletQuote = await quoteBalance(me, q);
      } catch (err) { console.warn(`[diver] split transfer failed (${String(err.message).slice(0, 120)}), it stays owed for the next dive`); }
    }
    // spend the buy budget only, and never the gas reserve or SOL still owed to the other buckets
    const stillOwed = (await L("owed_lp")) + (await L("owed_treasury"));
    // the PumpSwap buy wraps the amount plus its slippage allowance, so leave that headroom in the wallet
    const room = ((toRaw(walletQuote, 9) - toRaw(config.rules.gasReserveSol, 9) - stillOwed) * 100n) / BigInt(100 + Math.ceil(config.rules.slippagePct));
    const budget = ledger.buy < room ? ledger.buy : room;
    spend = budget > 0n ? Number(budget) / 1e9 : 0;
  }
  await sql`update dives set claimed_quote = ${claimed}, claim_tx = ${txs.claim || null}, split_tx = ${txs.split || null}, lp_quote = ${sentLp}, treasury_quote = ${sentTreasury}, status = 'buying' where id = ${id}`;
  setProgress({ status: "buying", claimed, txs: { ...txs } });

  // tokens in the wallet before the buy are NOT the engine's to burn (dev bag, transfers)
  const balanceBeforeRaw = await tokenBalanceRaw(me, config.mint, programId);

  // 2. one buy with all of it
  let buyTx = "", venue = "";
  if (spend * quoteUsd >= config.rules.minBuyUsd) {
    const raw = toRaw(spend, q.decimals);
    const graduated = (await isGraduated(config.mint)) ?? coin.graduated;
    const poolBuy = async () => {
      try { venue = "pumpswap"; return await pumpswapBuy({ wallet, mint: config.mint, quote: q, quoteAmountRaw: raw, pool: coin.pool }); }
      catch (err) { console.warn(`[diver] PumpSwap buy failed (${String(err.message).slice(0, 100)}) — routing through Jupiter`); venue = "jupiter"; return jupiterBuy({ wallet, mint: config.mint, quote: q, quoteAmountRaw: raw }); }
    };
    try {
      if (graduated) ({ sig: buyTx } = await poolBuy());
      else { venue = "curve"; ({ sig: buyTx } = await curveBuy({ wallet, mint: config.mint, quote: q, quoteAmountRaw: raw, programId })); }
    } catch (err) {
      if (!graduated && /graduated|complete|6002|BondingCurveComplete/i.test(String(err.message))) {
        console.warn("[diver] curve buy refused — the coin graduated, buying on PumpSwap");
        ({ sig: buyTx } = await poolBuy());
      } else throw err;
    }
    txs.buy = buyTx;
    console.log(`[diver] bought with ${spend} ${sym} on ${venue} · ${buyTx}`);
  }
  if (buyTx) await new Promise((r) => setTimeout(r, 1500)); // let the RPC catch up with the buy
  const walletAfterBuy = await quoteBalance(me, q);
  const spent = buyTx ? Math.max(0, walletQuote - walletAfterBuy) : 0;
  if (q.isSol && buyTx) {
    const left = BigInt((await getMeta("buy_budget", "0")) || "0") - toRaw(spent, 9);
    await setMeta("buy_budget", (left > 0n ? left : 0n).toString());
  }
  await sql`update dives set spent_quote = ${spent}, buy_tx = ${buyTx || null}, venue = ${venue || null}, status = 'burning' where id = ${id}`;
  setProgress({ status: "burning", spent, txs: { ...txs } });

  // 3. dispose of exactly what this buy brought in: the airdrop share goes to the top holders, the
  //    rest is burned (together with whatever a previous failed burn still owes).
  const balanceAfterRaw = buyTx ? await tokenBalanceRawSettled(me, config.mint, programId) : balanceBeforeRaw;
  const boughtRaw = balanceAfterRaw > balanceBeforeRaw ? balanceAfterRaw - balanceBeforeRaw : 0n;
  const part = splitBought(boughtRaw, bps);
  // everything bought is owed to the burn until the airdrop has actually left the wallet:
  // a crash or a failed airdrop burns the tokens instead of stranding them
  const owedBefore = BigInt((await getMeta("owed_burn_raw", "0")) || "0") + boughtRaw;
  if (boughtRaw > 0n) await setMeta("owed_burn_raw", owedBefore.toString());
  let airdropped = 0, recipients = 0, sentRaw = 0n;
  if (part.airdropRaw > 0n) {
    try {
      const holders = await topHolders(config.mint, { exclude: [me, config.lpWallet, config.treasuryWallet, coin.creator], limit: config.rules.airdropHolders });
      const drop = await airdropTokens({ wallet, mint: config.mint, programId, amountRaw: part.airdropRaw, holders });
      sentRaw = drop.sentRaw; recipients = drop.recipients; airdropped = Number(sentRaw) / 1e6;
      if (drop.sigs.length) txs.airdrop = drop.sigs[0];
      if (sentRaw > 0n) await setMeta("owed_burn_raw", (owedBefore - sentRaw).toString());
      console.log(`[diver] airdropped ${airdropped.toLocaleString()} $${coin.symbol} to ${recipients} holders${drop.error ? ` (stopped: ${drop.error})` : ""}`);
    } catch (err) { console.warn(`[diver] airdrop failed (${String(err.message).slice(0, 120)}), its share is burned instead`); }
  }
  const owedRaw = owedBefore - sentRaw;
  let burned = 0;
  if (owedRaw > 0n) {
    const { sig, amount } = await burnAmount({ wallet, mint: config.mint, programId, amountRaw: owedRaw });
    if (sig) {
      await setMeta("owed_burn_raw", (owedRaw - amount).toString());
      txs.burn = sig; burned = Number(amount) / 1e6;
      console.log(`[diver] burned ${burned.toLocaleString()} $${coin.symbol} · ${sig}`);
    }
  }
  const supplyAfter = await totalSupply(config.mint).catch(() => null);
  const solUsd = await getSolUsd();
  const status = buyTx || burned > 0 || txs.split ? "done" : "skipped";
  const msg = status === "done"
    ? `claimed ${claimed} ${sym}${txs.split ? ` · ${sentLp} to LP, ${sentTreasury} to treasury` : ""}${buyTx ? ` · bought with ${spent} ${sym} on ${venue}` : ""} · airdropped ${Math.round(airdropped).toLocaleString()} to ${recipients} holders · burned ${Math.round(burned).toLocaleString()} $${coin.symbol}`
    : `${spend} ${sym} (~$${(spend * quoteUsd).toFixed(2)}) in the buy budget, under the $${config.rules.minBuyUsd} minimum — rolls into the next dive`;
  await sql`update dives set status = ${status}, tokens_airdropped = ${airdropped}, airdrop_recipients = ${recipients}, airdrop_tx = ${txs.airdrop || null}, tokens_burned = ${burned}, burn_tx = ${txs.burn || null}, supply_after = ${supplyAfter}, sol_usd = ${solUsd}, price_usd = ${coin.priceUsd}, quote_usd = ${coin.quoteUsd || quoteUsd}, note = ${msg}, finished_at = ${now()} where id = ${id}`;
  setProgress({ status, tokens: burned, txs: { ...txs }, note: msg });
  if (status === "done" && state.lastNote) { state.lastNote = null; await setMeta("last_note", ""); } // a good dive clears the last error note
  if (supplyAfter !== null) { coin.supply = supplyAfter; coin.burned = Math.max(0, coin.supply0 - supplyAfter); }
  await readPot().catch(() => {});
  await loadHistory();
  console.log(`[diver] dive #${id} ${status}: ${msg}`);
}
