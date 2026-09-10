/**
 * The Standard Reserve, as an executable model.
 *
 * One tick is one hour. Everything that happens in an hour happens in a fixed
 * order (see `tick()`), and the only randomness comes from per-agent RNG
 * streams derived from `(seed, agentId, purpose)`. Same seed + same config
 * produces a byte-identical history, and — because the streams are
 * independent — a world that takes an extra draw in one place does not shift
 * every later draw everywhere else. That is what makes `runPaired` sound.
 */

import { WAD, clampBig, minBig, mulBps, mulWad } from './math/fixed.js'
import { createRng, type Rng } from './rng/xoshiro128.js'
import { deriveSeed, streamKey } from './rng/derive.js'
import {
  dormancyTicks,
  resolveConfig,
  ticksPerEpoch,
  withdrawalWindowTicks,
  type Config,
  type ConfigOverrides,
} from './config/index.js'
import {
  addLiquidity,
  createPool,
  spotPrice,
  standardToPair,
  swapExactEthForStandard,
  swapExactStandardForEth,
} from './core/pool.js'
import { resolutionFeeRate, resolutionPressure } from './core/fees.js'
import { buildLicenseSchedule, licenseFloorPrice, licenseStartPrice } from './core/licenses.js'
import { profitabilityFloor } from './core/hunters.js'
import { buyerValuation, clearingPrice, sellerReservationEth } from './core/seats.js'
import { assignArchetypes, genesisBranchesFor } from './cohort.js'
import {
  accrueIssuance,
  burnCirculating,
  burnLedgerValue,
  charterAccrued,
  circulatingSupply,
  creditsFor,
  debitCharter,
  liveBranches,
  maxSupply,
  mintLedgerValue,
  rebalanceBranches,
  redistributePro,
  requireBranch,
  settleBranch,
} from './core/ledger.js'
import {
  ProtocolError,
  type Action,
  type Agent,
  type AgentView,
  type Archetype,
  type Branch,
  type Charter,
  type CreditKind,
  type Event,
  type EthVolumeByOrigin,
  type RejectedAction,
  type SeatBid,
  type SeatListing,
  type SellOrigin,
  type TickResult,
  type TickSnapshot,
  type Tokens,
  type Wallet,
  type WalletCredits,
  type Wei,
  type WorldState,
} from './types.js'

export interface World {
  readonly config: Config
  readonly seed: number
  readonly state: Readonly<WorldState>
  readonly history: TickSnapshot[]
  /** The world's own general-purpose stream. Agents get their own. */
  readonly rng: Rng
  /** The stream for `(agentId, purpose)`, created on first use. */
  rngFor(agentId: string, purpose: string): Rng
  addAgent(agent: Agent): void
  removeAgent(id: string): void
  agentIds(): string[]
  tick(): TickResult
  /** Validate and apply one action. Throws `ProtocolError` on rejection. */
  apply(action: Action): void
  viewFor(agentId: string): AgentView
  /**
   * Endow an address with ETH from outside the model. ETH is exogenous here —
   * it is not part of the $STANDARD supply identity — so this touches no
   * protocol accounting.
   */
  fund(agentId: string, eth: Wei): void
  /** One branch's nominal issuance over one day at the current `m` and `N`. */
  yieldPerBranchPerDay(): Tokens
  isReportable(charterId: number): boolean
  /** Whether seat transfers are possible (whitepaper 12). One-way. */
  transfersEnabled(): boolean
  /** The seller's reservation price for a seat, in ETH. */
  seatReservationEth(charterId: number): Wei
  /** What a buyer would pay for a seat, under the documented valuation model. */
  valueSeat(charterId: number): {
    discountedBalanceEth: Wei
    npvEth: Wei
    totalEth: Wei
    expectedYieldPerBranchPerDay: Tokens
  }
  actions: {
    checkIn(charterId: number): void
    buyLicense(charterId: number): void
    retireBranches(charterId: number, k: number): void
    withdraw(charterId: number, amount: Tokens): void
    reportDormant(reporterId: string, charterId: number): void
    swap(agentId: string, direction: 'buy' | 'sell', amountIn: bigint, origin?: SellOrigin): void
    listSeat(charterId: number): void
    unlistSeat(charterId: number): void
    bidForSeat(buyerId: string, charterId: number, valuationEth: bigint): void
  }
}

export function createWorld(config: ConfigOverrides | Config, seed: number): World {
  return new StandardReserveWorld(resolveConfig(config as ConfigOverrides), seed)
}

class StandardReserveWorld implements World {
  readonly state: WorldState
  readonly history: TickSnapshot[] = []

  private readonly streams = new Map<string, Rng>()
  private readonly views = new Map<string, AgentView>()
  private readonly agents: Agent[] = []
  /** Parallel to `agents`: the view and stream each one is handed every tick. */
  private readonly runtimes: Array<{ agent: Agent; view: AgentView; rng: Rng }> = []
  private events: Event[] = []
  private haltAnnounced = false
  /**
   * All live branches in `liveBranches` order, rebuilt only when the branch
   * set changes. Redistribution runs on every withdrawal and every revocation,
   * so rebuilding this per call was the second largest cost in the model.
   */
  private branchOrder: Branch[] | null = null

  constructor(
    readonly config: Config,
    readonly seed: number,
  ) {
    this.state = genesis(config, this.rngFor('$world', 'cohort'))
  }

  // -------------------------------------------------------------------------
  // RNG streams
  // -------------------------------------------------------------------------

  rngFor(agentId: string, purpose: string): Rng {
    const key = streamKey(agentId, purpose)
    let rng = this.streams.get(key)
    if (rng === undefined) {
      rng = createRng(deriveSeed(this.seed, agentId, purpose))
      this.streams.set(key, rng)
    }
    return rng
  }

