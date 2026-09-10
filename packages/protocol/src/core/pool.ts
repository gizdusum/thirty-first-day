/**
 * Constant-product ETH <> $STANDARD pool with a trading fee paid in ETH.
 *
 * Price impact is real: every buy, sell, buyback and POL addition moves the
 * reserves, and therefore the spot price, before the next action sees it.
 *
 * All liquidity is protocol-owned (whitepaper 3: the 100e6 premint is locked in
 * the pool forever, and whitepaper 11 only ever adds to it). `polShares` is
 * therefore minted and never burned — the pool exposes no removal path at all.
 */

import { WAD, divWad, mulBps } from '../math/fixed.js'
import type { PoolState, Tokens, Wei } from '../types.js'
import type { Config } from '../config/index.js'

export interface SwapResult {
  /** ETH crossing the pool boundary before the fee, i.e. `F_n`'s measurement. */
  grossEth: Wei
  feeEth: Wei
  /** Tokens out on a buy, tokens in on a sell. */
  tokenAmount: Tokens
  /** ETH the seller actually receives; equals `grossEth - feeEth` on a sell. */
  netEth: Wei
}

export function createPool(cfg: Config): PoolState {
  return {
    ethReserve: cfg.poolInitialEth,
    standardReserve: cfg.polPremintTokens,
    // Nominal opening share count. Only its monotonicity is meaningful.
    polShares: WAD,
    cumulativePolEthAdded: cfg.poolInitialEth,
    cumulativePolStandardAdded: cfg.polPremintTokens,
    pendingPolEth: 0n,
    pendingPolStandard: 0n,
  }
}

/** Spot price in ETH per whole $STANDARD, WAD. */
export function spotPrice(pool: PoolState): bigint {
  if (pool.standardReserve === 0n) return 0n
  return divWad(pool.ethReserve, pool.standardReserve)
}

/** The invariant `k = x * y`. Grows with fees retained and with POL additions. */
export function constantProduct(pool: PoolState): bigint {
  return pool.ethReserve * pool.standardReserve
}

/**
 * Buy $STANDARD with an exact amount of ETH.
 *
 * The fee is taken in ETH off the top and handed back to the caller for
 * routing (whitepaper 11); only the post-fee remainder enters the reserve.
 */
export function swapExactEthForStandard(
  pool: PoolState,
  cfg: Config,
  ethIn: Wei,
  opts: { chargeFee: boolean },
): SwapResult {
  if (ethIn <= 0n) throw new RangeError('swapExactEthForStandard: ethIn must be positive')
  const feeEth = opts.chargeFee ? mulBps(ethIn, cfg.tradingFeeBps) : 0n
  const ethInAfterFee = ethIn - feeEth
  const out = (pool.standardReserve * ethInAfterFee) / (pool.ethReserve + ethInAfterFee)
  if (out >= pool.standardReserve) {
    throw new RangeError('swapExactEthForStandard: swap would drain the token reserve')
  }
  pool.ethReserve += ethInAfterFee
  pool.standardReserve -= out
  return { grossEth: ethIn, feeEth, tokenAmount: out, netEth: ethIn - feeEth }
}

/**
 * Sell an exact amount of $STANDARD for ETH.
 *
 * `grossEth` is the ETH that leaves the reserve — the quantity whitepaper 4
 * measures as sell-side flow. The fee is skimmed from it before the seller is
 * paid.
 */
export function swapExactStandardForEth(
  pool: PoolState,
  cfg: Config,
  standardIn: Tokens,
  opts: { chargeFee: boolean },
): SwapResult {
  if (standardIn <= 0n) throw new RangeError('swapExactStandardForEth: standardIn must be positive')
  const grossEth = (pool.ethReserve * standardIn) / (pool.standardReserve + standardIn)
  if (grossEth >= pool.ethReserve) {
    throw new RangeError('swapExactStandardForEth: swap would drain the ETH reserve')
  }
  const feeEth = opts.chargeFee ? mulBps(grossEth, cfg.tradingFeeBps) : 0n
  pool.standardReserve += standardIn
  pool.ethReserve -= grossEth
  return { grossEth, feeEth, tokenAmount: standardIn, netEth: grossEth - feeEth }
}

/**
 * Add protocol-owned liquidity. Shares are minted in proportion to the ETH
 * added against the pre-add reserve, and are never burned.
 */
export function addLiquidity(pool: PoolState, ethIn: Wei, standardIn: Tokens): bigint {
  if (ethIn <= 0n || standardIn <= 0n) return 0n
  const sharesMinted = (pool.polShares * ethIn) / pool.ethReserve
  pool.ethReserve += ethIn
  pool.standardReserve += standardIn
  pool.polShares += sharesMinted
  pool.cumulativePolEthAdded += ethIn
  pool.cumulativePolStandardAdded += standardIn
  return sharesMinted
}

/** $STANDARD required to pair with `ethIn` at the current reserve ratio. */
export function standardToPair(pool: PoolState, ethIn: Wei): Tokens {
  return (ethIn * pool.standardReserve) / pool.ethReserve
}
