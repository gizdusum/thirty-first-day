/**
 * The Standard Reserve — the dormancy study.
 *
 * `invariants.spec.ts` asserts that the protocol model is a faithful reading
 * of the whitepaper. This file asserts the things the *study* depends on: that
 * the genesis cohort is heterogeneous and its branch share emerges rather than
 * being assumed, that reporting is an economic act with a profitability floor
 * below it, that the wave is synchronized, that the 30% payout reaches the
 * pool, and — most important of all — that the paired counterfactual is clean.
 *
 * Like `invariants.spec.ts`, this is a public artifact. Assertions carry the
 * whitepaper section they concern where there is one, and the study section
 * where there is not.
 */

import { describe, expect, it } from 'vitest'

import { createWorld, type World } from './world.js'
import { ARMS, runArms, runPaired } from './paired.js'
import { populateGenesisCohort } from './population.js'
import { cohortCounts } from './cohort.js'
import {
  DEFAULT_CONFIG,
  dormancyTicks,
  hunterMarginWad,
  resolveConfig,
  type Config,
  type ConfigOverrides,
} from './config/index.js'
import { BPS, WAD, divExact, mulBps, mulWad, prepareDivisor, tokens } from './math/fixed.js'
import { createRng } from './rng/xoshiro128.js'
import { escalatedGasEth, profitabilityFloor } from './core/hunters.js'
import { charterAccrued } from './core/ledger.js'
import { spotPrice } from './core/pool.js'
import type { Action, Agent, Archetype, Event, TickResult, Wallet } from './types.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Emits a pre-set batch of actions on its next tick. */
class ScriptedAgent implements Agent {
  private readonly queue: Action[][] = []
  constructor(readonly id: string) {}
  enqueue(actions: Action[]): void {
    this.queue.push(actions)
  }
  onTick(): Action[] {
    return this.queue.shift() ?? []
  }
}

function hunterConfig(patch: Partial<Config['hunter']>): Config['hunter'] {
  return { ...DEFAULT_CONFIG.hunter, ...patch }
}

function onlyCommitted(): Config['cohortMixBps'] {
  return { committed: BPS, trader: 0n, casual: 0n, tourist: 0n, lost: 0n }
}

function studyWorld(overrides: ConfigOverrides, seed: number, populate = true): World {
  const world = createWorld(overrides, seed)
  if (populate) populateGenesisCohort(world)
  return world
}

function run(world: World, ticks: number): TickResult[] {
  const results: TickResult[] = []
  for (let t = 0; t < ticks; t++) results.push(world.tick())
  return results
}

function eventsOf<T extends Event['type']>(
  results: readonly TickResult[],
  type: T,
): Array<Extract<Event, { type: T }>> {
  const out: Array<Extract<Event, { type: T }>> = []
  for (const result of results) {
    for (const event of result.events) {
      if (event.type === type) out.push(event as Extract<Event, { type: T }>)
    }
  }
  return out
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
}

const DAY = 24

// ---------------------------------------------------------------------------
// 0. The mint split
// ---------------------------------------------------------------------------

describe('0 the mint split', () => {
  it('separates real mints from the notional counterpart of a ledger burn', () => {
    const world = studyWorld({ genesisCharters: 60 }, 11)
    run(world, DAY * 35)
    const token = world.state.token

    expect(token.mintedToWallets + token.notionalMints).toBe(token.cumulativeMints)
    // Only a resolution fee (whitepaper 9) or a revocation fee (10) burns value
    // that was never minted, so those two burn sources are exactly the
    // notional half.
    expect(token.burnsBySource.resolutionFee + token.burnsBySource.revocationFee).toBe(
      token.notionalMints,
    )
    // Licenses (7) and buybacks (11) burn tokens that were already circulating,
    // so they contribute nothing to it.
    expect(token.burnsBySource.license > 0n).toBe(true)
    expect(token.mintedToWallets > 0n).toBe(true)
    expect(token.notionalMints > 0n).toBe(true)

    // The sell-pressure figure is exact, and it can be located: every
    // circulating token is in a wallet, in the pool, or waiting to be paired
    // into POL. Notional mints appear nowhere, because nobody ever holds one.
    let held = 0n
    for (const wallet of world.state.wallets.values()) held += wallet.standard
    const pool = world.state.pool
    expect(held + pool.standardReserve + pool.pendingPolStandard).toBe(
      DEFAULT_CONFIG.polPremintTokens +
        token.mintedToWallets -
        token.burnsBySource.license -
        token.burnsBySource.buyback,
    )
  })
})

