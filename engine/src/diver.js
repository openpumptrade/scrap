import { config, mode } from "./config.js";
import { sql, getMeta, setMeta } from "./db.js";
import { getSolBalance, getSolUsd } from "./solana.js";
import { distributeSharedFees, burnAmount,claimCreatorFees, curveBuy, pumpswapBuy, jupiterBuy, mintProgramId, tokenBalanceRaw, tokenBalanceRawSettled, totalSupply, isGraduated, creatorVaultBalancesRaw, quoteBalance, toRaw } from "./pumpfun.js";
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
  lastDive: null,
  genesis: 0,
  dryTotals: { dives: 0, spentQuote: 0, spentUsd: 0, burned: 0 },
};

let firing = false;
const now = () => Math.floor(Date.now() / 1000);

export async function startDiver() {
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
  const [agg] = await sql`select count(*)::int as n, coalesce(sum(spent_quote), 0) as spent, coalesce(sum(spent_quote * coalesce(quote_usd, 0)), 0) as usd, coalesce(sum(tokens_burned), 0) as burned from dives where status = 'done' and dry = false`;
  const [dry] = await sql`select count(*)::int as n, coalesce(sum(spent_quote), 0) as spent, coalesce(sum(spent_quote * coalesce(quote_usd, 0)), 0) as usd, coalesce(sum(tokens_burned), 0) as burned from dives where status = 'done' and dry = true`;
  state.divesRun = agg.n;
  state.totalSpentQuote = Number(agg.spent);
  state.totalSpentUsd = Number(agg.usd);
  state.totalBurned = Number(agg.burned);
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
  try { await runDive(); }
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
  const walletQuote = await quoteBalance(me, q);
  const spend = q.isSol ? Math.max(0, walletQuote - config.rules.gasReserveSol) : walletQuote;
  await sql`update dives set claimed_quote = ${claimed}, claim_tx = ${txs.claim || null}, status = 'buying' where id = ${id}`;
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
  await sql`update dives set spent_quote = ${spent}, buy_tx = ${buyTx || null}, venue = ${venue || null}, status = 'burning' where id = ${id}`;
  setProgress({ status: "burning", spent, txs: { ...txs } });

  // 3. burn only what this buy brought in + what a previous failed burn still owes
  const balanceAfterRaw = buyTx ? await tokenBalanceRawSettled(me, config.mint, programId) : balanceBeforeRaw;
  const boughtRaw = balanceAfterRaw > balanceBeforeRaw ? balanceAfterRaw - balanceBeforeRaw : 0n;
  const owedRaw = BigInt((await getMeta("owed_burn_raw", "0")) || "0") + boughtRaw;
  if (boughtRaw > 0n) await setMeta("owed_burn_raw", owedRaw.toString()); // survives a failed burn or a restart
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
  const status = buyTx || burned > 0 ? "done" : "skipped";
  const msg = status === "done"
    ? `claimed ${claimed} ${sym} · bought with ${spent} ${sym} on ${venue} · burned ${Math.round(burned).toLocaleString()} $${coin.symbol}`
    : `${spend} ${sym} (~$${(spend * quoteUsd).toFixed(2)}) available, under the $${config.rules.minBuyUsd} minimum — rolls into the next dive`;
  await sql`update dives set status = ${status}, tokens_burned = ${burned}, burn_tx = ${txs.burn || null}, supply_after = ${supplyAfter}, sol_usd = ${solUsd}, price_usd = ${coin.priceUsd}, quote_usd = ${coin.quoteUsd || quoteUsd}, note = ${msg}, finished_at = ${now()} where id = ${id}`;
  setProgress({ status, tokens: burned, txs: { ...txs }, note: msg });
  if (status === "done" && state.lastNote) { state.lastNote = null; await setMeta("last_note", ""); } // a good dive clears the last error note
  if (supplyAfter !== null) { coin.supply = supplyAfter; coin.burned = Math.max(0, coin.supply0 - supplyAfter); }
  await readPot().catch(() => {});
  await loadHistory();
  console.log(`[diver] dive #${id} ${status}: ${msg}`);
}
