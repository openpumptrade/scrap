import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { effectiveBps } from "./split.js";

/// SCRAP engine config. $SCRAP is a plain pump.fun coin paired with SOL (no tax). The engine wallet
/// is the creator wallet (or a 100% fee-sharing shareholder). Every DIVE_INTERVAL_SEC the engine
/// claims the creator fees, market-buys $SCRAP with them in ONE tx and burns exactly what that buy
/// brought in. The same engine also runs custom pairs (quoted in $PUMP or another asset) with a tax.

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const bool = (v, d) => (v === undefined || v === "" ? d : String(v).toLowerCase() === "true");

/// bs58 (Phantom/Solflare export) or a JSON byte array. Anything else (for
/// example the PASTE_PRIVATE_KEY_HERE placeholder) keeps the engine in watch mode.
export function parseKeypair(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
    const bytes = bs58.decode(s);
    if (bytes.length !== 64) return null;
    return Keypair.fromSecretKey(bytes);
  } catch { return null; }
}

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/scrap",
  rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",

  brand: {
    name: process.env.BRAND_NAME || "SCRAP",
    siteUrl: (process.env.SITE_URL || "http://localhost:4000").replace(/\/$/, ""),
    twitter: process.env.BRAND_TWITTER || "",
    telegram: process.env.BRAND_TELEGRAM || "",
  },

  // the coin — one engine per mint
  mint: (process.env.TOKEN_MINT || "").trim(),
  // shown on the page before the coin exists (the real rate is read from the curve once live)
  plannedTaxBps: num(process.env.TAX_BPS, 0),

  // the creator wallet of the coin (the one pump.fun pays the creator fees to).
  // With its key the engine claims + buys + burns ("bot" mode); without it the
  // engine only watches the pot and records dry dives ("watch" mode).
  wallet: parseKeypair(process.env.WALLET_PRIVATE_KEY),
  // watch mode only: read the pot of this address instead of the coin's creator
  walletAddress: (process.env.WALLET_ADDRESS || "").trim(),
  dryRun: bool(process.env.DRY_RUN, false),
  // master kill switch — API and page stay up, nothing moves
  schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true),

  rules: {
    intervalSec: num(process.env.DIVE_INTERVAL_SEC, 180),   // one dive every 3 minutes
    // thresholds in USD so the same engine works whatever the coin is quoted in (SOL, or a custom pair)
    minClaimUsd: num(process.env.MIN_CLAIM_USD, 0.1),        // don't bother claiming dust
    minBuyUsd: num(process.env.MIN_BUY_USD, 0.25),           // a dive smaller than this rolls into the next one
    gasReserveSol: num(process.env.GAS_RESERVE_SOL, 0.01),   // SOL kept for tx fees (only spent on buys when the quote IS SOL)
    minGasSol: num(process.env.MIN_GAS_SOL, 0.003),          // below this the engine refuses to fire (token-quoted coins need SOL for fees)
    slippagePct: num(process.env.SLIPPAGE_PCT, 5),
    minTransferSol: num(process.env.MIN_TRANSFER_SOL, 0.002), // LP / treasury shares below this wait in the wallet (covers rent on a new account)
    airdropHolders: num(process.env.AIRDROP_HOLDERS, 20),     // the airdrop share goes to this many top holders, pro rata
  },
  pollSec: num(process.env.POLL_SEC, 10),
  priorityMicroLamports: num(process.env.PRIORITY_MICRO_LAMPORTS, 100_000),
};

export const mode = () => (config.wallet ? "bot" : "watch");

if (!config.mint) console.warn("[config] TOKEN_MINT not set — the page runs in 'not started' mode");
if (!config.wallet) console.warn(`[config] WALLET_PRIVATE_KEY ${(process.env.WALLET_PRIVATE_KEY || "").trim() ? "is not a valid key" : "not set"} — watch mode: dry dives, nothing moves`);
if (!config.schedulerEnabled) console.warn("[config] SCHEDULER_ENABLED=false — kill switch ON: no claims, no buys, no burns");

// Where every claim of creator fees goes (basis points). Defaults follow the original brief:
// 50% liquidity / 20% community airdrop / 20% meme treasury / 10% burn.
config.lpWallet = (process.env.LP_WALLET || "").trim();
config.treasuryWallet = (process.env.TREASURY_WALLET || "").trim();
config.split = effectiveBps({
  lpBps: num(process.env.SPLIT_LP_BPS, 5000),
  treasuryBps: num(process.env.SPLIT_TREASURY_BPS, 2000),
  airdropBps: num(process.env.SPLIT_AIRDROP_BPS, 2000),
  burnBps: num(process.env.SPLIT_BURN_BPS, 1000),
  lpWallet: config.lpWallet, treasuryWallet: config.treasuryWallet,
});
if (!config.lpWallet) console.warn("[config] LP_WALLET not set — the liquidity share is burned instead");
if (!config.treasuryWallet) console.warn("[config] TREASURY_WALLET not set — the treasury share is burned instead");
