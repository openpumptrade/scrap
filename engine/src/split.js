/// Fee split math. Pure functions over bigint lamports / raw token units, no I/O, so it can be tested.
///
/// Every claim of creator fees is divided into four buckets (basis points, they sum to 10000):
///   lp        SOL sent to the liquidity reserve wallet
///   treasury  SOL sent to the meme treasury wallet
///   airdrop   SOL that buys the coin, which is then sent to the top holders
///   burn      SOL that buys the coin, which is then burned
/// The airdrop and burn shares are spent in ONE market buy; the tokens it returns are divided
/// between the two in the same proportion.

/// Normalise the configured shares. A SOL bucket without a destination wallet folds into burn, so a
/// half-configured engine burns more instead of stranding SOL.
export function effectiveBps({ lpBps, treasuryBps, airdropBps, burnBps, lpWallet, treasuryWallet }) {
  const lp = lpWallet ? Math.max(0, Math.floor(lpBps)) : 0;
  const treasury = treasuryWallet ? Math.max(0, Math.floor(treasuryBps)) : 0;
  const airdrop = Math.max(0, Math.floor(airdropBps));
  if (lp + treasury + airdrop > 10_000) throw new Error("fee split: lp + treasury + airdrop exceed 100%");
  return { lp, treasury, airdrop, burn: 10_000 - lp - treasury - airdrop, configuredBurn: burnBps };
}

/// Divide a fresh claim between the buckets.
///   claimed  what the claim brought into the wallet
///   wallet   the wallet balance after the claim
///   reserve  SOL the engine keeps for transaction fees
///   ledger   {lp, treasury, buy}: lamports already earmarked and still sitting in the wallet
/// Only claimed fees are ever distributed. If the wallet is under its gas reserve, the claim tops the
/// reserve up first; SOL someone sent to the wallet by hand is never spent.
export function allocate({ claimed, wallet, reserve, ledger, bps }) {
  const earmarked = ledger.lp + ledger.treasury + ledger.buy;
  const free = wallet - earmarked - reserve; // what is left once the reserve and old earmarks are covered
  let distributable = claimed < free ? claimed : free;
  if (distributable < 0n) distributable = 0n;
  const lp = (distributable * BigInt(bps.lp)) / 10_000n;
  const treasury = (distributable * BigInt(bps.treasury)) / 10_000n;
  const buy = distributable - lp - treasury; // airdrop + burn, plus the rounding dust
  return { distributable, add: { lp, treasury, buy }, ledger: { lp: ledger.lp + lp, treasury: ledger.treasury + treasury, buy: ledger.buy + buy } };
}

/// Divide the tokens one buy returned between the burn and the airdrop.
export function splitBought(boughtRaw, bps) {
  const both = BigInt(bps.airdrop + bps.burn);
  if (boughtRaw <= 0n || both === 0n) return { airdropRaw: 0n, burnRaw: boughtRaw > 0n ? boughtRaw : 0n };
  const airdropRaw = (boughtRaw * BigInt(bps.airdrop)) / both;
  return { airdropRaw, burnRaw: boughtRaw - airdropRaw };
}
