/**
 * A genesis banker.
 *
 * One agent per genesis charter. Behaviour is decided by the charter's
 * archetype (see `src/cohort.ts`), and the archetype decides — indirectly, and
 * this is the point — how many branches the charter is holding when the
 * dormancy wave arrives. Committed bankers buy licenses and expand. Tourists
 * and Lost never buy anything, so they still hold their single genesis branch.
 * Nothing hands the dormant cohort a branch share; it falls out of that.
 *
 * Every archetype takes the same number of RNG draws on a given tick whatever
 * the world is doing, so an agent's stream position depends only on how many
 * ticks it has lived through. That is what keeps the paired counterfactual in
 * `runPaired` aligned.
 */

import { WAD, minBig, mulWad } from '../math/fixed.js'
import { casualWindowTicks, dormancyTicks, type Config } from '../config/index.js'
import { resolutionFeeRate, resolutionPressure } from '../core/fees.js'
import { sellsPayout } from '../cohort.js'
import type { Rng } from '../rng/xoshiro128.js'
import type { Action, Agent, AgentView, Archetype, Tokens } from '../types.js'

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) return a
  return (a + b - 1n) / b
}

export class BankerAgent implements Agent {
  /** Set once the charter has been revoked; the banker has nothing left to run. */
  private charterGone = false

  // -- Revocation payout programme (whitepaper 10, and section 5 of the study)
  private seenPayout = 0n
  private payoutQueue = 0n
  private payoutHoursLeft = 0

  // -- Proceeds of a branch retirement, sold under their own origin tag
  private seenRetirement = 0n
  private retirementQueue = 0n

  // -- Casual: one decision per week
  private casualActionHour: number | null = null

  constructor(
    readonly id: string,
    readonly charterId: number,
    readonly archetype: Archetype,
  ) {}

  onTick(view: AgentView, rng: Rng): Action[] {
    const cfg = view.config
    const actions: Action[] = []

    this.trackCredits(view)
    this.emitProgrammedSales(view, actions)

    const charters = view.charterIds()
    if (!charters.includes(this.charterId)) {
      this.charterGone = true
      return actions
    }

    switch (this.archetype) {
      case 'committed':
        this.runCommitted(view, cfg, rng, actions)
        break
      case 'trader':
        this.runTrader(view, cfg, rng, actions)
        break
      case 'casual':
        this.runCasual(view, cfg, rng, actions)
        break
      case 'tourist':
      case 'lost':
        // Minted at genesis, never came back. Nothing to do, ever.
        break
    }
    return actions
  }

  /** True once this banker's charter has been revoked. */
  get revoked(): boolean {
    return this.charterGone
  }

  // -------------------------------------------------------------------------
  // Selling what the protocol has minted into this wallet
  // -------------------------------------------------------------------------

  private trackCredits(view: AgentView): void {
    const cfg = view.config
    const credits = view.credits()

    if (credits.revocationPayout > this.seenPayout) {
      const fresh = credits.revocationPayout - this.seenPayout
      this.seenPayout = credits.revocationPayout
      // The Lost cohort never sells, by definition: the payout sits in the
      // wallet forever.
      if (sellsPayout(this.archetype)) {
        this.payoutQueue += mulWad(fresh, cfg.payout.sellFractionWad)
        this.payoutHoursLeft = cfg.payout.sellOverHours
      }
    }

    if (credits.retirement > this.seenRetirement) {
      const fresh = credits.retirement - this.seenRetirement
      this.seenRetirement = credits.retirement
      if (sellsPayout(this.archetype)) this.retirementQueue += fresh
    }
  }

