/**
 * The seat market — whitepaper 12.
 *
 * Charters launch soulbound (whitepaper 6). A one-way switch can later enable
 * transfers, and then "selling a charter becomes a second exit path: the seat
 * moves whole, branches and balance included. A seat sale is an exit with zero
 * sell pressure on $STANDARD; the buyer replaces the seller one for one."
 *
 * These tests are the argument that the model implements that sentence
 * literally: that nothing moves through the pool, nothing is minted, nothing
 * is burned, and no branch is destroyed — and that the switch really is
 * one-way.
 */

import { describe, expect, it } from 'vitest'

import { createWorld, type World } from './world.js'
import { runArms } from './paired.js'
import { populateGenesisCohort } from './population.js'
import { DEFAULT_CONFIG, resolveConfig, type Config, type ConfigOverrides } from './config/index.js'
import { WAD, mulWad, tokens } from './math/fixed.js'
import { retirementNetTokens, sellerReservationEth } from './core/seats.js'
import { spotPrice } from './core/pool.js'
import { charterAccrued } from './core/ledger.js'
import type { Action, Agent, Archetype, TickResult, Wallet } from './types.js'

const DAY = 24

class ScriptedAgent implements Agent {
  private readonly queue = new Map<number, Action[]>()
  constructor(readonly id: string) {}
  at(tick: number, actions: Action[]): void {
    this.queue.set(tick, actions)
  }
  onTick(view: { tick: number }): Action[] {
    return this.queue.get(view.tick) ?? []
  }
}

/** No propensity to list: only a scripted listing happens. */
function noAutoListing(): Config['seat']['sellerDailyPropensityWad'] {
  return { committed: 0n, trader: 0n, casual: 0n, tourist: 0n, lost: 0n }
}

function allOf(archetype: Archetype): Config['cohortMixBps'] {
  const mix = { committed: 0n, trader: 0n, casual: 0n, tourist: 0n, lost: 0n }
  mix[archetype] = 10_000n
  return mix
}

/**
 * The base issuance rate, scaled to a cohort size.
 *
 * Per-branch yield is `baseRatePerDay x m / N`, so shrinking the cohort for a
 * fast test while leaving the base rate at its 1000-charter default inflates
 * every branch's yield — and with it every seat valuation — by the same
 * factor. Scaling keeps a test seat worth roughly what a real one is worth,
 * which is what makes buyer budgets meaningful.
 */
function scaledBaseRate(charters: number): bigint {
  return (DEFAULT_CONFIG.baseRatePerDayTokens * BigInt(charters)) / 1000n
}

/**
 * A world with nothing else moving: no outside traders, no hunters, a cohort
 * that never acts, and no automatic listing. Whatever changes, the seat market
 * changed it.
 */
function quietWorld(overrides: ConfigOverrides, seed: number): World {
  const world = createWorld(
    {
      genesisCharters: 8,
      baseRatePerDayTokens: scaledBaseRate(8),
      cohortMixBps: allOf('tourist'),
      hunter: { ...DEFAULT_CONFIG.hunter, count: 0 },
      externalDemand: { ...DEFAULT_CONFIG.externalDemand, traders: 0 },
      seat: {
        ...DEFAULT_CONFIG.seat,
        sellerDailyPropensityWad: noAutoListing(),
        buyers: { ...DEFAULT_CONFIG.seat.buyers, count: 4 },
      },
      ...overrides,
    },
    seed,
  )
  populateGenesisCohort(world)
  return world
}

