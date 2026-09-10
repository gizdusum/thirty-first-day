/**
 * The genesis cohort.
 *
 * The whitepaper treats the 1000 genesis bankers as one homogeneous set. They
 * are not, and the difference is the study. Five archetypes, mixed in
 * configurable proportions:
 *
 *   Committed  checks in reliably, buys licenses when the payback is inside
 *              its horizon, rarely withdraws
 *   Trader     active; withdraws and sells periodically, and resets its
 *              dormancy clock as a side effect of acting
 *   Casual     irregular; acts with probability p each week, so it can lapse
 *              past thirty days and come back — some of these get reported,
 *              some do not
 *   Tourist    mints and never returns; goes dormant on day 30 by construction
 *   Lost       keys gone; never returns, never sells, and its 30% revocation
 *              payout sits in the wallet forever
 *
 * The point that matters most: **the dormant cohort's share of branches is not
 * a parameter.** Tourists and Lost never buy licenses, so they still hold one
 * branch each when the wave arrives, while Committed bankers have expanded to
 * several. Their share of total branches is therefore much smaller than their
 * share of charters, and it is the branch share — not the charter share — that
 * decides how far `totalBranches` falls and how much everyone else's yield
 * rises. Both are recorded separately in every snapshot.
 */

import { BPS } from './math/fixed.js'
import type { Config } from './config/index.js'
import type { Rng } from './rng/xoshiro128.js'
import { ARCHETYPES, type Archetype } from './types.js'

/** Archetypes that never interact again once genesis is over. */
export function isStructurallyDormant(archetype: Archetype): boolean {
  return archetype === 'tourist' || archetype === 'lost'
}

/** Archetypes that will sell part of a revocation payout. Lost never sells. */
export function sellsPayout(archetype: Archetype): boolean {
  return archetype !== 'lost'
}

/**
 * Exact per-archetype counts for `genesisCharters`.
 *
 * Floors each share, then hands the floor remainder out one charter at a time
 * in a fixed archetype order, so the counts always sum to `genesisCharters`
 * and never depend on iteration order of an object.
 */
export function cohortCounts(cfg: Config): Record<Archetype, number> {
  const total = BigInt(cfg.genesisCharters)
  const counts = {} as Record<Archetype, number>
  let assigned = 0
  for (const archetype of ARCHETYPES) {
    const share = Number((total * cfg.cohortMixBps[archetype]) / BPS)
    counts[archetype] = share
    assigned += share
  }
  for (let i = 0; assigned < cfg.genesisCharters; i++) {
    const archetype = ARCHETYPES[i % ARCHETYPES.length] as Archetype
    counts[archetype] += 1
    assigned += 1
  }
  return counts
}

/**
 * One archetype per genesis charter, shuffled.
 *
 * The shuffle matters: without it every Committed banker would hold a lower
 * charter id than every Tourist, and charter id decides the order in which
 * agents act — which would quietly hand the committed cohort priority in the
 * first-come-first-served license auction (whitepaper 8).
 */
export function assignArchetypes(cfg: Config, rng: Rng): Archetype[] {
  const counts = cohortCounts(cfg)
  const assignment: Archetype[] = []
  for (const archetype of ARCHETYPES) {
    for (let i = 0; i < counts[archetype]; i++) assignment.push(archetype)
  }
  // Fisher-Yates, drawing from the dedicated cohort-assignment stream.
  for (let i = assignment.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1)
    const swap = assignment[i] as Archetype
    assignment[i] = assignment[j] as Archetype
    assignment[j] = swap
  }
  return assignment
}

/**
 * How many branches a genesis charter opens with.
 *
 * One, unless the sensitivity override is set — in which case the
 * structurally-dormant archetypes open with the override instead, so the study
 * can measure how its results move with the dormant cohort's branch share
 * without pretending that share is a free parameter in the base case.
 */
export function genesisBranchesFor(cfg: Config, archetype: Archetype): number {
  if (cfg.dormantGenesisBranchesOverride !== null && isStructurallyDormant(archetype)) {
    return cfg.dormantGenesisBranchesOverride
  }
  return cfg.genesisBranchesPerCharter
}
