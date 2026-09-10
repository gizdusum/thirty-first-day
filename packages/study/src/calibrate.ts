/**
 * Locating the profitability boundary numerically.
 *
 * Whitepaper 10 pays an informant 2% of a dormant balance, capped at 100,000
 * tokens. Whether that is worth a transaction depends on the dormant balances
 * the cell actually produces and on the pool price on the day the wave lands —
 * neither of which is known in advance, and both of which move with every
 * other axis. Assuming a gas price and sweeping around it would sweep entirely
 * on one side of the boundary in most cells and entirely on the other in the
 * rest.
 *
 * So: run the cell once with hunters switched off, look at what the wave
 * actually holds on the thirty-first day, and solve for the gas price at which
 * the median ghost's bounty exactly stops clearing a hunter's margin.
 */

import {
  DEFAULT_CONFIG,
  charterAccrued,
  createWorld,
  dormancyTicks,
  hunterMarginWad,
  mulBps,
  mulWad,
  minBig,
  populateGenesisCohort,
  resolveConfig,
  type ConfigOverrides,
} from '@thirty-first-day/protocol'

export interface GasBoundary {
  /** Gas price at which the median ghost is exactly break-even to report. */
  boundaryWei: bigint
  medianDormantBalance: bigint
  poolPriceWad: bigint
  reportableCharters: number
  /** Tick the measurement was taken at. */
  tick: number
}

/**
 * The gas price at which the median dormant balance is break-even.
 *
 * A hunter reports when `bounty x price >= gas x margin`, so the break-even
 * gas is `bounty x price / margin`. Below it the median ghost is worth
 * collecting; above it, it is not.
 */
export function calibrateGasBoundary(
  overrides: ConfigOverrides,
  seed: number,
  options: { settleHours?: number } = {},
): GasBoundary {
  const cfg = resolveConfig(overrides)
  // Hunters off, so nothing is collected and the wave is observed intact.
  const world = createWorld(
    { ...overrides, hunter: { ...(overrides.hunter ?? DEFAULT_CONFIG.hunter), count: 0 } },
    seed,
  )
  populateGenesisCohort(world, { withHunters: false })

  const settle = options.settleHours ?? cfg.hunter.scanLatencyHours
  const target = dormancyTicks(cfg) + settle
  for (let t = 0; t < target; t++) world.tick()

  const balances: bigint[] = []
  for (const charter of world.state.charters.values()) {
    if (!world.isReportable(charter.id)) continue
    balances.push(charterAccrued(world.state, charter))
  }
  balances.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const price = world.state.hunters.priceAtScanWad
  if (balances.length === 0 || price <= 0n) {
    return {
      boundaryWei: cfg.hunter.gasCostEth,
      medianDormantBalance: 0n,
      poolPriceWad: price,
      reportableCharters: 0,
      tick: world.state.tick,
    }
  }

  const median = balances[Math.floor(balances.length / 2)] as bigint
  const bounty = minBig(mulBps(median, cfg.informantBountyBps), cfg.informantBountyCapTokens)
  const bountyEth = mulWad(bounty, price)
  const margin = hunterMarginWad(cfg)
  const boundaryWei = margin > 0n ? (bountyEth * 10n ** 18n) / margin : bountyEth

  return {
    boundaryWei,
    medianDormantBalance: median,
    poolPriceWad: price,
    reportableCharters: balances.length,
    tick: world.state.tick,
  }
}
