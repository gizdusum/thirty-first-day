/**
 * One worked seat sale, printed in full.
 *
 * Whitepaper 12 says a seat sale is "an exit with zero sell pressure on
 * $STANDARD; the buyer replaces the seller one for one". This prints what that
 * actually means for a single seat: what the seller would have got from each
 * of the three exit paths, what the buyer thought the seat was worth, and
 * where the two met.
 *
 *   pnpm tsx packages/study/scripts/seat-sale.ts [seed]
 */

import {
  DEFAULT_CONFIG,
  charterAccrued,
  createWorld,
  mulBps,
  mulWad,
  populateGenesisCohort,
  quoteEthOut,
  resolutionFeeRate,
  resolutionPressure,
  resolveConfig,
  retirementNetTokens,
  spotPrice,
  type Action,
  type Agent,
  type World,
} from '@thirty-first-day/protocol'

const seed = Number(process.argv[2] ?? 4242)
const DAY = 24

class Scripted implements Agent {
  readonly id = 'scripted'
  private readonly queue = new Map<number, Action[]>()
  at(tick: number, actions: Action[]): void {
    this.queue.set(tick, actions)
  }
  onTick(view: { tick: number }): Action[] {
    return this.queue.get(view.tick) ?? []
  }
}

const tokensFmt = (v: bigint): string =>
  `${(Number(v) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 })} $STANDARD`
const ethFmt = (v: bigint): string => `${(Number(v) / 1e18).toFixed(6)} ETH`
const pct = (v: bigint): string => `${((Number(v) / 1e18) * 100).toFixed(2)}%`

/**
 * Two identical worlds, same seed. Only one of them lists the seat.
 *
 * Everything else in the hour — bankers withdrawing, traders swapping, the
 * contraction vault buying back — happens in both. Diffing them is the only
 * way to say what the *sale* did, as opposed to what the hour did.
 */
function build(withListing: boolean): { world: World; scripted: Scripted } {
  const world: World = createWorld(
    {
      genesisCharters: 1000,
      charterTransfersEnabledAtDay: 1,
      seat: {
        ...DEFAULT_CONFIG.seat,
        // No automatic listing: this script lists one specific seat, or none.
        sellerDailyPropensityWad: { committed: 0n, trader: 0n, casual: 0n, tourist: 0n, lost: 0n },
      },
    },
    seed,
  )
  populateGenesisCohort(world)
  const scripted = new Scripted()
  world.addAgent(scripted)
  void withListing
  return { world, scripted }
}

const sold = build(true)
const notSold = build(false)
const world = sold.world

// Pick a Tourist: the archetype the dormancy wave is coming for.
const target = [...world.state.charters.values()].find((c) => c.archetype === 'tourist')
if (target === undefined) throw new Error('no tourist charter in this cohort')

sold.scripted.at(DAY * 20 + 3, [{ type: 'listSeat', charterId: target.id }])
for (let t = 0; t < DAY * 21; t++) {
  sold.world.tick()
  notSold.world.tick()
}

const cfg = resolveConfig(world.config)
const state = world.state
const balanceBefore = charterAccrued(state, target)
const pressure = resolutionPressure(cfg, state.withdrawals.trailingTotal, state.ledger.totalAccrued)
const feeRate = resolutionFeeRate(cfg, pressure)

console.log('A WORKED SEAT SALE')
console.log('='.repeat(72))
console.log(`seed ${seed}   charter ${target.id}   archetype ${target.archetype}`)
console.log(`branches ${target.branchIds.length}   accrued balance ${tokensFmt(balanceBefore)}`)
console.log(`pool: ${ethFmt(state.pool.ethReserve)} / ${tokensFmt(state.pool.standardReserve)}`)
console.log(`spot ${(Number(spotPrice(state.pool)) / 1e18).toExponential(4)} ETH per $STANDARD`)
console.log('')

// -- Path (a): retire every branch -----------------------------------------
const netTokens = retirementNetTokens(cfg, balanceBefore, pressure)
const retireEth = quoteEthOut(state.pool, cfg, netTokens)
const naiveEth = mulWad(netTokens, spotPrice(state.pool))
console.log('(a) RETIRE ALL BRANCHES  — paid in $STANDARD, branches destroyed, charter burned')
console.log(`    accrued balance          ${tokensFmt(balanceBefore)}`)
console.log(`    resolution fee (P=${pct(pressure)})   ${pct(feeRate)}  = ${tokensFmt(mulWad(balanceBefore, feeRate))}`)
console.log(`    net proceeds             ${tokensFmt(netTokens)}`)
console.log(`    sold into the pool       ${ethFmt(retireEth)}   <- the seller reservation`)
console.log(`    at spot x amount         ${ethFmt(naiveEth)}   (naive; overstates by ${ethFmt(naiveEth - retireEth)})`)
console.log('')

