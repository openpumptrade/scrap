import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import compression from "compression";
import { config, mode } from "./config.js";
import { sql } from "./db.js";
import { getSolBalance } from "./solana.js";
import { coin, pot, engineWallet } from "./tracker.js";
import { state, rowToJson } from "./diver.js";
import { lpState } from "./liquidity.js";
import { mountCommunity } from "./community.js";
import { fetchCandles, fetchTrades, taxConfig } from "./pumpfun.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const now = () => Math.floor(Date.now() / 1000);
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { v, at: Date.now() });
  return v;
}

export const live = { started: false };

/// What the engine wallet still owes each bucket (SOL claimed but not yet sent or spent).
async function ledger() {
  const rows = await sql`select key, value from meta where key in ('owed_lp', 'owed_treasury', 'buy_budget')`;
  const v = (k) => Number(rows.find((r) => r.key === k)?.value || 0) / 1e9;
  return { lp: v("owed_lp"), treasury: v("owed_treasury"), buy: v("buy_budget") };
}

/// SOL sitting in each project wallet right now (cached by the caller).
async function walletBalances() {
  const read = async (a) => (a ? await getSolBalance(a) : null);
  const [engine, lp, treasury] = await Promise.all([read(engineWallet()), read(config.lpWallet), read(config.treasuryWallet)]);
  return { engine, lp, treasury };
}