  get rng(): Rng {
    return this.rngFor('$world', 'default')
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  addAgent(agent: Agent): void {
    if (this.agents.some((a) => a.id === agent.id)) {
      throw new ProtocolError('AGENT_EXISTS', `agent ${agent.id} is already registered`)
    }
    this.agents.push(agent)
    this.ensureWallet(agent.id)
    this.runtimes.push({
      agent,
      view: this.viewFor(agent.id),
      rng: this.rngFor(agent.id, 'onTick'),
    })
  }

  removeAgent(id: string): void {
    const index = this.agents.findIndex((a) => a.id === id)
    if (index >= 0) this.agents.splice(index, 1)
    const runtime = this.runtimes.findIndex((r) => r.agent.id === id)
    if (runtime >= 0) this.runtimes.splice(runtime, 1)
  }

  /** The live branch list, rebuilt only when the branch set has changed. */
  private liveBranchOrder(): Branch[] {
    let order = this.branchOrder
    if (order === null) {
      order = liveBranches(this.state)
      this.branchOrder = order
    }
    return order
  }

  private invalidateBranchOrder(): void {
    this.branchOrder = null
  }

  agentIds(): string[] {
    return this.agents.map((a) => a.id)
  }

  fund(agentId: string, eth: Wei): void {
    if (eth < 0n) throw new ProtocolError('BAD_AMOUNT', 'endowment must be non-negative')
    this.ensureWallet(agentId).eth += eth
  }

  // -------------------------------------------------------------------------
  // The hour
  // -------------------------------------------------------------------------

  tick(): TickResult {
    const cfg = this.config
    const state = this.state
    const t = state.tick
    this.events = []
    const rejected: RejectedAction[] = []

    // 1. Clear the per-tick instrumentation.
    state.wave.revokedThisTick = 0
    state.wave.branchesDestroyedThisTick = 0
    state.wave.branchesRetiredThisTick = 0
    state.wave.branchesOpenedThisTick = 0
    state.hunters.reportsThisTick = 0
    state.seatMarket.salesThisTick = 0
    state.seatMarket.bids.length = 0
    state.tickEthVolumeByOrigin = zeroVolume()
    state.tickRedistributed = { resolutionFee: 0n, revocationFee: 0n }

    // 2. Roll the trailing withdrawal window (whitepaper 9: W is a 7-day sum).
    if (t > 0) {
      const window = state.withdrawals
      window.cursor = (window.cursor + 1) % window.ring.length
      window.trailingTotal -= window.ring[window.cursor] as Tokens
      window.ring[window.cursor] = 0n
    }

    state.day = Math.floor(t / cfg.ticksPerDay)
    state.epoch = Math.floor(t / ticksPerEpoch(cfg))

    // 3. Open a new auction day (whitepaper 7), and throw the transfer switch
    //    if this is the day it is due (whitepaper 12).
    if (t % cfg.ticksPerDay === 0) {
      this.maybeEnableTransfers(state.day)
      this.openAuctionDay(state.day)
    }

    // 4. One hour of the issuance stream (whitepaper 5, 6).
    const issued = accrueIssuance(state, cfg)
    if (issued.total > 0n) {
      this.events.push({
        type: 'issuance',
        tick: t,
        perBranch: issued.perBranch,
        total: issued.total,
        branches: state.totalBranches,
      })
    }
    if (state.issuanceHalted && !this.haltAnnounced) {
      this.haltAnnounced = true
      this.events.push({
        type: 'issuanceHalted',
        tick: t,
        cumulativeIssuance: state.token.cumulativeIssuance,
      })
    }

    // 5. Contraction vault buyback-and-burn (whitepaper 11, hourly).
    this.runContractionVault()

    // 6. Fix the profitability floor for the hour, at the price the hunters
    //    will actually see when they act.
    const scanPrice = spotPrice(state.pool)
    const floor = profitabilityFloor(cfg, scanPrice, cfg.hunter.gasCostEth)
    state.hunters.priceAtScanWad = scanPrice
    state.hunters.profitabilityFloorTokens = floor.tokens
    state.hunters.profitabilityFloorUnreachable = floor.unreachable

    // 7. Agent actions, in registration order.
    for (let a = 0; a < this.runtimes.length; a++) {
      const { agent, view, rng } = this.runtimes[a] as { agent: Agent; view: AgentView; rng: Rng }
      let proposed: Action[]
      try {
        proposed = agent.onTick(view, rng)
      } catch (error: unknown) {
        rejected.push({
          action: { type: 'checkIn', charterId: -1 },
          code: 'AGENT_THREW',
          message: `${agent.id}: ${(error as Error).message}`,
        })
        continue
      }
      for (const action of proposed) {
        try {
          this.apply(action)
        } catch (error: unknown) {
          const code = error instanceof ProtocolError ? error.code : 'UNEXPECTED'
          rejected.push({ action, code, message: (error as Error).message })
        }
      }
    }

    // 8. Clear the seat market, once a day, after everyone has listed and bid.
    if (state.seatMarket.enabled && t % cfg.ticksPerDay === 0) this.clearSeatMarket()

    // 9. Close the epoch if this hour ends one (whitepaper 4, 5, 11).
    if ((t + 1) % ticksPerEpoch(cfg) === 0) this.closeEpoch()

    // 10. Roll the trailing multiplier window, for the buyer expectation model.
    //     O(1), and only maintained where a buyer could ever read it.
    if (cfg.charterTransfersEnabledAtDay !== null) this.recordMultiplier()

    state.tick = t + 1
    const snapshot = this.snapshot()
    this.history.push(snapshot)
    return { tick: t, events: this.events, rejected, snapshot }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  readonly actions = {
    checkIn: (charterId: number): void => this.apply({ type: 'checkIn', charterId }),
    buyLicense: (charterId: number): void => this.apply({ type: 'buyLicense', charterId }),
    retireBranches: (charterId: number, k: number): void =>
      this.apply({ type: 'retireBranches', charterId, k }),
    withdraw: (charterId: number, amount: Tokens): void =>
      this.apply({ type: 'withdraw', charterId, amount }),
    reportDormant: (reporterId: string, charterId: number): void =>
      this.apply({ type: 'reportDormant', reporterId, charterId }),
    swap: (
      agentId: string,
      direction: 'buy' | 'sell',
      amountIn: bigint,
      origin: SellOrigin = 'trader',
    ): void => this.apply({ type: 'swap', agentId, direction, amountIn, origin }),
    listSeat: (charterId: number): void => this.apply({ type: 'listSeat', charterId }),
    unlistSeat: (charterId: number): void => this.apply({ type: 'unlistSeat', charterId }),
    bidForSeat: (buyerId: string, charterId: number, valuationEth: bigint): void =>
      this.apply({ type: 'bidForSeat', buyerId, charterId, valuationEth }),
  }

  apply(action: Action): void {
    switch (action.type) {
      case 'checkIn':
        return this.doCheckIn(action.charterId)
      case 'buyLicense':
        return this.doBuyLicense(action.charterId)
      case 'retireBranches':
        return this.doRetireBranches(action.charterId, action.k)
      case 'withdraw':
        return this.doWithdraw(action.charterId, action.amount)
      case 'reportDormant':
        return this.doReportDormant(action.reporterId, action.charterId)
      case 'submitReport':
        return this.doSubmitReport(action)
      case 'swap':
        return this.doSwap(action.agentId, action.direction, action.amountIn, action.origin)
      case 'listSeat':
        return this.doListSeat(action.charterId)
      case 'unlistSeat':
        return this.doUnlistSeat(action.charterId)
      case 'bidForSeat':
        return this.doBidForSeat(action)
      default:
        throw new ProtocolError(
          'UNKNOWN_ACTION',
          `no such action: ${(action as { type: string }).type}`,
        )
    }
  }

  /** Whitepaper 10: a zero-cost action whose only effect is to reset the clock. */
  private doCheckIn(charterId: number): void {
    const charter = this.liveCharter(charterId)
    charter.lastInteractionTick = this.state.tick
    this.events.push({ type: 'checkIn', tick: this.state.tick, charterId })
  }

  /** Whitepaper 7, 8: buy one license at the current falling price; burn the payment. */
  private doBuyLicense(charterId: number): void {
    const cfg = this.config
    const state = this.state
    const charter = this.liveCharter(charterId)
    const auction = state.licenses

    if (!auction.open || auction.remaining <= 0) {
      throw new ProtocolError('NO_INVENTORY', `no licenses remain on day ${auction.day}`)
    }
    if (charter.licensesBoughtToday >= cfg.maxLicensesPerCharterPerDay) {
      throw new ProtocolError(
        'CHARTER_DAILY_CAP',
        `charter ${charterId} has already bought ${charter.licensesBoughtToday} licenses today`,
      )
    }
    if (charter.branchIds.length >= cfg.maxBranchesPerCharter) {
      throw new ProtocolError(
        'BRANCH_CAP',
        `charter ${charterId} already holds ${charter.branchIds.length} branches`,
      )
    }
    const price = auction.schedule[state.tick % cfg.ticksPerDay] as Tokens
    if (price <= 0n) throw new ProtocolError('NO_PRICE', 'the auction has no price today')

    const wallet = this.requireWallet(charter.ownerId)
    if (wallet.standard < price) {
      throw new ProtocolError(
        'INSUFFICIENT_STANDARD',
        `${charter.ownerId} holds ${wallet.standard} but the license costs ${price}`,
      )
    }

    // 100% of the payment is burned (whitepaper 7).
    wallet.standard -= price
    burnCirculating(state, price, 'license')

    const branch: Branch = {
      id: state.nextBranchId++,
      charterId,
      settled: 0n,
      indexAt: state.ledger.rewardIndex,
      openedTick: state.tick,
    }
    state.branches.set(branch.id, branch)
    charter.branchIds.push(branch.id)
    state.totalBranches += 1
    state.wave.branchesOpenedThisTick += 1
    this.invalidateBranchOrder()

    auction.remaining -= 1
    auction.soldToday += 1
    // The schedule falls monotonically, so the newest sale is the lowest.
    auction.lowestSoldPrice = price
    charter.licensesBoughtToday += 1
    charter.lastInteractionTick = state.tick

    this.events.push({ type: 'licenseSold', tick: state.tick, charterId, price, branchId: branch.id })
  }

  /**
   * Whitepaper 9: retiring `k` of `n` branches liquidates exactly `k/n` of the
   * charter's accrued balance and destroys those branches permanently.
   * Retiring all `n` burns the charter.
   */
  private doRetireBranches(charterId: number, k: number): void {
    const state = this.state
    const charter = this.liveCharter(charterId)
    const n = charter.branchIds.length
    if (!Number.isInteger(k) || k <= 0 || k > n) {
      throw new ProtocolError('BAD_K', `cannot retire ${k} of ${n} branches`)
    }

    const branches = charter.branchIds.map((id) => requireBranch(state, id))
    let accrued = 0n
    for (const branch of branches) accrued += settleBranch(state, branch)

    const liquidated = (accrued * BigInt(k)) / BigInt(n)
    const residue = accrued - liquidated

    const survivors = branches.slice(0, n - k)
    const destroyed = branches.slice(n - k)
    for (const branch of destroyed) state.branches.delete(branch.id)
    charter.branchIds = survivors.map((b) => b.id)
    state.totalBranches -= k
    state.wave.branchesRetiredThisTick += k
    this.invalidateBranchOrder()

    // Everything the charter held leaves the pool of accrued balances; the
    // residue is handed straight back to the surviving branches.
    state.ledger.totalAccrued -= accrued
    rebalanceBranches(state, survivors, residue)
    state.ledger.totalAccrued += residue

    const charterBurned = k === n
    if (charterBurned) {
      charter.alive = false
      state.liveCharters -= 1
    }
    charter.lastInteractionTick = state.tick

    // The destroyed branches are already gone, so they cannot receive the
    // redistributed half of their own resolution fee (whitepaper 9).
    this.settleWithdrawal(charter.ownerId, charterId, liquidated, 'retirement')

    this.events.push({
      type: 'retirement',
      tick: state.tick,
      charterId,
      k,
      n,
      accruedBefore: accrued,
      liquidatedGross: liquidated,
      charterBurned,
    })
  }

  /** Whitepaper 9: withdraw accrued balance; tokens are minted here and only here. */
  private doWithdraw(charterId: number, amount: Tokens): void {
    const state = this.state
    const charter = this.liveCharter(charterId)
    if (amount <= 0n) throw new ProtocolError('BAD_AMOUNT', 'withdrawal must be positive')
    const available = charterAccrued(state, charter)
    if (amount > available) {
      throw new ProtocolError(
        'INSUFFICIENT_ACCRUED',
        `charter ${charterId} has ${available} accrued, asked for ${amount}`,
      )
    }
    debitCharter(state, charter, amount)
    charter.lastInteractionTick = state.tick
    this.settleWithdrawal(charter.ownerId, charterId, amount, 'withdrawal')
  }

  /**
   * The resolution fee, applied to value already debited from the ledger.
   *
   * The rate is read before anything is credited or burned, so it is locked at
   * the moment of commit (whitepaper 9). Half the fee is burned; the other half
   * is credited pro rata to the accrued balances of branches that did not exit.
   */
  private settleWithdrawal(
    ownerId: string,
    charterId: number,
    gross: Tokens,
    kind: CreditKind,
  ): void {
    const cfg = this.config
    const state = this.state
    if (gross <= 0n) return

    const window = state.withdrawals
    window.ring[window.cursor] = (window.ring[window.cursor] as Tokens) + gross
    window.trailingTotal += gross

    const w = window.trailingTotal
    const d = state.ledger.totalAccrued
    const p = resolutionPressure(cfg, w, d)
    const rate = resolutionFeeRate(cfg, p)

    const fee = mulWad(gross, rate)
    const burned = mulBps(fee, cfg.feeBurnShareBps)
    const redistributed = fee - burned
    const net = gross - fee

    burnLedgerValue(state, burned, 'resolutionFee')
    redistributePro(
      state,
      redistributed,
      this.liveBranchOrder(),
      state.ledger.totalAccrued,
      'resolutionFee',
    )
    mintLedgerValue(state, ownerId, net, kind)

    this.events.push({
      type: 'withdrawal',
      tick: state.tick,
      charterId,
      kind,
      gross,
      feeRate: rate,
      fee,
      burned,
      redistributed,
      net,
      p,
    })
  }

  /**
   * Whitepaper 10. Reporting is an explicit action taken by an agent, never an
   * automatic consequence of time passing. `submitReport` is what a bounty
   * hunter uses; this is the bare protocol action underneath it.
   */
  private doReportDormant(reporterId: string, charterId: number): void {
    const cfg = this.config
    const state = this.state
    const charter = this.liveCharter(charterId)
    if (!cfg.revocationEnabled) {
      throw new ProtocolError(
        'REVOCATION_DISABLED',
        'revocation is disabled in this world (counterfactual control)',
      )
    }
    if (!this.isReportable(charterId)) {
      const idle = state.tick - charter.lastInteractionTick
      throw new ProtocolError(
        'NOT_DORMANT',
        `charter ${charterId} has been idle ${idle}h, needs ${dormancyTicks(cfg)}h`,
      )
    }
    // "Any address may report it" — the reporter need not be a known agent.
    this.ensureWallet(reporterId)

    const yieldBefore = this.yieldPerBranchPerDay()
    const branchesBefore = state.totalBranches
    const dormantBalance = charterAccrued(state, charter)
    debitCharter(state, charter, dormantBalance)

    const bountyUncapped = mulBps(dormantBalance, cfg.informantBountyBps)
    const bounty = minBig(bountyUncapped, cfg.informantBountyCapTokens)
    const revocationFee = mulBps(dormantBalance, cfg.revocationFeeBps)
    let bankerShare = dormantBalance - revocationFee
    let feePot = revocationFee
    if (cfg.dormancyBountySource === 'revocationFee') feePot -= bounty
    else bankerShare -= bounty

    const burned = mulBps(feePot, cfg.revocationBurnShareBps)
    const redistributed = feePot - burned

    // All of the charter's branches are destroyed before the redistribution,
    // so they take no part in it and `totalBranches` falls on this same tick.
    const branchesDestroyed = charter.branchIds.length
    for (const id of charter.branchIds) state.branches.delete(id)
    charter.branchIds = []
    state.totalBranches -= branchesDestroyed
    this.invalidateBranchOrder()
    charter.alive = false
    charter.revokedAtTick = state.tick
    state.liveCharters -= 1
    state.revokedCharterIds.push(charterId)

    // Wave bookkeeping: a wave is a run of revocations with no `waveGapHours`
    // gap inside it.
    const wave = state.wave
    if (wave.lastRevocationTick === null || state.tick - wave.lastRevocationTick >= cfg.waveGapHours) {
      wave.index += 1
    }
    wave.lastRevocationTick = state.tick
    wave.revokedThisTick += 1
    wave.branchesDestroyedThisTick += branchesDestroyed
    wave.cumulativeRevoked += 1

    mintLedgerValue(state, reporterId, bounty, 'bounty')
    mintLedgerValue(state, charter.ownerId, bankerShare, 'revocationPayout')
    burnLedgerValue(state, burned, 'revocationFee')
    redistributePro(
      state,
      redistributed,
      this.liveBranchOrder(),
      state.ledger.totalAccrued,
      'revocationFee',
    )

    this.events.push({
      type: 'revocation',
      tick: state.tick,
      charterId,
      archetype: charter.archetype,
      reporterId,
      waveIndex: wave.index,
      dormantBalance,
      bounty,
      burned,
      redistributed,
      bankerShare,
      branchesDestroyed,
      multiplier: state.policy.multiplier,
      totalBranchesBefore: branchesBefore,
      totalBranchesAfter: state.totalBranches,
      yieldPerBranchBefore: yieldBefore,
      yieldPerBranchAfter: this.yieldPerBranchPerDay(),
    })
  }

  /**
   * One hunter's submission against one charter, in a contested hour.
   *
   * The hunter pool has already resolved who is willing at what gas and which
   * submission lands — that is the agent's job, and it is what a block builder
   * does on a real chain. The world charges the gas, records the attempt, and
   * performs the revocation for the submission that was included.
   */
  private doSubmitReport(action: Extract<Action, { type: 'submitReport' }>): void {
    const cfg = this.config
    const state = this.state
    const wallet = this.state.wallets.get(action.hunterId)
    if (wallet === undefined) {
      throw new ProtocolError('NO_WALLET', `no wallet for hunter ${action.hunterId}`)
    }
    if (action.gasEth < 0n) throw new ProtocolError('BAD_AMOUNT', 'gas must be non-negative')
    if (wallet.eth < action.gasEth) {
      throw new ProtocolError(
        'INSUFFICIENT_ETH',
        `${action.hunterId} holds ${wallet.eth} wei, gas is ${action.gasEth}`,
      )
    }
    if (action.included && state.hunters.reportsThisTick >= cfg.hunter.maxReportsPerHour) {
      throw new ProtocolError(
        'THROUGHPUT',
        `only ${cfg.hunter.maxReportsPerHour} reports can land in one hour`,
      )
    }
    if (action.included) {
      // Validate the revocation before charging gas, so a rejected submission
      // leaves no trace at all.
      const charter = this.state.charters.get(action.charterId)
      if (charter === undefined || !charter.alive) {
        throw new ProtocolError('NO_CHARTER', `charter ${action.charterId} is not live`)
      }
      if (!cfg.revocationEnabled) {
        throw new ProtocolError('REVOCATION_DISABLED', 'revocation is disabled in this world')
      }
      if (!this.isReportable(action.charterId)) {
        throw new ProtocolError('NOT_DORMANT', `charter ${action.charterId} is not reportable`)
      }
    }

    // Gas is a network cost, not protocol revenue: the ETH leaves the model.
    wallet.eth -= action.gasEth
    state.hunters.cumulativeGasSpentEth += action.gasEth
    state.hunters.cumulativeReportsAttempted += 1

    this.events.push({
      type: 'hunterReport',
      tick: state.tick,
      hunterId: action.hunterId,
      charterId: action.charterId,
      contenders: action.contenders,
      gasPaidEth: action.gasEth,
      bountyValueEth: action.bountyValueEth,
      requiredEth: action.requiredEth,
      won: action.included,
    })

    if (action.included) {
      this.doReportDormant(action.hunterId, action.charterId)
      state.hunters.cumulativeReportsLanded += 1
      state.hunters.reportsThisTick += 1
    }
  }

  private doSwap(
    agentId: string,
    direction: 'buy' | 'sell',
    amountIn: bigint,
    origin: SellOrigin = 'trader',
  ): void {
    const cfg = this.config
    const state = this.state
    if (amountIn <= 0n) throw new ProtocolError('BAD_AMOUNT', 'swap amount must be positive')
    if (origin === 'revocationPayout' && !cfg.payout.reachesPool) {
      throw new ProtocolError(
        'PAYOUT_SELLS_SUPPRESSED',
        'this world holds revocation payouts rather than selling them',
      )
    }
    const wallet = this.requireWallet(agentId)

    if (direction === 'buy') {
      if (wallet.eth < amountIn) {
        throw new ProtocolError('INSUFFICIENT_ETH', `${agentId} holds ${wallet.eth} wei`)
      }
      const result = swapExactEthForStandard(state.pool, cfg, amountIn, { chargeFee: true })
      wallet.eth -= amountIn
      wallet.standard += result.tokenAmount
      state.vaults.pendingProtocolEth += result.feeEth
      // Whitepaper 4: gross ETH in from buys.
      state.policy.currentEpochNetFlow += result.grossEth
      this.events.push({
        type: 'swap',
        tick: state.tick,
        agentId,
        direction,
        grossEth: result.grossEth,
        feeEth: result.feeEth,
        tokenAmount: result.tokenAmount,
        protocol: false,
        origin,
      })
    } else {
      if (wallet.standard < amountIn) {
        throw new ProtocolError('INSUFFICIENT_STANDARD', `${agentId} holds ${wallet.standard}`)
      }
      const result = swapExactStandardForEth(state.pool, cfg, amountIn, { chargeFee: true })
      wallet.standard -= amountIn
      wallet.eth += result.netEth
      state.vaults.pendingProtocolEth += result.feeEth
      // Whitepaper 4: gross ETH out from sells.
      state.policy.currentEpochNetFlow -= result.grossEth
      // Sell-side volume is attributed so that the study can say how much of a
      // post-wave issuance cut traces back to revocation payouts specifically.
      state.ethVolumeByOrigin[origin] += result.grossEth
      state.tickEthVolumeByOrigin[origin] += result.grossEth
      state.policy.epochEthVolumeByOrigin[origin] += result.grossEth
      this.events.push({
        type: 'swap',
        tick: state.tick,
        agentId,
        direction,
        grossEth: result.grossEth,
        feeEth: result.feeEth,
        tokenAmount: result.tokenAmount,
        protocol: false,
        origin,
      })
    }
  }

  // -------------------------------------------------------------------------
  // The seat market — whitepaper 12
  // -------------------------------------------------------------------------

  transfersEnabled(): boolean {
    return this.state.seatMarket.enabled
  }

  /**
   * The one-way switch.
   *
   * Whitepaper 12: the team makes this call once and cannot undo it. The latch
   * lives in state, is only ever written here, and is only ever written true —
   * there is no code path anywhere in the package that sets it back.
   */
  private maybeEnableTransfers(day: number): void {
    const cfg = this.config
    const market = this.state.seatMarket
    if (market.enabled) return
    if (cfg.charterTransfersEnabledAtDay === null) return
    if (day < cfg.charterTransfersEnabledAtDay) return
    market.enabled = true
    market.enabledAtTick = this.state.tick
    this.events.push({ type: 'transfersEnabled', tick: this.state.tick, day })
  }

  private recordMultiplier(): void {
    const trailing = this.state.multiplierTrailing
    trailing.sum -= trailing.ring[trailing.cursor] as bigint
    trailing.ring[trailing.cursor] = this.state.policy.multiplier
    trailing.sum += this.state.policy.multiplier
    trailing.cursor = (trailing.cursor + 1) % trailing.ring.length
    if (trailing.filled < trailing.ring.length) trailing.filled += 1
  }

  /**
   * The buyer's view of future `m`.
   *
   * `buyerExpectation: 'trailing7dMeanMultiplierFlatN'` — the trailing
   * seven-day mean of the multiplier, with the branch count held at its
   * current value. Deliberately unclever. Buyer sophistication is a modelling
   * choice and an axis a sweep should vary; see `docs/mechanics.md`.
   */
  private expectedMultiplier(): bigint {
    const trailing = this.state.multiplierTrailing
    if (trailing.filled === 0) return this.state.policy.multiplier
    return trailing.sum / BigInt(trailing.filled)
  }

  private currentResolutionPressure(): bigint {
    return resolutionPressure(
      this.config,
      this.state.withdrawals.trailingTotal,
      this.state.ledger.totalAccrued,
    )
  }

  /** What a buyer would pay for a seat, under the documented valuation model. */
  valueSeat(charterId: number): ReturnType<typeof buyerValuation> {
    const charter = this.liveCharter(charterId)
    return buyerValuation(
      this.config,
      this.state.pool,
      charterAccrued(this.state, charter),
      charter.branchIds.length,
      this.currentResolutionPressure(),
      this.expectedMultiplier(),
      this.state.totalBranches,
    )
  }

  seatReservationEth(charterId: number): Wei {
    const charter = this.liveCharter(charterId)
    return sellerReservationEth(
      this.config,
      this.state.pool,
      charterAccrued(this.state, charter),
      this.currentResolutionPressure(),
    )
  }

  /** How many live charters an address holds. */
  private charterCountOf(ownerId: string): number {
    const owned = this.state.chartersByOwner.get(ownerId)
    if (owned === undefined) return 0
    let count = 0
    for (const id of owned) if (this.state.charters.get(id)?.alive === true) count += 1
    return count
  }

  private requireTransfers(): void {
    if (!this.state.seatMarket.enabled) {
      throw new ProtocolError(
        'SOULBOUND',
        'charters are soulbound in this world (whitepaper 6); the transfer switch has not been thrown',
      )
    }
  }

  private doListSeat(charterId: number): void {
    this.requireTransfers()
    const charter = this.liveCharter(charterId)
    const market = this.state.seatMarket
    if (market.listings.has(charterId)) {
      throw new ProtocolError('ALREADY_LISTED', `charter ${charterId} is already listed`)
    }
    // Listing is a market action, not a charter interaction: it does not reset
    // the dormancy clock. A seat that is listed but never sold is still
    // reportable on schedule.
    market.listings.set(charterId, {
      charterId,
      sellerId: charter.ownerId,
      listedAtTick: this.state.tick,
    })
    this.events.push({
      type: 'seatListed',
      tick: this.state.tick,
      charterId,
      sellerId: charter.ownerId,
    })
  }

  private doUnlistSeat(charterId: number): void {
    this.requireTransfers()
    const market = this.state.seatMarket
    if (!market.listings.delete(charterId)) {
      throw new ProtocolError('NOT_LISTED', `charter ${charterId} is not listed`)
    }
  }

  private doBidForSeat(action: Extract<Action, { type: 'bidForSeat' }>): void {
    this.requireTransfers()
    const market = this.state.seatMarket
    if (!market.listings.has(action.charterId)) {
      throw new ProtocolError('NOT_LISTED', `charter ${action.charterId} is not listed`)
    }
    if (action.valuationEth <= 0n) throw new ProtocolError('BAD_AMOUNT', 'a bid must be positive')
    const wallet = this.state.wallets.get(action.buyerId)
    if (wallet === undefined) throw new ProtocolError('NO_WALLET', `no wallet for ${action.buyerId}`)
    market.bids.push({
      charterId: action.charterId,
      buyerId: action.buyerId,
      valuationEth: action.valuationEth,
    })
  }

  /**
   * Clearing, once a day.
   *
   * Deliberately simple, and stated exactly because "match highest bid against
   * lowest reservation" is ambiguous when seats are not fungible — they carry
   * different balances and different branch counts, so a bid is necessarily
   * for a particular seat.
   *
   * Listings are taken cheapest reservation first; for each, the highest live
   * bid from a buyer who is still eligible and still funded wins if it clears
   * the reservation, and the pair settles at the midpoint. A seat is
   * indivisible and there are no partial fills. A buyer takes at most one seat
   * per clearing round, whatever `postTransferCharterLimit` allows in total —
   * one round is one day, and a wallet buying several seats in a single day is
   * a level of activity this market does not model. Unmatched listings roll
   * over until `listingExpiryDays` have passed.
   */
  private clearSeatMarket(): void {
    const cfg = this.config
    const state = this.state
    const market = state.seatMarket
    if (market.listings.size === 0) return

    const pressure = this.currentResolutionPressure()
    const priced = [...market.listings.values()]
      .map((listing) => {
        const charter = state.charters.get(listing.charterId)
        if (charter === undefined || !charter.alive) return null
        const balance = charterAccrued(state, charter)
        return {
          listing,
          charter,
          balance,
          reservationEth: sellerReservationEth(cfg, state.pool, balance, pressure),
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) =>
        a.reservationEth === b.reservationEth
          ? a.listing.charterId - b.listing.charterId
          : a.reservationEth < b.reservationEth
            ? -1
            : 1,
      )

    const spent = new Set<string>()
    for (const entry of priced) {
      let best: SeatBid | null = null
      for (const bid of market.bids) {
        if (bid.charterId !== entry.listing.charterId) continue
        if (spent.has(bid.buyerId)) continue
        const wallet = state.wallets.get(bid.buyerId)
        if (wallet === undefined) continue
        if (this.charterCountOf(bid.buyerId) >= cfg.postTransferCharterLimit) continue
        if (bid.valuationEth < entry.reservationEth) continue
        const price = clearingPrice(cfg, bid.valuationEth, entry.reservationEth)
        if (wallet.eth < price) continue
        if (
          best === null ||
          bid.valuationEth > best.valuationEth ||
          (bid.valuationEth === best.valuationEth && bid.buyerId < best.buyerId)
        ) {
          best = bid
        }
      }
      if (best === null) continue
      this.settleSeatSale(entry.charter, entry.balance, best, entry.reservationEth)
      spent.add(best.buyerId)
    }

    // Expire stale listings, and drop any whose charter is gone.
    const expiryTicks = cfg.seat.listingExpiryDays * cfg.ticksPerDay
    for (const listing of [...market.listings.values()]) {
      const charter = state.charters.get(listing.charterId)
      if (charter === undefined || !charter.alive || charter.ownerId !== listing.sellerId) {
        market.listings.delete(listing.charterId)
        continue
      }
      if (state.tick - listing.listedAtTick >= expiryTicks) {
        market.listings.delete(listing.charterId)
        market.cumulativeExpired += 1
        this.events.push({
          type: 'seatListingExpired',
          tick: state.tick,
          charterId: listing.charterId,
          sellerId: listing.sellerId,
        })
      }
    }
  }

  /**
   * A completed sale.
   *
   * The seat moves whole. No branch is destroyed, no balance is touched, and
   * the ETH goes buyer to seller directly — it never enters the pool, pays no
   * trading fee, and never reaches the fee engine. That is the whole of
   * whitepaper 12's claim that a seat sale is "an exit with zero sell pressure
   * on $STANDARD", and it is also why `F_n` never sees the capital. See F-06.
   */
  private settleSeatSale(
    charter: Charter,
    balance: Tokens,
    bid: SeatBid,
    reservationEth: Wei,
  ): void {
    const state = this.state
    const price = clearingPrice(this.config, bid.valuationEth, reservationEth)
    const buyerWallet = this.state.wallets.get(bid.buyerId)
    if (buyerWallet === undefined || buyerWallet.eth < price) return
    const sellerId = charter.ownerId
    const sellerWallet = this.ensureWallet(sellerId)

    buyerWallet.eth -= price
    sellerWallet.eth += price

    // Ownership moves; the branches and the accrued balance do not move at all.
    const previousOwned = state.chartersByOwner.get(sellerId)
    if (previousOwned !== undefined) {
      const at = previousOwned.indexOf(charter.id)
      if (at >= 0) previousOwned.splice(at, 1)
    }
    const buyerOwned = state.chartersByOwner.get(bid.buyerId) ?? []
    buyerOwned.push(charter.id)
    state.chartersByOwner.set(bid.buyerId, buyerOwned)

    charter.ownerId = bid.buyerId
    charter.transferred = true
    // The buyer replaces the seller one for one, so the dormancy clock starts
    // over from the moment the seat changes hands (whitepaper 10, 12).
    charter.lastInteractionTick = state.tick

    const market = state.seatMarket
    market.salesThisTick += 1
    market.cumulativeSales += 1
    market.cumulativeVolumeEth += price
    market.cumulativeBranchesTransferred += charter.branchIds.length
    market.cumulativeBalanceTransferred += balance
    market.listings.delete(charter.id)

    this.events.push({
      type: 'seatSale',
      tick: state.tick,
      charterId: charter.id,
      sellerId,
      sellerArchetype: charter.archetype,
      buyerId: bid.buyerId,
      priceEth: price,
      reservationEth,
      valuationEth: bid.valuationEth,
      branchCount: charter.branchIds.length,
      accruedBalance: balance,
    })
  }

  /**
   * Ownership concentration over branches.
   *
   * Skipped entirely while charters are soulbound: ownership is then one
   * charter per wallet by construction, so the answer is known and a full scan
   * every tick would cost every non-transfer cell something for nothing.
   */
  private concentration(): { hhi: bigint; largestShare: bigint } {
    if (this.config.charterTransfersEnabledAtDay === null) return { hhi: 0n, largestShare: 0n }
    const state = this.state
    if (state.totalBranches <= 0) return { hhi: 0n, largestShare: 0n }
    const byOwner = new Map<string, number>()
    for (const charter of state.charters.values()) {
      if (!charter.alive) continue
      byOwner.set(charter.ownerId, (byOwner.get(charter.ownerId) ?? 0) + charter.branchIds.length)
    }
    const total = BigInt(state.totalBranches)
    let hhi = 0n
    let largest = 0n
    for (const branches of byOwner.values()) {
      const share = (BigInt(branches) * WAD) / total
      hhi += mulWad(share, share)
      if (share > largest) largest = share
    }
    return { hhi, largestShare: largest }
  }

  // -------------------------------------------------------------------------
  // Auction day
  // -------------------------------------------------------------------------

  private openAuctionDay(day: number): void {
    const cfg = this.config
    const state = this.state
    const auction = state.licenses

    const carriedLowest = auction.day === day - 1 ? auction.lowestSoldPrice : null
    const pFloor = licenseFloorPrice(cfg, state.policy.multiplier, state.totalBranches)
    const pStart = pFloor > 0n ? licenseStartPrice(cfg, carriedLowest, pFloor) : 0n

    auction.day = day
    auction.open = pStart > 0n
    auction.pFloor = pFloor
    auction.pStart = pStart
    auction.schedule = buildLicenseSchedule(cfg, pStart, pFloor)
    // Whitepaper 8: unsold inventory never rolls over.
    auction.remaining = auction.open ? cfg.licensesPerDay : 0
    auction.soldToday = 0
    auction.previousLowestSoldPrice = carriedLowest
    auction.lowestSoldPrice = null

    for (const charter of state.charters.values()) {
      if (charter.licensesBoughtToday !== 0) charter.licensesBoughtToday = 0
    }

    if (auction.open) {
      this.events.push({ type: 'auctionOpened', tick: state.tick, day, pStart, pFloor })
    }
  }

  // -------------------------------------------------------------------------
  // Fee engine — whitepaper 11
  // -------------------------------------------------------------------------

  private runContractionVault(): void {
    const cfg = this.config
    const state = this.state
    const vaults = state.vaults
    if (vaults.contractionEth <= 0n) return

    // spend_tick = min(0.10 * V, 0.002 * R)
    const fromVault = mulWad(vaults.contractionEth, cfg.contractionVaultSpendPerTickWad)
    const fromReserve = mulWad(state.pool.ethReserve, cfg.contractionReserveCapPerTickWad)
    const spend = minBig(fromVault, fromReserve)
    if (spend <= 0n) return

    const result = swapExactEthForStandard(state.pool, cfg, spend, {
      chargeFee: cfg.protocolSwapsPayFee,
    })
    vaults.contractionEth -= spend
    vaults.pendingProtocolEth += result.feeEth
    vaults.cumulativeBuybackEth += spend
    vaults.cumulativeBuybackBurned += result.tokenAmount
    if (cfg.countProtocolSwapsInNetFlow) state.policy.currentEpochNetFlow += result.grossEth

    // Everything bought is burned. The vault never holds and never sells.
    burnCirculating(state, result.tokenAmount, 'buyback')

    this.events.push({
      type: 'buyback',
      tick: state.tick,
      ethSpent: spend,
      tokensBurned: result.tokenAmount,
    })
  }

  private closeEpoch(): void {
    const cfg = this.config
    const state = this.state
    const policy = state.policy
    const netFlow = policy.currentEpochNetFlow

    // Fast lever (whitepaper 4): fee routing reacts to sign(F_n) of the epoch
    // that just closed.
    const routed = state.vaults.pendingProtocolEth
    const vault: 'expansion' | 'contraction' = netFlow > 0n ? 'expansion' : 'contraction'
    let toVault = 0n
    let toPol = 0n
    let toTeam = 0n
    if (routed > 0n) {
      toVault = mulBps(routed, cfg.feeSplitVaultBps)
      toPol = mulBps(routed, cfg.feeSplitPolBps)
      // The team takes the remainder, so the three shares sum to exactly the
      // routed amount with no dust left behind (whitepaper 11).
      toTeam = routed - toVault - toPol
      state.vaults.pendingProtocolEth = 0n
      if (vault === 'expansion') state.vaults.expansionEth += toVault
      else state.vaults.contractionEth += toVault
      state.vaults.teamEth += toTeam
      state.vaults.cumulativeRoutedEth += routed
      state.vaults.cumulativeToVaults += toVault
      state.vaults.cumulativeToPol += toPol
      state.vaults.cumulativeToTeam += toTeam
      this.deployPol(toPol)
    }

    // Slow lever (whitepaper 4, 5): signal_n = F_{n-1} + F_{n-2}.
    const history = policy.netFlowHistory
    const fPrev1 = history.length >= 1 ? (history[history.length - 1] as Wei) : 0n
    const fPrev2 = history.length >= 2 ? (history[history.length - 2] as Wei) : 0n
    const signal = fPrev1 + fPrev2

    const before = policy.multiplier
    const step = signal > 0n ? cfg.multiplierRaiseStepWad : -cfg.multiplierCutStepWad
    const after = clampBig(before + step, cfg.multiplierMinWad, cfg.multiplierMaxWad)

    policy.multiplier = after
    policy.lastSignal = signal
    policy.lastEpochNetFlow = netFlow
    history.push(netFlow)
    policy.currentEpochNetFlow = 0n

    const epochVolume = policy.epochEthVolumeByOrigin
    policy.lastEpochEthVolumeByOrigin = epochVolume
    policy.epochEthVolumeByOrigin = zeroVolume()

    this.events.push({
      type: 'epochClosed',
      tick: state.tick,
      epoch: state.epoch,
      netFlow,
      signal,
      multiplierBefore: before,
      multiplierAfter: after,
      routedEth: routed,
      toVault,
      vault,
      toPol,
      toTeam,
      ethVolumeByOrigin: { ...epochVolume },
    })
  }

  /**
   * Whitepaper 11: half the POL share is swapped to $STANDARD, paired with the
   * other half and added forever.
   *
   * The pool is priced by the swap itself, so the two halves never pair
   * exactly. Whatever cannot be paired this epoch is carried forward in
   * `pendingPolEth` / `pendingPolStandard` and paired later. Nothing is ever
   * sold back out: POL only grows.
   */
  private deployPol(budgetIn: Wei): void {
    const cfg = this.config
    const state = this.state
    const pool = state.pool

    const budget = budgetIn + pool.pendingPolEth
    pool.pendingPolEth = 0n
    if (budget <= 0n) return

    const swapEth = mulBps(budget, cfg.polSwapShareBps)
    let standardOnHand = pool.pendingPolStandard
    pool.pendingPolStandard = 0n

    if (swapEth > 0n) {
      const result = swapExactEthForStandard(pool, cfg, swapEth, {
        chargeFee: cfg.protocolSwapsPayFee,
      })
      standardOnHand += result.tokenAmount
      state.vaults.pendingProtocolEth += result.feeEth
      if (cfg.countProtocolSwapsInNetFlow) state.policy.currentEpochNetFlow += result.grossEth
    }

    const ethSide = budget - swapEth
    if (ethSide <= 0n || standardOnHand <= 0n) {
      pool.pendingPolEth += ethSide
      pool.pendingPolStandard += standardOnHand
      return
    }

    const required = standardToPair(pool, ethSide)
    let ethAdded: Wei
    let standardAdded: Tokens
    if (required <= standardOnHand) {
      ethAdded = ethSide
      standardAdded = required
    } else {
      standardAdded = standardOnHand
      ethAdded = (standardOnHand * pool.ethReserve) / pool.standardReserve
    }

    if (ethAdded > 0n && standardAdded > 0n) {
      const shares = addLiquidity(pool, ethAdded, standardAdded)
      this.events.push({
        type: 'polAdded',
        tick: state.tick,
        eth: ethAdded,
        standard: standardAdded,
        sharesMinted: shares,
      })
    } else {
      ethAdded = 0n
      standardAdded = 0n
    }
    pool.pendingPolEth += ethSide - ethAdded
    pool.pendingPolStandard += standardOnHand - standardAdded
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * One branch's nominal issuance over one day: `baseRatePerDay * m / N`.
   *
   * Nominal, because issuance is actually credited hourly and the per-branch
   * split floors, so the realised figure is at most `ticksPerDay` wei lower.
   * This is the quantity whitepaper 7's license floor is defined against.
   */
  yieldPerBranchPerDay(): Tokens {
    const state = this.state
    if (state.totalBranches <= 0 || state.issuanceHalted) return 0n
    return mulWad(this.config.baseRatePerDayTokens, state.policy.multiplier) / BigInt(state.totalBranches)
  }

  isReportable(charterId: number): boolean {
    if (!this.config.revocationEnabled) return false
    const charter = this.state.charters.get(charterId)
    if (charter === undefined || !charter.alive) return false
    return this.state.tick - charter.lastInteractionTick >= dormancyTicks(this.config)
  }

  currentLicensePrice(): Tokens {
    const auction = this.state.licenses
    if (!auction.open) return 0n
    return (auction.schedule[this.state.tick % this.config.ticksPerDay] ?? 0n) as Tokens
  }

  viewFor(agentId: string): AgentView {
    const cached = this.views.get(agentId)
    if (cached !== undefined) return cached
    const view = this.buildView(agentId)
    this.views.set(agentId, view)
    return view
  }

  private buildView(agentId: string): AgentView {
    const world = this
    const state = this.state
    return {
      get tick() {
        return state.tick
      },
      get day() {
        return state.day
      },
      get epoch() {
        return state.epoch
      },
      config: this.config,
      state,
      agentId,
      wallet(): Readonly<Wallet> {
        const wallet = state.wallets.get(agentId)
        return wallet === undefined ? { eth: 0n, standard: 0n } : { ...wallet }
      },
      charterIds(): number[] {
        const owned = state.chartersByOwner.get(agentId)
        if (owned === undefined) return []
        return owned.filter((id) => state.charters.get(id)?.alive === true)
      },
      accrued(charterId: number): Tokens {
        const charter = state.charters.get(charterId)
        if (charter === undefined || !charter.alive) return 0n
        return charterAccrued(state, charter)
      },
      branchCount(charterId: number): number {
        return state.charters.get(charterId)?.branchIds.length ?? 0
      },
      spotPrice(): bigint {
        return spotPrice(state.pool)
      },
      licensePrice(): Tokens {
        return world.currentLicensePrice()
      },
      licensesRemaining(): number {
        return state.licenses.remaining
      },
      yieldPerBranchPerDay(): Tokens {
        return world.yieldPerBranchPerDay()
      },
      isReportable(charterId: number): boolean {
        return world.isReportable(charterId)
      },
      reportableCharterIds(): number[] {
        const ids: number[] = []
        for (const charter of state.charters.values()) {
          if (world.isReportable(charter.id)) ids.push(charter.id)
        }
        return ids
      },
      credits(): Readonly<WalletCredits> {
        const credits = state.credits.get(agentId)
        return credits === undefined
          ? { withdrawal: 0n, retirement: 0n, revocationPayout: 0n, bounty: 0n }
          : { ...credits }
      },
      profitabilityFloor(): { tokens: Tokens; unreachable: boolean } {
        return {
          tokens: state.hunters.profitabilityFloorTokens,
          unreachable: state.hunters.profitabilityFloorUnreachable,
        }
      },
      stream(purpose: string): Rng {
        return world.rngFor(agentId, purpose)
      },
      transfersEnabled(): boolean {
        return state.seatMarket.enabled
      },
      seatListings(): readonly SeatListing[] {
        return [...state.seatMarket.listings.values()]
      },
      isSeatListed(charterId: number): boolean {
        return state.seatMarket.listings.has(charterId)
      },
      seatReservationEth(charterId: number): Wei {
        return world.seatReservationEth(charterId)
      },
      valueSeat(charterId: number) {
        return world.valueSeat(charterId)
      },
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private liveCharter(charterId: number): Charter {
    const charter = this.state.charters.get(charterId)
    if (charter === undefined) {
      throw new ProtocolError('NO_CHARTER', `charter ${charterId} does not exist`)
    }
    if (!charter.alive) {
      throw new ProtocolError('CHARTER_BURNED', `charter ${charterId} has been burned`)
    }
    return charter
  }

  private requireWallet(id: string): Wallet {
    const wallet = this.state.wallets.get(id)
    if (wallet === undefined) throw new ProtocolError('NO_WALLET', `no wallet for ${id}`)
    return wallet
  }

  private ensureWallet(id: string): Wallet {
    let wallet = this.state.wallets.get(id)
    if (wallet === undefined) {
      wallet = { eth: 0n, standard: 0n }
      this.state.wallets.set(id, wallet)
    }
    creditsFor(this.state, id)
    return wallet
  }

  /**
   * One pass over the live charters for the dormancy metrics.
   *
   * `reportableCharters` is measured at the end of the hour, so with hunters
   * running it is the backlog they have not cleared yet, not the number that
   * became reportable.
   */
  private dormancyScan(): {
    reportable: number
    reportableBranches: number
    ghostCount: number
    ghostBranches: number
  } {
    const state = this.state
    const floor = state.hunters.profitabilityFloorTokens
    const unreachable = state.hunters.profitabilityFloorUnreachable
    let reportable = 0
    let reportableBranches = 0
    let ghostCount = 0
    let ghostBranches = 0
    for (const charter of state.charters.values()) {
      if (!this.isReportable(charter.id)) continue
      reportable += 1
      reportableBranches += charter.branchIds.length
      const accrued = charterAccrued(state, charter)
      if (unreachable || accrued < floor) {
        ghostCount += 1
        ghostBranches += charter.branchIds.length
      }
    }
    return { reportable, reportableBranches, ghostCount, ghostBranches }
  }

  private snapshot(): TickSnapshot {
    const cfg = this.config
    const state = this.state
    const w = state.withdrawals.trailingTotal
    const d = state.ledger.totalAccrued
    const p = resolutionPressure(cfg, w, d)
    const scan = this.dormancyScan()
    const crowding = this.concentration()

    return {
      tick: state.tick,
      epoch: state.epoch,
      day: state.day,

      circulating: circulatingSupply(state, cfg),
      maxSupply: maxSupply(state, cfg),
      cumulativeMints: state.token.cumulativeMints,
      mintedToWallets: state.token.mintedToWallets,
      notionalMints: state.token.notionalMints,
      cumulativeBurns: state.token.cumulativeBurns,
      burnsBySource: { ...state.token.burnsBySource },
      cumulativeIssuance: state.token.cumulativeIssuance,
      issuanceHalted: state.issuanceHalted,

      totalAccrued: state.ledger.totalAccrued,
      mintedFromLedger: state.ledger.mintedFromLedger,
      burnedFromLedger: state.ledger.burnedFromLedger,
      redistributedThisTick: { ...state.tickRedistributed },
      trailingWithdrawals: w,
      resolutionPressure: p,
      resolutionFeeRate: resolutionFeeRate(cfg, p),

      totalBranches: state.totalBranches,
      liveCharters: state.liveCharters,
      yieldPerBranchPerDay: this.yieldPerBranchPerDay(),
      branchesOpenedThisTick: state.wave.branchesOpenedThisTick,
      branchesRetiredThisTick: state.wave.branchesRetiredThisTick,

      multiplier: state.policy.multiplier,
      epochIndex: state.epoch,
      currentEpochNetFlow: state.policy.currentEpochNetFlow,
      lastEpochNetFlow: state.policy.lastEpochNetFlow,
      signal: state.policy.lastSignal,
      regime: state.policy.lastEpochNetFlow > 0n ? 'expansion' : 'contraction',

      poolPrice: spotPrice(state.pool),
      poolEthReserve: state.pool.ethReserve,
      poolStandardReserve: state.pool.standardReserve,
      polShares: state.pool.polShares,
      polEth: state.pool.cumulativePolEthAdded,
      polStandard: state.pool.cumulativePolStandardAdded,
      expansionVaultEth: state.vaults.expansionEth,
      contractionVaultEth: state.vaults.contractionEth,
      teamEth: state.vaults.teamEth,
      pendingProtocolEth: state.vaults.pendingProtocolEth,
      ethVolumeByOrigin: { ...state.ethVolumeByOrigin },

      licensePrice: this.currentLicensePrice(),
      licenseFloor: state.licenses.pFloor,
      licensesRemaining: state.licenses.remaining,
      licensesSoldToday: state.licenses.soldToday,

      reportableCharters: scan.reportable,
      revokedThisTick: state.wave.revokedThisTick,
      branchesDestroyedThisTick: state.wave.branchesDestroyedThisTick,
      cumulativeRevoked: state.wave.cumulativeRevoked,
      waveIndex: state.wave.index,
      profitabilityFloorTokens: state.hunters.profitabilityFloorTokens,
      profitabilityFloorUnreachable: state.hunters.profitabilityFloorUnreachable,
      ghostsBelowFloor: { count: scan.ghostCount, branches: scan.ghostBranches },
      dormantCohort: {
        charterShare: state.liveCharters > 0 ? shareWad(scan.reportable, state.liveCharters) : 0n,
        branchShare:
          state.totalBranches > 0 ? shareWad(scan.reportableBranches, state.totalBranches) : 0n,
      },
      hunterGasSpentEth: state.hunters.cumulativeGasSpentEth,

      transfersEnabled: state.seatMarket.enabled,
      seatListingsOpen: state.seatMarket.listings.size,
      seatSalesThisTick: state.seatMarket.salesThisTick,
      cumulativeSeatSales: state.seatMarket.cumulativeSales,
      seatMarketEthVolume: state.seatMarket.cumulativeVolumeEth,
      cumulativeBranchesTransferred: state.seatMarket.cumulativeBranchesTransferred,
      concentrationHHI: crowding.hhi,
      largestHolderBranchShare: crowding.largestShare,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroVolume(): EthVolumeByOrigin {
  return { retirement: 0n, revocationPayout: 0n, trader: 0n }
}

function shareWad(part: number, whole: number): bigint {
  if (whole <= 0) return 0n
  return (BigInt(part) * WAD) / BigInt(whole)
}

// ---------------------------------------------------------------------------
// Genesis
// ---------------------------------------------------------------------------

function genesis(cfg: Config, cohortRng: Rng): WorldState {
  const charters = new Map<number, Charter>()
  const chartersByOwner = new Map<string, number[]>()
  const branches = new Map<number, Branch>()
  const wallets = new Map<string, Wallet>()
  const credits = new Map<string, WalletCredits>()
  const archetypes: Archetype[] = assignArchetypes(cfg, cohortRng)

  let nextBranchId = 0
  let totalBranches = 0
  for (let i = 0; i < cfg.genesisCharters; i++) {
    const ownerId = `${cfg.ownerIdPrefix}-${i}`
    const archetype = archetypes[i] as Archetype
    wallets.set(ownerId, { eth: cfg.genesisWalletEth, standard: cfg.genesisWalletStandard })
    credits.set(ownerId, { withdrawal: 0n, retirement: 0n, revocationPayout: 0n, bounty: 0n })

    const branchIds: number[] = []
    const openWith = genesisBranchesFor(cfg, archetype)
    for (let b = 0; b < openWith; b++) {
      const branch: Branch = {
        id: nextBranchId++,
        charterId: i,
        settled: 0n,
        indexAt: 0n,
        openedTick: 0,
      }
      branches.set(branch.id, branch)
      branchIds.push(branch.id)
    }
    totalBranches += openWith

    chartersByOwner.set(ownerId, [i])
    charters.set(i, {
      id: i,
      ownerId,
      branchIds,
      alive: true,
      // Whitepaper 6: all genesis charters are created at t = 0, so the whole
      // cohort's dormancy clock starts together. That is what makes the first
      // revocation wave a wave.
      lastInteractionTick: 0,
      licensesBoughtToday: 0,
      genesis: true,
      archetype,
      transferred: false,
      revokedAtTick: null,
    })
  }

  // Seat buyers are new capital entering the ecosystem, not existing bankers.
  // Their wallets exist from genesis so that ids and balances are stable, but
  // nothing can be bought until the transfer switch is thrown.
  if (cfg.charterTransfersEnabledAtDay !== null) {
    for (let b = 0; b < cfg.seat.buyers.count; b++) {
      const id = `${cfg.seat.buyers.idPrefix}-${b}`
      wallets.set(id, { eth: cfg.seat.buyers.budgetEth, standard: 0n })
      credits.set(id, { withdrawal: 0n, retirement: 0n, revocationPayout: 0n, bounty: 0n })
    }
  }

  // Hunters hold ETH so that gas is a real constraint on them.
  for (let h = 0; h < cfg.hunter.count; h++) {
    const id = `${cfg.hunterIdPrefix}-${h}`
    wallets.set(id, { eth: cfg.hunter.startingEth, standard: 0n })
    credits.set(id, { withdrawal: 0n, retirement: 0n, revocationPayout: 0n, bounty: 0n })
  }

  return {
    tick: 0,
    epoch: 0,
    day: 0,
    token: {
      cumulativeMints: 0n,
      mintedToWallets: 0n,
      notionalMints: 0n,
      cumulativeBurns: 0n,
      burnsBySource: { license: 0n, buyback: 0n, resolutionFee: 0n, revocationFee: 0n },
      cumulativeIssuance: 0n,
    },
    ledger: { rewardIndex: 0n, totalAccrued: 0n, mintedFromLedger: 0n, burnedFromLedger: 0n },
    pool: createPool(cfg),
    policy: {
      multiplier: cfg.multiplierInitWad,
      netFlowHistory: [],
      currentEpochNetFlow: 0n,
      lastSignal: 0n,
      lastEpochNetFlow: 0n,
      epochEthVolumeByOrigin: zeroVolume(),
      lastEpochEthVolumeByOrigin: zeroVolume(),
    },
    licenses: {
      day: -1,
      open: false,
      pStart: 0n,
      pFloor: 0n,
      schedule: new Array<Tokens>(cfg.ticksPerDay).fill(0n),
      remaining: 0,
      soldToday: 0,
      lowestSoldPrice: null,
      previousLowestSoldPrice: null,
    },
    vaults: {
      pendingProtocolEth: 0n,
      expansionEth: 0n,
      contractionEth: 0n,
      teamEth: 0n,
      contractionStandardHeld: 0n,
      contractionStandardSold: 0n,
      cumulativeBuybackEth: 0n,
      cumulativeBuybackBurned: 0n,
      cumulativeRoutedEth: 0n,
      cumulativeToVaults: 0n,
      cumulativeToPol: 0n,
      cumulativeToTeam: 0n,
    },
    withdrawals: {
      ring: new Array<Tokens>(withdrawalWindowTicks(cfg)).fill(0n),
      cursor: 0,
      trailingTotal: 0n,
    },
    hunters: {
      profitabilityFloorTokens: 0n,
      profitabilityFloorUnreachable: false,
      priceAtScanWad: 0n,
      cumulativeGasSpentEth: 0n,
      cumulativeReportsAttempted: 0,
      cumulativeReportsLanded: 0,
      reportsThisTick: 0,
    },
    seatMarket: {
      enabled: false,
      enabledAtTick: null,
      listings: new Map(),
      bids: [],
      salesThisTick: 0,
      cumulativeVolumeEth: 0n,
      cumulativeSales: 0,
      cumulativeBranchesTransferred: 0,
      cumulativeBalanceTransferred: 0n,
      cumulativeExpired: 0,
    },
    multiplierTrailing: {
      ring: new Array<bigint>(7 * cfg.ticksPerDay).fill(0n),
      cursor: 0,
      sum: 0n,
      filled: 0,
    },
    wave: {
      index: 0,
      lastRevocationTick: null,
      revokedThisTick: 0,
      branchesDestroyedThisTick: 0,
      branchesRetiredThisTick: 0,
      branchesOpenedThisTick: 0,
      cumulativeRevoked: 0,
    },
    charters,
    chartersByOwner,
    branches,
    wallets,
    credits,
    totalBranches,
    liveCharters: cfg.genesisCharters,
    revokedCharterIds: [],
    nextCharterId: cfg.genesisCharters,
    nextBranchId,
    issuanceHalted: false,
    ethVolumeByOrigin: zeroVolume(),
    tickEthVolumeByOrigin: zeroVolume(),
    tickRedistributed: { resolutionFee: 0n, revocationFee: 0n },
  }
}
