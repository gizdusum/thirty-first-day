/**
 * The paired counterfactual, and the attribution arm.
 *
 * The engine is deterministic, so the same world can be run more than once with
 * exactly one thing changed each time. Three arms:
 *
 *   control        revocation disabled. No charter is ever reportable, dormant
 *                  charters keep their branches and keep accruing.
 *   treatment      whitepaper 10 as written.
 *   noPayoutSell   as treatment, except that the 30% revocation payout is
 *                  minted into the banker's wallet and never sold.
 *
 * `treatment − control` is everything revocation does.
 * `treatment − noPayoutSell` is the part of it caused specifically by payout
 * selling reaching the pool — the channel that turns a revocation wave into
 * negative net flow (§4), a lower multiplier (§5) and lower yield for everyone
 * who stayed.
 * `noPayoutSell − control` is everything else revocation does: the branch
 * destruction, the burn, and the redistribution.
 *
 * The thing that makes this sound is that the arms do not share a random
 * sequence. Each agent draws from its own stream, derived from
 * `(seed, agentId, purpose)` — so when one arm takes a draw another never
 * takes, nothing else in that arm shifts. If that were not true the histories
 * would diverge for reasons unrelated to the lever being pulled and the whole
 * method would be worthless. `study.spec.ts` asserts it directly: with a cohort
 * that never goes dormant, all three arms produce byte-identical histories.
 */

import { resolveConfig, type Config, type ConfigOverrides } from './config/index.js'
import { populateGenesisCohort, type Population, type PopulateOptions } from './population.js'
import { createWorld, type World } from './world.js'

export type Arm = 'control' | 'treatment' | 'noPayoutSell'

export const ARMS: readonly Arm[] = ['control', 'treatment', 'noPayoutSell'] as const

export interface ArmsOptions extends PopulateOptions {
  /**
   * Register agents on each world. Called once per arm. Defaults to
   * `populateGenesisCohort`, which is the study's own population.
   */
  populate?: (world: World, arm: Arm) => void
  /** Run every world for this many ticks before returning. Default 0. */
  ticks?: number
  /** Which arms to build. Default all three. */
  arms?: readonly Arm[]
}

export interface ArmsRun {
  control: World
  treatment: World
  noPayoutSell: World
  populations: Partial<Record<Arm, Population>>
  config: Config
  seed: number
}

/** The config for one arm: the treatment config with that arm's lever pulled. */
export function configForArm(base: Config, arm: Arm): Config {
  switch (arm) {
    case 'treatment':
      return base
    case 'control':
      return { ...base, revocationEnabled: false }
    case 'noPayoutSell':
      return { ...base, payout: { ...base.payout, reachesPool: false } }
  }
}

export function runArms(
  config: ConfigOverrides | Config = {},
  seed = 0,
  options: ArmsOptions = {},
): ArmsRun {
  const resolved = resolveConfig(config as ConfigOverrides)
  if (!resolved.revocationEnabled) {
    throw new RangeError(
      'runArms: the treatment arm must have revocationEnabled; the other arms are derived from it',
    )
  }
  if (!resolved.payout.reachesPool) {
    throw new RangeError(
      'runArms: the treatment arm must let payouts reach the pool; noPayoutSell is derived from it',
    )
  }

  const wanted = options.arms ?? ARMS
  const populations: Partial<Record<Arm, Population>> = {}
  const worlds = {} as Record<Arm, World>

  for (const arm of ARMS) {
    const world = createWorld(configForArm(resolved, arm), seed)
    worlds[arm] = world
    if (!wanted.includes(arm)) continue
    if (options.populate !== undefined) {
      options.populate(world, arm)
    } else {
      const populateOptions: PopulateOptions = {}
      if (options.withHunters !== undefined) populateOptions.withHunters = options.withHunters
      if (options.withExternalDemand !== undefined) {
        populateOptions.withExternalDemand = options.withExternalDemand
      }
      populations[arm] = populateGenesisCohort(world, populateOptions)
    }
  }

  const ticks = options.ticks ?? 0
  for (let t = 0; t < ticks; t++) {
    for (const arm of wanted) worlds[arm].tick()
  }

  return {
    control: worlds.control,
    treatment: worlds.treatment,
    noPayoutSell: worlds.noPayoutSell,
    populations,
    config: resolved,
    seed,
  }
}

// ---------------------------------------------------------------------------
// Backwards-compatible two-arm form
// ---------------------------------------------------------------------------

export interface PairedOptions extends ArmsOptions {}

export interface PairedRun {
  treatment: World
  control: World
  populations: { treatment: Population | null; control: Population | null }
  config: Config
  seed: number
}

/** `runArms` restricted to the control and treatment arms. */
export function runPaired(
  config: ConfigOverrides | Config = {},
  seed = 0,
  options: PairedOptions = {},
): PairedRun {
  const run = runArms(config, seed, { ...options, arms: ['control', 'treatment'] })
  return {
    treatment: run.treatment,
    control: run.control,
    populations: {
      treatment: run.populations.treatment ?? null,
      control: run.populations.control ?? null,
    },
    config: run.config,
    seed: run.seed,
  }
}
