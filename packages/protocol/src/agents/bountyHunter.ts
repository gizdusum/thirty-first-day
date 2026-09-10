/**
 * The bounty hunters.
 *
 * Whitepaper 10 says any address may report a dormant charter and that the
 * informant takes 2% of the dormant balance, capped at 100_000 tokens. It says
 * nothing about what reporting costs, and once it costs something, three
 * things follow that the whitepaper does not discuss:
 *
 *   1. There is a dormant balance below which reporting never pays. Those
 *      ghosts are never cleaned up. They keep their branches and keep
 *      accruing, diluting every active banker for as long as the protocol
 *      runs. That threshold is `profitabilityFloorTokens`.
 *   2. Hunters compete. When several submit against the same charter in the
 *      same hour, one is included and the rest still pay gas — and the
 *      contention itself raises the gas, which pushes the profitability floor
 *      up exactly when the backlog is largest.
 *   3. Throughput is bounded. A synchronized thousand-charter wave does not
 *      clear in an hour.
 *
 * The hunters are modelled as one pool agent rather than N independent agents
 * because simultaneity has to be resolved somewhere: on a real chain the block
 * builder decides which of several competing reports lands. Each hunter still
 * has its own address and its own ETH balance, and each pays its own gas.
 */

import { mulWad } from '../math/fixed.js'
import { dormancyTicks, type Config } from '../config/index.js'
import { bountyFor, resolveContest } from '../core/hunters.js'
import { charterAccrued } from '../core/ledger.js'
import type { Rng } from '../rng/xoshiro128.js'
import type { Action, Agent, AgentView, Tokens, Wei } from '../types.js'

interface Candidate {
  charterId: number
  accrued: Tokens
  bounty: Tokens
  valueEth: Wei
}

export class BountyHunterPool implements Agent {
  constructor(readonly id: string = 'hunter-pool') {}

  hunterIds(cfg: Config): string[] {
    const ids: string[] = []
    for (let h = 0; h < cfg.hunter.count; h++) ids.push(`${cfg.hunterIdPrefix}-${h}`)
    return ids
  }

  onTick(view: AgentView, rng: Rng): Action[] {
    const cfg = view.config
    if (cfg.hunter.count <= 0 || cfg.hunter.maxReportsPerHour <= 0) return []

    const candidates = this.scan(view, cfg)
    const slots = Math.min(candidates.length, cfg.hunter.maxReportsPerHour)
    if (slots === 0) return []

    // Every hunter draws, every hour, whether or not it ends up submitting —
    // so the pool's stream position depends only on the tick.
    const picks: number[] = []
    for (let h = 0; h < cfg.hunter.count; h++) picks.push(rng.nextInt(slots))

    const actions: Action[] = []
    for (let slot = 0; slot < slots; slot++) {
      const candidate = candidates[slot] as Candidate
      const interested: string[] = []
      for (let h = 0; h < cfg.hunter.count; h++) {
        if (picks[h] === slot) interested.push(`${cfg.hunterIdPrefix}-${h}`)
      }
      if (interested.length === 0) continue

      const contest = this.settle(view, cfg, candidate.valueEth, interested)
      if (contest.submitters.length === 0) continue

      // One wins by a seeded draw among the submitters; the losers still pay.
      const winner = rng.nextInt(contest.submitters.length)
      for (let i = 0; i < contest.submitters.length; i++) {
        actions.push({
          type: 'submitReport',
          hunterId: contest.submitters[i] as string,
          charterId: candidate.charterId,
          gasEth: contest.gasEth,
          contenders: contest.submitters.length,
          bountyValueEth: candidate.valueEth,
          requiredEth: contest.requiredEth,
          included: i === winner,
        })
      }
    }
    return actions
  }

  /**
   * Reportable charters the hunters have actually noticed, richest first.
   *
   * `scanLatencyHours` is the lag between a charter becoming reportable and a
   * hunter seeing it: hunters poll, they do not watch every block.
   */
  private scan(view: AgentView, cfg: Config): Candidate[] {
    const state = view.state
    const price = state.hunters.priceAtScanWad
    const visibleAfter = dormancyTicks(cfg) + cfg.hunter.scanLatencyHours
    const candidates: Candidate[] = []

    for (const charter of state.charters.values()) {
      if (!charter.alive) continue
      if (state.tick - charter.lastInteractionTick < visibleAfter) continue
      if (!view.isReportable(charter.id)) continue
      const accrued = charterAccrued(state, charter)
      const bounty = bountyFor(cfg, accrued)
      candidates.push({
        charterId: charter.id,
        accrued,
        bounty,
        valueEth: mulWad(bounty, price),
      })
    }

    // Biggest ghosts first; charter id breaks ties so the order is total.
    candidates.sort((a, b) =>
      a.valueEth === b.valueEth ? a.charterId - b.charterId : a.valueEth > b.valueEth ? -1 : 1,
    )
    return candidates
  }

  /**
   * Who actually submits, and at what gas.
   *
   * The number of contenders sets the gas, the gas decides who is still
   * willing, and a hunter that cannot afford the gas drops out — which lowers
   * the gas again. The three are solved together; the group only ever shrinks,
   * so the loop terminates.
   */
  private settle(
    view: AgentView,
    cfg: Config,
    valueEth: Wei,
    interested: readonly string[],
  ): { submitters: string[]; gasEth: Wei; requiredEth: Wei } {
    const state = view.state
    const ethOf = (id: string): Wei => state.wallets.get(id)?.eth ?? 0n

    let group = interested.filter((id) => ethOf(id) >= cfg.hunter.gasCostEth)
    for (;;) {
      const contest = resolveContest(cfg, valueEth, group.length)
      if (contest.contenders === 0) {
        return { submitters: [], gasEth: contest.gasEth, requiredEth: contest.requiredEth }
      }
      group = group.slice(0, contest.contenders)
      const affordable = group.filter((id) => ethOf(id) >= contest.gasEth)
      if (affordable.length === group.length) {
        return { submitters: group, gasEth: contest.gasEth, requiredEth: contest.requiredEth }
      }
      group = affordable
      if (group.length === 0) {
        return { submitters: [], gasEth: contest.gasEth, requiredEth: contest.requiredEth }
      }
    }
  }
}
