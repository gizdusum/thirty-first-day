/**
 * One point of the grid: one cell, one seed, three arms.
 *
 * The hourly history is computed but never retained — snapshots are folded
 * into accumulators as they are produced, and only the daily downsample and
 * the derived metrics survive. A 90-day run produces 2,160 snapshots per arm;
 * keeping them for a grid of 10^4 runs would be tens of gigabytes for data
 * nobody reads.
 *
 * `keepHourly` is the exception, used by `study replay` and by the small,
 * explicitly listed set of exemplar seeds the report will chart.
 */

import {
  ARMS,
  configForArm,
  createWorld,
  populateGenesisCohort,
  resolveConfig,
  type Arm,
  type ConfigOverrides,
  type TickSnapshot,
  type World,
} from '@thirty-first-day/protocol'

import { canonicalJson, cellId, contentHash } from './cells.js'
import {
  ArmAccumulator,
  armMetrics,
  subtractMetrics,
  treatmentMetrics,
  type ArmMetrics,
  type Metrics,
} from './metrics.js'

export const PROTOCOL_VERSION = '0.0.0'

export interface RunResult {
  cellId: string
  seed: number
  metrics: Metrics
  provenance: {
    configHash: string
    protocolVersion: string
    seed: number
    horizonDays: number
  }
}

export interface RunOptions {
  /** Keep the full hourly history for each arm. Off by default. */
  keepHourly?: boolean
}

export interface DetailedRun extends RunResult {
  worlds: Record<Arm, World>
  daily: Record<Arm, TickSnapshot[]>
  hourly: Record<Arm, TickSnapshot[]> | null
}

export function runOne(
  overrides: ConfigOverrides,
  seed: number,
  horizonDays: number,
  options: RunOptions = {},
): DetailedRun {
  const resolved = resolveConfig(overrides)
  const ticks = horizonDays * 24

  const worlds = {} as Record<Arm, World>
  const accumulators = {} as Record<Arm, ArmAccumulator>
  const hourly: Record<Arm, TickSnapshot[]> | null = options.keepHourly
    ? ({ control: [], treatment: [], noPayoutSell: [] } as Record<Arm, TickSnapshot[]>)
    : null

  for (const arm of ARMS) {
    const world = createWorld(configForArm(resolved, arm), seed)
    populateGenesisCohort(world)
    worlds[arm] = world
    accumulators[arm] = new ArmAccumulator(horizonDays)
  }

  for (let t = 0; t < ticks; t++) {
    for (const arm of ARMS) {
      const result = worlds[arm].tick()
      accumulators[arm].observe(result.snapshot)
      if (hourly !== null) hourly[arm].push(result.snapshot)
      // `world.history` grows unboundedly and nothing downstream reads it
      // here; drop it as we go so a long grid stays flat in memory.
      if (!options.keepHourly) worlds[arm].history.length = 0
    }
  }

  const levels = {} as Record<Arm, ArmMetrics>
  for (const arm of ARMS) levels[arm] = armMetrics(accumulators[arm], horizonDays)

  const metrics: Metrics = {
    levels,
    delta: subtractMetrics(levels.treatment, levels.control),
    deltaNoPayout: subtractMetrics(levels.treatment, levels.noPayoutSell),
    treatment: treatmentMetrics(
      worlds.treatment,
      accumulators.treatment,
      levels.treatment,
      levels.noPayoutSell,
    ),
  }

  const daily = {} as Record<Arm, TickSnapshot[]>
  for (const arm of ARMS) daily[arm] = accumulators[arm].dailySnapshots()

  return {
    cellId: cellId(overrides, horizonDays),
    seed,
    metrics,
    provenance: {
      configHash: contentHash(canonicalJson(resolved)),
      protocolVersion: PROTOCOL_VERSION,
      seed,
      horizonDays,
    },
    worlds,
    daily,
    hourly,
  }
}

/** The storable part of a run: no worlds, no snapshots. */
export function toRunResult(run: DetailedRun): RunResult {
  return {
    cellId: run.cellId,
    seed: run.seed,
    metrics: run.metrics,
    provenance: run.provenance,
  }
}
