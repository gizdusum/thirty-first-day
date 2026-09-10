# Performance

The grid is on the order of 10^4 paired runs. At the model's original speed
that was about 75 hours single-threaded, so the runner could not be built until
the model was faster. This records what was measured, what was changed, and
what it bought — because "we optimised it" is not a claim anyone can check.

Every optimisation here is **result-preserving**. None of them changes a single
wei of any run. The protocol's 65 tests, including the byte-identical
determinism test and the exact ledger-closure invariants, were run after each
change.

---

## The baseline measurement

One 90-day run (2,160 ticks), 1,000 genesis charters, the full study
population: 1,000 banker agents, 5 bounty hunters and 6 outside traders.

```
$ pnpm tsx packages/study/scripts/profile.ts 90 1000

full run (population + ticks)          8421 ms
engine only (no agents)                  66 ms
cohort, no hunters                     8596 ms
cohort, no outside demand              8461 ms
agent decisions only                    796 ms

events: withdrawals=11381 revocations=351 licenses=4053 swaps=52414
final branches=4059 liveCharters=649
```

The engine floor — ticking a world with no agents at all — is 66 ms, less than
1%. Agent decision-making is 796 ms, about 9%. So roughly 90% of the time is
spent *applying* the actions agents produce, not producing them.

V8's sampling profiler says where:

| Self time | Function | |
| --- | --- | --- |
| **51.8%** | `redistributePro` | pro-rata fee redistribution |
| 5.2% | `settleBranch` | called from its first pass |
| 9.8% | `settleWithdrawal` | mostly building `liveBranchIds` |
| 9.4% | `viewFor` | rebuilds a 15-closure view object per agent per tick |
| 3.1% | (garbage collector) | |
| 2.6% | `rngFor` | string key + Map lookup per agent per tick |
| 0.8% | `liveBranchIds` | |

The shape of it: 11,732 redistributions (one per withdrawal, one per
revocation) x 4,059 live branches = **47.6 million branch-touches**, each a
BigInt multiply and divide. Nothing else is close.

---

## What changed

### 1. Cache the per-agent view and RNG stream (−9.4%, −2.6%)

`viewFor(agentId)` built a fresh object with fifteen closures on every call —
1,000 agents x 2,160 ticks = 2.16 million of them. The view reads live state,
so it has no per-tick content: it is now built once per agent and cached, and
each agent's `onTick` stream is cached alongside it in a parallel `runtimes`
array. Purely a matter of not rebuilding something immutable.

### 2. Cache the live-branch list (−~5%)

`settleWithdrawal` called `liveBranchIds(state)`, which walked every charter
and built a fresh array of ~4,000 ids, on every withdrawal. It is now a cached
array of `Branch` objects invalidated when the branch set changes — a license
purchase, a retirement, a revocation. Those are about 5,200 events against
11,732 redistributions, so the array is rebuilt less than half as often as it
was, and the redistribution loop no longer pays a `Map.get` per branch.

**The order is load-bearing.** The floor remainder of a redistribution is
spread one wei at a time in participant order, so iterating `state.branches`
directly — which is branch-id order, not charter-then-branch order — would move
dust between branches and change results. The cache reproduces `liveBranchIds`
order exactly.

### 3. Make redistribution a single pass (−~45% of the loop)

The original did two passes: settle every branch and sum the total, then
compute and apply each share. Both passes were removable:

- **The total was already known.** `ledger.totalAccrued` is maintained
  incrementally and every caller passes all live branches, so the sum is the
  value the ledger already holds. It is now passed in.
- **The settle was unnecessary.** A branch's balance is
  `settled + (rewardIndex − indexAt)`, so a credit can be added straight to
  `settled` without materialising the pending issuance first. The balance comes
  out identical either way; only `indexAt` differs, and nothing observable
  reads it.

### 4. Exact division by Barrett reduction (−1.5x on the divide)

What remains is irreducibly one `(amount * balance) / total` per branch per
redistribution. BigInt division is markedly more expensive than BigInt
multiplication in V8, and the divisor is constant across a whole
redistribution — so precompute `inv = floor(2^256 / total)` once and replace
the division with two multiplications, a shift and at most one correction step.

```
plain        1082 ms   11.26 Mops/s
barrett       706 ms   17.24 Mops/s   exact
```

