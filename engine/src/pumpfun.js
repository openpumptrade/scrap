import { createRequire } from "node:module";
import BN from "bn.js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { config } from "./config.js";
import { connection, sendTx, simulate, LAMPORTS, WSOL_MINT } from "./solana.js";

// the SDKs' ESM builds break on Node (bad named imports from @coral-xyz/anchor)
// — their CJS builds work
const require = createRequire(import.meta.url);
const { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } = require("@pump-fun/pump-sdk");
const { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda } = require("@pump-fun/pump-swap-sdk");

export const sdk = new PumpSdk();
export const online = new OnlinePumpSdk(connection);
export const amm = new OnlinePumpAmmSdk(connection);
export const DECIMALS = 6; // every pump.fun coin
export const PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";

// ----------------------------------------------------------------- helpers
const programCache = new Map();
/// pump.fun mints are Token-2022 nowadays, older ones classic SPL — never
/// assume, read the mint's owner program (see pumpfun-template-gotchas).
export async function mintProgramId(mint) {
  const key = String(mint);
  if (programCache.has(key)) return programCache.get(key);
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`mint ${mint} not found on chain`);
  const pid = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  programCache.set(key, pid);
  return pid;
}

export async function totalSupply(mint) {
  const s = await connection.getTokenSupply(new PublicKey(mint));
  return Number(s.value.uiAmount ?? Number(s.value.amount) / 10 ** s.value.decimals);
}

export function isSolQuote(pk) {
  return !pk || pk.equals(PublicKey.default) || pk.toBase58() === WSOL_MINT;
}

let globalCache = { at: 0, global: null, feeConfig: null };
export async function pumpGlobals() {
  if (Date.now() - globalCache.at < 60_000 && globalCache.global) return globalCache;
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  globalCache = { at: Date.now(), global, feeConfig };
  return globalCache;
}

// ------------------------------------------------------------- quote asset
const CATALOG_URL = "https://blockchain-swap.pump.fun/supported/coin-create-mints";
let catalog = { at: 0, map: new Map() };
/// pump.fun's own custom-pair catalog (what its create form offers): mint → ticker/name/decimals/image/price.
export async function fetchQuoteCatalog() {
  if (Date.now() - catalog.at < 10 * 60_000 && catalog.map.size) return catalog.map;
  const res = await fetch(CATALOG_URL, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`coin-create-mints → ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : json.data || json.mints || [];
  const map = new Map();
  for (const m of list) map.set(m.mint, { mint: m.mint, ticker: m.ticker || m.symbol, name: m.symbol || m.ticker, decimals: Number(m.decimals), image: m.image_url || "", priceUsd: Number(m.price_usd || 0) });
  catalog = { at: Date.now(), map };
  return map;
}

/// What a coin is quoted in: SOL, or a custom-pair asset ($PUMP, WBTC, an xStock...).
export async function resolveQuote(quoteMintPk) {
  if (isSolQuote(quoteMintPk)) return { mint: WSOL_MINT, isSol: true, tokenProgram: TOKEN_PROGRAM_ID, decimals: 9, symbol: "SOL", name: "Solana", image: "" };
  const key = quoteMintPk.toBase58();
  const cat = await fetchQuoteCatalog().catch(() => new Map());
  const c = cat.get(key);
  const info = await connection.getParsedAccountInfo(quoteMintPk);
  const decimals = info.value?.data?.parsed?.info?.decimals ?? c?.decimals ?? 6;
  const tokenProgram = info.value?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const known = key === PUMP_MINT ? { ticker: "PUMP", name: "Pump" } : null; // the catalog 403s from servers
  return { mint: key, isSol: false, tokenProgram, decimals, symbol: c?.ticker || known?.ticker || `${key.slice(0, 4)}…${key.slice(-4)}`, name: c?.name || "", image: c?.image || "" };
}

/// The coin's curve: quote mint (normalized), creator, the tax (creatorFeeBps), graduation.
export async function loadCurve(mint) {
  const bc = await online.fetchBondingCurve(new PublicKey(mint));
  const quoteMintPk = isSolQuote(bc.quoteMint) ? new PublicKey(WSOL_MINT) : bc.quoteMint;
  return {
    bondingCurve: bc, quoteMintPk, creator: bc.creator.toBase58(), complete: Boolean(bc.complete),
    taxBps: Number(bc.creatorFeeBps?.toString?.() ?? 0), isHolderReward: Boolean(bc.isHolderReward),
    tokenTotalSupply: bc.tokenTotalSupply,
  };
}

// ------------------------------------------------------ pump.fun public data
const FRONTEND = "https://frontend-api-v3.pump.fun";
const SWAP_API = "https://swap-api.pump.fun";
const UA = { accept: "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36" };

/// Coin info in pump.fun's frontend shape. pump.fun removed `GET /coins/<mint>` from
/// frontend-api-v3 (404 for every mint since late Sep 2026), so DexScreener is the
/// fallback — it indexes pump.fun curves (dexId "pumpfun") and PumpSwap pools
/// ("pumpswap") within seconds of the first trade. Mapped to the same field names.
let coinInfoSource = "";
export async function fetchCoinInfo(mint) {
  try {
    const res = await fetch(`${FRONTEND}/coins/${mint}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (res.ok) { coinInfoSource = "pump.fun"; return res.json(); }
  } catch { /* fall through */ }
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`coins/${mint}: pump.fun 404 and dexscreener → ${res.status}`);
  const pairs = (await res.json()).filter((p) => p.chainId === "solana" && p.baseToken?.address === mint);
  if (!pairs.length) throw new Error(`coins/${mint}: not on pump.fun's API nor on DexScreener yet (no trades?)`);
  const pool = pairs.find((p) => p.dexId === "pumpswap");
  const curve = pairs.find((p) => p.dexId === "pumpfun");
  const main = pool || curve || pairs[0];
  const priceUsd = Number(main.priceUsd || 0);
  if (coinInfoSource !== "dexscreener") { coinInfoSource = "dexscreener"; console.log(`[pumpfun] coin info via DexScreener (pump.fun's /coins/<mint> is gone)`); }
  return {
    mint, name: String(main.baseToken?.name || "").trim(), symbol: String(main.baseToken?.symbol || "").trim(),
    image_uri: main.info?.imageUrl || "", description: "",
    usd_market_cap: priceUsd * 1e9,                    // pump.fun's convention: price × the 1B mint supply
    price_usd: priceUsd,
    complete: pool ? true : undefined,                 // unknown on a curve pair — the on-chain curve decides
    pump_swap_pool: pool ? pool.pairAddress : "",
    created_timestamp: Number((curve || main).pairCreatedAt || 0),
    reply_count: 0, source: "dexscreener",
  };
}