function run(world: World, ticks: number): TickResult[] {
  const out: TickResult[] = []
  for (let t = 0; t < ticks; t++) out.push(world.tick())
  return out
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

describe('12 the one-way transfer switch', () => {
  it('is off by default, and every existing configuration is soulbound', () => {
    expect(DEFAULT_CONFIG.charterTransfersEnabledAtDay).toBeNull()
    const world = createWorld({ genesisCharters: 4 }, 1)
    run(world, DAY * 3)
    expect(world.transfersEnabled()).toBe(false)
    expect(() => world.actions.listSeat(0)).toThrow(/soulbound/i)
  })

  it('is impossible before day D and possible from day D', () => {
    const world = quietWorld({ charterTransfersEnabledAtDay: 5 }, 2)
    // Day 0 through the end of day 4: still soulbound.
    for (let t = 0; t < DAY * 5; t++) {
      expect(world.transfersEnabled(), `tick ${t}`).toBe(false)
      expect(() => world.actions.listSeat(0)).toThrow(/soulbound/i)
      world.tick()
    }
    // The switch is thrown at the start of day 5.
    expect(world.state.tick).toBe(DAY * 5)
    world.tick()
    expect(world.transfersEnabled()).toBe(true)
    expect(world.state.seatMarket.enabledAtTick).toBe(DAY * 5)
    expect(() => world.actions.listSeat(0)).not.toThrow()
  })

  it('cannot be reversed', () => {
    const world = quietWorld({ charterTransfersEnabledAtDay: 2 }, 3)
    let sawEnabled = false
    let previously = false
    for (let t = 0; t < DAY * 20; t++) {
      world.tick()
      const now = world.transfersEnabled()
      // Monotone: once true it never goes back.
      expect(previously && !now, `reversed at tick ${world.state.tick}`).toBe(false)
      previously = now
      if (now) sawEnabled = true
    }
    expect(sawEnabled).toBe(true)
    expect(world.transfersEnabled()).toBe(true)
    // There is no action that could turn it off.
    expect(() => world.apply({ type: 'disableTransfers' } as unknown as Action)).toThrow(
      /no such action/i,
    )
    expect(world.transfersEnabled()).toBe(true)
  })

  it('emits exactly one transfersEnabled event, on the configured day', () => {
    const world = quietWorld({ charterTransfersEnabledAtDay: 3 }, 4)
    const events = run(world, DAY * 10).flatMap((r) => r.events.filter((e) => e.type === 'transfersEnabled'))
    expect(events).toHaveLength(1)
    expect(events[0]?.type === 'transfersEnabled' && events[0].day).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('12 what a seller will accept', () => {
  it('uses the real pool quote, not spot price times amount', () => {
    // Retiring pays in $STANDARD. Turning that into ETH means selling into the
    // pool and eating the slippage — which is exactly why whitepaper 12 can
    // say a seat sale has zero sell pressure. A model that used spot would
    // price the two exit paths as equivalent and the claim would vanish.
    const cfg = resolveConfig({})
    const world = createWorld({}, 5)
    const pool = world.state.pool

    const balance = tokens(20_000_000) // large enough to move a 100e6 reserve
    const pressure = 0n
    const net = retirementNetTokens(cfg, balance, pressure)
    const realQuote = sellerReservationEth(cfg, pool, balance, pressure)
    const spotValue = mulWad(net, spotPrice(pool))

    expect(realQuote).toBeLessThan(spotValue)
    // On a fifth of the token reserve the gap is enormous, not a rounding
    // difference: the naive figure is more than 15% too high.
    expect(Number(spotValue - realQuote) / Number(spotValue)).toBeGreaterThan(0.15)

    // And on a size that does not move the pool, the two nearly agree.
    const small = tokens(1)
    const smallReal = sellerReservationEth(cfg, pool, small, pressure)
    const smallSpot = mulWad(retirementNetTokens(cfg, small, pressure), spotPrice(pool))
    expect(Number(smallSpot - smallReal) / Number(smallSpot)).toBeLessThan(0.01)
  })

  it('prices a seat above the seller reservation, by the value of the branches', () => {
    const world = quietWorld({ charterTransfersEnabledAtDay: 1 }, 6)
    run(world, DAY * 4)
    const valuation = world.valueSeat(0)
    const reservation = world.seatReservationEth(0)

    // The balance term is the seller's reservation seen from the other side.
    expect(valuation.discountedBalanceEth).toBe(reservation)
    // The buyer is weakly better off than the seller by the branch stream, so
    // a listed seat always clears if a funded buyer exists. That is not a
    // modelling accident — it is what makes a seat sale Pareto-improving, and
    // it means capacity, not price, is what limits the market.
    expect(valuation.npvEth > 0n).toBe(true)
    expect(valuation.totalEth).toBe(reservation + valuation.npvEth)
    expect(valuation.totalEth > reservation).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A sale
// ---------------------------------------------------------------------------

describe('12 what a sale does', () => {
  function saleWorld(seed: number, overrides: ConfigOverrides = {}): {
    world: World
    scripted: ScriptedAgent
  } {
    const world = quietWorld({ charterTransfersEnabledAtDay: 1, ...overrides }, seed)
    const scripted = new ScriptedAgent('scripted')
    world.addAgent(scripted)
    return { world, scripted }
  }

  it('moves the seat whole and touches nothing else', () => {
    const { world, scripted } = saleWorld(11)
    // List on a non-clearing tick, so the next clearing tick sees it.
    scripted.at(DAY * 2 + 3, [{ type: 'listSeat', charterId: 0 }])
    run(world, DAY * 3)

    const charter = world.state.charters.get(0)!
    const seller = charter.ownerId
    const branchesBefore = [...charter.branchIds]
    const balanceBefore = charterAccrued(world.state, charter)
    const sellerEthBefore = (world.state.wallets.get(seller) as Wallet).eth

    const before = world.history[world.history.length - 1]!
    const poolEthBefore = world.state.pool.ethReserve
    const poolStdBefore = world.state.pool.standardReserve
    const pendingProtocolBefore = world.state.vaults.pendingProtocolEth

    // The clearing tick.
    const result = world.tick()
    const sale = result.events.find((e) => e.type === 'seatSale')
    expect(sale?.type).toBe('seatSale')
    if (sale?.type !== 'seatSale') return

    const after = result.snapshot
    const buyer = sale.buyerId

    // -- Ownership moves; branches and balance do not.
    expect(charter.ownerId).toBe(buyer)
    expect(charter.ownerId).not.toBe(seller)
    expect(charter.transferred).toBe(true)
    expect(charter.branchIds).toEqual(branchesBefore)
    // The balance at transfer is exactly what the seat still holds afterwards:
    // clearing runs after issuance and after every agent action, and the sale
    // itself does not touch a single wei of it.
    expect(charterAccrued(world.state, charter)).toBe(sale.accruedBalance)
    // It is one tick of issuance above what it held before the tick began,
    // which is the accrual, not the sale.
    expect(sale.accruedBalance > balanceBefore).toBe(true)
    expect(sale.branchCount).toBe(branchesBefore.length)
    expect(sale.sellerId).toBe(seller)

    // -- The dormancy clock starts over (whitepaper 10, 12).
    expect(charter.lastInteractionTick).toBe(world.state.tick - 1)

    // -- ETH goes buyer to seller directly. The pool never sees it.
    expect(world.state.pool.ethReserve).toBe(poolEthBefore)
    expect(world.state.pool.standardReserve).toBe(poolStdBefore)
    expect(world.state.vaults.pendingProtocolEth).toBe(pendingProtocolBefore)
    expect((world.state.wallets.get(seller) as Wallet).eth).toBe(sellerEthBefore + sale.priceEth)
    expect((world.state.wallets.get(buyer) as Wallet).eth).toBe(
      DEFAULT_CONFIG.seat.buyers.budgetEth - sale.priceEth,
    )
    // Not a swap, so no swap event and no net flow.
    expect(result.events.some((e) => e.type === 'swap')).toBe(false)

    // -- Nothing minted, nothing burned, no branch destroyed.
    expect(after.totalBranches).toBe(before.totalBranches)
    expect(after.cumulativeBurns).toBe(before.cumulativeBurns)
    expect(after.cumulativeMints).toBe(before.cumulativeMints)
    expect(after.mintedToWallets).toBe(before.mintedToWallets)
    expect(after.circulating).toBe(before.circulating)
    expect(after.liveCharters).toBe(before.liveCharters)

    // -- The blind spot is recorded.
    expect(after.seatMarketEthVolume).toBe(sale.priceEth)
    expect(after.cumulativeSeatSales).toBe(1)
    expect(after.cumulativeBranchesTransferred).toBe(branchesBefore.length)
    // Whitepaper 4's flow signal saw none of it.
    expect(after.ethVolumeByOrigin.trader).toBe(before.ethVolumeByOrigin.trader)
  })

  it('clears at the midpoint of reservation and valuation', () => {
    const { world, scripted } = saleWorld(12)
    scripted.at(DAY * 2 + 3, [{ type: 'listSeat', charterId: 0 }])
    run(world, DAY * 3)
    const sale = world.tick().events.find((e) => e.type === 'seatSale')
    expect(sale?.type).toBe('seatSale')
    if (sale?.type !== 'seatSale') return
    expect(sale.priceEth).toBe((sale.valuationEth + sale.reservationEth) / 2n)
    expect(sale.priceEth >= sale.reservationEth).toBe(true)
    expect(sale.priceEth <= sale.valuationEth).toBe(true)
  })

  it('lets a lapsed listing expire without a sale', () => {
    const { world, scripted } = saleWorld(13, {
      seat: {
        ...DEFAULT_CONFIG.seat,
        sellerDailyPropensityWad: noAutoListing(),
        listingExpiryDays: 2,
        buyers: { ...DEFAULT_CONFIG.seat.buyers, count: 0 },
      },
    })
    scripted.at(DAY * 2, [{ type: 'listSeat', charterId: 0 }])
    const results = run(world, DAY * 8)
    expect(results.flatMap((r) => r.events.filter((e) => e.type === 'seatSale'))).toHaveLength(0)
    const expired = results.flatMap((r) => r.events.filter((e) => e.type === 'seatListingExpired'))
    expect(expired).toHaveLength(1)
    expect(world.state.seatMarket.listings.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// One charter per wallet, or not — F-05
// ---------------------------------------------------------------------------

describe('12 and 6 the charter limit after transferability', () => {
  function twoSaleWorld(limit: number, seed: number): { world: World; scripted: ScriptedAgent } {
    const world = createWorld(
      {
        genesisCharters: 6,
        baseRatePerDayTokens: scaledBaseRate(6),
        cohortMixBps: allOf('tourist'),
        hunter: { ...DEFAULT_CONFIG.hunter, count: 0 },
        externalDemand: { ...DEFAULT_CONFIG.externalDemand, traders: 0 },
        charterTransfersEnabledAtDay: 1,
        postTransferCharterLimit: limit,
        seat: {
          ...DEFAULT_CONFIG.seat,
          sellerDailyPropensityWad: noAutoListing(),
          // One buyer, so the limit is the only thing that can stop a second
          // acquisition.
          buyers: { ...DEFAULT_CONFIG.seat.buyers, count: 1, budgetEth: 200n * WAD },
        },
      },
      seed,
    )
    populateGenesisCohort(world)
    const scripted = new ScriptedAgent('scripted')
    world.addAgent(scripted)
    return { world, scripted }
  }

  it('one per wallet blocks a second acquisition', () => {
    const { world, scripted } = twoSaleWorld(1, 21)
    scripted.at(DAY * 2 + 3, [{ type: 'listSeat', charterId: 0 }])
    scripted.at(DAY * 4 + 3, [{ type: 'listSeat', charterId: 1 }])
    const results = run(world, DAY * 8)
    const sales = results.flatMap((r) => r.events.filter((e) => e.type === 'seatSale'))
    expect(sales).toHaveLength(1)
    expect(world.state.charters.get(0)!.ownerId).toBe('seat-buyer-0')
    expect(world.state.charters.get(1)!.ownerId).not.toBe('seat-buyer-0')
    // The second listing is still open, unsold.
    expect(world.state.seatMarket.listings.has(1)).toBe(true)
  })

  it('unlimited lets seats accumulate, and concentration responds', () => {
    const { world, scripted } = twoSaleWorld(Number.POSITIVE_INFINITY, 22)
    scripted.at(DAY * 2 + 3, [{ type: 'listSeat', charterId: 0 }])
    scripted.at(DAY * 4 + 3, [{ type: 'listSeat', charterId: 1 }])
    const results = run(world, DAY * 8)
    const sales = results.flatMap((r) => r.events.filter((e) => e.type === 'seatSale'))
    expect(sales).toHaveLength(2)
    expect(world.state.charters.get(0)!.ownerId).toBe('seat-buyer-0')
    expect(world.state.charters.get(1)!.ownerId).toBe('seat-buyer-0')

    const last = world.history[world.history.length - 1]!
    // One wallet now holds two of six seats.
    expect(last.largestHolderBranchShare).toBe((2n * WAD) / 6n)
    expect(last.concentrationHHI > 0n).toBe(true)
    // Strictly more concentrated than the one-per-wallet world at the same point.
    const limited = twoSaleWorld(1, 22)
    limited.scripted.at(DAY * 2 + 3, [{ type: 'listSeat', charterId: 0 }])
    limited.scripted.at(DAY * 4 + 3, [{ type: 'listSeat', charterId: 1 }])
    run(limited.world, DAY * 8)
    const limitedLast = limited.world.history[limited.world.history.length - 1]!
    expect(last.concentrationHHI > limitedLast.concentrationHHI).toBe(true)
    expect(last.largestHolderBranchShare > limitedLast.largestHolderBranchShare).toBe(true)
  })

  it('reports no concentration at all while charters are soulbound', () => {
    // Not "concentration is zero" — not computed, because ownership is one
    // charter per wallet by construction and a full scan every tick would cost
    // every soulbound cell something for a known answer.
    const world = createWorld({ genesisCharters: 20 }, 23)
    run(world, DAY * 2)
    const last = world.history[world.history.length - 1]!
    expect(last.concentrationHHI).toBe(0n)
    expect(last.largestHolderBranchShare).toBe(0n)
  })
})

// ---------------------------------------------------------------------------
// Against the wave
// ---------------------------------------------------------------------------

describe('12 against the day-31 wave', () => {
  it('transfers on at day 15 produce strictly fewer day-31 revocations', () => {
    // A caveat worth stating, because it is not universal: whether the *count*
    // of revocations falls by day 31 depends on whether the wave is
    // backlog-bound or throughput-bound. At the full 1000-charter scale with
    // the default `maxReportsPerHour`, the hunters are saturated for the first
    // days of the wave and clearing 100 charters off the backlog changes
    // nothing about how many get processed — the benefit only appears once the
    // hunters would otherwise have caught up. What *is* universal is that the
    // backlog itself shrinks, which is asserted below alongside the count.
    const run15 = runArms(
      {
        genesisCharters: 150,
        baseRatePerDayTokens: scaledBaseRate(150),
        charterTransfersEnabledAtDay: 15,
      },
      31,
      { ticks: DAY * 32 },
    )
    expect(run15.transferable).not.toBeNull()
    const transferable = run15.transferable
    if (transferable === null) return

    const treatmentAt31 = run15.treatment.history[DAY * 32 - 1]!
    const transferableAt31 = transferable.history[DAY * 32 - 1]!

    expect(treatmentAt31.cumulativeRevoked).toBeGreaterThan(0)
    expect(transferableAt31.cumulativeRevoked).toBeLessThan(treatmentAt31.cumulativeRevoked)
    // The mechanism, which holds whether or not the count has moved yet: a
    // seat sold before day 30 never joins the queue at all, so the backlog
    // never gets as large. (The backlog at any one instant may already be
    // cleared in both arms, which is why this is the peak and not a snapshot.)
    const peak = (world: World): number =>
      world.history.reduce((most, s) => Math.max(most, s.reportableCharters), 0)
    expect(peak(transferable)).toBeLessThan(peak(run15.treatment))
    // Seats that sold kept their branches.
    expect(transferable.state.seatMarket.cumulativeSales).toBeGreaterThan(0)
    expect(transferableAt31.totalBranches).toBeGreaterThan(treatmentAt31.totalBranches)
    // And the capital that bought them never went through the pool.
    expect(transferableAt31.seatMarketEthVolume > 0n).toBe(true)
    expect(transferableAt31.ethVolumeByOrigin.revocationPayout).toBeLessThan(
      treatmentAt31.ethVolumeByOrigin.revocationPayout,
    )
  }, 120_000)
})
