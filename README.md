<p align="center"><img src="logo.png" alt="SCRAP, an ASCII raccoon holding a SOL trash can" width="260"></p>

<h1 align="center">$SCRAP · the Solana Trash Panda</h1>

<p align="center"><i>One degen's trash is another degen's treasury.</i></p>

<p align="center">
  <a href="https://solanatrashpanda.fun">Website</a> ·
  <a href="https://solanatrashpanda.fun/dashboard">Dashboard</a> ·
  <a href="https://solanatrashpanda.fun/community">Community</a> ·
  <a href="https://x.com/soltrashpanda_">X</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#the-split">The split</a> ·
  <a href="#run-the-engine">Run the engine</a> ·
  <a href="#safety-rules-baked-in">Safety rules</a>
</p>

<p align="center"><code>7x8HCyf5Z3JYWXmC7p6C4w11Hw6JAXFEiZy6PCDBpump</code></p>

---

## Origin

We asked an AI one question:

> If you could launch a meme coin on Solana, what would it be like? And throw in a picture too.

It answered with a full brief: **$SCRAP, the Solana Trash Panda**. A self-aware raccoon astronaut that digs
through the dumpster and burns what it finds, an ASCII sketch of the mascot, a tagline and a rule set
(1B supply, 0% tax, no presale, no VC, a 50 / 20 / 20 / 10 allocation, "just memes and transparent burns").

```
    /\_/\      <- laser eyes: ON
   ( o.o )         $SCRAP
    > ^ <
   /  |  \      holding a glowing
  /___|___\     Solana validator trash can
    [SOL]         (neon purple/green)
   /     \
  /_/   \_\
```

This repository is that brief, shipped: the website and the engine that runs it.

## How it works

$SCRAP is a standard pump.fun coin paired with SOL. Every trade pays pump.fun creator fees, and all of
them are routed to the engine wallet. On a fixed 3-minute clock the engine runs one cycle, called a **dive**:

1. **Claim.** All unclaimed creator fees (bonding curve and PumpSwap) go to the engine wallet.
2. **Split.** The claim is divided into four buckets. The liquidity and treasury shares leave as SOL in
   one transaction.
3. **Buy.** The airdrop and burn shares go into one market buy of $SCRAP on the venue the coin trades on
   (curve, PumpSwap, Jupiter as a fallback).
4. **Airdrop and burn.** The tokens that buy returned are divided: the airdrop share is sent to the top
   holders pro rata, the rest is burned on-chain.

The engine has no sell path. A pot too small to be worth a transaction rolls into the next dive.

## The split

The brief wrote its allocation as a token split. A fair launch has no tokens to allocate, so the same
numbers are applied to every claim of creator fees.

| Share | Bucket | What happens |
|---|---|---|
| 50% | Liquidity | SOL sent to the liquidity reserve wallet `33S14NsHf4nahin48kLz8g7MnqwRWGdUcMCch5nfjvTu`. After graduation the engine buys $SCRAP with about half of it, deposits both sides into the PumpSwap pool and burns the LP tokens. |
| 20% | Community airdrop | Buys $SCRAP and sends it to the top 20 holders, pro rata. |
| 20% | Meme treasury | SOL sent to the treasury wallet `GGyze3VwA1C9otGajyqeM5YJJoPNcXmrKmWCMDqcFo96`. |
| 10% | Burn | Buys $SCRAP and burns it. |

Engine wallet: `9uhoRkqugdA5mUk1Z7xjZ4exh5Y9AhMpin9SRV6vCYKA`. It keeps a small SOL reserve for
transaction fees and nothing else.

## Community rounds

The treasury is spent by its holders, one UTC week at a time (Thursday 00:00 to Thursday 00:00).

- **Weekly Dumpster Dive.** Holders vote burn or donate on 25% of the treasury. Burn: the treasury buys
  $SCRAP and burns it. Donate: the slice is sent to `DONATION_WALLET`; while no shelter wallet is set it
  simply stays in the treasury.
- **Recycle a Rug.** Holders name a dead memecoin and roast it (one roast per wallet per week), holders
  vote, and the treasury buys $SCRAP with 10% of its balance and sends it to the winner.
- **Scrap Badge.** A streak of consecutive weeks in which a wallet voted or roasted: Scavenger (1),
  Dumpster Diver (2), Trash Panda (4), Scrap Lord (8).

How it is kept honest:

