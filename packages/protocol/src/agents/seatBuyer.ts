/**
 * The seat buyers — whitepaper 12.
 *
 * New capital entering the ecosystem in exchange for a claim on issuance, not
 * existing bankers rotating. That distinction is the point: the ETH a buyer
 * brings never passes through the pool, so `F_n` — which whitepaper 2 calls
 * the one place ETH enters or leaves this economy — never sees it. The study
 * measures the size of that blind spot as `seatMarketEthVolume`. See F-06.
 *
 * Modelled as one pool agent for the same reason as the bounty hunters:
 * simultaneity has to be resolved somewhere. Each buyer still has its own
 * address and its own budget, and pays for its own seat.
 *
 * A buyer's valuation of a seat does not depend on which buyer it is — the
 * model in `core/seats.ts` is a function of the seat and the world, nothing
 * else. So the pool prices each listing once and assigns buyers to listings in
 * charter-id order, one seat per buyer per clearing round. There is no order
 * book and no strategy beyond the one documented valuation.
 */

import { dormancyTicks } from '../config/index.js'
import type { Rng } from '../rng/xoshiro128.js'
import type { Action, Agent, AgentView } from '../types.js'

export class SeatBuyerPool implements Agent {
  constructor(readonly id: string = 'seat-buyer-pool') {}

  /**
   * Keep the seats already bought out of the dormancy clock.
   *
   * The one behaviour a buyer is given beyond its valuation, and it is not a
   * strategy: whitepaper 12 says "the buyer replaces the seller one for one",
   * and somebody who has just paid ETH for a seat does not then let it be
   * revoked for a 70% penalty when a check-in is free (whitepaper 10). Without
   * it a seat sale is not an exit but a thirty-day deferral, which would make
   * the whole arm measure the wrong thing.
   *
   * It stops there. The buyer does not trade, does not withdraw, and does not
   * buy licenses — so a seat that changes hands stops expanding, which is a
   * real consequence of transferability and shows up in `branchesKeptAlive`.
   */
  private mindOwnedSeats(view: AgentView, actions: Action[]): void {
    const cfg = view.config
    const state = view.state
    // Check in comfortably inside the window rather than at the last hour, so
    // a buyer is never one tick away from losing what it paid for.
    const dueAfter = Math.max(1, Math.floor(dormancyTicks(cfg) / 2))
    for (let b = 0; b < cfg.seat.buyers.count; b++) {
      const owned = state.chartersByOwner.get(`${cfg.seat.buyers.idPrefix}-${b}`)
      if (owned === undefined) continue
      for (const id of owned) {
        const charter = state.charters.get(id)
        if (charter === undefined || !charter.alive) continue
        if (state.tick - charter.lastInteractionTick < dueAfter) continue
        actions.push({ type: 'checkIn', charterId: id })
      }
    }
  }

  buyerIds(view: AgentView): string[] {
    const { count, idPrefix } = view.config.seat.buyers
    const ids: string[] = []
    for (let b = 0; b < count; b++) ids.push(`${idPrefix}-${b}`)
    return ids
  }

  onTick(view: AgentView, _rng: Rng): Action[] {
    const cfg = view.config
    if (!view.transfersEnabled()) return []
    // Clearing is once a day, so bidding — and minding what has already been
    // bought — is too.
    if (view.tick % cfg.ticksPerDay !== 0) return []

    const state = view.state
    const actions: Action[] = []
    this.mindOwnedSeats(view, actions)

    const listings = view.seatListings()
    if (listings.length === 0 || cfg.seat.buyers.count === 0) return actions

    let nextBuyer = 0

    // Listings in charter-id order, so the assignment is stable across runs.
    const ordered = [...listings].sort((a, b) => a.charterId - b.charterId)
    for (const listing of ordered) {
      if (nextBuyer >= cfg.seat.buyers.count) break
      let valuation: bigint
      try {
        valuation = view.valueSeat(listing.charterId).totalEth
      } catch {
        continue // the charter went away between listing and bidding
      }
      if (valuation <= 0n) continue

      // Walk to the next buyer that is both funded and still allowed a seat.
      while (nextBuyer < cfg.seat.buyers.count) {
        const buyerId = `${cfg.seat.buyers.idPrefix}-${nextBuyer}`
        const wallet = state.wallets.get(buyerId)
        const held = state.chartersByOwner.get(buyerId)
        const liveHeld =
          held === undefined
            ? 0
            : held.filter((id) => state.charters.get(id)?.alive === true).length
        if (wallet === undefined || liveHeld >= cfg.postTransferCharterLimit) {
          nextBuyer += 1
          continue
        }
        // A buyer will not bid more than it can pay. The clearing price is the
        // midpoint, so a budget that covers the valuation always covers it.
        if (wallet.eth < valuation) {
          nextBuyer += 1
          continue
        }
        actions.push({ type: 'bidForSeat', buyerId, charterId: listing.charterId, valuationEth: valuation })
        nextBuyer += 1
        break
      }
    }
    return actions
  }
}
