import express from "express";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { connection, sendSol } from "./solana.js";
import { coin } from "./tracker.js";
import { mintProgramId, tokenBalanceRaw, tokenBalanceRawSettled, isGraduated, curveBuy, pumpswapBuy, burnAmount, sendTokens } from "./pumpfun.js";

/// The community layer from the original brief, on top of the meme treasury:
///   Dumpster Dive   every week holders vote: burn a slice of the treasury, or donate it
///   Recycle a Rug   holders submit a failed memecoin and a roast, holders vote, the best roast wins $SCRAP
///   Scrap Badge     a streak of weeks in which a wallet took part (vote or roast)
/// A wallet proves itself by signing a plain text message; nothing is ever sent on-chain by the voter.
/// Votes are weighted by the $SCRAP the wallet holds, and counted again at settlement with
/// min(balance when voting, balance when the week closes), so buying to vote and selling does not pay.

export const WEEK = 604_800; // a round is one UTC week, Thursday 00:00 to Thursday 00:00
export const weekOf = (ts) => Math.floor(ts / WEEK);
const now = () => Math.floor(Date.now() / 1000);
const lamports = (sol) => BigInt(Math.floor(sol * 1e9));
const short = (a) => `${a.slice(0, 4)}...${a.slice(-4)}`;

export const BADGES = [
  { weeks: 8, name: "Scrap Lord" },
  { weeks: 4, name: "Trash Panda" },
  { weeks: 2, name: "Dumpster Diver" },
  { weeks: 1, name: "Scavenger" },
];
export const badgeFor = (streak) => BADGES.find((b) => streak >= b.weeks)?.name || null;

/// Longest run of consecutive weeks ending at `current` (or at the week before it, so a streak
/// is not lost on the first day of a new week). Pure, tested.
export function streakOf(weeks, current) {
  const set = new Set(weeks);
  let w = set.has(current) ? current : current - 1, n = 0;
  while (set.has(w)) { n++; w--; }
  return n;
}

/// The exact text a wallet signs. Client and server build it the same way.
export function messageFor({ action, week, data, ts }) {
  return `SCRAP community\naction: ${action}\nweek: ${week}\ndata: ${data}\nts: ${ts}`;
}

export function verifySignature({ wallet, message, sig }) {
  try { return nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(sig), new PublicKey(wallet).toBytes()); }
  catch { return false; }
}

export async function ensureCommunitySchema() {
  await sql`create table if not exists roasts (id serial primary key, week int not null, wallet text not null, target text not null, roast text not null, weight double precision not null default 0, created int not null, hidden boolean not null default false, unique (week, wallet))`;
  await sql`create table if not exists roast_votes (week int not null, wallet text not null, roast_id int not null, weight double precision not null, created int not null, primary key (week, wallet))`;
  await sql`create table if not exists dive_votes (week int not null, wallet text not null, choice text not null, weight double precision not null, created int not null, primary key (week, wallet))`;
  await sql`create table if not exists community_weeks (week int primary key, status text not null, settled_at int, result jsonb)`;
}

let treasuryCache = { at: 0, sol: 0 };
async function treasurySol() {
  if (Date.now() - treasuryCache.at > 30_000) treasuryCache = { at: Date.now(), sol: (await connection.getBalance(new PublicKey(config.treasuryWallet))) / 1e9 };
  return treasuryCache.sol;
}

const projectWallets = () => new Set([config.wallet?.publicKey.toBase58(), config.lpWallet, config.treasuryWallet].filter(Boolean));

async function holding(wallet) {
  const programId = await mintProgramId(config.mint);
  return Number(await tokenBalanceRaw(wallet, config.mint, programId)) / 1e6;
}

// ------------------------------------------------------------- reads
async function tally(week) {
  const dive = await sql`select choice, count(*)::int as n, coalesce(sum(weight), 0) as w from dive_votes where week = ${week} group by choice`;
  const pick = (c) => dive.find((r) => r.choice === c) || { n: 0, w: 0 };
  const roasts = await sql`select r.id, r.wallet, r.target, r.roast, r.created, coalesce(sum(v.weight), 0) as w, count(v.wallet)::int as n
    from roasts r left join roast_votes v on v.roast_id = r.id and v.week = r.week
    where r.week = ${week} and r.hidden = false group by r.id order by w desc, r.created asc limit 50`;
  return {
    dive: { burn: { weight: Number(pick("burn").w), voters: pick("burn").n }, donate: { weight: Number(pick("donate").w), voters: pick("donate").n } },
    roasts: roasts.map((r) => ({ id: r.id, wallet: short(r.wallet), target: r.target, roast: r.roast, created: r.created, weight: Number(r.w), voters: r.n })),
  };
}