- A wallet takes part by signing a plain text message. Nothing is sent on-chain by the voter.
- A wallet needs `COMMUNITY_MIN_HOLD` tokens (default 100,000). A vote weighs what the wallet holds, and
  at settlement it counts as the lower of the balance when voting and the balance when the week closes.
- The engine settles a closed week once. It marks the week before paying, so a crash never pays twice.

Stated plainly:

- The treasury is one wallet whose key the engine holds, not a multisig.
- No shelter wallet is configured, so a "donate" result is not paid out yet.
- Badges are tracked in the engine's database. They are not minted as compressed NFTs.
- Roasts are user content. They are escaped, length-limited and can be hidden with `ADMIN_TOKEN`.

## Spec vs. shipped

| From the AI brief | Status |
|---|---|
| 1,000,000,000 supply, 0% tax | At launch (plain SOL pair) |
| Mint and freeze authority revoked | At launch (pump.fun default) |
| No presale, no VC | At launch (fair launch on the curve) |
| Transparent burns | Engine: 10% of every claim, each transaction in the dive log |
| 50 / 20 / 20 / 10 allocation | Engine: applied to creator fees instead of supply |
| Fast, cheap airdrops | Engine: 20% of every claim to the top holders |
| LP burned | Engine: the liquidity share is deposited into the pool after each dive and its LP tokens are burned |
| "Recycle a rug" roast contest | Live: weekly, prize bought by the treasury |
| Weekly Dumpster Dive vote | Live: burn is automatic, donate waits for a shelter wallet |
| Scrap Badge cNFT | Partly: streaks and tiers are tracked, the cNFT mint is not built |

## Repository layout

```
index.html             the landing page (static, deployed as is)
dashboard.html         live numbers: fees, split, wallets, every dive and liquidity round
community.html         weekly vote, roast contest, badges (wallet signs a message)
art/                   the pages that render logo.png / og.png from the ASCII mascot
engine/                the engine: Node 20+, Express, Postgres
  src/config.js        every setting, read from the environment
  src/split.js         the fee split math (pure functions)
  src/diver.js         the dive: claim, split, one buy, airdrop, measured burn
  src/liquidity.js     the liquidity round: buy, deposit into the PumpSwap pool, burn the LP tokens
  src/community.js     weekly vote, roast contest, streaks, signed actions, settlement
  src/pumpfun.js       pump.fun / PumpSwap / Jupiter transactions, holders, airdrop
  src/tracker.js       price, supply and fee-pot tracking
  src/api.js           JSON API + serves engine/public
  scripts/launch.mjs   create the coin (dry run by default)
  scripts/verify.mjs   simulate the engine's transaction paths, no keys
  scripts/lp.mjs       run one liquidity round by hand
  test/                unit tests for the split math
Dockerfile             one image: engine + page
```

## Run the engine

Requires Node 20+ and a Postgres database.

```bash
cd engine
npm install
cp .env.example .env      # set TOKEN_MINT, DATABASE_URL, RPC_URL
npm test                  # split math
npm start                 # http://localhost:4000
```

