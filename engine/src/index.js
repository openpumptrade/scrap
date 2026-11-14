import { config, mode } from "./config.js";
import { ensureSchema } from "./db.js";
import { coin, loadCoin, startTracker } from "./tracker.js";
import { startDiver } from "./diver.js";
import { startApi, live } from "./api.js";

/// SCRAP. Every 3 minutes 100% of the fees → one buy of $SCRAP → burned.
/// One process: market/pot tracker + diver + API + page.

async function main() {
  await ensureSchema();
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
  await startDiver();
}

main().catch((err) => { console.error("[boot] fatal:", err); process.exit(1); });
