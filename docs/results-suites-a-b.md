# Results: suites A and B

What the runner found. Suites C and D are built but have not been run.

Every number here is reproducible in one command. The baseline cell is
`4296209191d71e99`; any of its 200 seeds regenerates a point:

```
pnpm study replay 4296209191d71e99 1000000
```

Two instruments, and they answer different questions:

- **The bootstrap CI on the mean** says whether the *average* effect is
  distinguishable from zero across 200 seeds. That is the right instrument for
  suite A's central estimate.
- **The noise band** (`1.96 x sd` of the per-seed distribution) says whether a
  *single* run's effect is distinguishable from a single run of the baseline.
  That is the right instrument for suite D, where each cell is one seed, and it
  is the materiality threshold defined in
  [`experimental-design.md`](./experimental-design.md#materiality).

A result can be clearly nonzero on the first and invisible on the second. Both
are reported, and where they disagree the disagreement is the finding.

---

## Suite A — the central estimate

Baseline: whitepaper defaults, `mild` demand, 90-day horizon, 200 seeds,
three arms each. `treatment − control`.

| Metric | Mean | 95% CI | per-seed sd | noise band |
| --- | --- | --- | --- | --- |
| `yieldPerBranchPerDayD45` | **+8.73** tokens/day | [+7.43, +9.98] | 9.60 | 18.82 |
| `yieldPerBranchPerDayD90` | **+1.39** tokens/day | [−0.44, +3.17] | 13.12 | 25.72 |
| `totalBranchesD45` | **−316.9** | [−317.7, −316.1] | 6.14 | 12.04 |
| `totalBranchesD90` | **−356.1** | [−358.1, −353.9] | 15.29 | 29.96 |
| `liveChartersD90` | **−364.1** | [−365.1, −363.1] | 7.21 | 14.12 |
| `circulatingD90` | +1.625e6 tokens | [1.582e6, 1.667e6] | 3.14e5 | 6.15e5 |
| `cumulativeBurnsD90` | +1.442e6 tokens | [1.436e6, 1.448e6] | 4.75e4 | 1e5 |
| `mintedToWalletsD90` | +1.660e6 tokens | [1.614e6, 1.706e6] | 3.41e5 | 6.68e5 |
| `burnsBySourceD90.revocationFee` | +1.400e6 tokens | [1.396e6, 1.404e6] | 3.18e4 | 1e5 |
| `burnsBySourceD90.license` | +30,520 tokens | [26,540, 34,497] | 2.97e4 | 1e5 |
| `burnsBySourceD90.buyback` | +4,135 tokens | [2,709, 5,672] | 1.07e4 | 1e5 |
| `burnsBySourceD90.resolutionFee` | +7,202 tokens | [6,883, 7,541] | 2,342 | 1e5 |
| `multiplierMeanD31to90` | **−0.0242** | [−0.0329, −0.0154] | 0.064 | 0.126 |
| `multiplierIntegralD31to90` | **−1.451** x-days | [−1.974, −0.922] | 3.86 | 7.56 |
| `multiplierD31` | **0** (exactly) | [0, 0] | 0 | 0.01 |
| `multiplierD45` | −0.0284 | [−0.0378, −0.0194] | 0.070 | 0.137 |
| `poolPriceD90` | −5.79e-7 ETH/token | [−6.58e-7, −4.96e-7] | 5.96e-7 | 1.17e-6 |
| `revocationPayoutVolume` | +21.48 ETH | [21.37, 21.60] | 0.805 | 1.58 |

Treatment-only:

| | Mean | 95% CI | n |
| --- | --- | --- | --- |
| `revocations` | 364.1 | [363.1, 365.1] | 200 |
| `valueDestroyedByRevocation` | 1.400e6 tokens | [1.396e6, 1.404e6] | 200 |
| `valueReturnedToBankers` | 1.235e6 tokens | [1.231e6, 1.239e6] | 200 |
| `valueRedistributedToActives` | 1.400e6 tokens | [1.396e6, 1.404e6] | 200 |
| `bountiesPaid` | 82,350 tokens | [82,090, 82,613] | 200 |
| `hunterGasSpentEth` | 2.022 ETH | [2.005, 2.039] | 200 |
| `waveClearedOnDay` | 35.03 | [35.01, 35.06] | 200 |
| `ghostsNeverCollected.count` | 0.020 charters | [0.005, 0.040] | 200 |
| `attributableCut` | **31.9%** | [14.8%, 48.3%] | **171** |

`attributableCut` has n = 171, not 200: in 29 of the 200 seeds `m` did not fall
at all between day 31 and day 45, so there was no cut to attribute and the
metric is null rather than zero. That is itself a result — see the nulls below.

### Arm levels, for reference

| Metric | control | treatment |
| --- | --- | --- |
| `yieldPerBranchPerDayD45` | 143.0 [141.3, 144.7] | 151.7 [149.8, 153.6] |
| `yieldPerBranchPerDayD90` | 69.09 [67.24, 70.92] | 70.48 [68.42, 72.47] |
| `totalBranchesD45` | 3,877.9 | 3,561.0 |
| `totalBranchesD90` | 4,422.5 | 4,066.4 |

`totalBranchesD90` exceeds `totalBranchesD45` in **both** arms: the branch base
is still growing through the whole window. The wave is a step down in a rising
series, not a collapse.

### What suite A says

**The wave destroys 36% of charters and 8% of branches.** 364 of 1,000
charters revoked; 317 branches gone by day 45 against a control-arm mean of
3,877.9 [3,875.4, 3,880.4] — so **−36.4% of charters and −8.2% of branches**. The
gap between those two percentages is the whole mechanism: charters that never
buy a license still hold the one branch they minted with, while committed
bankers have expanded to ten. Nothing in the model sets that ratio — it is what
thirty days of behaviour produces, and it is why the shock to `N` is a fifth of
the shock to the charter count.

**The yield boost is real, and temporary.** Every surviving branch earns
+8.73 tokens/day more at day 45 — **+6.1%** on a control level of 143.0
[141.3, 144.7]. By day
90 the mean is +1.39 with a CI that crosses zero. The branches destroyed are
replaced: the auction keeps selling licenses, `totalBranches` recovers, and the
survivors' advantage is competed away within about two months.

**Issuance over the window is lower, not higher.** `multiplierIntegralD31to90`
is −1.45 multiplier-days, CI clear of zero. Fewer branches raise the yield per
branch, but the payout selling pushes `F_n` negative, which cuts `m`, which
lowers total issuance. The per-branch and aggregate effects point in opposite
directions, and the aggregate one is negative.

**About a third of that cut is payout selling specifically.**
`attributableCut` = 31.9% [14.8%, 48.3%]. The remaining two thirds is
everything else revocation does. The interval is wide — a third of the cut,
give or take a half of that third — but it is clear of both zero and one, so
neither "payout selling is the whole story" nor "payout selling is irrelevant"
survives.

**The hunters barely make money, and contention is why.** They spend 2.022 ETH
in gas to collect 82,350 tokens of bounties — about 2.8 ETH at the prevailing
price, so a gross margin of roughly 37% across the entire wave. That is
striking given each hunter refuses to submit unless the bounty is worth twice
its gas. The reconciliation is contention: 2.022 ETH over 364 landed reports is
0.0056 ETH per successful revocation against a base gas price of 0.002 — **2.8x
base per report that actually lands**, because in a contested hour every
submitter pays and only one is included, and the escalation raises the price
for all of them. A 2x margin rule at the individual level delivers a 1.37x
return at the system level. The whole of that gap is the gas war.

**The policy cannot react for two days, by construction.** `multiplierD31` is
exactly zero across all 200 seeds, with zero variance. The first revocations
land at tick 726 (day 30, hour 6), inside epoch 30 — but §5's slow lever reads
`signal_n = F_{n−1} + F_{n−2}`, so the epoch that closes at the end of day 31
is still deciding on flow from epochs 28 and 29, both entirely pre-wave. `m`
cannot move until day 32 at the earliest. That is the lag working exactly as
specified, and it means the protocol spends the first two days of the wave
blind to it.

---

## Suite B — the sensitivity ranking

2,000 three-arm runs across 40 cells, 50 seeds each, in 5,312 s at 0.37
runs/s. `treatment − control`, exactly as in suite A.

**Read `in bands` first.** The range across an axis is meaningless on its own;
what matters is how it compares to how much the metric moves from seed to seed
with nothing changed at all. An axis whose whole range fits inside one noise
band did not move the answer.

### Ranking: `yieldPerBranchPerDayD45` (noise band 18.82 tokens/day)

| Axis | Range | In bands | Low → high |
| --- | --- | --- | --- |
| `dormancyRate` | 44.02 | **2.3** | 0.05 → 0.60 |
| `licensesPerDay` | 27.57 | **1.5** | 100 → 25 |
| `demandRegime` | 10.48 | 0.6 | none → bull |
| `epochDays` | 9.93 | 0.5 | 0.25 → 3 |
| `hunterGasCostEth` | 8.69 | 0.5 | 2x → 1x boundary |
| `cutRaiseRatio` | 8.62 | 0.5 | 5:1 → 1:1 |
| `payoutSellFraction` | 4.42 | 0.2 | 1.0 → 0.0 |
| everything else | < 4 | ≤ 0.2 | |

### Ranking: `mintedToWalletsD90` (noise band 667,757 tokens)

| Axis | Range | In bands | Low → high |
| --- | --- | --- | --- |
| `dormancyRate` | 3.02e6 | **4.5** | 0.05 → 0.60 |
| `licensesPerDay` | 1.97e6 | **2.9** | 400 → 25 |
| `demandRegime` | 1.73e6 | **2.6** | none → bull |
| `hunterGasCostEth` | 1.65e6 | **2.5** | 2x → 1x boundary |
| `cutRaiseRatio` | 376,868 | 0.6 | 5:1 → 1:1 |
| `payoutSellFraction` | 164,414 | 0.2 | 1.0 → 0.0 |
| `maxReportsPerHour` | 76,949 | 0.1 | 4 → 1 |
| `payoutSellOverHours` | 65,638 | 0.1 | 1 → 24 |
| `dormancyBountySource` | 35,223 | 0.1 | bankerShare → revocationFee |
| `hunterCount` | 33,841 | 0.1 | 1 → 4 |
| `epochDays` | 28,906 | 0.0 | 3 → 0.25 |
| `perCharterLicenseLimit` | 3,940 | 0.0 | 3 → 1 |

### Ranking: `multiplierIntegralD31to90` (noise band 7.56 x-days)

| Axis | Range | In bands |
| --- | --- | --- |
| `dormancyRate` | 3.51 | 0.5 |
| `payoutSellFraction` | 1.81 | 0.2 |
| `demandRegime` | 1.70 | 0.2 |
| `hunterGasCostEth` | 1.70 | 0.2 |
| `licensesPerDay` | 1.50 | 0.2 |
| everything else | < 1 | ≤ 0.1 |

**Nothing clears a single noise band.** At single-seed resolution, no axis in
the grid moves the issuance integral detectably. Suite A found the *mean*
effect of revocation on it was clearly nonzero (−1.45 x-days, CI clear of
zero), but the seed-to-seed variance is four times larger than anything the
axes do to it. That is a null result, and it is as much a result as the two
rankings above.

### The three most surprising rows

**1. The profitability floor is a cliff, not a slope.**

| `hunterGasCostEth` | `mintedToWalletsD90` delta | wave cleared on day |
| --- | --- | --- |
| 0x boundary | 1.635e6 | 35.02 (n=50) |
| 0.25x | 1.635e6 | 35.02 (n=50) |
| 0.5x | 1.635e6 | 35.02 (n=50) |
| 1x | 1.647e6 | 35.28 (n=50) |
| **2x** | **0** | **never (n=0)** |
| 4x | 0 | never (n=0) |
| 8x | 0 | never (n=0) |

Between 1x and 2x of the calibrated boundary, the entire wave goes from fully
collected in five days to **never collected at all**. Not fewer revocations —
zero, in all 50 seeds. There is no partial regime. A protocol whose gas costs
drift up by a factor of two does not get a slower cleanup; it gets none, and
every dormant charter dilutes every active one indefinitely.

**2. `licensesPerDay` — a REDACTED parameter — moves the headline number by
2.7x.** Confirmed as F-03 predicted:

| `licensesPerDay` | `mintedToWalletsD90` delta |
| --- | --- |
| 25 | 3.129e6 |
| 50 | 2.209e6 |
| 100 (the default) | 1.635e6 |
| 200 | 1.334e6 |
| 400 | 1.164e6 |
| unlimited | 1.216e6 |

The whitepaper does not state this number, and it is the second-strongest lever
in the study — behind only how many bankers walk away, which is not a protocol
parameter at all.

**3. More licenses means *more* ghosts nobody collects.**

| `licensesPerDay` | `ghostsNeverCollected.count` |
| --- | --- |
| 25 | 0 |
| 50 | 0 |
| 100 | 0 |
| 200 | 0.12 |
| 400 | 0.24 |
| unlimited | 0.26 |

Backwards from the obvious reading, and the mechanism is a chain: more licenses
→ more branches → lower yield per branch → smaller dormant balances → a 2%
bounty that no longer covers gas. Loosening the auction to dampen the wave
quietly pushes the smallest ghosts below the profitability floor, where they
stay forever. The two REDACTED parameters interact, and not in the same
direction.

### Confirmations, and what is null

**The attribution replay behaves.** `attributableCut` scales cleanly with how
much of the payout actually reaches the pool — 0% at `payoutSellFraction` 0.0
(n=41), 8.4% at 0.5 (n=43), 32.5% at 1.0 (n=47). A dose-response that lands on
zero when the dose is zero is the best evidence available that the third arm is
measuring what it claims to.

**Null, stated as plainly as the large results:**

- **The whole `multiplierIntegralD31to90` ranking.** No axis moves it by one
  noise band.
- **`perCharterLicenseLimit`** is last or near-last on every metric — 0.0 noise
  bands on minted supply. The three-a-day cap does not bind; the daily
  inventory does.
- **`dormancyBountySource`** — both readings of F-01 — moves minted supply by
  35,223 tokens, 0.1 noise bands. The 102% ambiguity is real and worth
  resolving in the text, but it does not change what the study measures.
- **`hunterCount`** at 1, 4 and 16 moves minted supply 0.1 noise bands.
  Contention changes who pays the gas, not how many charters get collected.
- **`epochDays`** ranks fourth on day-45 yield (0.5 bands) and last but one on
  minted supply. How often policy reacts barely matters when the signal it
  reacts to is two epochs stale anyway.

### The top three axes for suite C

`dormancyRate`, `licensesPerDay`, `demandRegime` — first, second and third on
minted supply, and first, second and third on day-45 yield once
`hunterGasCostEth` is set aside as a threshold effect rather than a gradient.
Suite C is built but not run:

```
pnpm study run factorial --axes=dormancyRate,licensesPerDay,demandRegime
```

That is 5 x 6 x 5 = 150 cells at 30 seeds — 4,500 runs, about 3.4 hours at the
measured rate.

---

Suite B was defined and executed **before** whitepaper §12's seat market was
modelled, so it covers the twelve pre-transfer axes — 40 cells at 50 seeds
each, 2,000 three-arm runs. The two transfer axes
(`charterTransfersEnabledAtDay`, `postTransferCharterLimit`) were added to the
suite afterwards and have not been swept; they appear in `study cells ofat`
with no results, and `study run ofat` would extend the suite rather than redo
it. Nothing about the 40 cells already run changed: see
[the proof](#appendix-the-suites-were-not-disturbed) below.

---

---

## Appendix: provenance for these two suites

`runs/manifest.json` records `gitSha: unknown` for both suites, and that is
left as it stands rather than backfilled. Both ran before the repository's
first commit, so at the moment they executed there was no SHA to record.

The tree they ran against is `a018273` ("Protocol model, dormancy study and
Monte Carlo runner"), with the caveat that a handful of reporting-layer changes
landed between suite A finishing and that commit — the per-axis level join, the
JSONL string-escaping fix, and the CLI's `executeSuite` refactor. None of them
touches `runOne`, the protocol package, or the metrics, so no stored number
depends on them; but "the tree is byte-identical to what ran" would be a
slightly stronger claim than the truth, so it is not made.

Writing a SHA into a manifest after the fact is the precise thing provenance
exists to prevent, so it was not done. Every suite run from `a018273` onwards
records a real SHA.

---

## Appendix: the suites were not disturbed

Adding whitepaper §12's seat market added configuration fields, which changes
the resolved configuration of every cell in the study. That is exactly why cell
ids are derived from how a configuration *differs from the defaults* rather
than from the whole thing — but the check is worth running rather than
asserting:

```
$ pnpm tsx packages/study/scripts/untouched.ts

config hash of the resolved configuration
  recorded in a stored result      9c004dea90a536fd5eb10f20a4d00598
  now, minus this prompt's fields  9c004dea90a536fd5eb10f20a4d00598
  identical                        YES

the fields this prompt added, and their values in the baseline
  charterTransfersEnabledAtDay   null
  postTransferCharterLimit       1
  seat                           { ...defaults }

difference from the defaults (what the cell id is derived from)
  baseline diff                    {} (none)

arms built for a cell that does not name the transfer switch
  control, treatment, noPayoutSell   -> 3 arms
  with the switch at day 15: control, treatment, noPayoutSell, transferable   -> 4 arms

UNTOUCHED.
```

The baseline's effective configuration is byte-identical to what suite A ran
against, once this prompt's additions are removed; the additions are all at
their inert defaults; and a cell that does not name the transfer switch builds
three arms, not four.

The cell **id** did move once — from `4296209191d71e99` to
`3b2ab0b6e0d949fd` — because the hashing scheme changed from "the whole
resolved configuration" to "its difference from the defaults", precisely so
that this could not happen again. `pnpm study migrate` re-points the stored
results, joining on the cell label recorded in the manifest. No result was
recomputed, and none was discarded.

---

## Reproducing anything here

```
pnpm study report baseline           # the table above
pnpm study report ofat               # the ranking, with per-axis level detail
pnpm study replay <cellId> <seed>    # one point, full hourly history
pnpm study cells ofat                # every cell id and what it varies
```
