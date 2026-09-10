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

*(2,000 runs across 40 cells; results section filled in below once the suite
completes.)*

---

## Reproducing anything here

```
pnpm study report baseline           # the table above
pnpm study report ofat               # the ranking, with per-axis level detail
pnpm study replay <cellId> <seed>    # one point, full hourly history
pnpm study cells ofat                # every cell id and what it varies
```
