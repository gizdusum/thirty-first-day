/**
 * The data the report's charts are drawn from.
 *
 * Writes `apps/report/data/*.json`. Two sources, and nothing else:
 *
 *  - the exemplar run, recomputed here from its cell id and seed, which is the
 *    same thing `study replay` does and the same thing the command printed
 *    under each chart does;
 *  - suite B's stored JSONL, aggregated the way `study report` aggregates it.
 *
 * Nothing in the report is typed in by hand except prose. If a number on the
 * page disagrees with this file, this file is right.
 *
 *   pnpm tsx packages/study/scripts/report-data.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { summarise, toDisplay } from '../src/aggregate.js'
import { baselineOverrides, LICENSES_PER_DAY } from '../src/config/axes.js'
import { cellId } from '../src/cells.js'
import { readMetricOrNull } from '../src/metrics.js'
import { runOne } from '../src/runCell.js'
import { readCellResults } from '../src/storage.js'

const ROOT = resolve(process.cwd())
const OUT = join(ROOT, 'apps', 'report', 'data')
const EXEMPLAR_SEED = 1_000_000
const HORIZON = 90

mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// The exemplar run
// ---------------------------------------------------------------------------

const exemplarCell = cellId(baselineOverrides(), HORIZON)
process.stdout.write(`exemplar: cell ${exemplarCell}, seed ${EXEMPLAR_SEED} ... `)
const started = Date.now()
const run = runOne(baselineOverrides(), EXEMPLAR_SEED, HORIZON)
process.stdout.write(`${((Date.now() - started) / 1000).toFixed(0)}s\n`)

const treatment = run.daily.treatment ?? []
const control = run.daily.control ?? []
if (treatment.length !== HORIZON || control.length !== HORIZON) {
  throw new Error(`expected ${HORIZON} daily snapshots, got ${treatment.length}/${control.length}`)
}

const series = {
  cellId: exemplarCell,
  seed: EXEMPLAR_SEED,
  horizonDays: HORIZON,
  replay: `pnpm study replay ${exemplarCell} ${EXEMPLAR_SEED}`,
  days: treatment.map((s) => s.day || Math.round(s.tick / 24)),
  multiplier: {
    treatment: treatment.map((s) => Number(s.multiplier) / 1e18),
    control: control.map((s) => Number(s.multiplier) / 1e18),
  },
  yieldPerBranchPerDay: {
    treatment: treatment.map((s) => Number(s.yieldPerBranchPerDay) / 1e18),
    control: control.map((s) => Number(s.yieldPerBranchPerDay) / 1e18),
  },
  totalBranches: {
    treatment: treatment.map((s) => s.totalBranches),
    control: control.map((s) => s.totalBranches),
  },
  revocations: treatment.map((s) => s.cumulativeRevoked),
}
writeFileSync(join(OUT, 'exemplar.json'), `${JSON.stringify(series)}\n`)
console.log(`  wrote exemplar.json (${series.days.length} days)`)

// ---------------------------------------------------------------------------
// Day-45 yield delta against licensesPerDay, from suite B
// ---------------------------------------------------------------------------

const licenses: Array<{ level: string; mean: number; lo: number; hi: number; n: number }> = []
for (const level of LICENSES_PER_DAY.levels) {
  const id = cellId(level.overrides, HORIZON)
  const results = readCellResults(ROOT, 'ofat', id)
  const values: number[] = []
  for (const result of results) {
    const raw = readMetricOrNull(result.metrics.delta, 'yieldPerBranchPerDayD45')
    if (raw !== null) values.push(toDisplay(raw, 'yieldPerBranchPerDayD45'))
  }
  const summary = summarise(values)
  licenses.push({
    level: level.label,
    mean: summary.mean,
    lo: summary.ci95[0],
    hi: summary.ci95[1],
    n: summary.n,
  })
  console.log(`  licensesPerDay=${level.label.padEnd(10)} n=${String(summary.n).padStart(3)}  mean ${summary.mean.toFixed(3)}`)
}
writeFileSync(
  join(OUT, 'licenses.json'),
  `${JSON.stringify({ metric: 'yieldPerBranchPerDayD45', suite: 'ofat', levels: licenses })}\n`,
)
console.log('  wrote licenses.json')