async function participationWeeks(wallet) {
  const rows = await sql`select week from dive_votes where wallet = ${wallet} union select week from roast_votes where wallet = ${wallet} union select week from roasts where wallet = ${wallet}`;
  return rows.map((r) => r.week);
}

// ------------------------------------------------------------- writes (signed)
const hits = new Map(); // ip → [timestamps]: a small brake on write endpoints
function throttled(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const t = Date.now(), list = (hits.get(ip) || []).filter((x) => t - x < 60_000);
  list.push(t); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 20;
}

/// Shared checks for a signed action. Returns { wallet, week, weight } or throws an Error with `.status`.
async function authorize(req, action, data) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  if (!config.mint) throw fail(503, "the coin is not live yet");
  if (throttled(req)) throw fail(429, "slow down");
  const { wallet, ts, sig } = req.body || {};
  if (typeof wallet !== "string" || typeof sig !== "string" || !Number.isFinite(Number(ts))) throw fail(400, "wallet, ts and sig are required");
  try { new PublicKey(wallet); } catch { throw fail(400, "not a wallet address"); }
  if (Math.abs(now() - Number(ts)) > 600) throw fail(400, "the signature is too old, sign again");
  const week = weekOf(now());
  if (!verifySignature({ wallet, message: messageFor({ action, week, data, ts: Number(ts) }), sig })) throw fail(401, "the signature does not match");
  if (projectWallets().has(wallet)) throw fail(403, "project wallets do not vote");
  const weight = await holding(wallet);
  if (weight < config.community.minHold) throw fail(403, `you need at least ${config.community.minHold.toLocaleString()} $${coin.symbol || "SCRAP"} to take part`);
  return { wallet, week, weight };
}

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function mountCommunity(app) {
  app.use("/api/community", express.json({ limit: "8kb" }));
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : "something broke on our side" }); if (!err.status) console.error("[community]", err.message); }
  };

  app.get("/api/community", wrap(async () => {
    const week = weekOf(now());
    // what the treasury holds now, and what each contest would move if the week closed this minute
    let treasury = null;
    if (config.treasuryWallet) {
      const sol = await treasurySol();
      const free = Math.max(0, sol - config.community.reserveSol);
      treasury = { sol, voteSol: (free * config.community.voteSliceBps) / 10_000, prizeSol: (free * config.community.prizeBps) / 10_000 };
    }
    const last = await sql`select week, status, settled_at, result from community_weeks order by week desc limit 4`;
    return {
      week, endsAt: (week + 1) * WEEK, now: now(), minHold: config.community.minHold,
      voteSliceBps: config.community.voteSliceBps, prizeBps: config.community.prizeBps,
      treasury, donationWallet: config.donationWallet || null, payouts: Boolean(config.treasuryKeypair), badges: BADGES,
      ...(await tally(week)),
      history: last.map((r) => ({ week: r.week, status: r.status, settledAt: r.settled_at, result: r.result })),
    };
  }));

  app.get("/api/community/me", wrap(async (req) => {
    const wallet = String(req.query.wallet || "");
    try { new PublicKey(wallet); } catch { throw Object.assign(new Error("not a wallet address"), { status: 400 }); }
    const week = weekOf(now());
    const [balance, weeks, dv, rv, mine] = await Promise.all([
      holding(wallet), participationWeeks(wallet),
      sql`select choice from dive_votes where week = ${week} and wallet = ${wallet}`,
      sql`select roast_id from roast_votes where week = ${week} and wallet = ${wallet}`,
      sql`select id from roasts where week = ${week} and wallet = ${wallet}`,
    ]);
    const streak = streakOf(weeks, week);
    return { wallet, balance, eligible: balance >= config.community.minHold && !projectWallets().has(wallet), diveVote: dv[0]?.choice || null, roastVote: rv[0]?.roast_id || null, myRoast: mine[0]?.id || null, streak, badge: badgeFor(streak), weeksPlayed: weeks.length };
  }));

  app.post("/api/community/vote", wrap(async (req) => {
    const choice = req.body?.choice;
    if (choice !== "burn" && choice !== "donate") throw Object.assign(new Error("choice must be burn or donate"), { status: 400 });
    const { wallet, week, weight } = await authorize(req, "dive-vote", choice);
    await sql`insert into dive_votes (week, wallet, choice, weight, created) values (${week}, ${wallet}, ${choice}, ${weight}, ${now()})
      on conflict (week, wallet) do update set choice = excluded.choice, weight = excluded.weight, created = excluded.created`;
    return { ok: true, week, choice, weight };
  }));

  app.post("/api/community/roast", wrap(async (req) => {
    const target = clean(req.body?.target, 64), roast = clean(req.body?.roast, 280);
    if (target.length < 2 || roast.length < 10) throw Object.assign(new Error("name the dead coin and write at least a line"), { status: 400 });
    const { wallet, week, weight } = await authorize(req, "roast", `${target}\n${roast}`);
    const had = await sql`select id from roasts where week = ${week} and wallet = ${wallet}`;
    if (had.length) throw Object.assign(new Error("one roast per wallet per week"), { status: 409 });
    const [row] = await sql`insert into roasts (week, wallet, target, roast, weight, created) values (${week}, ${wallet}, ${target}, ${roast}, ${weight}, ${now()}) returning id`;
    return { ok: true, id: row.id };
  }));

  app.post("/api/community/roast-vote", wrap(async (req) => {
    const roastId = Number(req.body?.roastId);
    if (!Number.isInteger(roastId)) throw Object.assign(new Error("roastId is required"), { status: 400 });
    const { wallet, week, weight } = await authorize(req, "roast-vote", String(roastId));
    const [r] = await sql`select wallet from roasts where id = ${roastId} and week = ${week} and hidden = false`;
    if (!r) throw Object.assign(new Error("that roast is not in this week's round"), { status: 404 });
    if (r.wallet === wallet) throw Object.assign(new Error("you cannot vote for your own roast"), { status: 403 });
    await sql`insert into roast_votes (week, wallet, roast_id, weight, created) values (${week}, ${wallet}, ${roastId}, ${weight}, ${now()})
      on conflict (week, wallet) do update set roast_id = excluded.roast_id, weight = excluded.weight, created = excluded.created`;
    return { ok: true, roastId, weight };
  }));

  /// moderation: hide a roast (it stops showing and cannot win). Needs ADMIN_TOKEN.
  app.post("/api/community/hide", wrap(async (req) => {
    if (!config.adminToken || req.headers["x-admin-token"] !== config.adminToken) throw Object.assign(new Error("not allowed"), { status: 403 });
    await sql`update roasts set hidden = true where id = ${Number(req.body?.id)}`;
    return { ok: true };
  }));
}