// ---------------------------------------------------------------------------
// 2. The genesis cohort
// ---------------------------------------------------------------------------

describe('2 the genesis cohort', () => {
  it('splits 1000 charters into the configured mix, exactly', () => {
    const world = studyWorld({}, 3, false)
    const counts = cohortCounts(world.config)
    const observed = new Map<Archetype, number>()
    for (const charter of world.state.charters.values()) {
      observed.set(charter.archetype, (observed.get(charter.archetype) ?? 0) + 1)
    }
    let total = 0
    for (const [archetype, expected] of Object.entries(counts) as Array<[Archetype, number]>) {
      expect(observed.get(archetype) ?? 0, `${archetype} count`).toBe(expected)
      total += expected
    }
    expect(total).toBe(1000)
    // The mix sums to 1.0 by construction; `validateConfig` rejects any that
    // does not.
    const mix = world.config.cohortMixBps
    expect(mix.committed + mix.trader + mix.casual + mix.tourist + mix.lost).toBe(BPS)
  })

  it('shuffles archetypes across charter ids so no cohort gets auction priority', () => {
    // Charter id order is the order actions are applied in, and the license
    // auction is first come, first served (whitepaper 8). If archetypes were
    // laid out in blocks, one cohort would always bid first.
    const world = studyWorld({}, 3, false)
    const firstHundred = new Set<Archetype>()
    for (let id = 0; id < 100; id++) {
      firstHundred.add(world.state.charters.get(id)!.archetype)
    }
    expect(firstHundred.size).toBeGreaterThan(3)
  })

  it('lets the dormant cohort branch share emerge, well below its charter share', () => {
    // This is the single most important modelling detail in the study.
    // Tourists and Lost never buy a license, so on day 30 they still hold the
    // one branch they minted with, while committed bankers have expanded. The
    // dormant cohort is therefore a much smaller share of N than it is of the
    // charter count, and that is what dampens the drop in N.
    const world = studyWorld({ genesisCharters: 300, hunter: hunterConfig({ count: 0 }) }, 5)
    run(world, DAY * 30)
    const snapshot = world.history[world.history.length - 1]!

    expect(snapshot.reportableCharters).toBeGreaterThan(0)
    expect(snapshot.dormantCohort.charterShare).toBeGreaterThan(0n)
    expect(
      snapshot.dormantCohort.branchShare < snapshot.dormantCohort.charterShare,
      'the dormant cohort must hold a smaller share of branches than of charters',
    ).toBe(true)

    // And it emerges from behaviour, not from a parameter: the committed
    // cohort is holding more than one branch each by now.
    let committedBranches = 0
    let committedCharters = 0
    let dormantBranches = 0
    let dormantCharters = 0
    for (const charter of world.state.charters.values()) {
      if (charter.archetype === 'committed') {
        committedCharters += 1
        committedBranches += charter.branchIds.length
      }
      if (charter.archetype === 'tourist' || charter.archetype === 'lost') {
        dormantCharters += 1
        dormantBranches += charter.branchIds.length
      }
    }
    expect(committedBranches).toBeGreaterThan(committedCharters)
    // Tourists and Lost never bought anything.
    expect(dormantBranches).toBe(dormantCharters)
  })

  it('exposes a marked override for sensitivity analysis only', () => {
    const world = studyWorld(
      { genesisCharters: 40, dormantGenesisBranchesOverride: 4, hunter: hunterConfig({ count: 0 }) },
      5,
      false,
    )
    for (const charter of world.state.charters.values()) {
      const expected = charter.archetype === 'tourist' || charter.archetype === 'lost' ? 4 : 1
      expect(charter.branchIds.length, `charter ${charter.id} (${charter.archetype})`).toBe(expected)
    }
    // The base case leaves it null, so nothing is assumed.
    expect(DEFAULT_CONFIG.dormantGenesisBranchesOverride).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. Bounty hunter economics
// ---------------------------------------------------------------------------

describe('3 bounty hunter economics', () => {
  it('never reports a charter below the profitability floor', () => {
    const world = studyWorld({ genesisCharters: 150 }, 21)
    const results = run(world, DAY * 40)

    let checked = 0
    for (const result of results) {
      for (const event of result.events) {
        if (event.type !== 'revocation') continue
        // The floor is fixed for the hour, before any hunter acts, and the
        // hunters value bounties at the same price it was computed from.
        expect(
          event.dormantBalance >= result.snapshot.profitabilityFloorTokens,
          `revocation of ${event.dormantBalance} below floor ${result.snapshot.profitabilityFloorTokens}`,
        ).toBe(true)
        expect(result.snapshot.profitabilityFloorUnreachable).toBe(false)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('never submits at a loss under its own margin rule', () => {
    const world = studyWorld({ genesisCharters: 150 }, 22)
    const results = run(world, DAY * 40)
    const reports = eventsOf(results, 'hunterReport')
    expect(reports.length).toBeGreaterThan(0)

    const margin = hunterMarginWad(world.config)
    for (const report of reports) {
      expect(report.requiredEth).toBe(mulWad(report.gasPaidEth, margin))
      expect(
        report.bountyValueEth >= report.requiredEth,
        `hunter ${report.hunterId} submitted for ${report.bountyValueEth} against ${report.requiredEth}`,
      ).toBe(true)
      // Escalation is applied for exactly the contenders that showed up.
      expect(report.gasPaidEth).toBe(escalatedGasEth(world.config, report.contenders))
    }
  })

  it('leaves ghosts below the floor uncollected forever', () => {
    // The finding this has to produce cleanly. Raise the gas until the 2%
    // bounty on a thirty-day balance cannot pay for the transaction, and the
    // dormant charters are never cleaned up: they keep their branches and keep
    // diluting every active banker.
    const world = studyWorld(
      { genesisCharters: 150, hunter: hunterConfig({ gasCostEth: WAD / 2n }) },
      23,
    )
    const results = run(world, DAY * 45)

    const last = results[results.length - 1]!.snapshot
    expect(last.cumulativeRevoked).toBe(0)
    expect(last.reportableCharters).toBeGreaterThan(0)
    // Every reportable charter is below the floor, and they are still holding
    // branches.
    expect(last.ghostsBelowFloor.count).toBe(last.reportableCharters)
    expect(last.ghostsBelowFloor.branches).toBeGreaterThan(0)
    expect(eventsOf(results, 'hunterReport').length).toBe(0)
    expect(world.state.hunters.cumulativeGasSpentEth).toBe(0n)
  })

  it('computes the floor as the balance whose 2% bounty just clears the margin', () => {
    const cfg = resolveConfig({})
    const price = WAD / 50_000n // 2e-5 ETH per token
    const floor = profitabilityFloor(cfg, price, cfg.hunter.gasCostEth)
    expect(floor.unreachable).toBe(false)

    // A balance at the floor pays a bounty worth at least the margin...
    const bountyAtFloor = mulBps(floor.tokens, cfg.informantBountyBps)
    expect(mulWad(bountyAtFloor, price) >= mulWad(cfg.hunter.gasCostEth, hunterMarginWad(cfg))).toBe(
      true,
    )
    // ...and the floor rises as the price falls, which is exactly when the
    // backlog is largest.
    const cheaper = profitabilityFloor(cfg, price / 2n, cfg.hunter.gasCostEth)
    expect(cheaper.tokens > floor.tokens).toBe(true)
    // The bounty cap can put the floor out of reach entirely.
    const collapsed = profitabilityFloor(cfg, WAD / 100_000_000n, cfg.hunter.gasCostEth)
    expect(collapsed.unreachable).toBe(true)
  })

  it('runs a gas war: one report lands, every contender pays', () => {
    const world = studyWorld(
      {
        genesisCharters: 60,
        hunter: hunterConfig({
          count: 5,
          maxReportsPerHour: 1,
          scanLatencyHours: 0,
          // Cheap enough that escalation never prices anyone out, so all five
          // really do contend.
          gasCostEth: WAD / 1_000_000n,
        }),
      },
      24,
    )
    const results = run(world, DAY * 31)

    // The first hour in which anything is reported.
    const contested = results.find((r) => r.events.some((e) => e.type === 'hunterReport'))
    expect(contested).toBeDefined()
    if (contested === undefined) return

    const reports = contested.events.filter((e) => e.type === 'hunterReport')
    expect(reports.length).toBe(5)
    const charterIds = new Set(reports.map((r) => r.charterId))
    expect(charterIds.size, 'all five contend for the same charter').toBe(1)
    expect(reports.filter((r) => r.won).length, 'exactly one lands').toBe(1)
    expect(contested.events.filter((e) => e.type === 'revocation').length).toBe(1)

    // Everyone paid the escalated price, winner and losers alike.
    const escalated = escalatedGasEth(world.config, 5)
    for (const report of reports) {
      expect(report.contenders).toBe(5)
      expect(report.gasPaidEth).toBe(escalated)
    }
    expect(escalated > world.config.hunter.gasCostEth, 'contention raises the gas').toBe(true)
    const hunterIds = new Set(reports.map((r) => r.hunterId))
    expect(hunterIds.size, 'five distinct hunters').toBe(5)
  })

  it('bounds throughput, so a synchronized wave takes time to clear', () => {
    const world = studyWorld(
      { genesisCharters: 200, hunter: hunterConfig({ maxReportsPerHour: 2, scanLatencyHours: 0 }) },
      25,
    )
    const results = run(world, DAY * 34)
    for (const result of results) {
      expect(result.snapshot.revokedThisTick).toBeLessThanOrEqual(2)
    }
    const wave = results.filter((r) => r.snapshot.revokedThisTick > 0)
    expect(wave.length).toBeGreaterThan(4)
  })
})

// ---------------------------------------------------------------------------
// 4. The wave
// ---------------------------------------------------------------------------

describe('4 the wave', () => {
  it('turns the whole synchronized cohort reportable inside one hour', () => {
    const world = studyWorld(
      { genesisCharters: 200, hunter: hunterConfig({ count: 0 }) },
      31,
    )
    const results = run(world, DAY * 31)
    const before = results[DAY * 30 - 2]!.snapshot // end of tick 718 => tick 719
    const at = results[DAY * 30 - 1]!.snapshot // end of tick 719 => tick 720

    expect(before.tick).toBe(DAY * 30 - 1)
    expect(at.tick).toBe(DAY * 30)
    expect(before.reportableCharters).toBe(0)

    // Everyone whose clock never moved becomes reportable in the same hour
    // (whitepaper 6: all genesis charters are created at t = 0; 10: the clock
    // only resets on interaction).
    let untouched = 0
    for (const charter of world.state.charters.values()) {
      if (charter.alive && charter.lastInteractionTick === 0) untouched += 1
    }
    expect(at.reportableCharters).toBe(untouched)
    expect(at.reportableCharters).toBeGreaterThan(0)
    expect(at.reportableCharters - before.reportableCharters).toBe(untouched)

    // With no hunters registered, nothing is collected.
    expect(at.cumulativeRevoked).toBe(0)
    expect(at.totalBranches).toBe(before.totalBranches)
  })

  it('drops totalBranches by exactly the branches the revoked charters held', () => {
    const world = studyWorld({ genesisCharters: 150 }, 32)
    const results = run(world, DAY * 40)

    let ticksWithRevocations = 0
    let previousBranches = world.config.genesisCharters
    for (const result of results) {
      const revocations = result.events.filter((e) => e.type === 'revocation')
      const destroyed = revocations.reduce((sum, e) => sum + e.branchesDestroyed, 0)
      expect(result.snapshot.branchesDestroyedThisTick).toBe(destroyed)
      expect(result.snapshot.revokedThisTick).toBe(revocations.length)
      // Same tick, exactly: nothing lags a hour behind.
      expect(result.snapshot.totalBranches).toBe(
        previousBranches +
          result.snapshot.branchesOpenedThisTick -
          result.snapshot.branchesRetiredThisTick -
          destroyed,
      )
      previousBranches = result.snapshot.totalBranches
      if (revocations.length > 0) ticksWithRevocations += 1
    }
    expect(ticksWithRevocations).toBeGreaterThan(0)
  })

  it('raises the yield of every surviving branch by exactly base * m / N', () => {
    const world = studyWorld({ genesisCharters: 150 }, 33)
    const results = run(world, DAY * 40)
    const revocations = eventsOf(results, 'revocation')
    expect(revocations.length).toBeGreaterThan(0)

    const base = world.config.baseRatePerDayTokens
    for (const event of revocations) {
      const issuancePerDay = mulWad(base, event.multiplier)
      expect(event.totalBranchesAfter).toBe(event.totalBranchesBefore - event.branchesDestroyed)
      expect(event.yieldPerBranchBefore).toBe(issuancePerDay / BigInt(event.totalBranchesBefore))
      expect(event.yieldPerBranchAfter).toBe(issuancePerDay / BigInt(event.totalBranchesAfter))
      expect(
        event.yieldPerBranchAfter >= event.yieldPerBranchBefore,
        'destroying branches cannot lower the survivors yield',
      ).toBe(true)
    }
  })

  it('labels the genesis wave 1 and the Casual tail above it', () => {
    const world = studyWorld({ genesisCharters: 250 }, 34)
    const results = run(world, DAY * 100)
    const revocations = eventsOf(results, 'revocation')
    expect(revocations.length).toBeGreaterThan(0)

    // The wave index never goes backwards, and the first revocation opens it.
    let last = 0
    for (const event of revocations) {
      expect(event.waveIndex >= last).toBe(true)
      last = event.waveIndex
    }
    expect(revocations[0]!.waveIndex).toBe(1)

    const waveOne = revocations.filter((e) => e.waveIndex === 1)
    const tail = revocations.filter((e) => e.waveIndex > 1)
    // Wave 1 is the synchronized genesis cohort: it is the big one, and it
    // starts on the thirty-first day.
    expect(waveOne.length).toBeGreaterThan(tail.length)
    expect(waveOne[0]!.tick).toBe(dormancyTicks(world.config) + world.config.hunter.scanLatencyHours)
    // The tail is the Casual cohort lapsing later, and it is separated from
    // wave 1 by a gap.
    expect(tail.length).toBeGreaterThan(0)
    expect(tail[0]!.tick - waveOne[waveOne.length - 1]!.tick).toBeGreaterThanOrEqual(
      world.config.waveGapHours,
    )
    for (const event of tail) expect(event.archetype).toBe('casual')
  })
})

// ---------------------------------------------------------------------------
// 5. The 30% payout
// ---------------------------------------------------------------------------

describe('5 the 30% payout', () => {
  it('mints exactly the remaining 30% to the dormant banker', () => {
    const world = createWorld({ genesisCharters: 6 }, 41)
    const scripted = new ScriptedAgent('scripted')
    world.addAgent(scripted)
    run(world, dormancyTicks(world.config))

    const mintedBefore = world.state.token.mintedToWallets
    scripted.enqueue([{ type: 'reportDormant', reporterId: 'hunter-x', charterId: 0 }])
    const result = world.tick()
    const event = result.events.find((e) => e.type === 'revocation')
    expect(event?.type).toBe('revocation')
    if (event?.type !== 'revocation') return

    const cfg = world.config
    const fee = mulBps(event.dormantBalance, cfg.revocationFeeBps)
    expect(event.bankerShare).toBe(event.dormantBalance - fee)
    // 30%, to within the wei the 70% floor leaves behind.
    const thirty = (event.dormantBalance * 3_000n) / BPS
    expect(event.bankerShare - thirty <= 1n).toBe(true)
    expect(event.bankerShare >= thirty).toBe(true)

    // Nothing else minted this tick, so the whole increase is the payout plus
    // the informant's bounty.
    expect(world.state.token.mintedToWallets - mintedBefore).toBe(event.bankerShare + event.bounty)
    expect(world.state.credits.get('banker-0')!.revocationPayout).toBe(event.bankerShare)
    expect(world.state.credits.get('hunter-x')!.bounty).toBe(event.bounty)
  })

  it('mints 28% under the alternative reading of section 10', () => {
    const world = createWorld({ genesisCharters: 6, dormancyBountySource: 'bankerShare' }, 42)
    const scripted = new ScriptedAgent('scripted')
    world.addAgent(scripted)
    run(world, dormancyTicks(world.config))

    scripted.enqueue([{ type: 'reportDormant', reporterId: 'hunter-x', charterId: 0 }])
    const event = world.tick().events.find((e) => e.type === 'revocation')
    expect(event?.type).toBe('revocation')
    if (event?.type !== 'revocation') return

    // The bounty comes out of the banker's 30% instead of the protocol's 70%.
    const thirty = event.dormantBalance - mulBps(event.dormantBalance, world.config.revocationFeeBps)
    expect(event.bankerShare).toBe(thirty - event.bounty)
    const twentyEight = (event.dormantBalance * 2_800n) / BPS
    expect(event.bankerShare - twentyEight <= 2n).toBe(true)
    expect(event.bankerShare + event.bounty + event.burned + event.redistributed).toBe(
      event.dormantBalance,
    )
  })

  it('sells the payout into the pool, tagged as its own origin', () => {
    const world = studyWorld({ genesisCharters: 150 }, 43)
    const results = run(world, DAY * 50)

    const sells = eventsOf(results, 'swap').filter((e) => e.direction === 'sell')
    const payoutSells = sells.filter((e) => e.origin === 'revocationPayout')
    expect(payoutSells.length).toBeGreaterThan(0)

    const last = results[results.length - 1]!.snapshot
    expect(last.ethVolumeByOrigin.revocationPayout).toBe(
      payoutSells.reduce((sum, e) => sum + e.grossEth, 0n),
    )
    expect(last.ethVolumeByOrigin.revocationPayout > 0n).toBe(true)
    // The three origins are exhaustive.
    const total =
      last.ethVolumeByOrigin.retirement +
      last.ethVolumeByOrigin.revocationPayout +
      last.ethVolumeByOrigin.trader
    expect(total).toBe(sells.reduce((sum, e) => sum + e.grossEth, 0n))

    // Selling the payout is negative net flow, which is the whole mechanism:
    // it cuts the multiplier, which cuts everyone's yield.
    const epochs = eventsOf(results, 'epochClosed')
    const attributable = epochs.reduce((sum, e) => sum + e.ethVolumeByOrigin.revocationPayout, 0n)
    expect(attributable > 0n).toBe(true)
  })

  it('never sells for the Lost cohort', () => {
    const world = studyWorld({ genesisCharters: 200 }, 44)
    run(world, DAY * 50)

    let lostRevoked = 0
    for (const charter of world.state.charters.values()) {
      if (charter.archetype !== 'lost' || charter.alive) continue
      lostRevoked += 1
      const credits = world.state.credits.get(charter.ownerId)!
      const wallet = world.state.wallets.get(charter.ownerId) as Wallet
      // Keys gone: the payout arrived and has sat in the wallet ever since.
      expect(credits.revocationPayout > 0n).toBe(true)
      expect(wallet.standard).toBe(
        credits.withdrawal + credits.retirement + credits.revocationPayout + credits.bounty,
      )
    }
    expect(lostRevoked).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 6. The paired counterfactual
// ---------------------------------------------------------------------------

describe('6 the paired counterfactual', () => {
  it('disables revocation in the control and nothing else', () => {
    const { treatment, control } = runPaired({ genesisCharters: 150 }, 51, { ticks: DAY * 40 })

    expect(treatment.config.revocationEnabled).toBe(true)
    expect(control.config.revocationEnabled).toBe(false)
    for (const key of Object.keys(treatment.config) as Array<keyof Config>) {
      if (key === 'revocationEnabled') continue
      expect(serialize(treatment.config[key]), `config.${key} differs`).toBe(
        serialize(control.config[key]),
      )
    }

    expect(treatment.state.wave.cumulativeRevoked).toBeGreaterThan(0)
    expect(control.state.wave.cumulativeRevoked).toBe(0)
    for (const snapshot of control.history) {
      expect(snapshot.branchesDestroyedThisTick).toBe(0)
      expect(snapshot.revokedThisTick).toBe(0)
      expect(snapshot.reportableCharters).toBe(0)
      expect(snapshot.waveIndex).toBe(0)
    }
    // Dormant charters keep their branches and keep accruing.
    expect(control.state.liveCharters).toBe(150)
    expect(control.state.totalBranches).toBeGreaterThan(treatment.state.totalBranches)
    expect(control.state.token.burnsBySource.revocationFee).toBe(0n)
  })

  it('produces byte-identical histories when nothing ever goes dormant', () => {
    // The test that proves the counterfactual is clean. With an all-Committed
    // cohort no charter is ever reportable, so revocation is irrelevant — and
    // the two arms must therefore agree exactly, tick for tick. If they do
    // not, the RNG streams are entangled and every difference this study
    // measures would be partly noise.
    const { treatment, control } = runPaired(
      { genesisCharters: 40, cohortMixBps: onlyCommitted() },
      52,
      { ticks: DAY * 40 },
    )
    expect(treatment.state.wave.cumulativeRevoked).toBe(0)
    expect(treatment.history.length).toBe(DAY * 40)
    expect(serialize(treatment.history)).toBe(serialize(control.history))
  })

  it('keeps unrelated agents at the same stream position even when the arms diverge', () => {
    // The sharper version of the same claim. Here the treatment world really
    // does revoke, so the two arms genuinely differ — but an agent that has
    // nothing to do with revocation must still be at exactly the same point in
    // its own stream in both.
    const { treatment, control } = runPaired({ genesisCharters: 150 }, 53, { ticks: DAY * 40 })
    expect(treatment.state.wave.cumulativeRevoked).toBeGreaterThan(0)

    for (let i = 0; i < treatment.config.externalDemand.traders; i++) {
      const id = `${treatment.config.externalTraderIdPrefix}-${i}`
      expect(
        treatment.rngFor(id, 'onTick').getState(),
        `outside trader ${id} drifted between arms`,
      ).toEqual(control.rngFor(id, 'onTick').getState())
    }
    // And a banker whose charter survives in both arms is likewise aligned.
    let checked = 0
    for (const charter of treatment.state.charters.values()) {
      if (charter.archetype !== 'committed') continue
      expect(treatment.rngFor(charter.ownerId, 'onTick').getState()).toEqual(
        control.rngFor(charter.ownerId, 'onTick').getState(),
      )
      checked += 1
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('runs three arms, and all three agree when nothing goes dormant', () => {
    // The test that proves the arms are clean. With an all-Committed cohort no
    // charter is ever reportable, so neither revocation nor payout selling can
    // matter — and all three arms must therefore agree exactly, tick for tick.
    // If they do not, the RNG streams are entangled and every difference this
    // study measures would be partly noise.
    const run = runArms({ genesisCharters: 40, cohortMixBps: onlyCommitted() }, 55, {
      ticks: DAY * 40,
    })
    expect(run.treatment.state.wave.cumulativeRevoked).toBe(0)
    const reference = serialize(run.control.history)
    for (const arm of ARMS) {
      expect(serialize(run[arm].history), `${arm} diverged`).toBe(reference)
    }
  })

  it('holds the payout instead of selling it in the noPayoutSell arm', () => {
    const run = runArms({ genesisCharters: 150 }, 56, { ticks: DAY * 45 })
    const treatment = run.treatment.history[run.treatment.history.length - 1]!
    const held = run.noPayoutSell.history[run.noPayoutSell.history.length - 1]!
    const control = run.control.history[run.control.history.length - 1]!

    // The payout is minted in both revocation arms...
    expect(run.noPayoutSell.state.wave.cumulativeRevoked).toBeGreaterThan(0)
    expect(held.mintedToWallets > control.mintedToWallets).toBe(true)
    // ...but only reaches the pool in the treatment arm.
    expect(treatment.ethVolumeByOrigin.revocationPayout > 0n).toBe(true)
    expect(held.ethVolumeByOrigin.revocationPayout).toBe(0n)
    expect(control.ethVolumeByOrigin.revocationPayout).toBe(0n)
  })

  it('rejects a payout sale outright when the arm suppresses it', () => {
    const world = createWorld({ genesisCharters: 6, payout: { ...DEFAULT_CONFIG.payout, reachesPool: false } }, 57)
    world.fund('someone', WAD)
    expect(() =>
      world.actions.swap('someone', 'sell', 1n, 'revocationPayout'),
    ).toThrow(/holds revocation payouts/i)
  })

  it('measures the difference the wave makes', () => {
    // Not an assertion about a number the study has not produced yet — just
    // that the paired design gives the runner something to difference.
    const { treatment, control } = runPaired({ genesisCharters: 150 }, 54, { ticks: DAY * 45 })
    const t = treatment.history[treatment.history.length - 1]!
    const c = control.history[control.history.length - 1]!

    expect(t.totalBranches).toBeLessThan(c.totalBranches)
    // Fewer branches, so each surviving one earns more.
    expect(t.yieldPerBranchPerDay).toBeGreaterThan(c.yieldPerBranchPerDay)
    // The wave mints into the least committed hands, and some of it is sold.
    expect(t.mintedToWallets).toBeGreaterThan(c.mintedToWallets)
    expect(t.ethVolumeByOrigin.revocationPayout > 0n).toBe(true)
    expect(c.ethVolumeByOrigin.revocationPayout).toBe(0n)
    // The revocation fee burns supply the control never burns.
    expect(t.burnsBySource.revocationFee > 0n).toBe(true)
    expect(c.burnsBySource.revocationFee).toBe(0n)
  })
})

// ---------------------------------------------------------------------------
// 7. Instrumentation
// ---------------------------------------------------------------------------

describe('7 instrumentation', () => {
  it('carries everything the runner needs, so nothing has to be re-derived', () => {
    const world = studyWorld({ genesisCharters: 120 }, 61)
    const results = run(world, DAY * 40)
    const last = results[results.length - 1]!.snapshot
    const state = world.state

    // Every field is the live value, not a stale copy.
    expect(last.totalBranches).toBe(state.totalBranches)
    expect(last.liveCharters).toBe(state.liveCharters)
    expect(last.yieldPerBranchPerDay).toBe(world.yieldPerBranchPerDay())
    expect(last.multiplier).toBe(state.policy.multiplier)
    expect(last.epochIndex).toBe(state.epoch)
    expect(last.lastEpochNetFlow).toBe(state.policy.lastEpochNetFlow)
    expect(last.signal).toBe(state.policy.lastSignal)
    expect(last.regime).toBe(state.policy.lastEpochNetFlow > 0n ? 'expansion' : 'contraction')
    expect(last.mintedToWallets).toBe(state.token.mintedToWallets)
    expect(last.notionalMints).toBe(state.token.notionalMints)
    expect(last.burnsBySource).toEqual(state.token.burnsBySource)
    expect(last.poolPrice).toBe(spotPrice(state.pool))
    expect(last.poolEthReserve).toBe(state.pool.ethReserve)
    expect(last.poolStandardReserve).toBe(state.pool.standardReserve)
    expect(last.polEth).toBe(state.pool.cumulativePolEthAdded)
    expect(last.polStandard).toBe(state.pool.cumulativePolStandardAdded)
    expect(last.expansionVaultEth).toBe(state.vaults.expansionEth)
    expect(last.contractionVaultEth).toBe(state.vaults.contractionEth)
    expect(last.cumulativeRevoked).toBe(state.wave.cumulativeRevoked)
    expect(last.waveIndex).toBe(state.wave.index)
    expect(last.profitabilityFloorTokens).toBe(state.hunters.profitabilityFloorTokens)
    expect(last.hunterGasSpentEth).toBe(state.hunters.cumulativeGasSpentEth)

    // The dormancy shares are computed over the charters that are reportable
    // right now, both as a share of charters and as a share of branches.
    let reportable = 0
    let reportableBranches = 0
    let belowFloor = 0
    for (const charter of state.charters.values()) {
      if (!world.isReportable(charter.id)) continue
      reportable += 1
      reportableBranches += charter.branchIds.length
      if (charterAccrued(state, charter) < last.profitabilityFloorTokens) belowFloor += 1
    }
    expect(last.reportableCharters).toBe(reportable)
    expect(last.ghostsBelowFloor.count).toBe(belowFloor)
    expect(last.dormantCohort.charterShare).toBe(
      (BigInt(reportable) * WAD) / BigInt(state.liveCharters),
    )
    expect(last.dormantCohort.branchShare).toBe(
      (BigInt(reportableBranches) * WAD) / BigInt(state.totalBranches),
    )

    // Redistribution is attributed to the rule that caused it.
    const redistributed = results.reduce(
      (sum, r) => sum + r.snapshot.redistributedThisTick.resolutionFee,
      0n,
    )
    expect(redistributed > 0n).toBe(true)
  })
})


// ---------------------------------------------------------------------------
// Exact division (the optimisation that made the study affordable)
// ---------------------------------------------------------------------------

describe('exact division by Barrett reduction', () => {
  it('is bit-identical to plain division across the model\'s magnitudes', () => {
    const rng = createRng(9090)
    for (let trial = 0; trial < 2_000; trial++) {
      const total = rng.nextRange(1n, tokens(900_000_000n))
      const amount = rng.nextRange(1n, total)
      const balance = rng.nextRange(0n, total)
      const divisor = prepareDivisor(total, amount * total)
      expect(divisor).not.toBeNull()
      if (divisor === null) continue
      expect(divExact(amount * balance, divisor)).toBe((amount * balance) / total)
    }
  })

  it('declines rather than guessing when the numerator bound cannot be met', () => {
    expect(prepareDivisor(0n, 1n)).toBeNull()
    expect(prepareDivisor(1n, 1n << 256n)).toBeNull()
    const ok = prepareDivisor(7n, 1_000_000n)
    expect(ok).not.toBeNull()
    if (ok !== null) {
      for (let n = 0n; n < 500n; n++) expect(divExact(n, ok)).toBe(n / 7n)
    }
  })
})
