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
  await sql`create index if not exists dives_ts on dives (ts)`;
  await sql`create table if not exists samples (ts int primary key, price_usd double precision not null, mcap_usd double precision not null, supply double precision)`;
}

export async function getMeta(key, fallback = null) {
  const rows = await sql`select value from meta where key = ${key}`;
  return rows.length ? rows[0].value : fallback;
}
export async function setMeta(key, value) {
  await sql`insert into meta (key, value) values (${key}, ${String(value)})
    on conflict (key) do update set value = excluded.value`;
}
