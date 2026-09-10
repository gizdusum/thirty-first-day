/**
 * @thirty-first-day/protocol
 *
 * A deterministic, dependency-free model of The Standard Reserve.
 *
 * See `docs/mechanics.md` in the repository root for every rule implemented
 * here, each keyed to the whitepaper section it comes from.
 */

export { createWorld, type World } from './world.js'
export {
  runArms,
  runPaired,
  configForArm,
  ARMS,
  type Arm,
  type ArmsOptions,
  type ArmsRun,
  type PairedOptions,
  type PairedRun,
} from './paired.js'
export {
  populateGenesisCohort,
  type Population,
  type PopulateOptions,
} from './population.js'
export {
  assignArchetypes,
  cohortCounts,
  genesisBranchesFor,
  isStructurallyDormant,
  sellsPayout,
} from './cohort.js'
export {
  DEFAULT_CONFIG,
  resolveConfig,
  validateConfig,
  ticksPerEpoch,
  withdrawalWindowTicks,
  dormancyTicks,
  hunterMarginWad,
  casualWindowTicks,
  type Config,
  type ConfigOverrides,
  type BountySource,
  type ExpansionVaultPolicy,
  type CohortMixBps,
  type CommittedConfig,
  type TraderConfig,
  type CasualConfig,
  type PayoutConfig,
  type HunterConfig,
  type ExternalDemandConfig,
} from './config/index.js'
export { createRng, rngFromState, type Rng } from './rng/xoshiro128.js'
export { deriveSeed, streamKey } from './rng/derive.js'
export {
  WAD,
  BPS,
  mulWad,
  divWad,
  mulBps,
  minBig,
  maxBig,
  clampBig,
  absBig,
  powWadN,
  nthRootWad,
  tokens,
  prepareDivisor,
  divExact,
  type Divisor,
} from './math/fixed.js'
export {
  branchBalance,
  charterAccrued,
  circulatingSupply,
  creditsFor,
  liveBranchIds,
  maxSupply,
} from './core/ledger.js'
export {
  spotPrice,
  constantProduct,
  swapExactEthForStandard,
  swapExactStandardForEth,
  addLiquidity,
  standardToPair,
  type SwapResult,
} from './core/pool.js'
export { resolutionFeeRate, resolutionPressure } from './core/fees.js'
export {
  bountyFor,
  escalatedGasEth,
  profitabilityFloor,
  requiredBountyEth,
  resolveContest,
  type Contest,
  type ProfitabilityFloor,
} from './core/hunters.js'
export { buildLicenseSchedule, licenseFloorPrice, licenseStartPrice } from './core/licenses.js'
export {
  PassiveHolder,
  RandomTrader,
  BankerAgent,
  BountyHunterPool,
  type RandomTraderOptions,
} from './agents/index.js'
export {
  ProtocolError,
  ARCHETYPES,
  type Action,
  type ActionType,
  type Agent,
  type AgentView,
  type Archetype,
  type Branch,
  type BurnsBySource,
  type BurnSource,
  type Charter,
  type CreditKind,
  type EthVolumeByOrigin,
  type HunterState,
  type SellOrigin,
  type WalletCredits,
  type WaveState,
  type Event,
  type LedgerState,
  type LicenseDayState,
  type PolicyState,
  type PoolState,
  type RejectedAction,
  type TickResult,
  type TickSnapshot,
  type TokenState,
  type Tokens,
  type VaultState,
  type Wad,
  type Wallet,
  type Wei,
  type WithdrawalWindow,
  type WorldState,
} from './types.js'
