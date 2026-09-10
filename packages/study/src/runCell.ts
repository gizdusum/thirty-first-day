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
  armsFor,
  configForArm,
  createWorld,
  populateGenesisCohort,
  resolveConfig,
  soulbound,
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
  transferMetrics,
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
  arms: readonly Arm[]
  worlds: Partial<Record<Arm, World>>
  daily: Partial<Record<Arm, TickSnapshot[]>>
  hourly: Partial<Record<Arm, TickSnapshot[]>> | null
}

export function runOne(
  overrides: ConfigOverrides,
  seed: number,
  horizonDays: number,
  options: RunOptions = {},
): DetailedRun {
  const resolved = resolveConfig(overrides)
  const ticks = horizonDays * 24
  // The fourth arm exists only when the cell configures the transfer switch.
  // A cell that leaves it null costs exactly what it cost before whitepaper
  // 12's machinery was built.
  const arms = armsFor(resolved)

  const worlds: Partial<Record<Arm, World>> = {}
  const accumulators: Partial<Record<Arm, ArmAccumulator>> = {}
  const hourly: Partial<Record<Arm, TickSnapshot[]>> | null = options.keepHourly ? {} : null

  for (const arm of arms) {
    // Every arm but `transferable` is soulbound, so the transfer switch is the
    // only thing the fourth arm varies.
    const armConfig =
      arm === 'transferable' ? configForArm(resolved, arm) : configForArm(soulbound(resolved), arm)
    const world = createWorld(armConfig, seed)
    populateGenesisCohort(world)
    worlds[arm as Arm] = world
    accumulators[arm as Arm] = new ArmAccumulator(horizonDays)
    if (hourly !== null) hourly[arm as Arm] = []
  }

  for (let t = 0; t < ticks; t++) {
    for (const arm of arms) {
      const world = worlds[arm as Arm] as World
      const result = world.tick()
      ;(accumulators[arm as Arm] as ArmAccumulator).observe(result.snapshot)
      if (hourly !== null) (hourly[arm as Arm] as TickSnapshot[]).push(result.snapshot)
      // `world.history` grows unboundedly and nothing downstream reads it
      // here; drop it as we go so a long grid stays flat in memory.
      if (!options.keepHourly) world.history.length = 0
    }
  }

  const levels: Partial<Record<Arm, ArmMetrics>> = {}
  for (const arm of arms) {
    levels[arm as Arm] = armMetrics(accumulators[arm as Arm] as ArmAccumulator, horizonDays)
  }
  const control = levels.control as ArmMetrics
  const treatment = levels.treatment as ArmMetrics
  const noPayoutSell = levels.noPayoutSell as ArmMetrics
  const transferable = levels.transferable ?? null

  const metrics: Metrics = {
    levels: { control, treatment, noPayoutSell, transferable },
    delta: subtractMetrics(treatment, control),
    deltaNoPayout: subtractMetrics(treatment, noPayoutSell),
    deltaTransfer: transferable === null ? null : subtractMetrics(transferable, treatment),
    treatment: treatmentMetrics(
      worlds.treatment as World,
      accumulators.treatment as ArmAccumulator,
      treatment,
      noPayoutSell,
    ),
    transfer:
      transferable === null || resolved.charterTransfersEnabledAtDay === null
        ? null
        : transferMetrics(resolved.charterTransfersEnabledAtDay, treatment, transferable),
  }

  const daily: Partial<Record<Arm, TickSnapshot[]>> = {}
  for (const arm of arms) {
    daily[arm as Arm] = (accumulators[arm as Arm] as ArmAccumulator).dailySnapshots()
  }

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
    arms,
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