Without `WALLET_PRIVATE_KEY` the engine runs in **watch mode**: it tracks the coin and records dry dives,
and nothing moves on-chain. With the key of the wallet that receives the creator fees it runs in **bot
mode** and executes real dives.

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_MINT` | empty | The coin. Empty serves the page in "not started" mode. |
| `WALLET_PRIVATE_KEY` | empty | Engine wallet key (bs58 or JSON array). Empty means watch mode. |
| `SPLIT_LP_BPS` | `5000` | Share of every claim sent to `LP_WALLET`, in basis points. |
| `SPLIT_TREASURY_BPS` | `2000` | Share sent to `TREASURY_WALLET`. |
| `SPLIT_AIRDROP_BPS` | `2000` | Share that buys the coin for the holder airdrop. |
| `SPLIT_BURN_BPS` | `1000` | Informational: burn always gets whatever the other three leave. |
| `LP_WALLET`, `TREASURY_WALLET` | empty | Destination wallets. A share without a wallet is burned instead. |
| `AIRDROP_HOLDERS` | `20` | How many top holders receive the airdrop. |
| `MIN_TRANSFER_SOL` | `0.002` | LP and treasury shares below this wait in the wallet. |
| `LP_WALLET_PRIVATE_KEY` | empty | Key of `LP_WALLET`. With it the engine deposits the reserve and burns the LP tokens; without it the reserve only accumulates. |
| `LP_MIN_DEPOSIT_SOL` | `0.1` | A smaller reserve waits for the next round. |
| `LP_RESERVE_SOL` | `0.02` | SOL the reserve wallet keeps for fees and account rent. |
| `TREASURY_WALLET_PRIVATE_KEY` | empty | Key of `TREASURY_WALLET`. With it the engine settles each community week; without it votes are only collected. |
| `DONATION_WALLET` | empty | Where a "donate" result is sent. Empty keeps it in the treasury. |
| `COMMUNITY_MIN_HOLD` | `100000` | Tokens a wallet must hold to vote or roast. |
| `VOTE_SLICE_BPS`, `ROAST_PRIZE_BPS` | `2500`, `1000` | Share of the treasury behind the weekly vote and the roast prize. |
| `ADMIN_TOKEN` | empty | Lets `POST /api/community/hide` hide a roast. |
| `DIVE_INTERVAL_SEC` | `180` | Seconds between dives. |
| `MIN_CLAIM_USD` | `0.1` | Do not claim dust. |
| `MIN_BUY_USD` | `0.25` | A smaller buy budget rolls into the next dive. |
| `GAS_RESERVE_SOL` | `0.01` | SOL the engine never distributes or spends on buys. |
| `SLIPPAGE_PCT` | `5` | Slippage for the buy. |
| `SCHEDULER_ENABLED` | `true` | Kill switch. `false` keeps the API up and moves nothing. |
| `DRY_RUN` | `false` | Force dry dives even with a key. |
| `DATABASE_URL` | local Postgres | Dive history and engine state. |
| `RPC_URL` | public mainnet | Use a paid RPC in production. |

The split applies to SOL-paired coins. A coin quoted in another asset keeps the simple path: everything
buys and burns.

### API

| Route | Returns |
|---|---|
| `GET /api/token` | Coin, market, fee pot, split, bucket totals, next dive time |
| `GET /api/dives` | Dive history with claim, split, buy, airdrop and burn signatures |
| `GET /api/chart` | Price candles plus the dives to plot on them |
| `GET /api/trades` | Recent trades, engine buys flagged |
| `GET /api/liquidity` | Liquidity rounds with buy, deposit and LP burn signatures |
| `GET /api/community` | This week's tallies, roasts, rules and past results |
| `GET /api/community/me?wallet=` | A wallet's balance, votes, streak and badge |
| `POST /api/community/vote`, `/roast`, `/roast-vote` | Signed actions |
| `GET /api/health` | Mode, scheduler state, next dive time |

### Launch script

```bash
node scripts/launch.mjs --name "SCRAP" --symbol SCRAP --image public/logo.png   # dry run: simulates create_v2
node scripts/launch.mjs ... --live                                             # sends it
```

It is a dry run unless `--live` is passed. `--quote PUMP` creates a custom pair with a tax instead of a
plain SOL coin.

## Safety rules baked in

- **Only claimed fees are distributed.** SOL sent to the engine wallet by hand is never split or spent.
  If the wallet is under its gas reserve, a claim tops the reserve up first.
- **Earmarks are tracked.** What each bucket is owed is stored in the database, so a failed transfer or
  a restart does not lose or double-spend a share.
- **Measured disposal only.** The engine reads its token balance before the buy and only ever airdrops
  or burns the difference. It never acts on "everything in the wallet", so tokens that were already
  there are not touched.
- **A failed airdrop burns.** Everything a buy returns is owed to the burn until the airdrop has actually
  left the wallet. Tokens are never stranded in the engine wallet.
- **Liquidity is one-way.** The reserve wallet buys and deposits; the LP tokens are burned in the same
  round, so nobody, the team included, can withdraw that liquidity. A round that fails halfway is
  finished by the next one.
- **Watch mode by default.** No key, no transactions.
- **Kill switch.** `SCHEDULER_ENABLED=false` stops everything without taking the site down.
- **No sell path.** There is no code that sells $SCRAP.

## Website

The site is a single static `index.html`. It reads `/api/token` and `/api/dives` when an engine is
reachable on the same origin and falls back to the 3-minute wall clock when it is not. Set the contract
address and the X link in the `CONFIG` object at the top of the script block.

## Disclaimer

$SCRAP is a memecoin with no intrinsic value and no expectation of financial return. Nothing here is
financial advice. The software is provided as is, under the MIT license. Read the code before you run it
with a funded wallet.
