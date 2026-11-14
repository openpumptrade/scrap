import test from "node:test";
import assert from "node:assert/strict";
import { effectiveBps, allocate, splitBought } from "../src/split.js";

const bps = effectiveBps({ lpBps: 5000, treasuryBps: 2000, airdropBps: 2000, burnBps: 1000, lpWallet: "lp", treasuryWallet: "tr" });
const SOL = 1_000_000_000n;
const zero = { lp: 0n, treasury: 0n, buy: 0n };

test("default shares are 50 / 20 / 20 / 10", () => {
  assert.deepEqual({ lp: bps.lp, treasury: bps.treasury, airdrop: bps.airdrop, burn: bps.burn }, { lp: 5000, treasury: 2000, airdrop: 2000, burn: 1000 });
});

test("a bucket without a wallet folds into burn", () => {
  const b = effectiveBps({ lpBps: 5000, treasuryBps: 2000, airdropBps: 2000, burnBps: 1000, lpWallet: "", treasuryWallet: "" });
  assert.deepEqual({ lp: b.lp, treasury: b.treasury, airdrop: b.airdrop, burn: b.burn }, { lp: 0, treasury: 0, airdrop: 2000, burn: 8000 });
});

test("a claim is divided and nothing is lost", () => {
  const r = allocate({ claimed: SOL, wallet: SOL + 10_000_000n, reserve: 10_000_000n, ledger: zero, bps });
  assert.equal(r.add.lp, 500_000_000n);
  assert.equal(r.add.treasury, 200_000_000n);
  assert.equal(r.add.buy, 300_000_000n);
  assert.equal(r.add.lp + r.add.treasury + r.add.buy, SOL);
});

test("the claim tops up the gas reserve first", () => {
  const r = allocate({ claimed: 50_000_000n, wallet: 50_000_000n, reserve: 10_000_000n, ledger: zero, bps });
  assert.equal(r.distributable, 40_000_000n);
});

test("SOL sent to the wallet by hand is never distributed", () => {
  const r = allocate({ claimed: 0n, wallet: 5n * SOL, reserve: 10_000_000n, ledger: zero, bps });
  assert.equal(r.distributable, 0n);
  assert.deepEqual(r.ledger, zero);
});

test("old earmarks are protected from a new claim", () => {
  const ledger = { lp: 1_000_000n, treasury: 400_000n, buy: 600_000n };
  const r = allocate({ claimed: 1_000_000n, wallet: 13_000_000n, reserve: 10_000_000n, ledger, bps });
  assert.equal(r.distributable, 1_000_000n);
  assert.equal(r.ledger.lp + r.ledger.treasury + r.ledger.buy, 3_000_000n);
});

test("bought tokens: two thirds airdrop, one third burn, no dust lost", () => {
  const p = splitBought(3_000_001n, bps);
  assert.equal(p.airdropRaw, 2_000_000n);
  assert.equal(p.burnRaw, 1_000_001n);
});