// -- Path (b): go dormant ---------------------------------------------------
const revocationFee = mulBps(balanceBefore, cfg.revocationFeeBps)
const bankerShare = balanceBefore - revocationFee
const dormantEth = quoteEthOut(state.pool, cfg, bankerShare)
console.log('(b) GO DORMANT  — eventually reported, 70% revocation fee (whitepaper 10)')
console.log(`    revocation fee           ${tokensFmt(revocationFee)}  (half burned, half to actives)`)
console.log(`    minted to the banker     ${tokensFmt(bankerShare)}`)
console.log(`    if sold into the pool    ${ethFmt(dormantEth)}`)
console.log('')

// -- Path (c): sell the seat -----------------------------------------------
const valuation = world.valueSeat(target.id)
const reservation = world.seatReservationEth(target.id)
console.log('(c) SELL THE SEAT  — paid in ETH, branches survive, pool untouched')
console.log(`    seller reservation       ${ethFmt(reservation)}`)
console.log(`    buyer valuation          ${ethFmt(valuation.totalEth)}`)
console.log(`      discounted balance     ${ethFmt(valuation.discountedBalanceEth)}`)
console.log(
  `      NPV of ${cfg.seat.buyerHorizonDays}d issuance  ${ethFmt(valuation.npvEth)}  ` +
    `(${tokensFmt(valuation.expectedYieldPerBranchPerDay)}/branch/day at ${(Number(cfg.seat.buyerDiscountRatePerDayWad) / 1e16).toFixed(3)}%/day)`,
)
console.log('')

const before = world.history[world.history.length - 1]
const result = world.tick()
const control = notSold.world.tick()
const sale = result.events.find((e) => e.type === 'seatSale')
if (sale === undefined || sale.type !== 'seatSale') {
  console.log('no sale cleared this tick')
  process.exit(1)
}
const after = result.snapshot
const withoutSale = control.snapshot

console.log('THE CLEARING')
console.log('-'.repeat(72))
console.log(`    reservation              ${ethFmt(sale.reservationEth)}`)
console.log(`    valuation                ${ethFmt(sale.valuationEth)}`)
console.log(`    clearing price (midpoint)${ethFmt(sale.priceEth)}`)
console.log(`    buyer                    ${sale.buyerId}`)
console.log('')
console.log('WHO GAINED WHAT, AGAINST THE ALTERNATIVES')
console.log('-'.repeat(72))
console.log(`    seller, selling          ${ethFmt(sale.priceEth)}`)
console.log(`    seller, retiring   (a)   ${ethFmt(retireEth)}   -> selling is ${ethFmt(sale.priceEth - retireEth)} better`)
console.log(`    seller, dormant    (b)   ${ethFmt(dormantEth)}   -> selling is ${ethFmt(sale.priceEth - dormantEth)} better`)
console.log(`    buyer surplus            ${ethFmt(sale.valuationEth - sale.priceEth)}  (valuation less what was paid)`)
console.log('')
console.log('WHAT THE SALE DID, AGAINST AN IDENTICAL WORLD THAT DID NOT SELL')
console.log('-'.repeat(72))
console.log('    (both worlds ran the same seed and the same hour; only the listing differs)')
const rows: Array<[string, bigint, bigint]> = [
  ['pool ETH reserve', withoutSale.poolEthReserve, after.poolEthReserve],
  ['pool $STANDARD reserve', withoutSale.poolStandardReserve, after.poolStandardReserve],
  ['circulating supply', withoutSale.circulating, after.circulating],
  ['cumulative burns', withoutSale.cumulativeBurns, after.cumulativeBurns],
  ['cumulative mints', withoutSale.cumulativeMints, after.cumulativeMints],
  ['minted to wallets', withoutSale.mintedToWallets, after.mintedToWallets],
  ['F_n this epoch', withoutSale.currentEpochNetFlow, after.currentEpochNetFlow],
  ['trader ETH volume', withoutSale.ethVolumeByOrigin.trader, after.ethVolumeByOrigin.trader],
]
for (const [label, a, b] of rows) {
  const same = a === b
  console.log(`    ${label.padEnd(24)} ${same ? 'unchanged' : `CHANGED by ${ethFmt(b - a)}`}`)
}
console.log(
  `    ${'total branches'.padEnd(24)} ${withoutSale.totalBranches === after.totalBranches ? 'unchanged' : 'CHANGED'}  (${withoutSale.totalBranches} vs ${after.totalBranches})`,
)
console.log('')
console.log(`    seatMarketEthVolume      ${ethFmt(after.seatMarketEthVolume)}   <- capital that entered the`)
console.log('                                              economy without the net flow')
console.log('                                              signal seeing a wei of it (F-06)')