/// interval: "1m" | "5m" | "15m" | "1h" — prices already in USD
export async function fetchCandles(mint, interval, createdTsMs, limit = 500) {
  const url = `${SWAP_API}/v2/coins/${mint}/candles?interval=${interval}&limit=${limit}&currency=USD&createdTs=${createdTsMs}`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`candles → ${res.status}`);
  return res.json();
}

export async function fetchTrades(mint, limit = 50) {
  const res = await fetch(`${SWAP_API}/v2/coins/${mint}/trades?limit=${limit}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`trades → ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : (json.trades ?? json.data ?? []);
}

// -------------------------------------------------------- metadata on IPFS
export async function uploadIpfs({ name, symbol, description, imageBuffer, imageMime, twitter, telegram, website }) {
  const form = new FormData();
  form.append("file", new Blob([imageBuffer], { type: imageMime }), "coin.png");
  form.append("name", name);
  form.append("symbol", symbol);
  form.append("description", description || "");
  if (twitter) form.append("twitter", twitter);
  if (telegram) form.append("telegram", telegram);
  if (website) form.append("website", website);
  form.append("showName", "true");
  const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form, headers: { "user-agent": UA["user-agent"] } });
  if (!res.ok) throw new Error(`IPFS upload failed (${res.status}): ${await res.text()}`);
  return (await res.json()).metadataUri;
}

// ------------------------------------------------- token balance / burn
export async function tokenBalanceRaw(owner, mint, programId) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, programId);
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch { return 0n; }
}


/// Token balance with a few retries — right after a buy the RPC can still return the old (zero) balance.
export async function tokenBalanceRawSettled(owner, mint, programId, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const v = await tokenBalanceRaw(owner, mint, programId);
    if (v > 0n) return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return tokenBalanceRaw(owner, mint, programId);
}

/// Balance of the quote asset in UI units (SOL or the token).
export async function quoteBalance(owner, quote) {
  if (quote.isSol) return (await connection.getBalance(new PublicKey(owner))) / LAMPORTS;
  return Number(await tokenBalanceRaw(owner, quote.mint, quote.tokenProgram)) / 10 ** quote.decimals;
}
export const toRaw = (ui, decimals) => BigInt(Math.floor(ui * 10 ** decimals));
export const fromRaw = (raw, decimals) => Number(raw) / 10 ** decimals;

