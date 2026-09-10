/**
 * The daily falling-price license auction — whitepaper 7 and 8.
 *
 *   P(t)    = P_start * (P_floor / P_start) ^ (t / 24h)
 *   P_start = 2 * P_last, where P_last is the lowest price that sold yesterday
 *             (2 * P_floor if nothing sold)
 *   P_floor = licenseFloorDays * (baseRatePerDay * m / totalBranches)
 *
 * The curve is evaluated on the hourly tick, so the day is a 24-entry
 * schedule. It is built by taking the 24th root of the decay ratio once and
 * stepping, which reproduces the continuous curve exactly at each hour and
 * makes strict monotonicity a property of the construction rather than of
 * repeated rounding: `P_start` is at least twice `P_floor`, so each hourly
 * step is a factor of at most `0.5 ^ (1/24)`.
 */

import { divWad, mulWad, nthRootWad } from '../math/fixed.js'
import type { Config } from '../config/index.js'
import type { Tokens, Wad } from '../types.js'

/**
 * One branch's yield over `licenseFloorDays` days, at the current multiplier
 * and branch count. Zero when there are no live branches, which closes the
 * auction for the day.
 */
export function licenseFloorPrice(cfg: Config, multiplier: Wad, totalBranches: number): Tokens {
  if (totalBranches <= 0) return 0n
  const perBranchPerDay = mulWad(cfg.baseRatePerDayTokens, multiplier) / BigInt(totalBranches)
  return cfg.licenseFloorDays * perBranchPerDay
}

/**
 * `P_start` for a new day.
 *
 * The whitepaper writes `P_start = 2 * P_last` and, separately, `2 * P_floor`
 * when nothing sold. Those two rules can disagree: `P_last` is bounded below by
 * *yesterday's* floor, and today's floor moves with `m` and `totalBranches` —
 * a revocation wave destroys branches and lifts the floor overnight. Taking
 * `2 * max(P_last, P_floor)` keeps the auction a falling one in every case and
 * reduces to each stated rule whenever they agree.
 */
export function licenseStartPrice(
  cfg: Config,
  previousLowestSold: Tokens | null,
  floor: Tokens,
): Tokens {
  const anchor =
    previousLowestSold !== null && previousLowestSold > floor ? previousLowestSold : floor
  return cfg.licenseStartMultiple * anchor
}

/**
 * The day's hourly price schedule, `schedule[h] = P(h hours)`.
 *
 * `schedule[0] === pStart` and, because the decay ratio is at most 1/2 by
 * construction of `pStart`, every step strictly decreases and `schedule[23]`
 * stays strictly above `pFloor` — the floor is reached at t = 24h, which is
 * when the day closes.
 */
export function buildLicenseSchedule(cfg: Config, pStart: Tokens, pFloor: Tokens): Tokens[] {
  const hours = cfg.ticksPerDay
  if (pStart <= 0n) return new Array<Tokens>(hours).fill(0n)
  const ratio = pFloor >= pStart ? divWad(pStart, pStart) : divWad(pFloor, pStart)
  const step = nthRootWad(ratio, hours)
  const schedule: Tokens[] = new Array<Tokens>(hours)
  let price = pStart
  for (let h = 0; h < hours; h++) {
    schedule[h] = price
    price = mulWad(price, step)
  }
  return schedule
}
