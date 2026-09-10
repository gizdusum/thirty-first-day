/**
 * What a run reports.
 *
 * Every quantity is computed for all three arms and reported as levels plus
 * two differences: `delta` (treatment − control, everything revocation does)
 * and `deltaNoPayout` (treatment − noPayoutSell, the part caused specifically
 * by payout selling reaching the pool).
 *
 * All values stay `bigint`. WAD-scaled quantities are marked in the field
 * comments.
 */

import type { Arm, TickSnapshot, World } from '@thirty-first-day/protocol'
import { WAD, charterAccrued } from '@thirty-first-day/protocol'

export interface BurnSplit {
  license: bigint
  buyback: bigint
  resolutionFee: bigint
  revocationFee: bigint
}

/** Levels for one arm. Differences are taken field-wise. */
export interface ArmMetrics {
  /** Nominal issuance per branch per day, WAD-free token wei. */
  yieldPerBranchPerDayD45: bigint
  yieldPerBranchPerDayD90: bigint
  totalBranchesD45: bigint
  totalBranchesD90: bigint
  circulatingD90: bigint
  cumulativeBurnsD90: bigint
  mintedToWalletsD90: bigint
  burnsBySourceD90: BurnSplit
  /** Mean of `m` over days 31..90, computed hourly. WAD. */
  multiplierMeanD31to90: bigint
  /** Integral of `m` over days 31..90, in WAD-days. */
  multiplierIntegralD31to90: bigint
  /** `m` at the end of day 31 and day 45, for the attribution window. WAD. */
  multiplierD31: bigint
  multiplierD45: bigint
  poolPriceD90: bigint
  revocationPayoutVolume: bigint
  liveChartersD90: bigint
}

export interface GhostSummary {
  count: bigint
  branches: bigint
  balance: bigint
}

/** Figures that only exist in the treatment arm. */
export interface TreatmentMetrics {
  revocations: bigint
  valueDestroyedByRevocation: bigint
  valueReturnedToBankers: bigint
  valueRedistributedToActives: bigint
  bountiesPaid: bigint
  hunterGasSpentEth: bigint
  /** First day after wave 1 opened on which no charter is reportable. */
  waveClearedOnDay: bigint | null
  ghostsNeverCollected: GhostSummary
  /**
   * The share of the day-31..45 fall in `m` that is caused by payout selling:
   * `(dropTreatment - dropNoPayoutSell) / dropTreatment`, WAD.
   *
   * Null when `m` did not fall over the window in the treatment arm, in which
   * case there is no cut to attribute. `mDrop*` are reported alongside so the
   * complementary reading — the share that survives when payout sells are
   * replayed at zero — is one subtraction away.
   */
  attributableCut: bigint | null
  mDropTreatment: bigint
  mDropNoPayoutSell: bigint
}

export interface Metrics {
  levels: Record<Arm, ArmMetrics>
  delta: ArmMetrics
  deltaNoPayout: ArmMetrics
  treatment: TreatmentMetrics
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/**
 * Running totals an arm needs that no single snapshot carries.
 *
 * Fed one snapshot per tick as the run proceeds, so the hourly history can be
 * discarded immediately afterwards.
 */
export class ArmAccumulator {
  private multiplierHourSum = 0n
  private multiplierHours = 0
  private redistributedByRevocation = 0n
  private waveOpened = false
  private clearedOnDay: number | null = null
  private readonly daily = new Map<number, TickSnapshot>()

  constructor(
    readonly horizonDays: number,
    /** Days 31..90 inclusive is the attribution window. */
    readonly windowFromDay = 31,
  ) {}

  observe(snapshot: TickSnapshot): void {
    // The multiplier integral is computed hourly and only its result is kept.
    const day = Math.ceil(snapshot.tick / 24)
    if (day >= this.windowFromDay && day <= this.horizonDays) {
      this.multiplierHourSum += snapshot.multiplier
      this.multiplierHours += 1
    }
    this.redistributedByRevocation += snapshot.redistributedThisTick.revocationFee

    if (snapshot.waveIndex >= 1) this.waveOpened = true
    if (this.waveOpened && this.clearedOnDay === null && snapshot.reportableCharters === 0) {
      this.clearedOnDay = day
    }
    // Daily downsample: the last tick of each day.
    if (snapshot.tick % 24 === 0) this.daily.set(snapshot.tick / 24, snapshot)
  }

  dailySnapshots(): TickSnapshot[] {
    return [...this.daily.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s)
  }

  at(day: number): TickSnapshot {
    const snapshot = this.daily.get(day)
    if (snapshot === undefined) throw new Error(`metrics: no snapshot for day ${day}`)
    return snapshot
  }

  get redistributedRevocation(): bigint {
    return this.redistributedByRevocation
  }

  get waveCleared(): bigint | null {
    return this.clearedOnDay === null ? null : BigInt(this.clearedOnDay)
  }

  multiplierIntegralDays(): bigint {
    // Hours summed at WAD, divided by 24 to give WAD-days.
    return this.multiplierHourSum / 24n
  }

