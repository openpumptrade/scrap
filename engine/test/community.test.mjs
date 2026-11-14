import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { streakOf, badgeFor, messageFor, verifySignature, weekOf, WEEK } from "../src/community.js";

test("a streak counts consecutive weeks up to the current one", () => {
  assert.equal(streakOf([10, 11, 12], 12), 3);
  assert.equal(streakOf([10, 11, 12], 13), 3, "not lost on the first day of a new week");
  assert.equal(streakOf([10, 11, 12], 14), 0, "a missed week resets it");
  assert.equal(streakOf([8, 10, 11], 11), 2);
  assert.equal(streakOf([], 5), 0);
});

test("badges follow the streak", () => {
  assert.equal(badgeFor(0), null);
  assert.equal(badgeFor(1), "Scavenger");
  assert.equal(badgeFor(3), "Dumpster Diver");
  assert.equal(badgeFor(4), "Trash Panda");
  assert.equal(badgeFor(20), "Scrap Lord");
});

test("weeks are 7 days", () => { assert.equal(weekOf(WEEK * 3 + 5), 3); });

test("a signature only verifies for the exact message and wallet", () => {
  const kp = Keypair.generate(), other = Keypair.generate();
  const message = messageFor({ action: "dive-vote", week: 2966, data: "burn", ts: 1794644000 });
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  assert.equal(verifySignature({ wallet: kp.publicKey.toBase58(), message, sig }), true);
  assert.equal(verifySignature({ wallet: other.publicKey.toBase58(), message, sig }), false);
  assert.equal(verifySignature({ wallet: kp.publicKey.toBase58(), message: message.replace("burn", "donate"), sig }), false);
  assert.equal(verifySignature({ wallet: kp.publicKey.toBase58(), message, sig: "garbage" }), false);
});
