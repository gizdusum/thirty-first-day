/**
 * Bounty-hunter economics.
 *
 * Whitepaper 10 says only that "any address may report" a dormant charter and
 * that the informant takes 2% of the dormant balance, capped at 100_000
 * tokens. It does not say what reporting costs, and that omission is the whole
 * of this module.
 *
 * A report costs gas. A hunter values the bounty in ETH at the current pool
 * price and submits only if that value clears its margin. Below some dormant
 * balance the bounty is worth less than the gas, so nobody ever reports those
 * charters — they keep their branches, keep accruing, and dilute every active
 * banker for as long as the protocol runs. That threshold is
 * `profitabilityFloorTokens`, and it is a first-class metric of this study
 * rather than a side effect.
 */

import { BPS, WAD, divWad, minBig, mulBps, mulWad } from '../math/fixed.js'
import { hunterMarginWad, type Config } from '../config/index.js'
import type { Tokens, Wei } from '../types.js'

/** The bounty a dormant balance would pay (whitepaper 10). */
export function bountyFor(cfg: Config, dormantBalance: Tokens): Tokens {
  return minBig(mulBps(dormantBalance, cfg.informantBountyBps), cfg.informantBountyCapTokens)
}

/** What a bounty must be worth before a hunter will spend `gasCostEth` on it. */
export function requiredBountyEth(cfg: Config, gasCostEth: Wei): Wei {
  return mulWad(gasCostEth, hunterMarginWad(cfg))
}

export interface ProfitabilityFloor {
  /**
   * The smallest dormant accrued balance whose bounty clears the margin. When
   * `unreachable`, this is the hypothetical requirement ignoring the bounty
   * cap, so the series stays continuous and plottable.
   */
  tokens: Tokens
  /** True when the bounty cap makes the threshold impossible to reach. */
  unreachable: boolean
}

/**
 * The profitability floor at the current pool price.
 *
 * `bountyEth = bountyTokens * price`, so the bounty in tokens must be at least
 * `requiredEth / price`, and the dormant balance at least `that / 0.02`.
 *
 * A price of zero, or a zero bounty rate, makes reporting unprofitable at any
 * size.
 */
export function profitabilityFloor(
  cfg: Config,
  poolPriceWad: bigint,
  gasCostEth: Wei,
): ProfitabilityFloor {
  const required = requiredBountyEth(cfg, gasCostEth)
  if (required <= 0n) return { tokens: 0n, unreachable: false }
  if (poolPriceWad <= 0n || cfg.informantBountyBps <= 0n) {
    return { tokens: 0n, unreachable: true }
  }
  const bountyNeeded = divWad(required, poolPriceWad)
  const balanceNeeded = (bountyNeeded * BPS) / cfg.informantBountyBps
  return { tokens: balanceNeeded, unreachable: bountyNeeded > cfg.informantBountyCapTokens }
}

/**
 * Gas when `contenders` hunters submit against the same charter in the same
 * hour: `gasCostEth * (1 + escalation * (contenders - 1))`.
 */
export function escalatedGasEth(cfg: Config, contenders: number): Wei {
  if (contenders <= 1) return cfg.hunter.gasCostEth
  const multiplier = WAD + cfg.hunter.gasWarEscalationWad * BigInt(contenders - 1)
  return mulWad(cfg.hunter.gasCostEth, multiplier)
}

export interface Contest {
  /** How many hunters actually submit. Zero means the charter is below the floor. */
  contenders: number
  /** What each contender pays, win or lose. */
  gasEth: Wei
  /** The bounty value each of them needed to clear to be willing. */
  requiredEth: Wei
}

/**
 * How many of `candidates` hunters are still willing once escalation is taken
 * into account.
 *
 * The contender count sets the gas, and the gas decides who is still willing,
 * so the two are solved together. Dropping a contender can only lower the gas,
 * which can only make the rest more willing, so the iteration decreases
 * monotonically and terminates.
 */
export function resolveContest(cfg: Config, bountyValueEth: Wei, candidates: number): Contest {
  let contenders = candidates
  while (contenders > 0) {
    const gasEth = escalatedGasEth(cfg, contenders)
    const requiredEth = requiredBountyEth(cfg, gasEth)
    if (bountyValueEth >= requiredEth) return { contenders, gasEth, requiredEth }
    contenders -= 1
  }
  const gasEth = escalatedGasEth(cfg, 1)
  return { contenders: 0, gasEth, requiredEth: requiredBountyEth(cfg, gasEth) }
}
