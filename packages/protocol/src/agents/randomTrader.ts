import { WAD, mulWad } from '../math/fixed.js'
import type { Rng } from '../rng/xoshiro128.js'
import type { Action, Agent, AgentView } from '../types.js'

export interface RandomTraderOptions {
  /** Probability of acting at all on a given tick, WAD. */
  activityWad?: bigint
  /** Probability that an action is a buy rather than a sell, WAD. */
  buyBiasWad?: bigint
  /** Largest fraction of the relevant balance to put into one trade, WAD. */
  maxTradeFractionWad?: bigint
}

/**
 * Buys and sells at random, sized as a fraction of what it holds.
 *
 * This exists to move the pool so that the net flow signal (whitepaper 4), the
 * fee engine (11) and price impact are all exercised. It is not a model of
 * anyone's behaviour — the cohort agents come later.
 */
export class RandomTrader implements Agent {
  private readonly activityWad: bigint
  private readonly buyBiasWad: bigint
  private readonly maxTradeFractionWad: bigint

  constructor(
    readonly id: string,
    options: RandomTraderOptions = {},
  ) {
    this.activityWad = options.activityWad ?? WAD / 10n
    this.buyBiasWad = options.buyBiasWad ?? WAD / 2n
    this.maxTradeFractionWad = options.maxTradeFractionWad ?? WAD / 20n
  }

  onTick(view: AgentView, rng: Rng): Action[] {
    if (!rng.nextBool(this.activityWad)) return []
    const wallet = view.wallet()
    const buy = rng.nextBool(this.buyBiasWad)

    const balance = buy ? wallet.eth : wallet.standard
    if (balance <= 0n) return []

    const cap = mulWad(balance, this.maxTradeFractionWad)
    if (cap <= 0n) return []
    const amountIn = 1n + rng.nextBigint(cap)

    return [{ type: 'swap', agentId: this.id, direction: buy ? 'buy' : 'sell', amountIn }]
  }
}
