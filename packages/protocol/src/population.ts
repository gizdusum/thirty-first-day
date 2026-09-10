/**
 * Populating a world with the study's agents.
 *
 * One `BankerAgent` per genesis charter, taking its behaviour from the
 * charter's archetype, plus one `BountyHunterPool`. Registration order is
 * charter id order, which is also the order actions are applied in — and
 * because archetypes are shuffled across charter ids at genesis, no archetype
 * gets a systematic head start in the first-come-first-served license auction
 * (whitepaper 8).
 */

import { BankerAgent } from './agents/banker.js'
import { BountyHunterPool } from './agents/bountyHunter.js'
import { RandomTrader } from './agents/randomTrader.js'
import type { World } from './world.js'

export interface Population {
  bankers: BankerAgent[]
  hunters: BountyHunterPool | null
  market: RandomTrader[]
}

export interface PopulateOptions {
  /** Register the bounty hunters. Default true. */
  withHunters?: boolean
  /** Register the outside traders. Default true. See `ExternalDemandConfig`. */
  withExternalDemand?: boolean
}

export function populateGenesisCohort(world: World, options: PopulateOptions = {}): Population {
  const bankers: BankerAgent[] = []
  for (const charter of world.state.charters.values()) {
    if (!charter.genesis) continue
    const banker = new BankerAgent(charter.ownerId, charter.id, charter.archetype)
    world.addAgent(banker)
    bankers.push(banker)
  }

  const market: RandomTrader[] = []
  if (options.withExternalDemand !== false) {
    const demand = world.config.externalDemand
    for (let i = 0; i < demand.traders; i++) {
      const trader = new RandomTrader(`${world.config.externalTraderIdPrefix}-${i}`, {
        activityWad: demand.activityWad,
        buyBiasWad: demand.buyBiasWad,
        maxTradeFractionWad: demand.maxTradeFractionWad,
      })
      world.addAgent(trader)
      world.fund(trader.id, demand.startingEth)
      market.push(trader)
    }
  }

  let hunters: BountyHunterPool | null = null
  if (options.withHunters !== false && world.config.hunter.count > 0) {
    hunters = new BountyHunterPool()
    world.addAgent(hunters)
  }
  return { bankers, hunters, market }
}