  /**
   * The programmed sales, spread evenly over `payout.sellOverHours`.
   *
   * These carry their origin, so the study can attribute how much of a
   * post-wave issuance cut traces back to revocation payouts specifically
   * rather than to ordinary trading.
   */
  private emitProgrammedSales(view: AgentView, actions: Action[]): void {
    // In the no-payout-sell arm the payout is minted and simply held. The
    // programme is not built at all, so no RNG is drawn and no action is
    // rejected — the arm differs from the treatment only in what reaches the
    // pool.
    if (!view.config.payout.reachesPool && this.payoutQueue > 0n) this.payoutQueue = 0n
    let available = view.wallet().standard

    if (this.payoutQueue > 0n && available > 0n) {
      const slice =
        this.payoutHoursLeft > 0
          ? ceilDiv(this.payoutQueue, BigInt(this.payoutHoursLeft))
          : this.payoutQueue
      const amount = minBig(slice, available)
      if (amount > 0n) {
        actions.push({
          type: 'swap',
          agentId: this.id,
          direction: 'sell',
          amountIn: amount,
          origin: 'revocationPayout',
        })
        this.payoutQueue -= amount
        available -= amount
      }
      if (this.payoutHoursLeft > 0) this.payoutHoursLeft -= 1
    }

    if (this.retirementQueue > 0n && available > 0n) {
      const amount = minBig(this.retirementQueue, available)
      actions.push({
        type: 'swap',
        agentId: this.id,
        direction: 'sell',
        amountIn: amount,
        origin: 'retirement',
      })
      this.retirementQueue -= amount
    }
  }

  // -------------------------------------------------------------------------
  // Archetypes
  // -------------------------------------------------------------------------

  /**
   * Checks in reliably, expands when a license pays for itself inside its
   * horizon, and otherwise leaves the balance at the bank.
   */
  private runCommitted(view: AgentView, cfg: Config, rng: Rng, actions: Action[]): void {
    // Fixed draw count: taken every tick whether or not it is used.
    const withdrawRoll = rng.nextBool(cfg.committed.withdrawProbabilityWad)

    const idle = view.tick - this.lastInteraction(view)
    let interacting = false

    const price = view.licensePrice()
    const yieldPerDay = view.yieldPerBranchPerDay()
    const boughtToday = view.state.charters.get(this.charterId)?.licensesBoughtToday ?? 0
    const wantsLicense =
      price > 0n &&
      yieldPerDay > 0n &&
      view.licensesRemaining() > 0 &&
      boughtToday < cfg.maxLicensesPerCharterPerDay &&
      view.branchCount(this.charterId) < cfg.maxBranchesPerCharter &&
      // Buy only if the branch pays for itself inside the horizon. As the
      // branch count grows the yield falls, so this stops being true — which
      // is what makes the committed cohort's expansion level off instead of
      // running straight to the ten-branch cap.
      price <= cfg.committed.paybackHorizonDays * yieldPerDay

    if (wantsLicense) {
      const held = view.wallet().standard
      let affordable = true
      if (held < price) {
        const gross = this.grossFor(view, cfg, price - held)
        // Withdraw only if it will actually complete the purchase. Draining a
        // small accrual every hour towards a price it cannot reach is not what
        // a committed banker does, and it would put a withdrawal on the wire
        // every tick for nothing.
        if (gross <= view.accrued(this.charterId)) {
          actions.push({ type: 'withdraw', charterId: this.charterId, amount: gross })
          interacting = true
        } else {
          affordable = false
        }
      }
      if (affordable) {
        actions.push({ type: 'buyLicense', charterId: this.charterId })
        interacting = true
      }
    }

    if (!interacting && withdrawRoll) {
      const accrued = view.accrued(this.charterId)
      const amount = mulWad(accrued, cfg.committed.withdrawFractionWad)
      if (amount > 0n) {
        actions.push({ type: 'withdraw', charterId: this.charterId, amount })
        interacting = true
      }
    }

    // Whatever else happened, do not let the clock run out. A committed banker
    // checks in inside the dormancy window even when the configured interval
    // is longer than that window, because that is what "committed" means.
    const interval = Math.max(1, Math.min(cfg.committed.checkInIntervalHours, dormancyTicks(cfg) - 1))
    if (!interacting && idle >= interval) {
      actions.push({ type: 'checkIn', charterId: this.charterId })
    }
  }