/// Burn an exact raw amount, capped at what the wallet holds. Never "everything in the wallet":
/// the engine wallet is usually the creator wallet and may carry a bag that is not the engine's to burn.
export async function burnAmount({ wallet, mint, programId, amountRaw }) {
  const mintPk = new PublicKey(mint);
  const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, programId);
  const held = await tokenBalanceRaw(wallet.publicKey.toBase58(), mint, programId);
  const amount = BigInt(amountRaw) > held ? held : BigInt(amountRaw);
  if (amount <= 0n) return { sig: "", amount: 0n };
  const instructions = [createBurnCheckedInstruction(ata, mintPk, wallet.publicKey, amount, DECIMALS, [], programId)];
  const sig = await sendTx({ instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 80_000 });
  return { sig, amount };
}

// ------------------------------------------------------------- creator fees
function vaultPdas(creatorPk) {
  const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creatorPk.toBuffer()], PUMP_PROGRAM_ID);
  const [ammVaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creatorPk.toBuffer()], PUMP_AMM_PROGRAM_ID);
  return { creatorVault, ammVaultAuth };
}

// pump-sdk 4.x for the v3 creator-fee bucket + fee-sharing distribution in a custom-pair quote
// (the pinned 2.x predates both: distribute fails 6095 CreatorFeesNotSwept, see coina)
const V4 = require("pump-sdk-v4");
const onlineV4 = new V4.OnlinePumpSdk(connection);
const sdkV4 = new V4.PumpSdk();
export const feeSharingConfigPda = (mint) => V4.feeSharingConfigPda(new PublicKey(mint));

/// creator fees v3 trades left on the curve itself, waiting for `sweep_creator_fee` (raw quote units)
export async function curveCreatorBucket(mint) {
  try { const bc = await onlineV4.fetchBondingCurve(new PublicKey(mint)); return BigInt((bc.creatorFee ?? 0).toString()); } catch { return 0n; }
}
async function sweepIx(mint, payer) {
  const bc = await onlineV4.fetchBondingCurve(new PublicKey(mint));
  return sdkV4.sweepCreatorFeeInstruction({ payer, mint: new PublicKey(mint), creator: bc.creator, quoteMint: bc.quoteMint, quoteTokenProgram: bc.quoteMint && !isSolQuote(bc.quoteMint) ? await onlineV4.fetchQuoteTokenProgram(bc.quoteMint) : undefined });
}

/// Unclaimed creator fees owed to `creator` (a wallet, or a fee-sharing config PDA) in the quote asset,
/// raw units: curve vault + PumpSwap vault (+ with `mint`, the curve bucket not swept yet).
export async function creatorVaultBalancesRaw(creator, quote, mint = null) {
  const creatorPk = new PublicKey(creator);
  const bucket = mint ? await curveCreatorBucket(mint) : 0n;
  if (quote.isSol) {
    const bn = await online.getCreatorVaultBalanceBothPrograms(creatorPk);
    const total = BigInt(bn.toString()) + bucket;
    return { bonding: total, amm: 0n, bucket, total };
  }
  const quoteMint = new PublicKey(quote.mint);
  const { creatorVault, ammVaultAuth } = vaultPdas(creatorPk);
  const read = async (owner) => {
    try { return BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(quoteMint, owner, true, quote.tokenProgram))).value.amount); }
    catch { return 0n; }
  };
  const [bonding, ammv] = await Promise.all([read(creatorVault), read(ammVaultAuth)]);
  return { bonding: bonding + bucket, amm: ammv, bucket, total: bonding + ammv + bucket };
}

/// Instructions that move the whole unclaimed creator fees into the creator's wallet / quote ATA.
export async function claimInstructions(creatorPk, quote, claimable, feePayer = creatorPk, mint = null) {
  const pre = mint && claimable.bucket > 0n ? [await sweepIx(mint, feePayer)] : [];
  if (quote.isSol) return [...pre, ...(await online.collectCoinCreatorFeeInstructions(creatorPk))];
  const quoteMint = new PublicKey(quote.mint);
  const ata = getAssociatedTokenAddressSync(quoteMint, creatorPk, false, quote.tokenProgram);
  const ixs = [...pre, createAssociatedTokenAccountIdempotentInstruction(feePayer, ata, creatorPk, quoteMint, quote.tokenProgram)];
  if (claimable.total > 0n) ixs.push(...(await online.collectCoinCreatorFeeV2Instructions(creatorPk, quoteMint, quote.tokenProgram, feePayer)));
  return ixs;
}

