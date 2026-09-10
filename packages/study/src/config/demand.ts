/**
 * Demand regimes.
 *
 * Outside demand is not a whitepaper concept. It is the rest of the market,
 * and it has to be modelled explicitly because without any buy-side flow `F_n`
 * is negative in every epoch, `m` pins to its floor on the second day, and a
 * study about what a revocation wave does to issuance has nothing left to
 * measure.
 *
 * A regime is a setting of `config.externalDemand`, which drives
 * `RandomTrader`. Each trader, on each tick:
 *
 *   1. acts with probability `activityWad`; otherwise does nothing;
 *   2. if acting, buys with probability `buyBiasWad`, else sells;
 *   3. sizes the trade uniformly in `[1, maxTradeFractionWad x balance]`,
 *      where balance is its ETH on a buy and its $STANDARD on a sell.
 *
 * Every trader starts with `startingEth` and no $STANDARD, so early sells are
 * limited by what it has bought. The regimes below therefore describe the
 * *tendency* of flow, not a guaranteed net.
 */

import type { Config } from '@thirty-first-day/protocol'
import { WAD } from '@thirty-first-day/protocol'

export type DemandRegime = 'none' | 'bear' | 'chop' | 'mild' | 'bull'

export const DEMAND_REGIMES: readonly DemandRegime[] = [
  'none',
  'bear',
  'chop',
  'mild',
  'bull',
] as const

type Demand = Config['externalDemand']

/**
 * What each regime produces, stated exactly.
 *
 * | regime | traders | acts/tick | buy prob | max trade | intent |
 * | --- | --- | --- | --- | --- | --- |
 * | none | 0 | — | — | — | no outside flow at all; `m` collapses to its floor |
 * | bear | 6 | 1/8 | 0.35 | 4% of balance | persistent net outflow |
 * | chop | 6 | 1/3 | 0.50 | 12.5% of balance | mean-zero direction, high variance |
 * | mild | 6 | 1/8 | 0.55 | 4% of balance | slight net inflow — the baseline |
 * | bull | 6 | 1/8 | 0.70 | 4% of balance | persistent net inflow |
 *
 * **`chop` is the one that matters.** Its buy probability is exactly 0.5, so
 * the *direction* of flow is a fair coin, and its trade sizes are three times
 * the other regimes' while it acts nearly three times as often. That makes
 * `F_n` a high-variance, zero-mean-direction series — and whitepaper 5's
 * policy rule is asymmetric (`cutStep > raiseStep`), so a sequence of epochs
 * that averages to nothing in flow does *not* average to nothing in `m`. It
 * ratchets downward. The whitepaper does not discuss this, and it is the case
 * the study most wants a clean read on. See `docs/experimental-design.md`.
 */
export const DEMAND: Record<DemandRegime, Demand> = {
  none: {
    traders: 0,
    startingEth: 0n,
    activityWad: 0n,
    buyBiasWad: WAD / 2n,
    maxTradeFractionWad: WAD / 25n,
  },
  bear: {
    traders: 6,
    startingEth: 250n * WAD,
    activityWad: WAD / 8n,
    buyBiasWad: (35n * WAD) / 100n,
    maxTradeFractionWad: WAD / 25n,
  },
  chop: {
    traders: 6,
    startingEth: 250n * WAD,
    activityWad: WAD / 3n,
    buyBiasWad: WAD / 2n,
    maxTradeFractionWad: WAD / 8n,
  },
  mild: {
    traders: 6,
    startingEth: 250n * WAD,
    activityWad: WAD / 8n,
    buyBiasWad: (55n * WAD) / 100n,
    maxTradeFractionWad: WAD / 25n,
  },
  bull: {
    traders: 6,
    startingEth: 250n * WAD,
    activityWad: WAD / 8n,
    buyBiasWad: (70n * WAD) / 100n,
    maxTradeFractionWad: WAD / 25n,
  },
}
