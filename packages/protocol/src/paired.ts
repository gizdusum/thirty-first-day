/**
 * The paired counterfactual, and the attribution arm.
 *
 * The engine is deterministic, so the same world can be run more than once with
 * exactly one thing changed each time. Four arms, the last of them conditional:
 *
 *   control        revocation disabled. No charter is ever reportable, dormant
 *                  charters keep their branches and keep accruing.
 *   treatment      whitepaper 10 as written.
 *   noPayoutSell   as treatment, except that the 30% revocation payout is
 *                  minted into the banker's wallet and never sold.
 *   transferable   as treatment, plus whitepaper 12's one-way transfer switch
 *                  thrown on the configured day. Built only when
 *                  `charterTransfersEnabledAtDay` is non-null.
 *
 * `treatment − control` is everything revocation does.
 * `treatment − noPayoutSell` is the part of it caused specifically by payout
 * selling reaching the pool — the channel that turns a revocation wave into
 * negative net flow (§4), a lower multiplier (§5) and lower yield for everyone
 * who stayed.
 * `noPayoutSell − control` is everything else revocation does: the branch
 * destruction, the burn, and the redistribution.
 * `transferable − treatment` is what a seat market bought, or cost: revocations
 * avoided, value rescued from a 70% penalty, branches kept alive — and the ETH
 * that entered the economy without the net flow signal seeing it (F-06).
 *
 * The thing that makes this sound is that the arms do not share a random
 * sequence. Each agent draws from its own stream, derived from
 * `(seed, agentId, purpose)` — so when one arm takes a draw another never
 * takes, nothing else in that arm shifts. If that were not true the histories
 * would diverge for reasons unrelated to the lever being pulled and the whole
 * method would be worthless. `study.spec.ts` asserts it directly: with a cohort
 * that never goes dormant and never lists a seat, all four arms produce
 * byte-identical histories.
 */

import { resolveConfig, type Config, type ConfigOverrides } from './config/index.js'
import { populateGenesisCohort, type Population, type PopulateOptions } from './population.js'
import { createWorld, type World } from './world.js'

export type Arm = 'control' | 'treatment' | 'noPayoutSell' | 'transferable'

/** The arms that always exist. */
export const ARMS: readonly Arm[] = ['control', 'treatment', 'noPayoutSell'] as const

/**
 * Every arm, including the one that is conditional.
 *
 * `transferable` is built **only** when `charterTransfersEnabledAtDay` is
 * non-null. A fourth arm is a third more compute on every cell it applies to,
 * and cells that do not name the transfer axis must cost exactly what they
 * cost before it existed.
 */
export const ALL_ARMS: readonly Arm[] = [...ARMS, 'transferable'] as const

/** The arms a given configuration calls for. */
export function armsFor(config: Config): readonly Arm[] {
  return config.charterTransfersEnabledAtDay === null ? ARMS : ALL_ARMS
}

export interface ArmsOptions extends PopulateOptions {
  /**
   * Register agents on each world. Called once per arm. Defaults to
   * `populateGenesisCohort`, which is the study's own population.
   */
  populate?: (world: World, arm: Arm) => void
  /** Run every world for this many ticks before returning. Default 0. */
  ticks?: number
  /** Which arms to build. Defaults to whatever the config calls for. */
  arms?: readonly Arm[]
}

export interface ArmsRun {
  control: World
  treatment: World
  noPayoutSell: World
  /** Only present when `charterTransfersEnabledAtDay` is non-null. */
  transferable: World | null
  populations: Partial<Record<Arm, Population>>
  config: Config
  arms: readonly Arm[]
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
    case 'transferable':
      // Revocation is on, exactly as in the treatment arm, and the transfer
      // switch is thrown on the configured day. The difference against
      // treatment is what transferability bought — or cost.
      return base
  }
}

/**
 * The config for the three unconditional arms, with the transfer switch off.
 *
 * `control`, `treatment` and `noPayoutSell` are all soulbound, whatever the
 * cell says about transfers: the transfer switch is the thing the fourth arm
 * varies, so it must be absent from the other three or there is nothing to
 * difference against.
 */
export function soulbound(base: Config): Config {
  return base.charterTransfersEnabledAtDay === null
    ? base
    : { ...base, charterTransfersEnabledAtDay: null }
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

  const available = armsFor(resolved)
  const wanted = options.arms ?? available
  const populations: Partial<Record<Arm, Population>> = {}
  const worlds = {} as Record<Arm, World>

  for (const arm of available) {
    // Every arm but `transferable` is soulbound, so the fourth arm is the only
    // thing the transfer switch changes.
    const armConfig =
      arm === 'transferable' ? configForArm(resolved, arm) : configForArm(soulbound(resolved), arm)
    const world = createWorld(armConfig, seed)
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
    transferable: worlds.transferable ?? null,
    populations,
    config: resolved,
    arms: available,
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