  multiplierMean(): bigint {
    if (this.multiplierHours === 0) return 0n
    return this.multiplierHourSum / BigInt(this.multiplierHours)
  }
}

function zeroBurns(): BurnSplit {
  return { license: 0n, buyback: 0n, resolutionFee: 0n, revocationFee: 0n }
}

export function armMetrics(accumulator: ArmAccumulator, horizonDays: number): ArmMetrics {
  const d45 = accumulator.at(Math.min(45, horizonDays))
  const d90 = accumulator.at(horizonDays)
  const d31 = accumulator.at(Math.min(31, horizonDays))
  return {
    yieldPerBranchPerDayD45: d45.yieldPerBranchPerDay,
    yieldPerBranchPerDayD90: d90.yieldPerBranchPerDay,
    totalBranchesD45: BigInt(d45.totalBranches),
    totalBranchesD90: BigInt(d90.totalBranches),
    circulatingD90: d90.circulating,
    cumulativeBurnsD90: d90.cumulativeBurns,
    mintedToWalletsD90: d90.mintedToWallets,
    burnsBySourceD90: { ...d90.burnsBySource },
    multiplierMeanD31to90: accumulator.multiplierMean(),
    multiplierIntegralD31to90: accumulator.multiplierIntegralDays(),
    multiplierD31: d31.multiplier,
    multiplierD45: d45.multiplier,
    poolPriceD90: d90.poolPrice,
    revocationPayoutVolume: d90.ethVolumeByOrigin.revocationPayout,
    liveChartersD90: BigInt(d90.liveCharters),
  }
}

function combine(a: ArmMetrics, b: ArmMetrics, op: (x: bigint, y: bigint) => bigint): ArmMetrics {
  const burns = zeroBurns()
  for (const key of Object.keys(burns) as Array<keyof BurnSplit>) {
    burns[key] = op(a.burnsBySourceD90[key], b.burnsBySourceD90[key])
  }
  const out = {} as ArmMetrics
  for (const key of Object.keys(a) as Array<keyof ArmMetrics>) {
    if (key === 'burnsBySourceD90') continue
    ;(out[key] as bigint) = op(a[key] as bigint, b[key] as bigint)
  }
  out.burnsBySourceD90 = burns
  return out
}

export function subtractMetrics(a: ArmMetrics, b: ArmMetrics): ArmMetrics {
  return combine(a, b, (x, y) => x - y)
}

/** Ghosts still uncollected at the horizon, with their balances. */
export function ghostSummary(world: World): GhostSummary {
  const state = world.state
  const floor = state.hunters.profitabilityFloorTokens
  const unreachable = state.hunters.profitabilityFloorUnreachable
  let count = 0n
  let branches = 0n
  let balance = 0n
  for (const charter of state.charters.values()) {
    if (!world.isReportable(charter.id)) continue
    const accrued = charterAccrued(state, charter)
    if (!unreachable && accrued >= floor) continue
    count += 1n
    branches += BigInt(charter.branchIds.length)
    balance += accrued
  }
  return { count, branches, balance }
}

export function treatmentMetrics(
  treatment: World,
  treatmentAcc: ArmAccumulator,
  treatmentArm: ArmMetrics,
  noPayoutArm: ArmMetrics,
): TreatmentMetrics {
  const state = treatment.state
  let returned = 0n
  let bounties = 0n
  for (const credits of state.credits.values()) {
    returned += credits.revocationPayout
    bounties += credits.bounty
  }

  const dropTreatment = treatmentArm.multiplierD31 - treatmentArm.multiplierD45
  const dropNoPayout = noPayoutArm.multiplierD31 - noPayoutArm.multiplierD45
  const attributableCut =
    dropTreatment > 0n ? ((dropTreatment - dropNoPayout) * WAD) / dropTreatment : null

  return {
    revocations: BigInt(state.wave.cumulativeRevoked),
    valueDestroyedByRevocation: state.token.burnsBySource.revocationFee,
    valueReturnedToBankers: returned,
    valueRedistributedToActives: treatmentAcc.redistributedRevocation,
    bountiesPaid: bounties,
    hunterGasSpentEth: state.hunters.cumulativeGasSpentEth,
    waveClearedOnDay: treatmentAcc.waveCleared,
    ghostsNeverCollected: ghostSummary(treatment),
    attributableCut,
    mDropTreatment: dropTreatment,
    mDropNoPayoutSell: dropNoPayout,
  }
}

/** Every leaf metric path, for generic aggregation and ranking. */
export const METRIC_PATHS: readonly string[] = [
  'yieldPerBranchPerDayD45',
  'yieldPerBranchPerDayD90',
  'totalBranchesD45',
  'totalBranchesD90',
  'circulatingD90',
  'cumulativeBurnsD90',
  'mintedToWalletsD90',
  'burnsBySourceD90.license',
  'burnsBySourceD90.buyback',
  'burnsBySourceD90.resolutionFee',
  'burnsBySourceD90.revocationFee',
  'multiplierMeanD31to90',
  'multiplierIntegralD31to90',
  'multiplierD31',
  'multiplierD45',
  'poolPriceD90',
  'revocationPayoutVolume',
  'liveChartersD90',
] as const

export function readMetric(metrics: ArmMetrics, path: string): bigint {
  const dot = path.indexOf('.')
  if (dot < 0) return metrics[path as keyof ArmMetrics] as bigint
  const head = path.slice(0, dot) as keyof ArmMetrics
  const tail = path.slice(dot + 1) as keyof BurnSplit
  return (metrics[head] as BurnSplit)[tail]
}
