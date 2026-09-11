# Experimental design

What the study measures, how the grid is built, and what counts as a result.

The companion documents are [`mechanics.md`](./mechanics.md) — every protocol
rule, keyed to its whitepaper section — and [`findings.md`](./findings.md) —
the places where the whitepaper had to be interpreted.

---

## The unit of result

**Every cell is a paired run, and nothing is ever reported as a level alone.**

A single world's `totalBranches` on day 90 is not a result. It depends on the
seed, on the cohort mix, on how the market happened to move. The result is what
that number would have been had the same world, with the same seed and the same
agents making the same decisions, not revoked anybody.

So each point of the grid runs three arms of the same world:

| Arm | What differs | Built |
| --- | --- | --- |
| `control` | `revocationEnabled: false`. No charter is ever reportable; dormant charters keep their branches and keep accruing. | always |
| `treatment` | Whitepaper §10 as written. | always |
| `noPayoutSell` | As treatment, except the 30% revocation payout is minted into the banker's wallet and never sold. | always |
| `transferable` | As treatment, plus §12's one-way transfer switch thrown on the configured day. | only when `charterTransfersEnabledAtDay` is set |

and reports three differences:

- `delta` = **treatment − control**: everything revocation does.
- `deltaNoPayout` = **treatment − noPayoutSell**: the part of it caused
  specifically by payout selling reaching the pool.
- `deltaTransfer` = **transferable − treatment**: what a seat market bought, or
  cost.

`noPayoutSell − control` is the remainder: the branch destruction, the burn and
the redistribution, with the sell pressure taken out.

The fourth arm is conditional on purpose. It is a third more compute on every
cell it applies to, so a cell that leaves the transfer switch at its `null`
default builds three arms and costs exactly what it cost before §12 existed —
asserted in `study.spec.ts`. The other three arms are forced soulbound whatever
the cell says, so the switch is the only thing the fourth arm varies.

This only means anything because the arms do not share a random sequence. Each
agent draws from its own stream, derived from `(seed, agentId, purpose)`, so a
draw one arm takes and another does not shifts nothing else. `study.spec.ts` in
the protocol package asserts it directly: with an all-Committed cohort, where
neither revocation nor a seat market can matter, all four arms produce
byte-identical histories.

---

## Attribution replay

`attributableCut` separates "`m` fell after day 31" from "`m` fell **because
of** revocation payout selling".

```
dropTreatment    = m(day 31) − m(day 45)   in the treatment arm
dropNoPayoutSell = m(day 31) − m(day 45)   in the noPayoutSell arm
attributableCut  = (dropTreatment − dropNoPayoutSell) / dropTreatment
```

When `m` did not fall in the treatment arm there is no cut to attribute and the
metric is null rather than zero. `mDropTreatment` and `mDropNoPayoutSell` are
reported alongside it, so the complementary reading — the share of the fall
that *survives* when payout sells are replayed at zero — is one subtraction
away. The prompt's phrasing admits both readings; the metric named
`attributableCut` is the one that matches its name, and both numbers are in
every stored result.

---

## The axes