export async function claimCreatorFees(wallet, quote, claimable, mint = null) {
  const instructions = await claimInstructions(wallet.publicKey, quote, claimable, wallet.publicKey, mint);
  if (instructions.length === 0) return { sig: "" };
  const sig = await sendTx({ instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 300_000 });
  return { sig };
}

// ------------------------------------------------------------- fee sharing
/// The coin's on-chain fee-sharing config, or null while it still pays a plain creator.
export async function readSharing(mint) {
  const pda = feeSharingConfigPda(mint);
  const info = await connection.getAccountInfo(pda).catch(() => null);
  if (!info) return null;
  const cfg = sdkV4.decodeSharingConfig(info);
  return {
    address: pda.toBase58(), adminRevoked: Boolean(cfg.adminRevoked),
    shareholders: (cfg.shareholders || []).map((x) => ({ address: x.address.toBase58(), shareBps: Number(x.shareBps?.toString?.() ?? x.shareBps) })),
  };
}

/// Permissionless distribution of a fee-sharing coin's fees to every shareholder, in the quote asset
/// (distribute_creator_fees_v2 for custom pairs), curve/pool sweeps included. The engine pays the tx.
export async function distributeSharedFees(wallet, mint, quote) {
  const opts = { payer: wallet.publicKey };
  if (!quote.isSol) { opts.quoteMint = new PublicKey(quote.mint); opts.quoteTokenProgram = new PublicKey(quote.tokenProgram); }
  const { instructions } = await onlineV4.buildDistributeCreatorFeesInstructions(new PublicKey(mint), opts);
  const sig = await sendTx({ instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 500_000 });
  return { sig };
}

// -------------------------------------------------------------- curve buy
/// How many tokens `quoteAmountRaw` of the quote buys on the curve right now (fees included).
export async function estimateCurveBuy(mint, quote, quoteAmountRaw) {
  const { global, feeConfig } = await pumpGlobals();
  const bc = await online.fetchBondingCurve(new PublicKey(mint));
  if (bc.complete) return null;
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: new BN(quoteAmountRaw.toString()), quoteMint: isSolQuote(bc.quoteMint) ? PublicKey.default : bc.quoteMint });
  return Number(amount.toString()) / 10 ** DECIMALS;
}

/// ONE buy of the coin on the bonding curve, paying `quoteAmountRaw` of the quote asset.
export async function curveBuy({ wallet, mint, quote, quoteAmountRaw, programId }) {
  const mintPk = new PublicKey(mint);
  const { global, feeConfig } = await pumpGlobals();
  const st = await online.fetchBuyState(mintPk, wallet.publicKey, programId, quote.isSol ? undefined : new PublicKey(quote.mint));
  if (st.bondingCurve.complete) throw new Error("graduated");
  // the SDK adds `slippage` on top of quoteAmount as the max cost — size the buy so that max never
  // exceeds the budget (a sniper moving the curve between quote and send otherwise ends in InsufficientFunds)
  const slipBps = Math.round(config.rules.slippagePct * 100);
  const quoteAmount = new BN(quoteAmountRaw.toString()).muln(10_000).divn(10_000 + slipBps);
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: quoteAmount, quoteMint: st.quoteMint });
  const common = { global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: mintPk, user: wallet.publicKey, amount, slippage: config.rules.slippagePct, tokenProgram: programId };
  const instructions = quote.isSol
    ? await sdk.buyInstructions({ ...common, solAmount: quoteAmount })
    : await sdk.buyV2Instructions({ ...common, quoteAmount, quoteTokenProgram: quote.tokenProgram });
  const sig = await sendTx({ instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 400_000 });
  return { sig, expectedTokens: amount };
}

export async function isGraduated(mint) {
  try {
    const bc = await online.fetchBondingCurve(new PublicKey(mint));
    return Boolean(bc.complete);
  } catch { return null; }
}

