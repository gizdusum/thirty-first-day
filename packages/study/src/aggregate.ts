/**
 * Turning JSONL into tables.
 *
 * Everything here works on `treatment − control` differences, never on levels
 * alone. A level tells you what happened in one world; the difference tells
 * you what revocation did.
 */

import { createRng } from '@thirty-first-day/protocol'

import type { CellSpec } from './cells.js'
import { METRIC_PATHS, readMetricOrNull, type ArmMetrics } from './metrics.js'
import type { RunResult } from './runCell.js'
import { readCellResults } from './storage.js'
import type { LevelRef, Suite } from './suites.js'

/** How a metric is scaled for display, and what an economically null move is. */
export interface MetricDisplay {
  path: string
  /** Divide the raw bigint by 10^decimals to get the display number. */
  decimals: number
  unit: string
}

const TOKEN: Omit<MetricDisplay, 'path'> = { decimals: 18, unit: 'tokens' }
const COUNT: Omit<MetricDisplay, 'path'> = { decimals: 0, unit: '' }
const WAD_UNIT: Omit<MetricDisplay, 'path'> = { decimals: 18, unit: 'x' }
const ETH: Omit<MetricDisplay, 'path'> = { decimals: 18, unit: 'ETH' }

export const METRIC_DISPLAY: Record<string, MetricDisplay> = Object.fromEntries(
  (
    [
      ['yieldPerBranchPerDayD45', TOKEN],
      ['yieldPerBranchPerDayD90', TOKEN],
      ['totalBranchesD45', COUNT],
      ['totalBranchesD90', COUNT],
      ['circulatingD90', TOKEN],
      ['cumulativeBurnsD90', TOKEN],
      ['mintedToWalletsD90', TOKEN],
      ['burnsBySourceD90.license', TOKEN],
      ['burnsBySourceD90.buyback', TOKEN],
      ['burnsBySourceD90.resolutionFee', TOKEN],
      ['burnsBySourceD90.revocationFee', TOKEN],
      ['multiplierMeanD31to90', WAD_UNIT],
      ['multiplierIntegralD31to90', { decimals: 18, unit: 'x-days' }],
      ['multiplierD31', WAD_UNIT],
      ['multiplierD45', WAD_UNIT],
      ['poolPriceD90', { decimals: 18, unit: 'ETH/token' }],
      ['revocationPayoutVolume', ETH],
      ['liveChartersD90', COUNT],
      ['cumulativeRevokedD90', COUNT],
      ['seatMarketEthVolumeD90', ETH],
      ['cumulativeSeatSalesD90', COUNT],
      ['branchesTransferredD90', COUNT],
      ['concentrationHHID90', { decimals: 18, unit: 'HHI' }],
      ['largestHolderBranchShareD90', { decimals: 18, unit: 'share' }],
    ] as Array<[string, Omit<MetricDisplay, 'path'>]>
  ).map(([path, rest]) => [path, { path, ...rest }]),
)

export function toDisplay(value: bigint, path: string): number {
  const decimals = METRIC_DISPLAY[path]?.decimals ?? 0
  return decimals === 0 ? Number(value) : Number(value) / 10 ** decimals
}

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

export interface Summary {
  n: number
  mean: number
  median: number
  sd: number
  min: number
  max: number
  /** Bootstrap 95% interval for the mean. */
  ci95: [number, number]
}

export const BOOTSTRAP_RESAMPLES = 2_000

/**
 * Bootstrap confidence interval for the mean.
 *
 * Percentile bootstrap: resample the seeds with replacement, take the mean of
 * each resample, report the 2.5th and 97.5th percentiles. Seeded, so a report
 * regenerated tomorrow prints the same interval.
 */