  /** Active. Buys, withdraws, sells, and occasionally retires a branch. */
  private runTrader(view: AgentView, cfg: Config, rng: Rng, actions: Action[]): void {
    // Four draws, taken every tick, so the stream position depends only on
    // how many ticks this agent has lived through.
    const acts = rng.nextBool(cfg.trader.actionProbabilityWad)
    const sells = rng.nextBool(cfg.trader.sellBiasWad)
    const retires = rng.nextBool(cfg.trader.retireProbabilityWad)
    const buys = rng.nextBool(cfg.trader.buyLicenseProbabilityWad)
    if (!acts) return

    if (retires && view.branchCount(this.charterId) > 1) {
      // The proceeds are sold under the 'retirement' origin on later ticks.
      actions.push({ type: 'retireBranches', charterId: this.charterId, k: 1 })
      return
    }

    const price = view.licensePrice()
    const boughtToday = view.state.charters.get(this.charterId)?.licensesBoughtToday ?? 0
    if (
      buys &&
      price > 0n &&
      view.licensesRemaining() > 0 &&
      boughtToday < cfg.maxLicensesPerCharterPerDay &&
      view.branchCount(this.charterId) < cfg.maxBranchesPerCharter &&
      view.wallet().standard >= price
    ) {
      actions.push({ type: 'buyLicense', charterId: this.charterId })
      return
    }

    if (sells) {
      const held = view.wallet().standard
      const amount = mulWad(held, cfg.trader.sellFractionWad)
      if (amount > 0n) {
        actions.push({
          type: 'swap',
          agentId: this.id,
          direction: 'sell',
          amountIn: amount,
          origin: 'trader',
        })
        // Selling is not a charter interaction, so keep the clock alive too.
        actions.push({ type: 'checkIn', charterId: this.charterId })
        return
      }
    }

    const accrued = view.accrued(this.charterId)
    const amount = mulWad(accrued, cfg.trader.withdrawFractionWad)
    if (amount > 0n) actions.push({ type: 'withdraw', charterId: this.charterId, amount })
    else actions.push({ type: 'checkIn', charterId: this.charterId })
  }

  /**
   * Irregular. Once a week it decides whether it will act at all, and if so
   * when. The gaps run past thirty days often enough that some of these lapse,
   * get reported, and some do not — which is what produces the secondary waves
   * after the synchronized genesis one.
   */
  private runCasual(view: AgentView, cfg: Config, rng: Rng, actions: Action[]): void {
    const window = casualWindowTicks(cfg)
    if (view.tick % window === 0) {
      // Two draws, at a fixed position in this agent's stream.
      const acts = rng.nextBool(cfg.casual.weeklyActionProbabilityWad)
      const hour = rng.nextInt(window)
      this.casualActionHour = acts ? hour : null
    }
    if (this.casualActionHour === null) return
    if (view.tick % window !== this.casualActionHour) return

    const withdraws = view.accrued(this.charterId) > 0n && (view.tick & 1) === 0
    if (withdraws) {
      const amount = mulWad(view.accrued(this.charterId), cfg.casual.withdrawFractionWad)
      if (amount > 0n) {
        actions.push({ type: 'withdraw', charterId: this.charterId, amount })
        return
      }
    }
    actions.push({ type: 'checkIn', charterId: this.charterId })
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private lastInteraction(view: AgentView): number {
    return view.state.charters.get(this.charterId)?.lastInteractionTick ?? 0
  }

  /**
   * The gross withdrawal needed to net `target` tokens after the resolution
   * fee (whitepaper 9), at the rate that currently applies.
   *
   * The rate moves with the withdrawal itself, so this is an estimate; the
   * banker simply takes a little more than it needs and leaves the difference
   * in the wallet.
   */
  private grossFor(view: AgentView, cfg: Config, target: Tokens): Tokens {
    const state = view.state
    const p = resolutionPressure(cfg, state.withdrawals.trailingTotal, state.ledger.totalAccrued)
    const rate = resolutionFeeRate(cfg, p)
    if (rate >= WAD) return target
    return (target * WAD) / (WAD - rate) + 1n
  }
}