// ------------------------------------------------------------- weekly settlement
/// Buy the coin with treasury SOL and return exactly what the buy brought in.
async function buyMeasured(wallet, lamportsIn) {
  const me = wallet.publicKey.toBase58();
  const programId = await mintProgramId(config.mint);
  const before = await tokenBalanceRaw(me, config.mint, programId);
  const graduated = (await isGraduated(config.mint)) ?? coin.graduated;
  const { sig } = graduated
    ? await pumpswapBuy({ wallet, mint: config.mint, quote: coin.quote, quoteAmountRaw: lamportsIn, pool: coin.pool || null })
    : await curveBuy({ wallet, mint: config.mint, quote: coin.quote, quoteAmountRaw: lamportsIn, programId });
  await new Promise((r) => setTimeout(r, 1500));
  const after = await tokenBalanceRawSettled(me, config.mint, programId);
  return { sig, programId, boughtRaw: after > before ? after - before : 0n };
}

/// Final weights: what a wallet held when it voted, capped by what it holds now.
async function finalWeights(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.wallet)) out.set(r.wallet, await holding(r.wallet).catch(() => 0));
  }
  return (r) => Math.min(Number(r.weight), out.get(r.wallet) ?? 0);
}

let settling = false;
/// Settle the week that just closed, once. Never throws.
export async function communityTick() {
  if (settling || !config.mint || !coin.loaded) return;
  const week = weekOf(now()) - 1;
  settling = true;
  try {
    const [any] = await sql`select (select count(*) from dive_votes where week = ${week}) + (select count(*) from roasts where week = ${week}) as n`;
    if (Number(any.n) === 0) return; // nothing happened that week
    if (!config.treasuryKeypair) return; // no key: the round stays open for a manual settlement
    // claim the week first: a crash halfway leaves it "settling" and it is never paid twice
    const claimed = await sql`insert into community_weeks (week, status) values (${week}, 'settling') on conflict (week) do nothing returning week`;
    if (!claimed.length) return;
    const result = await settle(week);
    await sql`update community_weeks set status = 'settled', settled_at = ${now()}, result = ${sql.json(result)} where week = ${week}`;
    console.log(`[community] week ${week} settled: ${JSON.stringify(result).slice(0, 300)}`);
  } catch (err) { console.error("[community] settlement failed:", String(err.message).slice(0, 200)); }
  finally { settling = false; }
}

