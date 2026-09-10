/**
 * The axes.
 *
 * An axis is a named factor with a list of levels; a level is a display label
 * plus the config overrides that produce it. Suites compose these into cells.
 *
 * `licensesPerDay` is deliberately first. The day-31 probe found the dormant
 * cohort holding 8.2% of branches against 30.2% of charters, and the reason is
 * arithmetic: the auction sells at most 100 licenses a day and at most 3 to
 * any one charter, so in the thirty days before the wave the active cohort
 * physically cannot dilute the dormant one faster than that. The whitepaper
 * leaves `licensesPerDay` unspecified, and it turns out to be the binding
 * constraint on the whole question. It is a first-class axis, not a default.
 */

import { BPS, DEFAULT_CONFIG, WAD, type Config, type ConfigOverrides } from '@thirty-first-day/protocol'

import { DEMAND, DEMAND_REGIMES, type DemandRegime } from './demand.js'

export interface Level {
  label: string
  overrides: ConfigOverrides
}

export interface Axis {
  name: string
  /** One line on what the axis is and why it is in the study. */
  rationale: string
  levels: Level[]
}

/**
 * The baseline: whitepaper defaults with outside demand at `mild`.
 *
 * Written out rather than left implicit so the baseline cell's id is derived
 * from something explicit, and so that changing the default demand regime does
 * not silently move the study's central estimate.
 */
export function baselineOverrides(): ConfigOverrides {
  return { externalDemand: DEMAND.mild }
}

function withBase(overrides: ConfigOverrides): ConfigOverrides {
  return { ...baselineOverrides(), ...overrides }
}

// ---------------------------------------------------------------------------
// Cohort mix as a function of the dormancy rate
// ---------------------------------------------------------------------------

/**
 * The cohort mix at a given dormancy rate.
 *
 * `rate` is the Tourist + Lost share. Within it the default 2:1 Tourist:Lost
 * split is preserved; the remainder is split across Committed, Trader and
 * Casual in their default 30:15:25 proportions. Remainders go to Committed and
 * Tourist so the mix always sums to exactly 10,000 bps.
 */
