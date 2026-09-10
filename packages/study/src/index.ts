/**
 * @thirty-first-day/study
 *
 * The Monte Carlo runner and the experimental design.
 *
 * See `docs/experimental-design.md` for what the suites are, what the axes
 * mean, and how materiality is defined.
 */

export {
  canonicalJson,
  cellId,
  contentHash,
  dedupeCells,
  makeCell,
  seedRange,
  DEFAULT_HORIZON_DAYS,
  type CellSpec,
  type MakeCellOptions,
} from './cells.js'
export {
  DEMAND,
  DEMAND_REGIMES,
  type DemandRegime,
} from './config/demand.js'
export {
  baselineOverrides,
  gasAxis,
  mixForDormancyRate,
  STATIC_AXES,
  GAS_MULTIPLES,
  UNLIMITED_LICENSES,
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
  type Axis,
  type Level,
} from './config/axes.js'
export { calibrateGasBoundary, type GasBoundary } from './calibrate.js'
export {
  ArmAccumulator,
  armMetrics,
  ghostSummary,
  readMetric,
  subtractMetrics,
  treatmentMetrics,
  METRIC_PATHS,
  type ArmMetrics,
  type BurnSplit,
  type GhostSummary,
  type Metrics,
  type TreatmentMetrics,
} from './metrics.js'
export { runOne, toRunResult, PROTOCOL_VERSION, type DetailedRun, type RunResult, type RunOptions } from './runCell.js'
export {
  buildBaseline,
  buildFactorial,
  buildOfat,
  buildSample,
  buildSuite,
  totalRuns,
  axesFor,
  BASELINE_SEEDS,
  OFAT_SEEDS,
  FACTORIAL_SEEDS,
  SAMPLE_CELLS,
  type LevelRef,
  type Suite,
  type SuiteName,
  type SuiteOptions,
} from './suites.js'
export {
  appendResult,
  cellPath,
  completedSeeds,
  listCellFiles,
  manifestFingerprint,
  manifestPath,
  parse,
  readCellResults,
  readManifest,
  stringify,
  suiteDir,
  suiteManifestFor,
  upsertSuiteManifest,
  writeManifest,
  RUNS_DIR,
  type Manifest,
  type SuiteManifest,
} from './storage.js'
export {
  executeSuite,
  machineInfo,
  pendingTasks,
  type ExecuteOptions,
  type ExecuteReport,
} from './execute.js'
export {
  defaultWorkerCount,
  runTasksPooled,
  runTasksSerial,
  type PoolOptions,
  type Task,
} from './pool.js'
export {
  METRIC_DISPLAY,
  rankAxes,
  summarise,
  summariseCell,
  summariseSuite,
  toDisplay,
  BOOTSTRAP_RESAMPLES,
  type AxisSensitivity,
  type CellSummary,
  type MetricDisplay,
  type Summary,
  type Which,
} from './aggregate.js'
export {
  isMaterial,
  noiseBands,
  thresholdFor,
  ABSOLUTE_FLOOR,
  NOISE_Z,
  type Threshold,
} from './materiality.js'