This is a cheaper route to the same integer, not an approximation. With
`inv = floor(2^k / d) = 2^k/d − e` for `0 ≤ e < 1`, the estimate
`floor(n * inv / 2^k)` equals `floor(n/d)` or one less whenever `n < 2^k`; the
correction step resolves which. `prepareDivisor` returns null when that bound
cannot be guaranteed and the caller falls back to plain division. A property
test checks 2,000 random cases across the model's full magnitude range against
`n / d` directly.

An adaptive shift width was tried and abandoned: `k = 141` against `k = 256`
was 651 ms against 676 ms, a 4% gain not worth the extra branch.

---

## Result

```
8,421 ms  ->  4,821 ms      1.75x, all 65 tests still green
```

The remaining profile is:

| Self time | Function |
| --- | --- |
| 38.4% | `redistributePro` |
| 29.4% | `divExact` |
| 4.9% | `settleWithdrawal` |
| 2.5% | `nextU32` |
| 2.5% | `credits` |

Redistribution is still 68% of the run, and it is now essentially pure BigInt
arithmetic on 47.6 million operands. **That is the floor for exact semantics.**

Going further would mean changing the algorithm — representing balances as
shares against a multiplicative index, so that a proportional credit is an O(1)
change to a scale factor instead of an O(N) walk. That would be perhaps 10x
faster and would break the ledger-closure invariant, which currently holds with
`===` rather than to within a tolerance:

```
sum(all live branch balances) + mintedFromLedger + burnedFromLedger === cumulativeIssuance
```

That identity is one of the study's credibility claims, and per-wei exactness
in a model about who gets paid what is worth more than a 10x. The trade was not
made.

---

## Parallelism and throughput

`worker_threads`, pool size `os.cpus().length − 1` by default, one core left
for the main thread writing results to disk. Every task is a self-contained
deterministic function of `(overrides, seed, horizonDays)`, so there is no
shared state and no ordering requirement — results are written as they land,
keyed by cell and seed. `study.spec.ts` asserts that a pooled run is
byte-identical to a serial one.

### Achieved throughput

Measured on an Apple M4 Pro — and the core topology turns out to matter.
`os.cpus().length` reports 14, but that is **10 performance cores plus 4
efficiency cores**. The prompt's default of `cpus().length - 1 = 13` therefore
puts three workers on cores that run several times slower, and because the pool
finishes when its slowest task finishes, the whole pool waits on them.

| Workers | Achieved | Load average |
| --- | --- | --- |
| 13 (the default) | 0.29–0.31 runs/s | 38 |
| 9 (performance cores only) | **0.36 runs/s** | 16 |

So `cpus().length - 1` is kept as the default, because it is right on a
homogeneous machine and it is what the design specifies — but on a big.LITTLE
machine it is worth passing `--workers` explicitly. This is a real finding
about the runner, not a tuning detail: the naive default costs about 20% here.

| | |
| --- | --- |
| One three-arm 90-day paired run, 1,000 charters, isolated | ~16 s |
| The same run, with 9 of them in flight | ~25 s |
| Achieved throughput, 9 workers | **0.36 runs/s** |
| Suite A (200 runs) | 8.5 min, measured |
| Suite B (40 cells x 50 seeds = 2,000 runs) | ~92 min, measured rate |
| Suites C and D at the specified sizes | ~7 h and ~70 min respectively at this rate |
| A cell that names whitepaper §12's transfer switch | a third more: four arms, not three |

The fourth arm is conditional for that reason. A cell that leaves
`charterTransfersEnabledAtDay` at its `null` default builds three arms and
costs exactly what it cost before the seat market was modelled — asserted in
`study.spec.ts` rather than assumed.

The gap between 16 s isolated and 25 s under load is contention, not memory:
nine concurrent worlds hold a few hundred megabytes between them, well inside
what the machine has. It is nine processes competing for ten cores against a
machine that was already carrying background load.

Memory stays flat: hourly snapshots are folded into accumulators as they are
produced and the world's history array is cleared each tick, so only the daily
downsample and the derived metrics survive a run. The full hourly history is
retained only by `study replay`.

Resumability was exercised for real rather than only in a test: suite B was
killed 26 runs in when the worker count was changed, and the restart picked up
at 1,974 remaining without redoing any of them.

## Reproducing these numbers

```
pnpm tsx packages/study/scripts/profile.ts 90 1000     # the phase breakdown
node --cpu-prof --import tsx packages/study/scripts/hotspots.ts   # the profile
```