export function mixForDormancyRate(rate: number): Config['cohortMixBps'] {
  const dormant = BigInt(Math.round(rate * 10_000))
  const lost = dormant / 3n
  const tourist = dormant - lost
  const active = BPS - dormant
  const trader = (active * 15n) / 70n
  const casual = (active * 25n) / 70n
  const committed = active - trader - casual
  return { committed, trader, casual, tourist, lost }
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

/**
 * "Unlimited" licenses.
 *
 * `Infinity` is not a valid config value — the daily inventory is an integer
 * count. One million a day is more than 1000 charters could buy at the
 * three-a-day per-charter cap, so it is unlimited in every way that matters
 * while remaining a real number that hashes into a cell id.
 */
export const UNLIMITED_LICENSES = 1_000_000

export const LICENSES_PER_DAY: Axis = {
  name: 'licensesPerDay',
  rationale:
    'The binding constraint on how fast the active cohort can dilute the dormant one before day 31.',
  levels: [25, 50, 100, 200, 400, UNLIMITED_LICENSES].map((n) => ({
    label: n === UNLIMITED_LICENSES ? 'unlimited' : String(n),
    overrides: withBase({ licensesPerDay: n }),
  })),
}

export const PER_CHARTER_LICENSE_LIMIT: Axis = {
  name: 'perCharterLicenseLimit',
  rationale: 'The other half of the dilution constraint: how fast any one charter can expand.',
  levels: [1, 3, 5, 10].map((n) => ({
    label: String(n),
    overrides: withBase({ maxLicensesPerCharterPerDay: n }),
  })),
}

export const DORMANCY_RATE: Axis = {
  name: 'dormancyRate',
  rationale: 'The Tourist + Lost share of the genesis cohort — the size of the wave.',
  levels: [0.05, 0.15, 0.3, 0.45, 0.6].map((rate) => ({
    label: rate.toFixed(2),
    overrides: withBase({ cohortMixBps: mixForDormancyRate(rate) }),
  })),
}

export const DEMAND_REGIME: Axis = {
  name: 'demandRegime',
  rationale: 'The market the wave lands in. `chop` is the asymmetric-policy case.',
  levels: DEMAND_REGIMES.map((regime: DemandRegime) => ({
    label: regime,
    overrides: { ...baselineOverrides(), externalDemand: DEMAND[regime] },
  })),
}

export const HUNTER_COUNT: Axis = {
  name: 'hunterCount',
  rationale: 'How much contention there is for each ghost, and so how high the gas war goes.',
  levels: [1, 4, 16].map((n) => ({
    label: String(n),
    overrides: withBase({ hunter: { ...DEFAULT_CONFIG.hunter, count: n } }),
  })),
}

export const MAX_REPORTS_PER_HOUR: Axis = {
  name: 'maxReportsPerHour',
  rationale: 'Throughput: whether a synchronized wave clears in a day or a month.',
  levels: [1, 4, 24].map((n) => ({
    label: String(n),
    overrides: withBase({ hunter: { ...DEFAULT_CONFIG.hunter, maxReportsPerHour: n } }),
  })),
}

export const BOUNTY_SOURCE: Axis = {
  name: 'dormancyBountySource',
  rationale: 'Both readings of F-01, the 102% split in whitepaper 10.',
  levels: (['revocationFee', 'bankerShare'] as const).map((source) => ({
    label: source,
    overrides: withBase({ dormancyBountySource: source }),
  })),
}

export const PAYOUT_SELL_FRACTION: Axis = {
  name: 'payoutSellFraction',
  rationale: 'How much of the 30% revocation payout reaches the pool at all.',
  levels: [0, 0.5, 1].map((f) => ({
    label: f.toFixed(1),
    overrides: withBase({
      payout: { ...DEFAULT_CONFIG.payout, sellFractionWad: BigInt(Math.round(f * 1e6)) * 10n ** 12n },
    }),
  })),
}

export const PAYOUT_SELL_OVER_HOURS: Axis = {
  name: 'payoutSellOverHours',
  rationale: 'Whether the payout hits the pool as a block or a trickle.',
  levels: [1, 24, 168].map((h) => ({
    label: String(h),
    overrides: withBase({ payout: { ...DEFAULT_CONFIG.payout, sellOverHours: h } }),
  })),
}

export const EPOCH_DAYS: Axis = {
  name: 'epochDays',
  rationale: 'How often policy reacts. Whitepaper 5 never fixes the epoch length.',
  levels: [0.25, 1, 3].map((d) => ({
    label: String(d),
    overrides: withBase({ epochDays: d }),
  })),
}

/**
 * The policy asymmetry.
 *
 * A ratio of 1 is the symmetric case. Whitepaper 5 says `cutStep > raiseStep`
 * "by design", so ratio 1 is off-spec — it is included precisely as the
 * control for whether the asymmetry is what produces the ratchet under `chop`.
 */
export const CUT_RAISE_RATIO: Axis = {
  name: 'cutRaiseRatio',
  rationale: 'Whether the asymmetric policy rule is what ratchets `m` down in choppy markets.',
  levels: [1, 2, 3, 5].map((r) => ({
    label: `${r}:1`,
    overrides: withBase({
      multiplierRaiseStepWad: DEFAULT_CONFIG.multiplierRaiseStepWad,
      multiplierCutStepWad: DEFAULT_CONFIG.multiplierRaiseStepWad * BigInt(r),
    }),
  })),
}

/**
 * Whitepaper 12's one-way switch.
 *
 * Levels below 30 pre-empt the wave: the market is open before anyone becomes
 * reportable, so a seat can leave through the second exit path instead of
 * being revoked. Levels above 30 can only catch the tail. `null` is soulbound
 * forever and is the level every other suite runs at.
 *
 * The shape of the curve between those two regimes is the deliverable.
 */
export const CHARTER_TRANSFERS: Axis = {
  name: 'charterTransfersEnabledAtDay',
  rationale:
    'When the one-way transfer switch is thrown, relative to the day-31 wave. Before 30 pre-empts it; after 30 only catches the tail.',
  levels: ([null, 0, 7, 15, 21, 25, 29, 31, 45] as Array<number | null>).map((day) => ({
    label: day === null ? 'null' : String(day),
    overrides: withBase({ charterTransfersEnabledAtDay: day }),
  })),
}

/**
 * Whether whitepaper 6's one-charter-per-wallet limit survives transferability.
 *
 * Held at a switch day of 15 — early enough to pre-empt the wave — because the
 * limit is inert while charters are soulbound and the axis would otherwise be
 * measuring nothing. See F-05.
 */
export const POST_TRANSFER_CHARTER_LIMIT: Axis = {
  name: 'postTransferCharterLimit',
  rationale: 'Whether seats can be accumulated once they are transferable, and what that does to concentration.',
  levels: [1, Number.POSITIVE_INFINITY].map((limit) => ({
    label: Number.isFinite(limit) ? String(limit) : 'unlimited',
    overrides: withBase({ charterTransfersEnabledAtDay: 15, postTransferCharterLimit: limit }),
  })),
}

/** Every axis except the hunter gas axis, which has to be calibrated per cell. */
export const STATIC_AXES: readonly Axis[] = [
  LICENSES_PER_DAY,
  PER_CHARTER_LICENSE_LIMIT,
  DORMANCY_RATE,
  DEMAND_REGIME,
  HUNTER_COUNT,
  MAX_REPORTS_PER_HOUR,
  BOUNTY_SOURCE,
  PAYOUT_SELL_FRACTION,
  PAYOUT_SELL_OVER_HOURS,
  EPOCH_DAYS,
  CUT_RAISE_RATIO,
  CHARTER_TRANSFERS,
  POST_TRANSFER_CHARTER_LIMIT,
]

/**
 * The gas axis, built around a numerically located profitability boundary.
 *
 * The boundary is not assumed: `calibrateGasBoundary` runs the cell with
 * hunters switched off, reads the dormant balances and the pool price on the
 * thirty-first day, and solves for the gas price at which the median ghost's
 * bounty exactly stops clearing a hunter's margin. The sweep is then relative
 * to that, so every cell is swept across its own boundary rather than across
 * an absolute gas price that might sit entirely on one side of it.
 */
export const GAS_MULTIPLES: readonly number[] = [0, 0.25, 0.5, 1, 2, 4, 8]

export function gasAxis(boundaryWei: bigint): Axis {
  return {
    name: 'hunterGasCostEth',
    rationale:
      'Swept across the numerically located profitability floor, where ghosts stop being worth collecting.',
    levels: GAS_MULTIPLES.map((multiple) => ({
      label: `${multiple}x boundary`,
      overrides: withBase({
        hunter: {
          ...DEFAULT_CONFIG.hunter,
          gasCostEth: (boundaryWei * BigInt(Math.round(multiple * 1e6))) / 1_000_000n,
        },
      }),
    })),
  }
}

export { WAD }
