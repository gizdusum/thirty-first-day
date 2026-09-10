# The Thirty-First Day

The Standard Reserve mints 1000 genesis charters at once, and its dormancy rule
(whitepaper §10) revokes any charter whose owner has not interacted for thirty
days. Because the whole cohort's clock starts at the same instant, the first
revocations cannot arrive as a trickle: on the thirty-first day every genesis
banker who has not touched their charter becomes reportable simultaneously, and
each revocation destroys branches, burns half of a 70% fee, mints the other
thirty percent into a wallet that had no reason to hold it, and redistributes
the rest across the branches that remain — which raises everyone else's yield,
which raises the license floor price, which moves the auction, while the newly
minted supply meets a pool whose depth the protocol itself has been quietly
buying. This repository asks what that day actually does: how much of the wave
fires at once, how far the resolution fee (§9) climbs as the bank drains, where
the net flow signal (§4) sends the fee engine while it happens, and whether the
protocol comes out of it more or less concentrated than it went in. It is a
Monte Carlo study, so the question is really about the distribution of
outcomes, not a single path.

## Layout

| Path | What it is |
| --- | --- |
| `packages/protocol` | The model. Deterministic, zero runtime dependencies, MIT. |
| `packages/study` | The Monte Carlo runner and the experimental design. |
| `docs/mechanics.md` | Every rule implemented, keyed to its whitepaper section, plus the study layers built on top. Read this first. |
| `docs/experimental-design.md` | The axes, the four suites, the demand regimes, and what counts as a difference. |
| `docs/findings.md` | Places where the whitepaper had to be interpreted, and what the model does about each. |
| `docs/performance.md` | What the model cost, what was optimised, and what it bought. |
| `packages/protocol/src/invariants.spec.ts` | The protocol invariants, asserted at every tick over randomized configs and seeds. |
| `packages/protocol/src/study.spec.ts` | The claims the study depends on: the cohort, the hunters, the wave, and the arms. |
| `packages/study/src/study.spec.ts` | The runner's guarantees: stable ids, exact replay, pool equivalence, resumability. |

## Running

```sh
pnpm install
pnpm test
```

Requires Node 20+ and pnpm.

## Running the study

```sh
pnpm study calibrate            # locate the profitability boundary numerically
pnpm study cells ofat           # every cell id and what it varies
pnpm study run baseline         # suite A: the central estimate
pnpm study run ofat             # suite B: the sensitivity ranking
pnpm study report ofat          # aggregate the stored JSONL into tables
pnpm study replay <cellId> <seed>   # reproduce exactly one point, in full
```

Every figure in the published report carries its own `replay` command. Someone
who doubts a chart reproduces the exact point in one line — that is the
study's credibility mechanism, not a convenience.

## Method

The engine is deterministic, so every result is a **paired difference** rather
than a comparison across configurations. `runArms(config, seed)` builds three
worlds from the same seed that differ in exactly one setting each: the control
never revokes a dormant charter, and a third arm revokes but never lets the 30%
payout reach the pool — which is how the study separates "issuance fell after
day 31" from "issuance fell *because of* payout selling". Each agent draws from its own random stream, derived
from `(seed, agentId, purpose)`, so an extra draw in one arm does not shift
every later draw in it — without that the two histories would diverge for
reasons unrelated to revocation and the comparison would be meaningless. The
test suite asserts it directly.

Two things the model deliberately refuses to assume:

- **The dormant cohort's share of branches.** It emerges. Charters that never
  buy a license still hold the one branch they minted with, while committed
  bankers have expanded — so on day 31 the dormant cohort is around 30% of live
  charters and about 8% of live branches, and it is the second number that
  decides how far issuance per branch moves.
- **That dormant charters get cleaned up.** Reporting costs gas, and below some
  dormant balance the 2% bounty never covers it. Those charters keep their
  branches and dilute everyone else indefinitely.

## Status

Protocol model, cohort, bounty-hunter economy, three-arm counterfactual, and
the Monte Carlo runner with suites A–D. Suites A and B have been run; C and D
are built but not yet executed. No report site yet — that comes next.
