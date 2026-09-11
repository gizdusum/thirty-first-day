/**
 * Reading suite D.
 *
 * `study report <suite>` ranks axes by holding every other axis at its
 * baseline and walking one axis through its levels. That is suite B's design
 * and suite B's question. Suite D is a Latin hypercube: every cell differs
 * from every other cell on every axis at once, and there is one seed each, so
 * the OFAT ranking has nothing to compare and prints empty. That is the wrong
 * report for this suite, not a missing result.
 *
 * Suite D's own description states what it is for: "Supports the global 'N
 * showed a difference, M did not' claim." So that is what this prints, plus
 * the main effect of each axis — which an LHS does support, because every
 * level appears in an equal number of cells with the other axes randomised
 * across it.
 *
 * Two things this deliberately does not do:
 *
 *   - It does not call a per-cell difference "significant". One seed cannot
 *     separate a real effect from seed noise. The materiality band is suite
 *     A's 1.96 x sd over 200 seeds at the baseline cell, so the count below is
 *     "how often the arms differ by more than baseline seed noise" — and under
 *     a true null you would still expect about 5% of cells to clear it. The
 *     number is only interesting against that 5%.
 *
 *   - It does not rank axes by correlation. Two axes here are categorical
 *     (`demandRegime`, `dormancyBountySource`) and one is not monotone in its
 *     level order (`charterTransfersEnabledAtDay` starts at `null`, which is
 *     "never", not "early"). Per-level means are the honest read across all of
 *     them.
 *
 *   pnpm tsx packages/study/scripts/sample-sensitivity.ts
 */

import {
  METRIC_DISPLAY,
  summarise,
  summariseCell,
  type CellSummary,
} from '../src/aggregate.js'
import { axesFor, buildBaseline, buildSample } from '../src/suites.js'
import { noiseBands, type Threshold } from '../src/materiality.js'
import { readCellResults, readManifest } from '../src/storage.js'
import { auditSuite, levelLabelFor } from './axis-audit.js'

const ROOT = process.cwd()
const HORIZON = 90

/**
 * The gas boundary the run actually used, read back out of the manifest.
 *
 * It is part of an axis, so it is part of every cell id. Recalibrating it here
 * would rebuild the suite with different ids and find no results at all.
 */
function gasBoundaryFromManifest(horizonDays: number): bigint {
  for (const entry of Object.values(readManifest(ROOT).suites)) {
    if (entry.gasBoundaryWei !== null && entry.horizonDays === horizonDays) {
      return BigInt(entry.gasBoundaryWei)
    }
  }
  throw new Error(`no manifest entry carries a gas boundary for a ${horizonDays}-day horizon`)
}

const HEADLINE = [
  'yieldPerBranchPerDayD45',
  'yieldPerBranchPerDayD90',
  'mintedToWalletsD90',
  'multiplierIntegralD31to90',
] as const

function fmt(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e6) return value.toExponential(3)
  if (abs >= 100) return value.toFixed(1)
  if (abs >= 1) return value.toFixed(3)
  return value.toFixed(4)
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const options = { horizonDays: HORIZON, gasBoundaryWei: gasBoundaryFromManifest(HORIZON) }
const sample = buildSample(options)
const axes = axesFor(options)

const summaries: CellSummary[] = sample.cells.map((cell) =>
  summariseCell(cell, readCellResults(ROOT, sample.name, cell.id), 'delta'),
)
const withRuns = summaries.filter((s) => s.runs > 0)

// Suite A supplies the noise band. Without it there is no scale to judge a
// per-cell difference against, and the count below would be meaningless.
const baselineCell = buildBaseline(options).cells[0]
if (baselineCell === undefined) throw new Error('no baseline cell')
const baseline = summariseCell(
  baselineCell,
  readCellResults(ROOT, 'baseline', baselineCell.id),
  'delta',
)
if (baseline.runs === 0) {
  throw new Error('suite A has no results; the noise bands come from it')
}
const bands = noiseBands(baseline.metrics)

/*
 * Which axes actually reached the cells.
 *
 * An axis whose level is overwritten during composition produces a flat
 * result, and a flat result is indistinguishable from a null unless you go
 * looking. Nulls are publishable, so this has to be checked before anything is
 * printed, not after. See scripts/axis-audit.ts.
 */
const clobbered = new Set(
  auditSuite(sample, axes)
    .filter((v) => v.clobbered > 0)
    .map((v) => v.axis),
)

console.log('# suite D — Latin hypercube, one seed per cell')
console.log('')
console.log(`cells with results   ${withRuns.length} / ${summaries.length}`)
console.log(`noise bands from     suite A, ${baseline.runs} seeds at the baseline cell`)
if (clobbered.size > 0) {
  console.log('')
  console.log(`!! ${clobbered.size} axes were overwritten during composition and measured nothing:`)
  console.log(`!!   ${[...clobbered].join(', ')}`)
  console.log('!! They are omitted below. A flat row from a dead axis is not a null.')
  console.log('!! Run `pnpm tsx packages/study/scripts/axis-audit.ts sample` for the detail.')
}
console.log('')

// ---------------------------------------------------------------------------
// The global claim
// ---------------------------------------------------------------------------

console.log('## how often the arms differ by more than baseline seed noise')
console.log('')
console.log(
  `${'metric'.padEnd(28)}${'band'.padStart(13)}${'exactly 0'.padStart(12)}${'within band'.padStart(13)}${'beyond band'.padStart(13)}${'share'.padStart(9)}`,
)

