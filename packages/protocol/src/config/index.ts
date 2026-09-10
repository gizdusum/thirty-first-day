import { BPS, WAD } from '../math/fixed.js'
import { DEFAULT_CONFIG, type Config } from './defaults.js'

export { DEFAULT_CONFIG }
export type {
  Config,
  BountySource,
  ExpansionVaultPolicy,
  CohortMixBps,
  CommittedConfig,
  TraderConfig,
  CasualConfig,
  PayoutConfig,
  HunterConfig,
  ExternalDemandConfig,
  SeatMarketConfig,
  BuyerExpectation,
  SeatClearingRule,
} from './defaults.js'

export type ConfigOverrides = Partial<Config>

/** Merges overrides over the defaults and validates the result. */
export function resolveConfig(overrides: ConfigOverrides = {}): Config {
  const cfg: Config = { ...DEFAULT_CONFIG, ...overrides }
  validateConfig(cfg)
  return cfg
}

/**
 * Hours in one epoch.
 *
 * `epochDays` may be fractional as long as it lands on a whole number of
 * hours, so that the study can sweep sub-daily epochs (whitepaper 5 never
 * fixes the epoch length).
 */
export function ticksPerEpoch(cfg: Config): number {
  return Math.round(cfg.epochDays * cfg.ticksPerDay)
}

export function withdrawalWindowTicks(cfg: Config): number {
  return cfg.withdrawalWindowDays * cfg.ticksPerDay
}

export function dormancyTicks(cfg: Config): number {
  return cfg.dormancyDays * cfg.ticksPerDay
}

/**
 * `hunter.marginRequired` as WAD, quantised to six decimal places.
 *
 * The interface takes a `number` because that is how a margin is naturally
 * written. Quantising on the way in means the value that reaches state is
 * exact, and two runs that were configured with the same literal always agree
 * to the wei.
 */
export function hunterMarginWad(cfg: Config): bigint {
  const quantised = Math.round(cfg.hunter.marginRequired * 1e6)
  return BigInt(quantised) * 1_000_000_000_000n
}

/** Ticks in one Casual decision window. */
export function casualWindowTicks(cfg: Config): number {
  return 7 * cfg.ticksPerDay
}

