# The Thirty-First Day

The Standard Reserve mints a thousand Genesis Charters in the same hour, and
whitepaper §10 makes any charter reportable once its owner has gone thirty days
without interacting. Because the whole cohort's clock starts at the same
instant, the first revocations cannot arrive as a trickle — they arrive on one
day, and this repository is a deterministic model of the protocol run as a
Monte Carlo experiment against a matched control to find out what that day
does.

Published at [day31.xyz](https://day31.xyz).

**This is an unofficial study. It is not affiliated with, commissioned by, or
endorsed by The Standard Reserve.** It models the protocol as the whitepaper
describes it. Where the whitepaper is silent, the model makes a choice, marks
it, and says so — there are 39 such parameters and they are listed in
[`packages/protocol/src/config/defaults.ts`](./packages/protocol/src/config/defaults.ts),
each with its default and the reasoning for it.

## What it found

Four findings, each a paired difference against a control that never revokes.

1. **The bank cannot see it.** The issuance multiplier on day 31 moves by
   exactly `0.0000` — in all 200 seeds, with zero variance. §4 sets the policy
   signal from the net flow of the *two preceding* epochs, so the multiplier
   cannot respond until two epoch closes after the wave has already landed.
2. **The survivors get a bigger share of a smaller issue.** Yield per branch
   per day at day 45 is **+8.73** `[+7.43, +9.98]`, while the multiplier
   integrated over days 31–90 falls by **−1.451** `[−1.974, −0.922]`. Fewer
   branches raise the per-branch share; the payouts being sold cut the
   multiplier, which shrinks what is shared.
3. **The advantage does not last.** By day 90 the same figure is **+1.39**
   `[−0.44, +3.17]` — a null. The auction refills the base.
4. **All of it scales with a number that is not published.** Daily licence
   supply is redacted in the whitepaper and turns out to be the binding
   constraint: across its range it swings supply minted into wallets by
   **2.7×**, from 3.13M tokens at 25 licences a day to 1.16M at 400. It is not
   a dial — it is steep below the default and flat above it.

Where a result is null it is reported as a null. The full write-up of suites A
and B is in [`docs/results-suites-a-b.md`](./docs/results-suites-a-b.md).

## Reproducing a figure

Every chart on the published page carries its own replay command. This one
reproduces the exemplar run behind the multiplier, yield and branch charts, in
full, from nothing but the cell id and the seed:

```sh
pnpm install
pnpm study replay 3b2ab0b6e0d949fd 1000000
```

Requires Node 20+ and pnpm. Someone who doubts a chart reproduces the exact
point in one line; that is the study's credibility mechanism, not a
convenience.

```sh
pnpm test                          # 105 tests: protocol invariants and study guarantees
pnpm study calibrate               # locate the profitability boundary numerically
pnpm study cells ofat              # every cell id and what it varies
pnpm study run baseline            # suite A, the central estimate
pnpm study run ofat                # suite B, the sensitivity ranking
pnpm study report ofat             # aggregate the stored JSONL into tables
pnpm tsx packages/study/scripts/axis-audit.ts sample        # does every axis reach its cells?
pnpm tsx packages/study/scripts/sample-sensitivity.ts       # read suite D
```

## Layout

| Path | What it is |
| --- | --- |
| `packages/protocol` | The model. Deterministic, zero runtime dependencies. All state in bigint fixed point; one seeded PRNG, threaded explicitly. |
| `packages/study` | The Monte Carlo runner and the experimental design: cells, suites, materiality, the worker pool, and exact replay. |
| `apps/report` | The published report. Next.js static export, hand-rolled inline SVG charts, and a WebGL instrument over the per-charter data. |
| `runs/` | The provenance record — every stored result from suites A, B and D, as JSONL, with a manifest. 23 MB, and it belongs in the repository. |

| Doc | What it covers |
| --- | --- |
| [`docs/mechanics.md`](./docs/mechanics.md) | Every rule implemented, keyed to its whitepaper section, plus the study layers on top. Read this first. |
| [`docs/experimental-design.md`](./docs/experimental-design.md) | The axes, the four suites, the demand regimes, what counts as a difference, and the composition defect below. |
| [`docs/findings.md`](./docs/findings.md) | The six places the whitepaper had to be interpreted, and what the model does about each. |
| [`docs/results-suites-a-b.md`](./docs/results-suites-a-b.md) | What suites A and B found. |
| [`docs/performance.md`](./docs/performance.md) | What a run cost, what was optimised, and what it bought. |

The three spec files are the claims, not scaffolding:
`packages/protocol/src/invariants.spec.ts` asserts the protocol invariants at
every tick over randomized configs and seeds;
`packages/protocol/src/study.spec.ts` asserts the cohort, the hunters, the wave
and the arms; `packages/study/src/study.spec.ts` asserts stable cell ids, exact
replay, pool equivalence and resumability.

## Limitations

- **Suite C was not run.** The full factorial over the top three axes from B is
  in the design and was never executed — about three and a half hours at the
  measured throughput, and B's ranking already answered what C was there to
  answer. It is not pending; it is not done.
- **Five of suite D's fourteen axes never reached their cells.** A suite
  composes a cell by shallow-merging one level per axis, and several axes write
  the same key, so the last one composed silently wins. `demandRegime`,
  `hunterCount`, `maxReportsPerHour`, `payoutSellFraction` and
  `charterTransfersEnabledAtDay` were pinned rather than varied. What survives
  is a valid hypercube over the nine remaining axes — including hunter gas,
  which carries the strongest result in the study. The failure mode is the
  point: a clobbered axis does not throw, it produces a flat row with
  overlapping intervals, which is exactly what a real null looks like. Written
  up in
  [experimental-design.md](./docs/experimental-design.md#composition-five-of-suite-ds-axes-never-reached-the-cells);
  `axis-audit.ts` now runs before the suite D report and exits non-zero.
  Suites A and B are unaffected and the audit confirms it.
- **Seat buyers are passive.** In the §12 transfer arm a buyer checks in, and
  does nothing else: no trading, no withdrawals, no licence purchases. So a
  seat that changes hands stops expanding, and that turns out to dominate the
  arm — on one 90-day run with the switch at day 15 the transferable arm
  avoided 144 revocations and still finished with 309 *fewer* branches. A real
  buyer paying for 180 days of expected yield might well buy licences. This is
  the single assumption in the study most likely to be wrong.
- **39 parameters are redacted in the whitepaper** and had to be assumed. Each
  carries its default and the reasoning in `config/defaults.ts`, and the ones
  that move the answer are swept as axes — but finding four is precisely the
  result that one of them sets the scale of everything else.

## Licence

MIT. See [`LICENSE`](./LICENSE).
