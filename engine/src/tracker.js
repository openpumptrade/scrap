import { config, mode } from "./config.js";
import { sql, getMeta, setMeta } from "./db.js";
import { connection, getSolBalance, getSolUsd, getUsdPrice } from "./solana.js";
import { readSharing, fetchCoinInfo, creatorVaultBalancesRaw, totalSupply, tokenBalanceRaw, mintProgramId, loadCurve, resolveQuote, quoteBalance, estimateCurveBuy, toRaw, fromRaw } from "./pumpfun.js";
import { PublicKey } from "@solana/web3.js";

/// Market + pot tracker. Every POLL_SEC it refreshes the coin from pump.fun's
/// public API (price, mcap, graduation), the curve, the total supply from the
/// RPC, the unclaimed creator fees (the pot, in the coin's quote asset) and
/// the engine wallet's balances.

export const coin = {
  loaded: false, mint: "", name: "", symbol: "", image: "", description: "", creator: "", createdTs: 0, tokenProgram: "",
  quote: null,            // {mint, isSol, tokenProgram, decimals, symbol, name, image}
  taxBps: 0, isHolderReward: false,
  sharing: null,          // pump.fun fee-sharing config {address, adminRevoked, shareholders} once fees are redirected
  engineShareBps: 0,      // the engine wallet's slice of that split
  graduated: false, pool: "", priceUsd: 0, mcapUsd: 0, solUsd: 0, quoteUsd: 0, supply: 0, supply0: 0, burned: 0, updatedAt: 0, replyCount: 0,
};
export const pot = {
  unclaimed: 0,        // unclaimed creator fees, in the quote asset (SOL here; UI units)
  unclaimedUsd: 0,
  wallet: 0,           // quote asset already in the engine wallet (claimed but not spent yet)
  spendable: 0,        // what the next dive can spend (SOL quote: minus the gas reserve)
  walletSol: 0,        // SOL for fees
  walletTokens: 0,     // coin tokens waiting to be burned
  estTokens: 0,        // what the next dive would buy
  updatedAt: 0, error: null,
};

let running = false;
let walletPk = "";

export function engineWallet() { return walletPk; }

export async function loadCoin() {
  const [info, curve] = await Promise.all([fetchCoinInfo(config.mint).catch((e) => { console.warn(`[tracker] coin info unavailable (${e.message}) — booting from the curve only`); return {}; }), loadCurve(config.mint)]);
  coin.mint = config.mint;
  const onchain = info.symbol ? null : await onchainMetadata(config.mint);
  coin.name = info.name || onchain?.name || "";
  coin.symbol = info.symbol || onchain?.symbol || "";
  coin.image = info.image_uri || "";
  coin.description = info.description || "";
  coin.creator = curve.creator || info.creator || "";
  coin.createdTs = Number(info.created_timestamp || 0);
  coin.tokenProgram = (await mintProgramId(config.mint)).toBase58();
  coin.quote = await resolveQuote(curve.quoteMintPk);
  coin.taxBps = curve.taxBps;
  coin.isHolderReward = curve.isHolderReward;
  coin.graduated = curve.complete || Boolean(info.complete);
  coin.pool = info.pump_swap_pool || info.pool_address || "";
  coin.replyCount = Number(info.reply_count || 0);
  coin.supply = await totalSupply(config.mint);
  const s0 = Number(await getMeta("supply0", 0));
  coin.supply0 = s0 || coin.supply;
  if (!s0) await setMeta("supply0", coin.supply0);
  coin.burned = Math.max(0, coin.supply0 - coin.supply);
  coin.loaded = true;
  walletPk = mode() === "bot" ? config.wallet.publicKey.toBase58() : (config.walletAddress || coin.creator);
  await refreshSharing(true);
  if (coin.isHolderReward) console.warn("[tracker] WARNING: this is a holder-rewards coin — its creator fees go to holders, not to a wallet; the engine cannot claim it");
  if (!coin.quote.isSol && !coin.taxBps) console.log(`[tracker] note: ${coin.symbol} is a custom pair (${coin.quote.symbol}) without a configured tax — the standard creator fee applies`);
  return coin;
}

/// Fees reach the engine one of two ways: the engine wallet IS the creator, or the creator redirected
/// them with pump.fun fee sharing (the engine wallet is a shareholder). Re-read every poll: the split
/// can be written after the engine is already running.
async function refreshSharing(log = false) {
  const prev = coin.sharing?.address || "";
  coin.sharing = await readSharing(config.mint).catch(() => coin.sharing);
  coin.engineShareBps = coin.sharing ? (coin.sharing.shareholders.find((x) => x.address === walletPk)?.shareBps || 0) : (walletPk === coin.creator ? 10_000 : 0);
  if (!log && (coin.sharing?.address || "") === prev) return;
  if (coin.sharing) {
    const split = coin.sharing.shareholders.map((x) => `${x.address.slice(0, 4)}…${x.address.slice(-4)} ${x.shareBps / 100}%`).join(", ");
    console.log(`[tracker] fee sharing ON (${coin.sharing.adminRevoked ? "locked" : "admin not revoked"}) · ${split} · engine gets ${coin.engineShareBps / 100}%`);
    if (!coin.engineShareBps) console.warn(`[tracker] WARNING: the engine wallet ${walletPk} is not a shareholder of ${coin.symbol} — nothing reaches it`);
  } else if (walletPk !== coin.creator) {
    console.warn(`[tracker] WARNING: no fee sharing yet and the engine wallet ${walletPk} is not the creator (${coin.creator}) — redirect 100% of the creator fees to the engine wallet on pump.fun`);
  }
}