export function summarise(values: readonly number[], seed = 424_242): Summary {
  const n = values.length
  if (n === 0) return { n: 0, mean: 0, median: 0, sd: 0, min: 0, max: 0, ci95: [0, 0] }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((s, v) => s + v, 0) / n
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0
  const median =
    n % 2 === 1
      ? (sorted[(n - 1) / 2] as number)
      : ((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2

  const rng = createRng(seed)
  const means: number[] = []
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += values[rng.nextInt(n)] as number
    means.push(sum / n)
  }
  means.sort((a, b) => a - b)
  const lo = means[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)] as number
  const hi = means[Math.min(BOOTSTRAP_RESAMPLES - 1, Math.ceil(0.975 * BOOTSTRAP_RESAMPLES))] as number

  return {
    n,
    mean,
    median,
    sd: Math.sqrt(variance),
    min: sorted[0] as number,
    max: sorted[n - 1] as number,
    ci95: [lo, hi],
  }
}

// ---------------------------------------------------------------------------
// Cell aggregation
// ---------------------------------------------------------------------------

export type Which =
  | 'delta'
  | 'deltaNoPayout'
  | 'deltaTransfer'
  | 'treatment'
  | 'control'
  | 'noPayoutSell'
  | 'transferable'

function pick(result: RunResult, which: Which): ArmMetrics | null {
  if (which === 'delta') return result.metrics.delta
  if (which === 'deltaNoPayout') return result.metrics.deltaNoPayout
  if (which === 'deltaTransfer') return result.metrics.deltaTransfer ?? null
  return result.metrics.levels[which] ?? null
}

export interface CellSummary {
  cellId: string
  label: string
  axis: string | null
  level: string
  runs: number
  metrics: Record<string, Summary>
  /** Treatment-only figures, summarised the same way. */
  treatmentOnly: Record<string, Summary>
}

export function summariseCell(
  cell: CellSpec,
  results: readonly RunResult[],
  which: Which = 'delta',
): CellSummary {
  const metrics: Record<string, Summary> = {}
  for (const path of METRIC_PATHS) {
    // A metric a stored result predates, or an arm a cell never built, is
    // counted out rather than read as zero — the smaller `n` says so.
    const values: number[] = []
    for (const result of results) {
      const arm = pick(result, which)
      if (arm === null) continue
      const raw = readMetricOrNull(arm, path)
      if (raw === null) continue
      values.push(toDisplay(raw, path))
    }
    metrics[path] = summarise(values)
  }

  const treatmentOnly: Record<string, Summary> = {}
  const scalarPaths: Array<[string, (r: RunResult) => number]> = [
    ['revocations', (r) => Number(r.metrics.treatment.revocations)],
    ['valueDestroyedByRevocation', (r) => Number(r.metrics.treatment.valueDestroyedByRevocation) / 1e18],
    ['valueReturnedToBankers', (r) => Number(r.metrics.treatment.valueReturnedToBankers) / 1e18],
    ['valueRedistributedToActives', (r) => Number(r.metrics.treatment.valueRedistributedToActives) / 1e18],
    ['bountiesPaid', (r) => Number(r.metrics.treatment.bountiesPaid) / 1e18],
    ['hunterGasSpentEth', (r) => Number(r.metrics.treatment.hunterGasSpentEth) / 1e18],
    ['ghostsNeverCollected.count', (r) => Number(r.metrics.treatment.ghostsNeverCollected.count)],
    ['ghostsNeverCollected.branches', (r) => Number(r.metrics.treatment.ghostsNeverCollected.branches)],
    ['ghostsNeverCollected.balance', (r) => Number(r.metrics.treatment.ghostsNeverCollected.balance) / 1e18],
  ]
  for (const [name, read] of scalarPaths) treatmentOnly[name] = summarise(results.map(read))

  // Metrics that are absent in some runs are summarised over the runs that
  // have them, and the count is reported so a partial series is visible.
  const cleared = results
    .map((r) => r.metrics.treatment.waveClearedOnDay)
    .filter((v): v is bigint => v !== null)
    .map(Number)
  treatmentOnly['waveClearedOnDay'] = summarise(cleared)

  const attributable = results
    .map((r) => r.metrics.treatment.attributableCut)
    .filter((v): v is bigint => v !== null)
    .map((v) => Number(v) / 1e18)
  treatmentOnly['attributableCut'] = summarise(attributable)

  // Whitepaper 12 figures, over the runs that built a fourth arm.
  const transfers = results
    .map((r) => r.metrics.transfer)
    .filter((v): v is NonNullable<typeof v> => v !== null && v !== undefined)
  const transferScalars: Array<[string, (t: (typeof transfers)[number]) => number]> = [
    ['transfersEnabledOnDay', (t) => Number(t.transfersEnabledOnDay)],
    ['revocationsAvoided', (t) => Number(t.revocationsAvoided)],
    ['valueRescuedBySale', (t) => Number(t.valueRescuedBySale) / 1e18],
    ['sellerProceedsEth', (t) => Number(t.sellerProceedsEth) / 1e18],
    ['seatMarketEthVolume', (t) => Number(t.seatMarketEthVolume) / 1e18],
    ['branchesKeptAlive', (t) => Number(t.branchesKeptAlive)],
    ['seatSales', (t) => Number(t.seatSales)],
    ['concentrationHHI', (t) => Number(t.concentrationHHI) / 1e18],
    ['largestHolderBranchShare', (t) => Number(t.largestHolderBranchShare) / 1e18],
  ]
  for (const [name, read] of transferScalars) {
    treatmentOnly[name] = summarise(transfers.map(read))
  }

  return {
    cellId: cell.id,
    label: cell.label,
    axis: cell.axis,
    level: cell.level,
    runs: results.length,
    metrics,
    treatmentOnly,
  }
}