for (const metric of HEADLINE) {
  const band: Threshold | undefined = bands[metric]
  const threshold = band?.threshold ?? 0
  let zero = 0
  let within = 0
  let beyond = 0
  for (const cell of withRuns) {
    const value = cell.metrics[metric]?.mean
    if (value === undefined || !Number.isFinite(value)) continue
    if (value === 0) zero += 1
    else if (Math.abs(value) <= threshold) within += 1
    else beyond += 1
  }
  const counted = zero + within + beyond
  const share = counted === 0 ? 0 : (beyond / counted) * 100
  console.log(
    metric.padEnd(28) +
      fmt(threshold).padStart(13) +
      String(zero).padStart(12) +
      String(within).padStart(13) +
      String(beyond).padStart(13) +
      `${share.toFixed(1)}%`.padStart(9),
  )
}

console.log('')
console.log('Under a true null about 5% of cells clear the band by chance alone.')
console.log('A share near 5% is a null; the interesting rows are the ones well above it.')
console.log('')

// ---------------------------------------------------------------------------
// Main effects
// ---------------------------------------------------------------------------

function levelOf(cell: CellSummary, axisName: string): string | null {
  return levelLabelFor(cell.label, axisName)
}

console.log('## main effects — mean delta per level, other axes randomised across it')

for (const metric of HEADLINE) {
  const unit = METRIC_DISPLAY[metric]?.unit ?? ''
  const band = bands[metric]?.threshold ?? 0
  console.log('')
  console.log(`### ${metric}   (${unit}; noise band ${fmt(band)})`)
  console.log(
    `${'axis'.padEnd(30)}${'level'.padEnd(14)}${'n'.padStart(6)}${'mean'.padStart(13)}${'ci95 lo'.padStart(13)}${'ci95 hi'.padStart(13)}`,
  )

  for (const axis of axes) {
    if (clobbered.has(axis.name)) continue
    let printedAxis = false
    for (const level of axis.levels) {
      const values: number[] = []
      for (const cell of withRuns) {
        if (levelOf(cell, axis.name) !== level.label) continue
        const value = cell.metrics[metric]?.mean
        if (value !== undefined && Number.isFinite(value)) values.push(value)
      }
      if (values.length === 0) continue
      const s = summarise(values)
      console.log(
        (printedAxis ? '' : axis.name).padEnd(30) +
          level.label.padEnd(14) +
          String(values.length).padStart(6) +
          fmt(s.mean).padStart(13) +
          fmt(s.ci95[0]).padStart(13) +
          fmt(s.ci95[1]).padStart(13),
      )
      printedAxis = true
    }
  }
}

// ---------------------------------------------------------------------------
// Whitepaper 12: the switch-day curve
// ---------------------------------------------------------------------------

/*
 * The fourth arm is built only where `charterTransfersEnabledAtDay` is set, so
 * the `null` level has no transfer figures at all and is absent below by
 * construction, not by omission. Everything here is the transferable arm
 * against the treatment arm on the same seed.
 *
 * Levels below 30 open the market before anyone is reportable; levels above 30
 * can only catch the tail. The shape across that boundary is the deliverable.
 */

const TRANSFER_METRICS = [
  'revocationsAvoided',
  'branchesKeptAlive',
  'seatSales',
  'valueRescuedBySale',
  'seatMarketEthVolume',
  'largestHolderBranchShare',
] as const

const switchAxis = axes.find((a) => a.name === 'charterTransfersEnabledAtDay')
if (switchAxis !== undefined && clobbered.has(switchAxis.name)) {
  console.log('')
  console.log('## whitepaper 12 — the transferable arm against treatment, by switch day')
  console.log('')
  console.log('NOT REPORTED. Every cell ran at a switch day of 15, whatever it drew, because')
  console.log('the postTransferCharterLimit axis pins that field and is composed after it.')
  console.log('The curve this suite was built to produce is not in these results.')
}

if (switchAxis !== undefined && !clobbered.has(switchAxis.name)) {
  console.log('')
  console.log('## whitepaper 12 — the transferable arm against treatment, by switch day')

  for (const metric of TRANSFER_METRICS) {
    console.log('')
    console.log(`### ${metric}`)
    console.log(
      `${'switch day'.padEnd(14)}${'cells'.padStart(7)}${'mean'.padStart(14)}${'ci95 lo'.padStart(14)}${'ci95 hi'.padStart(14)}`,
    )
    for (const level of switchAxis.levels) {
      if (level.label === 'null') continue
      const values: number[] = []
      for (const cell of withRuns) {
        if (levelOf(cell, switchAxis.name) !== level.label) continue
        const s = cell.treatmentOnly[metric]
        if (s !== undefined && s.n > 0 && Number.isFinite(s.mean)) values.push(s.mean)
      }
      if (values.length === 0) continue
      const s = summarise(values)
      console.log(
        level.label.padEnd(14) +
          String(values.length).padStart(7) +
          fmt(s.mean).padStart(14) +
          fmt(s.ci95[0]).padStart(14) +
          fmt(s.ci95[1]).padStart(14),
      )
    }
  }
}

console.log('')
console.log(`replay any cell: pnpm study replay <cellId> <seed>`)