// --------------------------------------------- post-graduation buys (PumpSwap)
/// ONE buy on the coin's canonical PumpSwap pool, paying `quoteAmountRaw` of the quote asset.
export async function pumpswapBuy({ wallet, mint, quote, quoteAmountRaw, pool }) {
  const mintPk = new PublicKey(mint);
  const poolPk = pool ? new PublicKey(pool) : canonicalPumpPoolPda(mintPk, quote.isSol ? undefined : new PublicKey(quote.mint));
  const state = await amm.swapSolanaState(poolPk, wallet.publicKey);
  const instructions = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(quoteAmountRaw.toString()), config.rules.slippagePct);
  const sig = await sendTx({ instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 400_000 });
  return { sig, pool: poolPk.toBase58() };
}

/// Fallback route: Jupiter, paying with the quote asset (WSOL for SOL).
export async function jupiterBuy({ wallet, mint, quote, quoteAmountRaw }) {
  const bps = Math.round(config.rules.slippagePct * 100);
  const quoteRes = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${quote.mint}&outputMint=${mint}&amount=${quoteAmountRaw}&slippageBps=${bps}`, { signal: AbortSignal.timeout(15_000) });
  if (!quoteRes.ok) throw new Error(`jupiter quote → ${quoteRes.status}`);
  const q = await quoteRes.json();
  const swapRes = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
    }),
  });
  if (!swapRes.ok) throw new Error(`jupiter swap → ${swapRes.status}: ${await swapRes.text()}`);
  const { swapTransaction } = await swapRes.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return { sig };
}

/// Swap native SOL → `outMint` inside `wallet` (used by the launcher to fund a dev buy in the quote asset).
export async function jupiterSwapSolTo({ wallet, outMint, lamports }) {
  const bps = Math.round(config.rules.slippagePct * 100);
  const quoteRes = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${WSOL_MINT}&outputMint=${outMint}&amount=${lamports}&slippageBps=${bps}`, { signal: AbortSignal.timeout(15_000) });
  if (!quoteRes.ok) throw new Error(`jupiter quote → ${quoteRes.status}: ${await quoteRes.text()}`);
  const q = await quoteRes.json();
  const swapRes = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } } }),
  });
  if (!swapRes.ok) throw new Error(`jupiter swap → ${swapRes.status}: ${await swapRes.text()}`);
  const { swapTransaction } = await swapRes.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return { sig, outAmount: BigInt(q.outAmount || 0) };
}

// ------------------------------------------------------------- launching
/// The tax gate as pump.fun has it on chain right now.
export async function taxConfig() {
  const { global } = await pumpGlobals();
  return { enabled: Boolean(global.creatorFeeConfigurable), maxBps: Number(global.maxConfigurableCreatorFeeBps?.toString?.() ?? 0), holderRewards: Boolean(global.isHolderRewardEnabled) };
}

/// create_v2 for a coin paired with SOL (the default), or quoted in a custom pair — optionally
/// carrying its own creator fee (`taxBps`, custom pairs only; pump.fun ignores it on SOL/USDC).
/// SDK 2.x appends the remaining accounts a custom pair needs by itself.
export async function buildCreate({ mint, name, symbol, uri, creator, user, quote, taxBps = 0 }) {
  if (quote.isSol) return sdk.createV2Instruction({ mint, name, symbol, uri, creator, user, mayhemMode: false });
  const quoteMint = new PublicKey(quote.mint);
  return sdk.createV2Instruction({ mint, name, symbol, uri, creator, user, mayhemMode: false, quoteMint, quoteTokenProgram: quote.tokenProgram, creatorFeeBps: taxBps ? new BN(taxBps) : undefined });
}

export async function simulateCreate({ mint, name, symbol, uri, payer, quote, taxBps = 0 }) {
  const ix = await buildCreate({ mint, name, symbol, uri, creator: payer, user: payer, quote, taxBps });
  return simulate({ instructions: [ix], payer, computeUnits: 400_000 });
}

export { getBuyTokenAmountFromSolAmount, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, BN };

