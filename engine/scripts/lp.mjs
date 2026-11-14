#!/usr/bin/env node
/// Run one liquidity round by hand: buy, deposit into the PumpSwap pool, burn the LP tokens.
///   node scripts/lp.mjs --key .keys/lp.json [--max-sol 0.05]
/// The key file is a JSON byte array. Every transaction is simulated before it is sent.
import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config.js";
import { runLiquidity } from "../src/liquidity.js";

const a = process.argv.slice(2), opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
const wallet = opt("--key") ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(opt("--key"), "utf8")))) : config.lpKeypair;
if (!wallet) { console.error("pass --key <file> or set LP_WALLET_PRIVATE_KEY"); process.exit(1); }
const res = await runLiquidity({ wallet, maxSol: opt("--max-sol") ? Number(opt("--max-sol")) : Infinity });
console.log(JSON.stringify(res, null, 2));
process.exit(0);
