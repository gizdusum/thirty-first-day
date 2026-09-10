/**
 * When does a cell "show a difference"?
 *
 * Suite D exists to support claims of the form "N cells showed a difference,
 * M did not", and that claim is worth exactly as much as the threshold behind
 * it. So the threshold is stated here, in one place, and nothing is allowed to
 * decide materiality implicitly.
 *
 * A cell shows a difference on a metric when the observed `treatment − control`
 * delta clears **both** of:
 *
 *   1. **A noise band.** With nothing changed at all, the delta still varies
 *      from seed to seed. Suite A measures that variation directly: 200 seeds
 *      of the baseline cell. The band is `Z x sd_A(metric)`, with `Z = 1.96`.
 *      A suite-D cell runs one seed, so this is the right comparison — the
 *      question is whether a single draw is distinguishable from a single draw
 *      of the baseline, not whether a mean is.
 *
 *   2. **An absolute floor.** A move can be statistically clean and still be
 *      economically nothing. The floors below are stated per metric in the
 *      metric's own units, chosen so that a difference below the floor would
 *      not change any decision a reader of the report could make.
 *
 * Requiring both means the study never reports a difference that is merely
 * detectable, and never reports one that is merely large but indistinguishable
 * from seed noise.
 */

import type { Summary } from './aggregate.js'

export const NOISE_Z = 1.96

/**
 * Absolute floors, in display units (tokens, counts, multiples of `m`).
 *
 * The reasoning for each is written next to it. These are judgements, and a
 * reader who disagrees with one can change it here and re-run `study report`
 * without touching a single stored result.
 */
export const ABSOLUTE_FLOOR: Record<string, number> = {
  // One token a day per branch. Below that, a branch's yield has not
  // meaningfully changed for anyone holding one.
  yieldPerBranchPerDayD45: 1,
  yieldPerBranchPerDayD90: 1,
  // A single branch. Branches are integers; anything smaller is rounding.
  totalBranchesD45: 1,
  totalBranchesD90: 1,
  // 100,000 tokens is 0.01% of the hard cap.
  circulatingD90: 100_000,
  cumulativeBurnsD90: 100_000,
  mintedToWalletsD90: 100_000,
  'burnsBySourceD90.license': 100_000,
  'burnsBySourceD90.buyback': 100_000,
  'burnsBySourceD90.resolutionFee': 100_000,
  'burnsBySourceD90.revocationFee': 100_000,
  // 0.01 of a multiplier: one raise step at the default parameterisation, so
  // the smallest move policy itself can make in an epoch.
  multiplierMeanD31to90: 0.01,
  multiplierD31: 0.01,
  multiplierD45: 0.01,
  // 0.01 x 60 days: the same step sustained across the whole window.
  multiplierIntegralD31to90: 0.6,
  // 1% of the opening spot price of 2e-5 ETH per token.
  poolPriceD90: 2e-7,
  // 0.1 ETH of pool volume.
  revocationPayoutVolume: 0.1,
  // A single charter.
  liveChartersD90: 1,
  cumulativeRevokedD90: 1,

  // -- The seat market (whitepaper 12) --------------------------------------
  // 0.1 ETH of seat volume, matching the pool-volume floor: below that the
  // blind spot is not worth naming.
  seatMarketEthVolumeD90: 0.1,
  // A single seat.
  cumulativeSeatSalesD90: 1,
  branchesTransferredD90: 1,
  // 0.001 of the Herfindahl index. On a thousand equal holders the index is
  // 0.001, so this is "one holder's worth" of concentration.
  concentrationHHID90: 0.001,
  // One tenth of one percent of all branches.
  largestHolderBranchShareD90: 0.001,
}

export const DEFAULT_FLOOR = 0

export interface Threshold {
  metric: string
  absoluteFloor: number
  noiseBand: number
  /** The threshold actually applied: the larger of the two. */
  threshold: number
}

/** The materiality threshold for one metric, given suite A's summary of it. */
export function thresholdFor(metric: string, baseline: Summary): Threshold {
  const absoluteFloor = ABSOLUTE_FLOOR[metric] ?? DEFAULT_FLOOR
  const noiseBand = NOISE_Z * baseline.sd
  return { metric, absoluteFloor, noiseBand, threshold: Math.max(absoluteFloor, noiseBand) }
}

/** Whether an observed delta is material against a threshold. */
export function isMaterial(delta: number, threshold: Threshold): boolean {
  return Math.abs(delta) > threshold.threshold
}

/**
 * The noise band for every metric, from suite A.
 *
 * This is the object suite D is scored against, and `study report baseline`
 * prints it so the numbers behind the claim are visible without re-deriving
 * them.
 */
export function noiseBands(baseline: Record<string, Summary>): Record<string, Threshold> {
  const bands: Record<string, Threshold> = {}
  for (const [metric, summary] of Object.entries(baseline)) {
    bands[metric] = thresholdFor(metric, summary)
  }
  return bands
}