// ------------------------------------------------------------- holders + airdrop
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/// The largest real holders of `mint`: wallets owned by the system program (the curve, pools and other
/// program-owned accounts are left out), each with an existing token account. `exclude` drops owners.
export async function topHolders(mint, { exclude = [], limit = 20 } = {}) {
  const mintPk = new PublicKey(mint);
  let rows;
  try {
    const res = await fetch(`${FRONTEND}/coins/top-holders/${mint}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`top-holders -> ${res.status}`);
    const list = (await res.json()).topHolders || [];
    if (!list.length) throw new Error("top-holders -> empty");
    const programId = await mintProgramId(mint);
    rows = list.map((h) => ({ owner: String(h.address), account: getAssociatedTokenAddressSync(mintPk, new PublicKey(h.address), true, programId).toBase58(), amountRaw: BigInt(Math.floor(Number(h.amount) * 10 ** DECIMALS)) })).filter((r) => r.amountRaw > 0n);
    // the token account must exist on chain: a holder keeping the coin elsewhere is skipped
    const accounts = await connection.getMultipleAccountsInfo(rows.map((r) => new PublicKey(r.account)));
    rows = rows.filter((_, i) => accounts[i]);
  } catch (err) {
    console.warn(`[holders] pump.fun list unavailable (${String(err.message).slice(0, 80)}), asking the RPC`);
    // every token account of the mint, straight from the token program (works on RPCs without getTokenLargestAccounts)
    const programId = await mintProgramId(mint);
    const list = await connection.getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }], dataSlice: { offset: 32, length: 77 } });
    rows = list.map((a) => ({ account: a.pubkey.toBase58(), owner: new PublicKey(a.account.data.subarray(0, 32)).toBase58(), amountRaw: a.account.data.readBigUInt64LE(32), frozen: a.account.data[76] === 2 }))
      .filter((r) => r.amountRaw > 0n && !r.frozen).sort((a, b) => (a.amountRaw > b.amountRaw ? -1 : a.amountRaw < b.amountRaw ? 1 : 0)).slice(0, 60);
  }
  if (!rows.length) return [];
  const owners = await connection.getMultipleAccountsInfo(rows.map((r) => new PublicKey(r.owner)));
  const skip = new Set(exclude.filter(Boolean));
  return rows.filter((r, i) => !skip.has(r.owner) && (!owners[i] || owners[i].owner.toBase58() === SYSTEM_PROGRAM)).slice(0, limit);
}

/// Split `amountRaw` pro rata (by balance) between `holders` and send it, 8 transfers per transaction.
/// Returns what actually left the wallet; a failed batch stops the loop and is reported.
export async function airdropTokens({ wallet, mint, programId, amountRaw, holders }) {
  const mintPk = new PublicKey(mint);
  const from = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, programId);
  const total = holders.reduce((acc, h) => acc + h.amountRaw, 0n);
  if (total === 0n || amountRaw <= 0n) return { sigs: [], sentRaw: 0n, recipients: 0, error: null };
  const shares = holders.map((h) => ({ ...h, share: (amountRaw * h.amountRaw) / total })).filter((h) => h.share > 0n);
  const sigs = []; let sentRaw = 0n, recipients = 0, error = null;
  for (let i = 0; i < shares.length; i += 8) {
    const batch = shares.slice(i, i + 8);
    const instructions = batch.map((h) => createTransferCheckedInstruction(from, mintPk, new PublicKey(h.account), wallet.publicKey, h.share, DECIMALS, [], programId));
    try {
      sigs.push(await sendTx({ instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 40_000 * batch.length }));
      sentRaw += batch.reduce((acc, h) => acc + h.share, 0n); recipients += batch.length;
    } catch (err) { error = String(err.message).slice(0, 160); break; }
  }
  return { sigs, sentRaw, recipients, error };
}

/// Send an exact raw amount of `mint` to another wallet, creating its token account if it has none.
export async function sendTokens({ wallet, mint, programId, to, amountRaw }) {
  if (BigInt(amountRaw) <= 0n) return "";
  const mintPk = new PublicKey(mint), toPk = new PublicKey(to);
  const from = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, programId);
  const dest = getAssociatedTokenAddressSync(mintPk, toPk, true, programId);
  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, dest, toPk, mintPk, programId),
    createTransferCheckedInstruction(from, mintPk, dest, wallet.publicKey, BigInt(amountRaw), DECIMALS, [], programId),
  ];
  return sendTx({ instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 120_000 });
}

/// Close the wallet's token account for `mint` when it exists and is empty; the rent goes back to the
/// wallet. An engine that airdrops should not sit on the holder list between rounds: holder maps draw
/// every recipient as a cluster around the sender for as long as the sender still has a token account.
/// Returns the signature, or "" when there was nothing to close (no account, or it still holds tokens).
export async function closeEmptyTokenAccount({ wallet, mint, programId }) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey, false, programId);
  const info = await connection.getAccountInfo(ata);
  if (!info) return "";
  if (info.data.readBigUInt64LE(64) !== 0n) return ""; // amount: u64 at offset 64 of a token account
  return sendTx({ instructions: [createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, [], programId)], payer: wallet.publicKey, signers: [wallet], computeUnits: 30_000 });
}