async function settle(week) {
  const wallet = config.treasuryKeypair;
  const balance = BigInt(await connection.getBalance(wallet.publicKey));
  const free = balance - lamports(config.community.reserveSol);
  const min = lamports(0.01);
  const result = { treasurySol: Number(balance) / 1e9, dive: null, roast: null, errors: [] };

  // Dumpster Dive
  const votes = await sql`select wallet, choice, weight from dive_votes where week = ${week}`;
  const wOf = await finalWeights(votes);
  const sum = (c) => votes.filter((v) => v.choice === c).reduce((a, v) => a + wOf(v), 0);
  const burnW = sum("burn"), donateW = sum("donate");
  if (votes.length) {
    const outcome = donateW > burnW ? "donate" : "burn";
    const slice = free > 0n ? (free * BigInt(config.community.voteSliceBps)) / 10_000n : 0n;
    result.dive = { burnWeight: burnW, donateWeight: donateW, voters: votes.length, outcome, sol: Number(slice) / 1e9 };
    try {
      if (slice < min) result.dive.note = "the slice is under 0.01 SOL, nothing moved";
      else if (outcome === "burn") {
        const buy = await buyMeasured(wallet, slice);
        const burn = await burnAmount({ wallet, mint: config.mint, programId: buy.programId, amountRaw: buy.boughtRaw });
        Object.assign(result.dive, { buyTx: buy.sig, burnTx: burn.sig, burned: Number(burn.amount) / 1e6 });
      } else if (config.donationWallet) {
        result.dive.donationTx = await sendSol({ wallet, transfers: [{ to: config.donationWallet, lamports: slice }] });
        result.dive.donatedTo = config.donationWallet;
      } else result.dive.note = "donate won: the slice stays in the treasury until a shelter wallet is set";
    } catch (err) { result.errors.push(`dive: ${String(err.message).slice(0, 160)}`); }
  }

  // Recycle a Rug
  const rvotes = await sql`select v.wallet, v.roast_id, v.weight from roast_votes v join roasts r on r.id = v.roast_id where v.week = ${week} and r.hidden = false`;
  const roasts = await sql`select id, wallet, target, roast, created from roasts where week = ${week} and hidden = false order by created asc`;
  if (roasts.length) {
    const rw = await finalWeights(rvotes);
    const score = new Map(roasts.map((r) => [r.id, 0]));
    for (const v of rvotes) score.set(v.roast_id, (score.get(v.roast_id) || 0) + rw(v));
    const winner = roasts.slice().sort((a, b) => score.get(b.id) - score.get(a.id) || a.created - b.created)[0];
    const prize = free > 0n ? (free * BigInt(config.community.prizeBps)) / 10_000n : 0n;
    result.roast = { entries: roasts.length, voters: rvotes.length, winner: winner.wallet, target: winner.target, roast: winner.roast, weight: score.get(winner.id), sol: Number(prize) / 1e9 };
    try {
      if (prize < min) result.roast.note = "the prize is under 0.01 SOL, nothing moved";
      else {
        const buy = await buyMeasured(wallet, prize);
        const sig = await sendTokens({ wallet, mint: config.mint, programId: buy.programId, to: winner.wallet, amountRaw: buy.boughtRaw });
        Object.assign(result.roast, { buyTx: buy.sig, prizeTx: sig, prize: Number(buy.boughtRaw) / 1e6 });
      }
    } catch (err) { result.errors.push(`roast: ${String(err.message).slice(0, 160)}`); }
  }
  return result;
}
