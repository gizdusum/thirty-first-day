/**
 * The resolution fee curve — whitepaper 9.
 *
 *   P    = W / max(D + W, pFloorDenominator)
 *   fee  = feeFloor + (feeCeiling - feeFloor) * min(P / pSaturation, 1)^2
 *
 * `W` is everything withdrawn system-wide over the trailing 7 days and `D` is
 * everything still held at the bank. The curve is quadratic in `P` and flat
 * above `pSaturation`, so it is non-decreasing everywhere and never leaves
 * `[feeFloor, feeCeiling]`.
 *
 * Both functions are pure: the rate is computed and locked before any state is
 * mutated, which is what "the rate LOCKS at the moment of commit" means at
 * hourly granularity, where commit and execution fall in the same tick.
 */

import { WAD, divWad, maxBig, mulWad } from '../math/fixed.js'
import type { Config } from '../config/index.js'
import type { Tokens, Wad } from '../types.js'

/** `P`, the withdrawal pressure, WAD. Always in `[0, 1]`. */
export function resolutionPressure(cfg: Config, w: Tokens, d: Tokens): Wad {
  if (w <= 0n) return 0n
  const denominator = maxBig(d + w, cfg.pFloorDenominatorTokens)
  const p = divWad(w, denominator)
  return p > WAD ? WAD : p
}

/** The fee rate at pressure `p`, WAD. */
export function resolutionFeeRate(cfg: Config, p: Wad): Wad {
  const clamped = p < 0n ? 0n : p > WAD ? WAD : p
  const x = clamped >= cfg.pSaturationWad ? WAD : divWad(clamped, cfg.pSaturationWad)
  const xSquared = mulWad(x, x)
  return cfg.feeFloorWad + mulWad(cfg.feeCeilingWad - cfg.feeFloorWad, xSquared)
}