/// pump.fun's API 403s from servers and DexScreener lists nothing before the first trade —
/// Token-2022 coins carry name/symbol in the mint's own metadata extension.
async function onchainMetadata(mint) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const ext = (info.value?.data?.parsed?.info?.extensions || []).find((e) => e.extension === "tokenMetadata");
    return ext ? { name: ext.state.name, symbol: ext.state.symbol, uri: ext.state.uri } : null;
  } catch { return null; }
}

export async function startTracker() {
  await tick();
  setInterval(tick, config.pollSec * 1000);
  console.log(`[tracker] ${coin.name} ($${coin.symbol}) · quoted in ${coin.quote.symbol} ·${coin.taxBps ? ` tax ${coin.taxBps / 100}% ·` : ""} ${coin.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "SPL"} · ${coin.graduated ? "graduated" : "on the curve"} · supply ${coin.supply.toLocaleString()} · polling every ${config.pollSec}s`);
}

export async function readPot() {
  const q = coin.quote;
  const [vault, walletQuote, walletSol, tokensRaw] = await Promise.all([
    creatorVaultBalancesRaw(coin.sharing ? coin.sharing.address : walletPk, q, config.mint).catch((e) => { pot.error = String(e.message).slice(0, 120); return null; }),
    quoteBalance(walletPk, q).catch(() => pot.wallet),
    getSolBalance(walletPk).catch(() => pot.walletSol),
    mintProgramId(config.mint).then((pid) => tokenBalanceRaw(walletPk, config.mint, pid)).catch(() => 0n),
  ]);
  // with fee sharing the vault belongs to the sharing config — only the engine's slice of it is ours
  const share = coin.sharing ? coin.engineShareBps / 10_000 : (walletPk === coin.creator ? 1 : 0);
  if (vault) { pot.unclaimed = fromRaw(vault.total, q.decimals) * share; pot.error = null; }
  pot.unclaimedUsd = pot.unclaimed * coin.quoteUsd;
  pot.wallet = walletQuote;
  pot.walletSol = walletSol;
  pot.spendable = q.isSol ? Math.max(0, walletQuote - config.rules.gasReserveSol) : walletQuote;
  pot.walletTokens = Number(tokensRaw) / 1e6;
  const est = pot.unclaimed + (mode() === "bot" ? pot.spendable : 0);
  if (est > 0) {
    try {
      const onCurve = coin.graduated ? null : await estimateCurveBuy(config.mint, q, toRaw(est, q.decimals));
      pot.estTokens = onCurve ?? (coin.priceUsd > 0 ? (est * coin.quoteUsd) / coin.priceUsd : 0);
    } catch { /* keep the previous estimate */ }
  } else pot.estTokens = 0;
  pot.updatedAt = Math.floor(Date.now() / 1000);
  return pot;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const [info, supply, solUsd, quoteUsd, curve] = await Promise.all([
      fetchCoinInfo(config.mint).catch(() => null),
      totalSupply(config.mint).catch(() => coin.supply),
      getSolUsd(),
      coin.quote.isSol ? getSolUsd() : getUsdPrice(coin.quote.mint),
      loadCurve(config.mint).catch(() => null),
    ]);
    if (info) {
      coin.mcapUsd = Number(info.usd_market_cap || 0);
      coin.priceUsd = coin.mcapUsd / 1e9; // pump.fun quotes usd_market_cap as price × the 1B mint supply, burns or not
      if (info.complete !== undefined) coin.graduated = Boolean(info.complete);
      coin.pool = info.pump_swap_pool || info.pool_address || coin.pool;
      coin.replyCount = Number(info.reply_count || coin.replyCount);
      if (info.image_uri) coin.image = info.image_uri;
    }
    await refreshSharing();
    if (curve) { coin.graduated = curve.complete || coin.graduated; coin.taxBps = curve.taxBps; }
    coin.supply = supply;
    coin.burned = Math.max(0, coin.supply0 - coin.supply);
    coin.solUsd = solUsd;
    coin.quoteUsd = quoteUsd;
    coin.updatedAt = Math.floor(Date.now() / 1000);
    await readPot();
    if (coin.priceUsd > 0) {
      const ts = Math.floor(Date.now() / 1000);
      await sql`insert into samples (ts, price_usd, mcap_usd, supply) values (${ts}, ${coin.priceUsd}, ${coin.mcapUsd}, ${coin.supply}) on conflict (ts) do nothing`;
      await sql`delete from samples where ts < ${ts - 14 * 86400}`;
    }
  } catch (err) {
    console.error("[tracker] tick:", String(err.message).slice(0, 200));
  } finally { running = false; }
}

export { PublicKey, connection };
