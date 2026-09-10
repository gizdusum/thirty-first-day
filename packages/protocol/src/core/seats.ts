/**
 * The seat market — whitepaper 12.
 *
 * Charters launch soulbound (whitepaper 6). A one-way switch can later enable
 * transfers, and then "selling a charter becomes a second exit path: the seat
 * moves whole, branches and balance included. A seat sale is an exit with zero
 * sell pressure on $STANDARD; the buyer replaces the seller one for one."
 *
 * This module is the pricing. The clearing and the transfer live in `World`,
 * because they mutate charters.
 *
 * The one thing to get right: **retiring pays in $STANDARD, and turning that
 * into ETH means selling into the pool and eating the slippage.** A seller's
 * reservation price is therefore the real pool quote for the whole balance,
 * not the spot price times the amount. If the model used spot it would price
 * the two exit paths as equivalent, and the whole claim in 12 — that a seat
 * sale carries no sell pressure — would be invisible.
 */

import { WAD, divWad, mulWad } from '../math/fixed.js'
import type { Config } from '../config/index.js'
import type { PoolState, Tokens, Wei } from '../types.js'
import { quoteEthOut, spotPrice } from './pool.js'
import { resolutionFeeRate } from './fees.js'

/** What a retirement would leave, in $STANDARD, after the resolution fee. */
export function retirementNetTokens(
  cfg: Config,
  accruedBalance: Tokens,
  resolutionPressureWad: bigint,
): Tokens {
  if (accruedBalance <= 0n) return 0n
  const rate = resolutionFeeRate(cfg, resolutionPressureWad)
  return accruedBalance - mulWad(accruedBalance, rate)
}

/**
 * The seller's reservation price, in ETH.
 *
 * `ethOut(balance − resolutionFee)` — what option (a), retiring every branch,
 * would actually leave them with once the proceeds have been sold into the
 * pool. Below this a seller prefers to retire; at or above it, selling the
 * seat is weakly better and carries no sell pressure.
 */
export function sellerReservationEth(
  cfg: Config,
  pool: PoolState,
  accruedBalance: Tokens,
  resolutionPressureWad: bigint,
): Wei {
  return quoteEthOut(pool, cfg, retirementNetTokens(cfg, accruedBalance, resolutionPressureWad))
}

export interface BuyerValuation {
  /** What the buyer could extract from the accrued balance today, net, in ETH. */
  discountedBalanceEth: Wei
  /** Present value of the branches' future issuance, in ETH. */
  npvEth: Wei
  totalEth: Wei
  /** The per-branch daily yield the buyer expected. */
  expectedYieldPerBranchPerDay: Tokens
}

/**
 * What a buyer will pay, in ETH.
 *
 * `value = discountedBalance + npvOfFutureIssuance`.
 *
 * The balance term gets exactly the same treatment as the seller's
 * reservation, because it is the same quantity seen from the other side: what
 * that balance is worth once it has actually been turned into ETH.
 *
 * The branch term is valued over `buyerHorizonDays` at
 * `buyerDiscountRatePerDayWad`. The future token stream is converted at spot
 * rather than at a size-adjusted quote, because it arrives a day at a time and
 * a single day's yield does not move the pool — the whole balance, sold at
 * once, does.
 *
 * **Buyer sophistication is a modelling choice.** `buyerExpectation` names one
 * simple, documented model and nothing else is implemented. See
 * `docs/mechanics.md`.
 */
export function buyerValuation(
  cfg: Config,
  pool: PoolState,
  accruedBalance: Tokens,
  branchCount: number,
  resolutionPressureWad: bigint,
  expectedMultiplierWad: bigint,
  totalBranches: number,
): BuyerValuation {
  const discountedBalanceEth = sellerReservationEth(
    cfg,
    pool,
    accruedBalance,
    resolutionPressureWad,
  )

  const expectedYieldPerBranchPerDay =
    totalBranches > 0
      ? mulWad(cfg.baseRatePerDayTokens, expectedMultiplierWad) / BigInt(totalBranches)
      : 0n
  const dailyTokens = expectedYieldPerBranchPerDay * BigInt(branchCount)

  // Sum of `dailyTokens / (1 + r)^d` for d = 1..horizon, computed iteratively
  // so no power function is needed.
  let discount = WAD
  let streamTokens = 0n
  const onePlusR = WAD + cfg.seat.buyerDiscountRatePerDayWad
  for (let day = 0; day < cfg.seat.buyerHorizonDays; day++) {
    discount = divWad(discount, onePlusR)
    streamTokens += mulWad(dailyTokens, discount)
    if (discount === 0n) break
  }

  const npvEth = mulWad(streamTokens, spotPrice(pool))
  return {
    discountedBalanceEth,
    npvEth,
    totalEth: discountedBalanceEth + npvEth,
    expectedYieldPerBranchPerDay,
  }
}

/**
 * The clearing price for a matched pair.
 *
 * Midpoint: the surplus — which is the buyer's view of the future issuance the
 * seller was about to walk away from — is split evenly between them.
 */
export function clearingPrice(cfg: Config, bidEth: Wei, reservationEth: Wei): Wei {
  switch (cfg.seat.clearingRule) {
    case 'midpoint':
      return (bidEth + reservationEth) / 2n
  }
}