`licensesPerDay` is listed first deliberately. The day-31 probe found the
dormant cohort holding 8.2% of branches against 30.2% of charters, and the
reason is arithmetic: the auction sells at most 100 licenses a day, at most
three to any one charter, so in thirty days the active cohort cannot dilute the
dormant one faster than that however much it wants to. The whitepaper leaves
the number unspecified, and it turns out to bound the answer to the study's
central question. It is an axis, not a default. See
[F-03](./findings.md#f-03--the-daily-license-supply-is-unspecified-and-it-bounds-the-answer).

| Axis | Levels | Why |
| --- | --- | --- |
| `licensesPerDay` | 25, 50, 100, 200, 400, unlimited | How fast the active cohort can dilute the dormant one before the wave. |
| `perCharterLicenseLimit` | 1, 3, 5, 10 | The other half of that constraint. |
| `dormancyRate` | 0.05, 0.15, 0.30, 0.45, 0.60 | Tourist + Lost share: the size of the wave. |
| `demandRegime` | none, bear, chop, mild, bull | The market the wave lands in. |
| `hunterGasCostEth` | 0, 0.25x, 0.5x, 1x, 2x, 4x, 8x the **calibrated boundary** | Whether ghosts are worth collecting at all. |
| `hunterCount` | 1, 4, 16 | Contention, and so how high the gas war goes. |
| `maxReportsPerHour` | 1, 4, 24 | Throughput: a day or a month to clear the wave. |
| `dormancyBountySource` | `revocationFee`, `bankerShare` | Both readings of [F-01](./findings.md#f-01--the-revocation-split-sums-to-102). |
| `payoutSellFraction` | 0.0, 0.5, 1.0 | How much of the 30% payout reaches the pool. |
| `payoutSellOverHours` | 1, 24, 168 | A block or a trickle. |
| `epochDays` | 0.25, 1, 3 | How often policy reacts. §5 never fixes the epoch. |
| `cutRaiseRatio` | 1:1, 2:1, 3:1, 5:1 | Whether the policy asymmetry is what ratchets `m` down. |
| `charterTransfersEnabledAtDay` | null, 0, 7, 15, 21, 25, 29, 31, 45 | When §12's one-way switch is thrown. Below 30 pre-empts the wave; above 30 only catches the tail. |
| `postTransferCharterLimit` | 1, unlimited | Whether §6's one-charter-per-wallet limit survives transferability ([F-05](./findings.md#f-05--does-one-charter-per-wallet-survive-the-transfer-switch)). Held at a switch day of 15, since the limit is inert while charters are soulbound. |

`Infinity` is not a valid `licensesPerDay` — the daily inventory is an integer
count — so "unlimited" is 1,000,000, more than 1000 charters could buy at the
three-a-day cap.

A ratio of 1:1 is off-spec: §5 says `cutStep > raiseStep` "by design". It is
included as the control for whether the asymmetry is doing the work. See
[F-04](./findings.md#f-04--is-cutstep--raisestep-a-protocol-rule-or-a-default).

### Locating the gas boundary rather than assuming it

Whether a bounty is worth a transaction depends on the dormant balances a cell
actually produces and on the pool price on the day the wave lands — neither
known in advance, both moving with every other axis. A fixed gas sweep would
sit entirely on one side of the profitability floor in most cells.

So `calibrateGasBoundary` runs the cell once with hunters switched off, reads
what the wave is holding on the thirty-first day, and solves for the gas price
at which the median ghost's bounty exactly stops clearing a hunter's margin:

```
boundary = bounty(median dormant balance) x poolPrice / marginRequired
```

The axis is then swept relative to that, so every cell is swept **across its
own boundary**. For the baseline cell:

```
$ pnpm study calibrate
  reportable charters     308
  median dormant balance  9876.6 tokens
  pool price              3.374e-5 ETH/token
  break-even gas          0.0033 ETH
  default gas             0.0020 ETH
```

The whitepaper-default parameterisation sits just *inside* profitability, at
about 0.6x the boundary. That is a narrow margin, and it is why the gas axis
matters.

### Demand regimes

Not a whitepaper concept: outside demand is the rest of the market, and it has
to be modelled because without any buy-side flow `F_n` is negative in every
epoch, `m` pins to its floor on the second day, and a study about what a
revocation wave does to issuance has nothing left to measure.

A regime is a setting of `config.externalDemand`, driving `RandomTrader`. Each
trader, each tick: acts with probability `activityWad`; if acting, buys with
probability `buyBiasWad` else sells; sizes the trade uniformly in
`[1, maxTradeFraction x balance]` where balance is its ETH on a buy and its
$STANDARD on a sell.

| Regime | Traders | Acts/tick | Buy prob | Max trade | Intent |
| --- | --- | --- | --- | --- | --- |
| `none` | 0 | — | — | — | No outside flow. `m` collapses to its floor. |
| `bear` | 6 | 1/8 | 0.35 | 4% | Persistent net outflow. |
| `chop` | 6 | 1/3 | 0.50 | 12.5% | Mean-zero direction, high variance. |
| `mild` | 6 | 1/8 | 0.55 | 4% | Slight net inflow. **The baseline.** |
| `bull` | 6 | 1/8 | 0.70 | 4% | Persistent net inflow. |

**`chop` is the one to get right.** Its buy probability is exactly 0.5, so the
*direction* of flow is a fair coin; its trades are three times the size and
nearly three times as frequent as the other regimes'. That makes `F_n` a
high-variance series with no directional drift — and §5's policy rule is
asymmetric. A sequence of epochs that averages to nothing in flow does not
average to nothing in `m`: down-steps are three times the size of up-steps, so
the multiplier ratchets downward under pure noise. The whitepaper does not
discuss this. `cutRaiseRatio` is in the grid as its control.

Each trader starts with ETH and no $STANDARD, so early sells are bounded by
what it has already bought. The regimes describe the *tendency* of flow, not a
guaranteed net; `epochClosed` events carry the realised `F_n` per epoch so the
realised regime can be checked against the intended one.

---

## The four suites

A full factorial over these axes is millions of cells and most of it is noise.
The design is staged instead.

| Suite | What | Seeds | Purpose |
| --- | --- | --- | --- |
| **A. `baseline`** | The baseline cell | ≥ 200 | Central estimate with a bootstrap CI, and the seed-variance noise band everything else is judged against. |
| **B. `ofat`** | One factor at a time, everything else at baseline | ≥ 50/level | The sensitivity ranking: which axes move the answer. |
| **C. `factorial`** | Full factorial over the top three axes from B | ≥ 30/cell | Interactions. |
| **D. `sample`** | Latin hypercube over the whole space | 1/cell, ≥ 1500 cells | Supports an honest global claim: "N cells showed a difference, M did not". |

Suite C takes its axes from suite B's result, not from an assumption, so
`buildFactorial` requires them explicitly:
`pnpm study run factorial --axes=dormancyRate,licensesPerDay,demandRegime`.

**Suite C has not been run, and is not planned before the mint.** At the
measured throughput it is 150 cells x 30 seeds = 4,500 runs, about three and a
half hours, and suite B's ranking already answers the question it was there to
answer — which axes move the result. It stays in the design because the
interactions are worth having eventually, not because they are pending.

Cells are deduplicated by **effective configuration**, so the several axes that
include the baseline as one of their levels resolve to one cell rather than a
dozen. That takes OFAT from 48 nominal cells to 40 real ones.

---

## Materiality

Suite D exists to say how many cells in the whole space showed a difference.
That claim is worth exactly as much as the threshold behind it, so the
threshold is stated once, in `packages/study/src/materiality.ts`, and nothing
is allowed to decide it implicitly.

**A cell shows a difference on a metric when the observed delta clears both:**

1. **A noise band.** With nothing changed at all, the delta still varies from
   seed to seed. Suite A measures that variation directly across 200 seeds of
   the baseline cell. The band is `1.96 x sd_A(metric)`. A suite-D cell runs
   one seed, so this is the right comparison: whether a single draw is
   distinguishable from a single draw of the baseline, not whether a mean is.

2. **An absolute floor.** A move can be statistically clean and economically
   nothing. The floors are per metric, in the metric's own units:

   | Metric | Floor | Reasoning |
   | --- | --- | --- |
   | `yieldPerBranchPerDay*` | 1 token/day | Below that a branch's yield has not meaningfully changed for anyone holding one. |
   | `totalBranches*`, `liveChartersD90` | 1 | Branches and charters are integers. |
   | token totals (`circulating`, burns, `mintedToWallets`) | 100,000 tokens | 0.01% of the hard cap. |
   | `multiplier*` | 0.01 | One raise step: the smallest move policy itself can make in an epoch. |
   | `multiplierIntegralD31to90` | 0.6 | That step sustained across the whole 60-day window. |
   | `poolPriceD90` | 2e-7 ETH/token | 1% of the opening spot price. |
   | `revocationPayoutVolume` | 0.1 ETH | |
| `seatMarketEthVolumeD90` | 0.1 ETH | Same as pool volume: below that the blind spot is not worth naming. |
| `cumulativeSeatSalesD90`, `branchesTransferredD90` | 1 | Seats and branches are integers. |
| `concentrationHHID90` | 0.001 | On a thousand equal holders the index is 0.001, so this is one holder's worth. |
| `largestHolderBranchShareD90` | 0.001 | One tenth of one percent of all branches. |

Requiring **both** means the study never reports a difference that is merely
detectable, and never one that is merely large but indistinguishable from seed
noise. A reader who disagrees with a floor changes it in `materiality.ts` and
re-runs `study report` — no stored result has to be touched.

---

## Reproducing any number

Every figure in the published report carries the command that regenerates it:

```
pnpm study replay <cellId> <seed>
```

That re-runs exactly that point with the full hourly history retained and
prints the whole metric table for all three arms. If a stored result exists for
that point, `replay` compares against it and says whether it matched.

Cell ids are content-derived: a 128-bit hash of the horizon and of **how the
resolved configuration differs from the defaults**. Resolved, so that spelling
out a default value does not create a new cell; the horizon, because a stored
result depends on it; and only the *difference*, so that adding a new
configuration field cannot move the id of any cell that leaves it alone.

That last property was learned the hard way. Hashing the whole resolved config
meant that adding the seat market to the protocol orphaned every result the
study had already computed — stored data held hostage to a schema addition.
The one-time repair is `pnpm study migrate`, which re-points stored results at
their current ids by joining on the cell label recorded in the manifest.

The trade: if a *default value* changes, ids do not change even though results
would. That is what `provenance.protocolVersion` and the manifest's git SHA are
for — a default is a change to the model, and a change to the model is a change
to the code.

```
pnpm study cells <suite>      # every cell id and what it is
pnpm study report <suite>     # aggregate the stored JSONL into tables
pnpm study calibrate          # locate the profitability boundary
```

## What the transfer arm reports

Only when the fourth arm was built:

| Metric | What it is |
| --- | --- |
| `revocationsAvoided` | Revocations in the treatment arm that did not happen in the transferable one. |
| `valueRescuedBySale` | The revocation-fee burn that did not happen, in tokens: value §10 would have destroyed. |
| `sellerProceedsEth` | What sellers actually received, in ETH. |
| `seatMarketEthVolume` | The same number seen as a blind spot: capital `F_n` never observed ([F-06](./findings.md#f-06--a-seat-sale-is-capital-entering-the-economy-that-the-flow-signal-cannot-see)). |
| `branchesKeptAlive` | `totalBranches` in the transferable arm less the treatment arm. **Frequently negative**, and the name flatters it: it is a net of two opposing effects — branches saved from revocation, less branches never bought because the seat changed hands and the buyer does not expand. Read it with `revocationsAvoided` and `seatSales`, never alone. |
| `seatSales`, `concentrationHHI`, `largestHolderBranchShare` | Volume, and what accumulation does to it ([F-05](./findings.md#f-05--does-one-charter-per-wallet-survive-the-transfer-switch)). |

## Storage

- `runs/<suite>/<cellId>.jsonl` — one line per seed, streamed as it finishes.
  Nothing accumulates in memory.
- `runs/manifest.json` — per suite: cell specs, config hashes, protocol
  version, git SHA, machine, horizon, gas boundary, start and end time, total
  runs.
- **Daily** snapshots are persisted; hourly ones are computed and folded into
  accumulators as they are produced, then dropped. The full hourly history is
  retained only by `study replay` and for the exemplar seeds the report charts.
- Resuming is automatic: a suite reads back which `(cell, seed)` pairs already
  have a line and skips them. The unit of lost work is one seed. A torn final
  line — the signature of a process killed mid-write — is ignored and re-run.