/// Keep at most `max` evenly spaced points: history endpoints must not grow with the age of the coin.
const thin = (rows, max = 500) => { const step = Math.ceil(rows.length / max); return step <= 1 ? rows : rows.filter((_, i) => i % step === 0 || i === rows.length - 1); };
export function startApi() {
  const app = express();
  app.use(cors());
  app.use(compression());
  app.set("etag", false);
  // Short edge cache: a proxy in front (s-maxage) answers many viewers with one origin fetch.
  const EDGE_TTL = { "/community": 8, "/airdrop/last": 20, "/token": 5, "/trades": 10, "/dives": 20, "/chart": 15, "/liquidity": 20 };
  app.use("/api", (req, res, next) => {
    const ttl = EDGE_TTL[req.path];
    res.set("cache-control", ttl ? `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}` : "no-store");
    next();
  });

  mountCommunity(app);

  app.get("/api/health", (_req, res) => res.json({ ok: true, mode: mode(), scheduler: config.schedulerEnabled, started: live.started, coin: coin.symbol, quote: coin.quote?.symbol || null, taxBps: coin.taxBps, nextDiveAt: state.nextDiveAt }));

  app.get("/api/token", async (_req, res) => {
    if (!live.started) {
      const tax = await cached("taxcfg", 60_000, () => taxConfig()).catch(() => null);
      return res.json({ started: false, mint: config.mint, wallet: config.wallet?.publicKey.toBase58() || config.walletAddress || "", brand: config.brand, rules: config.rules, split: config.split, lpWallet: config.lpWallet, treasuryWallet: config.treasuryWallet, chain: "Solana", launchpad: "pump.fun", plannedTaxBps: config.plannedTaxBps, taxGate: tax, now: now() });
    }
    res.json({
      started: true, mode: mode(), brand: config.brand, rules: config.rules,
      dryRun: config.dryRun || mode() !== "bot", schedulerEnabled: config.schedulerEnabled,
      chain: "Solana", launchpad: "pump.fun",
      mint: coin.mint, name: coin.name, symbol: coin.symbol, image: coin.image, creator: coin.creator, wallet: engineWallet(),
      quote: coin.quote, taxBps: coin.taxBps, sharing: coin.sharing, engineShareBps: coin.engineShareBps, isHolderReward: coin.isHolderReward,
      tokenProgram: coin.tokenProgram, graduated: coin.graduated, pool: coin.pool, createdTs: coin.createdTs,
      priceUsd: coin.priceUsd, mcapUsd: coin.mcapUsd, realMcapUsd: coin.priceUsd * coin.supply, solUsd: coin.solUsd, quoteUsd: coin.quoteUsd,
      supply: coin.supply, supply0: coin.supply0, burned: coin.burned,
      burnedPct: coin.supply0 ? coin.burned / coin.supply0 : 0, marketUpdatedAt: coin.updatedAt,
      pot: { unclaimed: pot.unclaimed, unclaimedUsd: pot.unclaimedUsd, wallet: pot.wallet, spendable: pot.spendable, walletSol: pot.walletSol, walletTokens: pot.walletTokens, estTokens: pot.estTokens, updatedAt: pot.updatedAt, error: pot.error },
      nextDiveAt: state.nextDiveAt, genesis: state.genesis, progress: state.progress, lastNote: state.lastNote,
      ledger: await cached("ledger", 10_000, ledger).catch(() => null),
      totalClaimed: state.totalClaimed, totalClaimedUsd: state.totalClaimedUsd, totalAirdropTransfers: state.totalAirdropTransfers, wallets: await cached("wallets", 30_000, walletBalances).catch(() => null),
      liquidity: lpState, split: config.split, lpWallet: config.lpWallet, treasuryWallet: config.treasuryWallet, totalLp: state.totalLp, totalTreasury: state.totalTreasury, totalAirdropped: state.totalAirdropped,
      divesRun: state.divesRun, totalSpentQuote: state.totalSpentQuote, totalSpentUsd: state.totalSpentUsd, totalBurned: state.totalBurned, dryTotals: state.dryTotals, lastDive: state.lastDive,
      links: { pump: `https://pump.fun/coin/${coin.mint}`, explorer: `https://solscan.io/token/${coin.mint}`, wallet: `https://solscan.io/account/${engineWallet()}`, tx: "https://solscan.io/tx/", quote: coin.quote?.isSol ? "" : `https://solscan.io/token/${coin.quote.mint}` },
      now: now(),
    });
  });

  /// liquidity rounds: each one is a buy, a pool deposit and the burn of the LP tokens it returned
  app.get("/api/liquidity", async (req, res) => {
    const limit = Math.min(100, Number(req.query.limit || 30));
    const rows = await sql`select * from lp_rounds order by id desc limit ${limit}`;
    res.json(rows.map((r) => ({ id: r.id, t: r.ts, status: r.status, spentSol: r.spent_sol, tokensPaired: r.base_deposited, buyTx: r.buy_tx, depositTx: r.deposit_tx, burnTx: r.burn_tx, note: r.note })));
  });

  /// who received the most recent airdrop, and how much each
  app.get("/api/airdrop/last", async (_req, res) => {
    const [r] = await sql`select id, ts, airdrop_to from dives where status = 'done' and dry = false and airdrop_to is not null order by id desc limit 1`;
    res.json(r ? { dive: r.id, t: r.ts, recipients: r.airdrop_to } : { dive: null, recipients: [] });
  });

  app.get("/api/dives", async (req, res) => {
    const limit = Math.min(200, Number(req.query.limit || 60));
    const rows = await sql`select * from dives where status in ('done', 'skipped', 'failed') order by id desc limit ${limit}`;
    res.json(rows.map(rowToJson));
  });

  /// price history for the chart: pump.fun candles (USD) + our own samples as fallback
  app.get("/api/chart", async (req, res) => {
    if (!live.started) return res.status(404).json({ error: "not started" });
    const interval = ["1m", "5m", "15m", "1h"].includes(String(req.query.i)) ? String(req.query.i) : "1m";
    const dives = (await sql`select id, ts, dry, spent_quote, quote_usd, tokens_burned from dives where status = 'done' order by id`).map((b) => ({ id: b.id, t: b.ts, dry: b.dry, spentQuote: b.spent_quote, spentUsd: b.spent_quote * (b.quote_usd || 0), tokens: b.tokens_burned }));
    try {
      const candles = await cached(`c:${interval}`, 8_000, () => fetchCandles(coin.mint, interval, coin.createdTs, 1000));
      const points = candles.map((c) => ({ t: Number(c.timestamp ?? c.time ?? c.t), o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close), v: Number(c.volume ?? 0) }))
        .filter((c) => isFinite(c.t) && c.c > 0).map((c) => (c.t > 1e12 ? { ...c, t: Math.floor(c.t / 1000) } : c)).sort((a, b) => a.t - b.t);
      res.json({ source: "pump.fun", interval, points, dives, priceUsd: coin.priceUsd, mcapUsd: coin.mcapUsd, supply0: coin.supply0, supply: coin.supply, now: now() });
    } catch (err) {
      const rows = await cached("samples", 15_000, async () => {
        const [{ lo, hi }] = await sql`select min(ts) as lo, max(ts) as hi from samples`;
        const bucket = Math.max(10, Math.ceil(((hi || 0) - (lo || 0)) / 500));
        return sql`select distinct on (k) ts, price_usd from (select ts, price_usd, ts / ${bucket} as k from samples) s order by k, ts desc`;
      });
      res.json({ source: "samples", interval, points: thin(rows).map((r) => ({ t: r.ts, c: r.price_usd })), dives, priceUsd: coin.priceUsd, mcapUsd: coin.mcapUsd, supply0: coin.supply0, supply: coin.supply, now: now(), error: String(err.message).slice(0, 100) });
    }
  });

  app.get("/api/trades", async (_req, res) => {
    if (!live.started) return res.json([]);
    try {
      const trades = await cached("trades", 5_000, () => fetchTrades(coin.mint, 40));
      const me = engineWallet();
      // swap-api shape: {tx, timestamp (ISO), userAddress, type: "buy"|"sell", amountSol, amountUsd, baseAmount, quoteAmount, priceUsd}
      res.json(trades.map((t) => ({
        t: Math.floor(new Date(t.timestamp ?? 0).getTime() / 1000) || Math.floor(Number(t.timestamp ?? 0) / 1000),
        side: /buy/i.test(String(t.type ?? t.side ?? "")) || t.is_buy === true ? "buy" : "sell",
        quote: Number(t.quoteAmount ?? (coin.quote?.isSol ? t.amountSol : 0) ?? 0),
        sol: Number(t.amountSol ?? 0),
        tokens: Number(t.baseAmount ?? t.token_amount ?? 0),
        usd: Number(t.amountUsd ?? 0), priceUsd: Number(t.priceUsd ?? 0),
        wallet: String(t.userAddress ?? t.user ?? ""), tx: String(t.tx ?? t.signature ?? ""),
        engine: String(t.userAddress ?? "") === me,
      })).filter((t) => t.t > 0));
    } catch (err) { res.json([]); }
  });

  app.use(express.static(path.join(here, "..", "public"), { etag: false, maxAge: 0, extensions: ["html"] }));
  app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
}
