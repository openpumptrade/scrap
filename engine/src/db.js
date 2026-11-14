import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.databaseUrl, {
  max: 6,
  idle_timeout: 30,
  ssl: config.databaseUrl.includes("localhost") || config.databaseUrl.includes("127.0.0.1") ? false : "require",
  transform: { undefined: null },
  onnotice: () => {},
});

/// Idempotent schema — runs at boot (Railway has no shell for migrations).
/// Amounts are in the coin's QUOTE asset ($PUMP, WBTC, SOL...) — `quote_usd`
/// is the USD price of one unit of it at dive time.
export async function ensureSchema() {
  await sql`create table if not exists meta (key text primary key, value text not null)`;
  await sql`create table if not exists dives (
    id serial primary key, ts int not null,
    status text not null default 'claiming',
    dry boolean not null default false,
    pot_quote double precision not null default 0,
    claimed_quote double precision not null default 0,
    spent_quote double precision not null default 0,
    tokens_burned double precision not null default 0,
    quote_usd double precision, price_usd double precision, sol_usd double precision, supply_after double precision,
    venue text, claim_tx text, buy_tx text, burn_tx text,
    note text, finished_at int)`;
  for (const col of ["lp_quote double precision not null default 0", "treasury_quote double precision not null default 0", "tokens_airdropped double precision not null default 0", "airdrop_recipients int not null default 0", "split_tx text", "airdrop_tx text", "airdrop_to jsonb"]) await sql.unsafe(`alter table dives add column if not exists ${col}`);
  await sql`create index if not exists dives_ts on dives (ts)`;
  await sql`create table if not exists lp_rounds (id serial primary key, ts int not null, status text not null, spent_sol double precision not null default 0, base_deposited double precision not null default 0, lp_burned double precision not null default 0, buy_tx text, deposit_tx text, burn_tx text, note text)`;
  await sql`create table if not exists samples (ts int primary key, price_usd double precision not null, mcap_usd double precision not null, supply double precision)`;
}

/// Only one engine may run dives on a database. A redeploy starts the new container while the old one
/// is still alive; the new one waits here until the old one is gone and its lock is released.
/// The lock lives on a reserved connection that is kept busy so the pool's idle timeout never drops it.
export async function acquireEngineLock(log = console.log) {
  const conn = await sql.reserve();
  for (let i = 0; ; i++) {
    const [{ ok }] = await conn`select pg_try_advisory_lock(727272) as ok`;
    if (ok) break;
    if (i % 10 === 0) log("[lock] another engine holds the lock, waiting for it to stop");
    await new Promise((r) => setTimeout(r, 3_000));
  }
  setInterval(() => { conn`select 1`.catch((e) => { console.error("[lock] lost the lock connection, exiting:", e.message); process.exit(1); }); }, 20_000).unref();
  log("[lock] engine lock acquired");
}

export async function getMeta(key, fallback = null) {
  const rows = await sql`select value from meta where key = ${key}`;
  return rows.length ? rows[0].value : fallback;
}
export async function setMeta(key, value) {
  await sql`insert into meta (key, value) values (${key}, ${String(value)})
    on conflict (key) do update set value = excluded.value`;
}