export function summariseSuite(root: string, suite: Suite, which: Which = 'delta'): CellSummary[] {
  return suite.cells.map((cell) =>
    summariseCell(cell, readCellResults(root, suite.name, cell.id), which),
  )
}

// ---------------------------------------------------------------------------
// Sensitivity ranking
// ---------------------------------------------------------------------------

export interface AxisSensitivity {
  axis: string
  metric: string
  /** Spread of the cell means across the axis's levels. */
  range: number
  /** That spread expressed in units of the baseline's per-seed noise band. */
  rangeInNoiseBands: number
  bestLevel: string
  worstLevel: string
  levels: Array<{ level: string; mean: number; n: number }>
}

/**
 * Rank axes by how far they move a metric.
 *
 * The range across an axis's levels is meaningless on its own — it has to be
 * read against how much the metric moves from seed to seed with nothing
 * changed at all. `noiseBand` is that: the width the baseline's own seed
 * variance produces. An axis whose whole range fits inside one noise band did
 * not move the answer.
 */
export function rankAxes(
  summaries: readonly CellSummary[],
  levelRefs: readonly LevelRef[],
  metric: string,
  noiseBand: number,
): AxisSensitivity[] {
  const byCell = new Map(summaries.map((s) => [s.cellId, s]))
  const byAxis = new Map<string, Array<{ level: string; mean: number; n: number }>>()
  for (const ref of levelRefs) {
    const summary = byCell.get(ref.cellId)
    if (summary === undefined || summary.runs === 0) continue
    const list = byAxis.get(ref.axis) ?? []
    list.push({ level: ref.level, mean: summary.metrics[metric]?.mean ?? 0, n: summary.runs })
    byAxis.set(ref.axis, list)
  }

  const rows: AxisSensitivity[] = []
  for (const [axis, unsorted] of byAxis) {
    const levels = [...unsorted].sort((a, b) => a.mean - b.mean)
    if (levels.length < 2) continue
    const lo = levels[0] as { level: string; mean: number }
    const hi = levels[levels.length - 1] as { level: string; mean: number }
    rows.push({
      axis,
      metric,
      range: hi.mean - lo.mean,
      rangeInNoiseBands: noiseBand > 0 ? (hi.mean - lo.mean) / noiseBand : Infinity,
      bestLevel: hi.level,
      worstLevel: lo.level,
      levels,
    })
  }
  return rows.sort((a, b) => Math.abs(b.range) - Math.abs(a.range))
}