export function validateConfig(cfg: Config): void {
  const positiveInts: Array<[keyof Config, number]> = [
    ['ticksPerDay', cfg.ticksPerDay],
    ['genesisCharters', cfg.genesisCharters],
    ['genesisBranchesPerCharter', cfg.genesisBranchesPerCharter],
    ['licensesPerDay', cfg.licensesPerDay],
    ['maxLicensesPerCharterPerDay', cfg.maxLicensesPerCharterPerDay],
    ['maxBranchesPerCharter', cfg.maxBranchesPerCharter],
    ['withdrawalWindowDays', cfg.withdrawalWindowDays],
    ['dormancyDays', cfg.dormancyDays],
  ]
  for (const [name, value] of positiveInts) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`config.${String(name)} must be a positive integer, got ${value}`)
    }
  }

  if (!(cfg.epochDays > 0) || !Number.isInteger(cfg.epochDays * cfg.ticksPerDay)) {
    throw new RangeError(
      `config.epochDays must be positive and a whole number of hours, got ${cfg.epochDays}`,
    )
  }

  if (cfg.genesisBranchesPerCharter > cfg.maxBranchesPerCharter) {
    throw new RangeError('config.genesisBranchesPerCharter exceeds maxBranchesPerCharter')
  }

  // Whitepaper 3: the premint plus the issuance budget is the hard cap.
  if (cfg.polPremintTokens + cfg.issuanceBudgetTokens !== cfg.hardCapTokens) {
    throw new RangeError('config: polPremint + issuanceBudget must equal hardCap')
  }

  // Whitepaper 11: the fee split is exhaustive.
  if (cfg.feeSplitVaultBps + cfg.feeSplitPolBps + cfg.feeSplitTeamBps !== BPS) {
    throw new RangeError('config: fee split must sum to exactly 10_000 bps')
  }

  // Whitepaper 5: the clamp must be a real interval containing the start.
  if (cfg.multiplierMinWad <= 0n || cfg.multiplierMinWad > cfg.multiplierMaxWad) {
    throw new RangeError('config: multiplier bounds are inverted or non-positive')
  }
  if (
    cfg.multiplierInitWad < cfg.multiplierMinWad ||
    cfg.multiplierInitWad > cfg.multiplierMaxWad
  ) {
    throw new RangeError('config: multiplierInit is outside [multiplierMin, multiplierMax]')
  }
  // Whitepaper 5 says "cutStep > raiseStep by design", which is a statement
  // about the intended parameterisation rather than a protocol constraint. The
  // validator therefore admits the symmetric case, because the symmetric
  // policy is one of the counterfactuals the study sweeps: it is the control
  // for whether the asymmetry itself is doing the work.
  if (cfg.multiplierCutStepWad < cfg.multiplierRaiseStepWad) {
    throw new RangeError('config: multiplierCutStep must not be smaller than multiplierRaiseStep')
  }
  if (cfg.multiplierRaiseStepWad < 0n) {
    throw new RangeError('config: multiplierRaiseStep must be non-negative')
  }

  // Whitepaper 9: the fee curve must be a real interval and saturate somewhere.
  if (cfg.feeFloorWad < 0n || cfg.feeCeilingWad < cfg.feeFloorWad || cfg.feeCeilingWad > WAD) {
    throw new RangeError('config: resolution fee bounds are invalid')
  }
  if (cfg.pSaturationWad <= 0n || cfg.pSaturationWad > WAD) {
    throw new RangeError('config: pSaturation must be in (0, 1]')
  }
  if (cfg.pFloorDenominatorTokens <= 0n) {
    throw new RangeError('config: pFloorDenominator must be positive')
  }

  // Whitepaper 10: the bounty must fit inside whichever pot funds it.
  if (cfg.revocationFeeBps > BPS || cfg.informantBountyBps > BPS) {
    throw new RangeError('config: revocation percentages exceed 100%')
  }
  const bountyPot =
    cfg.dormancyBountySource === 'revocationFee' ? cfg.revocationFeeBps : BPS - cfg.revocationFeeBps
  if (cfg.informantBountyBps > bountyPot) {
    throw new RangeError('config: informant bounty cannot exceed the pot that funds it')
  }

  if (cfg.tradingFeeBps < 0n || cfg.tradingFeeBps >= BPS) {
    throw new RangeError('config: tradingFeeBps must be in [0, 10_000)')
  }
  if (cfg.poolInitialEth <= 0n || cfg.polPremintTokens <= 0n) {
    throw new RangeError('config: the pool must open with both reserves positive')
  }
  if (cfg.baseRatePerDayTokens < 0n) {
    throw new RangeError('config: baseRatePerDay must be non-negative')
  }
  if (cfg.licenseFloorDays <= 0n) {
    throw new RangeError('config: licenseFloorDays must be positive')
  }
  // A start multiple of 1 or less would make the Dutch curve flat or rising.
  if (cfg.licenseStartMultiple < 2n) {
    throw new RangeError('config: licenseStartMultiple must be at least 2')
  }
  if (cfg.contractionVaultSpendPerTickWad < 0n || cfg.contractionVaultSpendPerTickWad > WAD) {
    throw new RangeError('config: contractionVaultSpendPerTick must be in [0, 1]')
  }
  if (cfg.contractionReserveCapPerTickWad < 0n || cfg.contractionReserveCapPerTickWad > WAD) {
    throw new RangeError('config: contractionReserveCapPerTick must be in [0, 1]')
  }
  if (cfg.secondsPerTick !== 3600) {
    throw new RangeError('config: this model evaluates the issuance stream on an hourly tick')
  }

  // -- The genesis cohort must be a partition -------------------------------
  const mix = cfg.cohortMixBps
  const mixTotal = mix.committed + mix.trader + mix.casual + mix.tourist + mix.lost
  if (mixTotal !== BPS) {
    throw new RangeError(`config: cohortMixBps must sum to exactly 10_000 bps, got ${mixTotal}`)
  }
  for (const [name, share] of Object.entries(mix)) {
    if (share < 0n) throw new RangeError(`config: cohortMixBps.${name} is negative`)
  }

  if (cfg.committed.checkInIntervalHours <= 0) {
    throw new RangeError('config: committed.checkInIntervalHours must be positive')
  }
  if (cfg.committed.paybackHorizonDays <= 0n) {
    throw new RangeError('config: committed.paybackHorizonDays must be positive')
  }
  if (cfg.payout.sellFractionWad < 0n || cfg.payout.sellFractionWad > WAD) {
    throw new RangeError('config: payout.sellFractionWad must be in [0, 1]')
  }
  if (!Number.isInteger(cfg.payout.sellOverHours) || cfg.payout.sellOverHours <= 0) {
    throw new RangeError('config: payout.sellOverHours must be a positive integer')
  }

  // -- Hunters --------------------------------------------------------------
  const hunter = cfg.hunter
  if (!Number.isInteger(hunter.count) || hunter.count < 0) {
    throw new RangeError('config: hunter.count must be a non-negative integer')
  }
  if (!Number.isFinite(hunter.marginRequired) || hunter.marginRequired < 1) {
    throw new RangeError('config: hunter.marginRequired must be a finite number at least 1')
  }
  if (hunter.gasCostEth < 0n) throw new RangeError('config: hunter.gasCostEth must be non-negative')
  if (!Number.isInteger(hunter.scanLatencyHours) || hunter.scanLatencyHours < 0) {
    throw new RangeError('config: hunter.scanLatencyHours must be a non-negative integer')
  }
  if (!Number.isInteger(hunter.maxReportsPerHour) || hunter.maxReportsPerHour < 0) {
    throw new RangeError('config: hunter.maxReportsPerHour must be a non-negative integer')
  }
  if (hunter.gasWarEscalationWad < 0n) {
    throw new RangeError('config: hunter.gasWarEscalationWad must be non-negative')
  }

  const demand = cfg.externalDemand
  if (!Number.isInteger(demand.traders) || demand.traders < 0) {
    throw new RangeError('config: externalDemand.traders must be a non-negative integer')
  }
  if (demand.startingEth < 0n) {
    throw new RangeError('config: externalDemand.startingEth must be non-negative')
  }

  // -- The seat market (whitepaper 12) --------------------------------------
  const switchDay = cfg.charterTransfersEnabledAtDay
  if (switchDay !== null && (!Number.isInteger(switchDay) || switchDay < 0)) {
    throw new RangeError(
      `config.charterTransfersEnabledAtDay must be null or a non-negative integer day, got ${switchDay}`,
    )
  }
  if (!(cfg.postTransferCharterLimit >= 1)) {
    throw new RangeError('config.postTransferCharterLimit must be at least 1')
  }
  const seat = cfg.seat
  if (!Number.isInteger(seat.buyerHorizonDays) || seat.buyerHorizonDays <= 0) {
    throw new RangeError('config.seat.buyerHorizonDays must be a positive integer')
  }
  if (seat.buyerDiscountRatePerDayWad < 0n) {
    throw new RangeError('config.seat.buyerDiscountRatePerDayWad must be non-negative')
  }
  if (!Number.isInteger(seat.listingExpiryDays) || seat.listingExpiryDays <= 0) {
    throw new RangeError('config.seat.listingExpiryDays must be a positive integer')
  }
  if (!Number.isInteger(seat.buyers.count) || seat.buyers.count < 0) {
    throw new RangeError('config.seat.buyers.count must be a non-negative integer')
  }
  if (seat.buyers.budgetEth < 0n) {
    throw new RangeError('config.seat.buyers.budgetEth must be non-negative')
  }
  for (const [archetype, propensity] of Object.entries(seat.sellerDailyPropensityWad)) {
    if (propensity < 0n || propensity > WAD) {
      throw new RangeError(`config.seat.sellerDailyPropensityWad.${archetype} must be in [0, 1]`)
    }
  }

  // -- Waves and the sensitivity override ------------------------------------
  if (!Number.isInteger(cfg.waveGapHours) || cfg.waveGapHours <= 0) {
    throw new RangeError('config: waveGapHours must be a positive integer')
  }
  const override = cfg.dormantGenesisBranchesOverride
  if (override !== null) {
    if (!Number.isInteger(override) || override < 1 || override > cfg.maxBranchesPerCharter) {
      throw new RangeError(
        `config: dormantGenesisBranchesOverride must be an integer in [1, ${cfg.maxBranchesPerCharter}]`,
      )
    }
  }
}
