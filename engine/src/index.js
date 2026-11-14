import { config, mode } from "./config.js";
import { ensureSchema, acquireEngineLock } from "./db.js";
import { ensureCommunitySchema } from "./community.js";
import { coin, loadCoin, startTracker } from "./tracker.js";
import { startDiver, stopDiver } from "./diver.js";
import { startApi, live } from "./api.js";

/// SCRAP. Every 3 minutes the creator fees are claimed and split: liquidity, airdrop, treasury, burn.
/// One process: market/pot tracker + diver + API + page.

async function main() {
  await ensureSchema();
  await ensureCommunitySchema();
  startApi();
  if (!config.mint) { console.log("[boot] no TOKEN_MINT — serving the page in 'not started' mode"); return; }
  // the CA can be set before the coin exists on-chain: wait for its curve, then switch on by itself
  for (let i = 0; ; i++) {
    try { await loadCoin(); break; }
    catch (err) {
      if (i % 20 === 0) console.log(`[boot] ${config.mint} not on-chain yet (${String(err.message).slice(0, 80)}) — checking every 15 s`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  console.log(`[boot] ${coin.name} ($${coin.symbol}) · mint ${coin.mint} · paired with ${coin.quote.symbol}${coin.taxBps ? ` · tax ${coin.taxBps / 100}%` : ""} · creator ${coin.creator} · mode ${mode()} · dryRun ${config.dryRun} · scheduler ${config.schedulerEnabled}`);
  live.started = true;
  await startTracker();
  await acquireEngineLock(); // a redeploy overlaps the old container: never two engines on one wallet
  await startDiver();
}

// a redeploy sends SIGTERM: stop scheduling, let a dive in flight finish, then leave
process.on("SIGTERM", async () => { console.log("[boot] SIGTERM: finishing the work in flight"); await stopDiver(); process.exit(0); });

main().catch((err) => { console.error("[boot] fatal:", err); process.exit(1); });
