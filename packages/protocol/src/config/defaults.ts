/**
 * Every tunable number in the model.
 *
 * Rule for this file: no magic number appears anywhere else in the package.
 * If the whitepaper states a value, the comment cites the section. If the
 * whitepaper leaves it unspecified, the entry is marked **REDACTED** and the
 * comment gives the default chosen here and the reasoning behind it.
 *
 * Units:
 *   *Wad      WAD fixed point, 1e18 === 1.0
 *   *Bps      basis points, 10_000 === 100%
 *   *Tokens   token wei (18 decimals)
 *   *Eth      wei
 *   *Ticks    hours
 *   *Days     days
 */

import { WAD, tokens } from '../math/fixed.js'

/** How the informant bounty is funded. See `dormancyBountySource`. */
export type BountySource = 'revocationFee' | 'bankerShare'

/** What the expansion vault does with the ETH routed to it. */
export type ExpansionVaultPolicy = 'hold'

/**
 * The genesis cohort mix, in basis points, summing to exactly 10_000.
 *
 * Basis points rather than floats: the mix has to sum to 1.0 exactly and the
 * per-archetype counts have to be reproducible to the charter, which a float
 * mix cannot promise.
 */
export interface CohortMixBps {
  committed: bigint
  trader: bigint
  casual: bigint
  tourist: bigint
  lost: bigint
}

/** Committed bankers: check in reliably, expand when a license pays back. */
export interface CommittedConfig {
  /** Hours between routine check-ins. Must be well under the dormancy clock. */
  checkInIntervalHours: number
  /** Buy a license only if it pays for itself within this many days. */
  paybackHorizonDays: bigint
  /** Per-tick probability of a discretionary withdrawal, WAD. */
  withdrawProbabilityWad: bigint
  /** Fraction of the accrued balance taken by such a withdrawal, WAD. */
  withdrawFractionWad: bigint
}

/** Traders: active, withdraw and sell periodically, reset the clock by acting. */
export interface TraderConfig {
  /** Per-tick probability of doing something at all, WAD. */
  actionProbabilityWad: bigint
  /** Fraction of the accrued balance a withdrawal takes, WAD. */
  withdrawFractionWad: bigint
  /** Fraction of the $STANDARD wallet a sell takes, WAD. */
  sellFractionWad: bigint
  /** Probability that an action is a sell rather than a withdrawal, WAD. */
  sellBiasWad: bigint
  /** Probability that an action retires a branch, WAD. */
  retireProbabilityWad: bigint
  /** Probability that an action buys a license, WAD. */
  buyLicenseProbabilityWad: bigint
}

/** Casual bankers: irregular. Each week they act with probability p. */
export interface CasualConfig {
  /** Probability of acting at all in a given week, WAD. */
  weeklyActionProbabilityWad: bigint
  /** Fraction of the accrued balance a withdrawal takes, WAD. */
  withdrawFractionWad: bigint
  /** Probability that a week's action is a withdrawal rather than a check-in, WAD. */
  withdrawBiasWad: bigint
}

/** What a revoked banker does with the 30% payout (whitepaper 10). */
export interface PayoutConfig {
  /** Fraction of the payout that eventually reaches the pool, WAD. */
  sellFractionWad: bigint
  /** Hours over which that fraction is sold, spread evenly. */
  sellOverHours: number
  /**
   * Whether programmed payout sales actually reach the pool.
   *
   * The counterfactual lever for attribution. When false the payout is still
   * minted into the banker's wallet exactly as whitepaper 10 says, but never
   * sold — so the difference against the treatment arm is the part of an
   * issuance cut that is genuinely caused by payout selling rather than by
   * everything else revocation does. See `runArms`.
   */
  reachesPool: boolean
}

/**
 * Outside demand for $STANDARD.
 *
 * Not a whitepaper concept, and not part of the protocol: it is the rest of
 * the market. Without it the only flow through the pool is bankers selling
 * what they withdraw, so `F_n` is negative in every epoch, `m` pins to
 * `mMin` on the second day and stays there — and a study about what a
 * revocation wave does to issuance has nothing left to measure. These traders
 * exist so that the multiplier sits somewhere in the interior of its clamp
 * when the wave arrives.
 */
export interface ExternalDemandConfig {
  /** How many independent outside traders. */
  traders: number
  /** ETH each of them starts with. */
  startingEth: bigint
  /** Per-tick probability that one of them acts, WAD. */
  activityWad: bigint
  /** Probability that an action is a buy rather than a sell, WAD. */
  buyBiasWad: bigint
  /** Largest fraction of the relevant balance in one trade, WAD. */
  maxTradeFractionWad: bigint
}

/** Bounty-hunter economics. Reporting is an action, never an automatic event. */
export interface HunterConfig {
  /** Base cost to submit one report. */
  gasCostEth: bigint
  /**
   * Report only if the bounty is worth at least `gasCostEth * marginRequired`.
   * Quantised to six decimal places when converted to WAD, so that a float
   * here can never put a non-representable number into state.
   */
  marginRequired: number
  /** Hours after a charter becomes reportable before a hunter can see it. */
  scanLatencyHours: number
  /** How many hunters compete. */
  count: number
  /**
   * Gas escalation per additional contender in the same hour, WAD. With `e`,
   * `c` contenders pay `gasCostEth * (1 + e * (c - 1))` each.
   */
  gasWarEscalationWad: bigint
  /** Upper bound on reports that can land in one hour. */
  maxReportsPerHour: number
  /** ETH each hunter starts with. */
  startingEth: bigint
}

export interface Config {
  // -- Time ----------------------------------------------------------------
  /** Hours per tick is fixed at 1; this is the derived tick length in seconds. */
  readonly secondsPerTick: number
  readonly ticksPerDay: number
  /** Epoch length. Whitepaper 5 speaks of epochs but never fixes their length. */
  readonly epochDays: number

  // -- Token (whitepaper 3) -------------------------------------------------
  readonly hardCapTokens: bigint
  readonly polPremintTokens: bigint
  readonly issuanceBudgetTokens: bigint

  // -- Genesis --------------------------------------------------------------
  readonly genesisCharters: number
  readonly genesisBranchesPerCharter: number
  readonly ownerIdPrefix: string
  readonly genesisWalletEth: bigint
  readonly genesisWalletStandard: bigint

  // -- Issuance and monetary policy (whitepaper 5) --------------------------
  readonly baseRatePerDayTokens: bigint
  readonly multiplierInitWad: bigint
  readonly multiplierMinWad: bigint
  readonly multiplierMaxWad: bigint
  readonly multiplierRaiseStepWad: bigint
  readonly multiplierCutStepWad: bigint

  // -- Pool -----------------------------------------------------------------
  readonly poolInitialEth: bigint
  readonly tradingFeeBps: bigint
  readonly protocolSwapsPayFee: boolean
  readonly countProtocolSwapsInNetFlow: boolean

  // -- License auction (whitepaper 7, 8) ------------------------------------
  readonly licensesPerDay: number
  readonly maxLicensesPerCharterPerDay: number
  readonly maxBranchesPerCharter: number
  readonly licenseFloorDays: bigint
  readonly licenseStartMultiple: bigint
  readonly licenseCurveFixedAtDayOpen: boolean

  // -- Withdrawal and resolution fee (whitepaper 9) -------------------------
  readonly withdrawalWindowDays: number
  readonly pFloorDenominatorTokens: bigint
  readonly feeFloorWad: bigint
  readonly feeCeilingWad: bigint
  readonly pSaturationWad: bigint
  readonly feeBurnShareBps: bigint

  // -- Dormancy (whitepaper 10) ---------------------------------------------
  readonly dormancyDays: number
  readonly informantBountyBps: bigint
  readonly informantBountyCapTokens: bigint
  readonly revocationFeeBps: bigint
  readonly revocationBurnShareBps: bigint
  readonly dormancyBountySource: BountySource

  // -- Fee engine (whitepaper 11) -------------------------------------------
  readonly feeSplitVaultBps: bigint
  readonly feeSplitPolBps: bigint
  readonly feeSplitTeamBps: bigint
  readonly polSwapShareBps: bigint
  readonly contractionVaultSpendPerTickWad: bigint
  readonly contractionReserveCapPerTickWad: bigint
  readonly expansionVaultPolicy: ExpansionVaultPolicy

  // -- The genesis cohort ---------------------------------------------------
  readonly cohortMixBps: CohortMixBps
  readonly committed: CommittedConfig
  readonly trader: TraderConfig
  readonly casual: CasualConfig
  readonly payout: PayoutConfig
  readonly hunter: HunterConfig
  readonly hunterIdPrefix: string
  readonly externalDemand: ExternalDemandConfig
  readonly externalTraderIdPrefix: string
  /**
   * SENSITIVITY OVERRIDE. Normally `null`, and the dormant cohort's branch
   * share emerges from behaviour. Set it to force Tourist and Lost charters to
   * open with this many branches at genesis instead of one, to measure how
   * sensitive the study's results are to that share.
   */
  readonly dormantGenesisBranchesOverride: number | null

  // -- Dormancy waves -------------------------------------------------------
  readonly waveGapHours: number
  /**
   * The counterfactual lever. When false, no charter is ever reportable, so
   * dormant charters keep their branches and keep accruing. Nothing else
   * changes. See `runPaired`.
   */
  readonly revocationEnabled: boolean
}

export const DEFAULT_CONFIG: Config = {
  // ==========================================================================
  // Time
  // ==========================================================================

  /** One tick is one hour. Whitepaper 6: issuance streams per second, and the
   *  model evaluates that stream on an hourly tick. */
  secondsPerTick: 3600,
  ticksPerDay: 24,

  /** REDACTED. Default 1 day.
   *  Whitepaper 5 indexes policy by epoch `n` but never states the epoch
   *  length. One day is chosen because every other cadence in the document is
   *  daily — the license auction (7), the dormancy clock (10) and the base
   *  issuance rate itself are all expressed per day. A daily epoch makes the
   *  slow lever (`signal_n = F_{n-1} + F_{n-2}`) a two-day-lagged signal,
   *  which is the shortest lag that still reads as "slow" against the hourly
   *  contraction vault. */
  epochDays: 1,

  // ==========================================================================
  // Token — whitepaper 3
  // ==========================================================================

  /** Whitepaper 3: 1e9 hard cap, 18 decimals. */
  hardCapTokens: tokens(1_000_000_000),
  /** Whitepaper 3: 100e6 pre-minted as protocol-owned liquidity, locked forever. */
  polPremintTokens: tokens(100_000_000),
  /** Whitepaper 3: issuance budget 900e6. Base issuance stops permanently on exhaustion. */
  issuanceBudgetTokens: tokens(900_000_000),

  // ==========================================================================
  // Genesis
  // ==========================================================================

  /** Whitepaper 6: 1000 charters at genesis, one branch each, all created at t=0. */
  genesisCharters: 1000,
  genesisBranchesPerCharter: 1,

  /** REDACTED. Default "banker".
   *  Owner addresses are modelled as opaque string ids. The prefix only has to
   *  be stable so that histories are comparable across runs. */
  ownerIdPrefix: 'banker',

  /** REDACTED. Default 10 ETH per genesis banker.
   *  The whitepaper says nothing about who the genesis bankers are or what
   *  they hold. 10 ETH is enough for a banker to be a meaningful buyer of a
   *  license at plausible prices without any single banker being able to move
   *  the pool on their own at the default `poolInitialEth`. */
  genesisWalletEth: 10n * WAD,

  /** REDACTED. Default 0.
   *  Genesis bankers start with no $STANDARD: every token they hold has to be
   *  withdrawn through 9 or bought through the pool, which is the point of the
   *  study. */
  genesisWalletStandard: 0n,

  // ==========================================================================
  // Issuance and monetary policy — whitepaper 5
  // ==========================================================================

  /** REDACTED. Default 500_000 tokens/day at m = 1.
   *  Whitepaper 5 defines `I_n = baseRatePerDay * epochDays * m_n` but leaves
   *  the base rate open. At 500k/day the 900e6 budget lasts ~4.9 years at
   *  m = 1, which places the 31st day — the subject of this study — deep
   *  inside the issuance regime rather than near its exhaustion, so the
   *  revocation wave is measured against a live issuance stream. */
  baseRatePerDayTokens: tokens(500_000),

  /** REDACTED. Default 1.0.
   *  The multiplier has to start somewhere and 1.0 is the only neutral choice:
   *  it makes `baseRatePerDay` mean what its name says on day one. */
  multiplierInitWad: WAD,

  /** REDACTED. Default 0.25.
   *  Whitepaper 5 clamps `m` to `[mMin, mMax]` without giving either bound. A
   *  floor of 0.25 keeps issuance alive under sustained outflow — a floor of
   *  zero would make branch yield zero, which in turn drives the license floor
   *  price to zero (7) and collapses the auction entirely. */
  multiplierMinWad: WAD / 4n,

  /** REDACTED. Default 4.0.
   *  Symmetric with the floor on a log scale (0.25 = 1/4, 4.0 = 4/1), so
   *  neither direction of the clamp is privileged. */
  multiplierMaxWad: 4n * WAD,

  /** REDACTED. Default +0.01 per epoch.
   *  Whitepaper 5 fixes only the relation `cutStep > raiseStep`. At one day per
   *  epoch, +0.01 takes ~300 epochs to climb from 1.0 to the 4.0 ceiling. */
  multiplierRaiseStepWad: WAD / 100n,

  /** REDACTED. Default -0.03 per epoch, three times the raise step.
   *  Whitepaper 5: "cutStep > raiseStep by design". A 3:1 ratio means sustained
   *  outflow unwinds three epochs of expansion per epoch, which is the
   *  asymmetry the design is asking for without being so violent that a single
   *  bad epoch pins `m` to the floor. */
  multiplierCutStepWad: (3n * WAD) / 100n,

  // ==========================================================================
  // Pool
  // ==========================================================================

  /** REDACTED. Default 2_000 ETH paired with the 100e6 premint.
   *  Whitepaper 3 fixes the token side of genesis liquidity and says nothing
   *  about the ETH side. 2_000 ETH implies an opening spot of 2e-5 ETH per
   *  $STANDARD (50_000 $STANDARD per ETH) and gives the pool enough depth that
   *  a single genesis banker spending their whole 10 ETH moves spot by well
   *  under 1%, so price impact in the study comes from cohorts, not from
   *  individuals. */
  poolInitialEth: 2_000n * WAD,

  /** REDACTED. Default 30 bps.
   *  Whitepaper 11 routes "all protocol ETH" and 3 calls the trading fee
   *  configurable, but never names it. 30 bps is the constant-product
   *  convention and makes the fee engine's throughput comparable to a
   *  Uniswap-v2-shaped venue. */
  tradingFeeBps: 30n,

  /** REDACTED. Default false.
   *  The POL zap and the contraction vault buyback are the protocol trading
   *  with itself. Charging them the fee would route protocol ETH straight back
   *  into the protocol's own fee accumulator, creating a self-referential loop
   *  in the epoch accounting for no modelled benefit. */
  protocolSwapsPayFee: false,

  /** REDACTED. Default false.
   *  Whitepaper 4 defines `F_n` as buys minus sells "measured at the pool".
   *  Counting the protocol's own buybacks as inflow would let the contraction
   *  vault manufacture a positive `F_n`, flip the fee routing to expansion and
   *  raise `m` — a feedback loop the signal is plainly not meant to contain.
   *  `F_n` is therefore market flow only. */
  countProtocolSwapsInNetFlow: false,

  // ==========================================================================
  // License auction — whitepaper 7, 8
  // ==========================================================================

  /** Whitepaper 8: 100 licenses per day. */
  licensesPerDay: 100,
  /** Whitepaper 8: max 3 per charter per day. */
  maxLicensesPerCharterPerDay: 3,
  /** Whitepaper 8: max 10 branches per charter. */
  maxBranchesPerCharter: 10,
  /** Whitepaper 7: `P_floor = licenseFloorDays * (baseRatePerDay * m / totalBranches)`, default 2. */
  licenseFloorDays: 2n,
  /** Whitepaper 7: `P_start = 2 * P_last`, and `2 * P_floor` if nothing sold. */
  licenseStartMultiple: 2n,

  /** REDACTED. Default true.
   *  `P_floor` is a function of `m` and `totalBranches`, both of which move
   *  during a day — and a revocation wave moves `totalBranches` hard. If the
   *  curve were recomputed hourly the quoted price would jump upward the
   *  moment branches are destroyed, contradicting 7's falling-price auction.
   *  `P_start` and `P_floor` are therefore fixed when the day opens. */
  licenseCurveFixedAtDayOpen: true,

  // ==========================================================================
  // Withdrawal and resolution fee — whitepaper 9
  // ==========================================================================

  /** Whitepaper 9: `W` is measured over the trailing 7 days. */
  withdrawalWindowDays: 7,

  /** REDACTED. Default 1_000_000 tokens.
   *  Whitepaper 9 writes `max(D + W, pFloorDenominator)` without naming the
   *  floor. It exists to stop `P` from saturating when the bank is nearly
   *  empty. 1e6 tokens is two days of base issuance at the default rate, so
   *  the floor only binds when the bank holds less than that — a genuinely
   *  drained protocol — and is otherwise inert. */
  pFloorDenominatorTokens: tokens(1_000_000),

  /** REDACTED. Default 1%.
   *  Whitepaper 9 interpolates from `feeFloor` to `feeCeiling` without giving
   *  either. A 1% floor is the resting cost of leaving the bank in calm
   *  conditions: enough to be a real friction, small enough not to be a lock. */
  feeFloorWad: WAD / 100n,

  /** REDACTED. Default 35%.
   *  The ceiling has to bite hard enough to matter during a run on the bank
   *  but stay under the 70% revocation fee of 10 — otherwise a dormant banker
   *  would prefer to be revoked than to withdraw, which inverts the incentive
   *  the dormancy rule is built on. */
  feeCeilingWad: (35n * WAD) / 100n,

  /** REDACTED. Default P = 0.5.
   *  Whitepaper 9 says the quadratic saturates at `pSaturation` without a
   *  value. `P = W / (D + W)`, so P = 0.5 is the point at which a week of
   *  withdrawals equals everything still at the bank — a reasonable reading of
   *  "the fee is now as high as it goes". */
  pSaturationWad: WAD / 2n,

  /** Whitepaper 9: half of every fee is burned, the other half is credited pro
   *  rata to branches that did not exit. */
  feeBurnShareBps: 5_000n,

  // ==========================================================================
  // Dormancy — whitepaper 10
  // ==========================================================================

  /** Whitepaper 10: 30 days without an interaction makes a charter reportable. */
  dormancyDays: 30,
  /** Whitepaper 10: informant bounty is 2% of the dormant accrued balance... */
  informantBountyBps: 200n,
  /** ...capped at 100_000 tokens. */
  informantBountyCapTokens: tokens(100_000),
  /** Whitepaper 10: the dormant banker pays a 70% revocation fee. */
  revocationFeeBps: 7_000n,
  /** Whitepaper 10: half of that fee is burned, half is credited pro rata to
   *  all still-active branches. */
  revocationBurnShareBps: 5_000n,

  /** REDACTED. Default 'revocationFee'.
   *  Whitepaper 10 is over-determined here: it assigns 2% to the informant,
   *  70% to the revocation fee and "the remaining 30%" to the banker, which
   *  sums to 102% of the dormant balance. Something has to give. Taking the
   *  bounty out of the 70% fee preserves the two figures the section states
   *  most emphatically — the banker's 30% and the 70% penalty — and leaves the
   *  bounty as a carve-out from the protocol's own take rather than an extra
   *  levy on the banker. The alternative reading, 'bankerShare', charges the
   *  bounty to the banker's 30% instead; it is selectable so the study can
   *  measure whether the choice matters. Either way the split closes exactly:
   *  bounty + burned + redistributed + bankerShare === dormant balance. */
  dormancyBountySource: 'revocationFee',

  // ==========================================================================
  // Fee engine — whitepaper 11
  // ==========================================================================

  /** Whitepaper 11: 70% to the active vault. */
  feeSplitVaultBps: 7_000n,
  /** Whitepaper 11: 15% to POL. */
  feeSplitPolBps: 1_500n,
  /** Whitepaper 11: 15% to team. */
  feeSplitTeamBps: 1_500n,
  /** Whitepaper 11: of the POL share, half is swapped to $STANDARD and paired. */
  polSwapShareBps: 5_000n,

  /** Whitepaper 11: `spend_tick = min(0.10 * V, 0.002 * R)`. */
  contractionVaultSpendPerTickWad: WAD / 10n,
  contractionReserveCapPerTickWad: (2n * WAD) / 1_000n,

  /** REDACTED. Default 'hold'.
   *  Whitepaper 11 gives a spend rule for the contraction vault and none at
   *  all for the expansion vault. Rather than invent a deployment strategy,
   *  the expansion vault accumulates and holds; its balance is reported every
   *  tick so a later prompt can give it a policy without changing any of the
   *  accounting here. */
  expansionVaultPolicy: 'hold',

  // ==========================================================================
  // The genesis cohort
  // ==========================================================================

  /** REDACTED. Default 30/15/25/20/10.
   *  The whitepaper says nothing at all about who the 1000 genesis bankers
   *  are; it treats them as one homogeneous set. They are not, and the
   *  difference is the study. The default mix is a deliberately unflattering
   *  but not catastrophic reading of a genesis mint: three in ten stay
   *  engaged, one in six trades actively, a quarter drift in and out, one in
   *  five never comes back at all, and one in ten has lost their keys. The
   *  30% Tourist share is the parameter the results are most sensitive to and
   *  the one a real chain-history study should replace first. */
  cohortMixBps: {
    committed: 3_000n,
    trader: 1_500n,
    casual: 2_500n,
    tourist: 2_000n,
    lost: 1_000n,
  },

  /** REDACTED. Committed banker behaviour.
   *  A 5-day check-in interval is comfortably inside the 30-day clock even
   *  with jitter, which is what "checks in reliably" has to mean. A 45-day
   *  payback horizon against a 2-day license floor (7) means a committed
   *  banker buys whenever the auction has fallen to roughly the middle of its
   *  range, and stops buying as the branch count dilutes the yield — which is
   *  the mechanism that lets the committed cohort's branch count level off
   *  rather than run to the 10-branch cap on day one. */
  committed: {
    checkInIntervalHours: 24 * 5,
    paybackHorizonDays: 45n,
    withdrawProbabilityWad: WAD / 2_000n,
    withdrawFractionWad: WAD / 4n,
  },

  /** REDACTED. Trader behaviour.
   *  Acting on roughly one tick in twenty makes a trader visible in the flow
   *  signal without letting a single trader dominate an epoch. */
  trader: {
    actionProbabilityWad: WAD / 20n,
    withdrawFractionWad: WAD / 3n,
    sellFractionWad: WAD / 2n,
    sellBiasWad: (6n * WAD) / 10n,
    retireProbabilityWad: WAD / 12n,
    buyLicenseProbabilityWad: WAD / 4n,
  },

  /** REDACTED. Casual behaviour.
   *  A 55% chance of acting in any given week gives a mean gap of about
   *  1.8 weeks and a tail that reaches past 30 days often enough to produce a
   *  real secondary wave, without making the cohort indistinguishable from
   *  Tourists. */
  casual: {
    weeklyActionProbabilityWad: (55n * WAD) / 100n,
    withdrawFractionWad: WAD / 3n,
    withdrawBiasWad: (4n * WAD) / 10n,
  },

  /** REDACTED. What a revoked banker does with the 30% payout.
   *  The whitepaper mints it and says nothing more. Selling 70% of it over a
   *  week is the assumption that a wallet which had gone quiet for a month,
   *  and has just been handed liquid tokens by a stranger's transaction, is
   *  mostly a seller. The Lost cohort never sells, by definition. */
  payout: {
    sellFractionWad: (70n * WAD) / 100n,
    sellOverHours: 24 * 7,
    reachesPool: true,
  },

  /** REDACTED. Bounty-hunter economics.
   *  None of this is in the whitepaper, which says only that "any address may
   *  report". 0.002 ETH is a plausible cost for one report; a 2x margin is
   *  what a searcher running an inventory of targets would want before
   *  spending gas; 6 hours of scan latency assumes hunters poll rather than
   *  watch every block; 5 competing hunters is enough for contests to be
   *  routine. The escalation factor turns a contested hour into a gas auction:
   *  five contenders each pay 2.6x base. `maxReportsPerHour` is the throughput
   *  bound — with a synchronized 1000-charter wave, it is what decides whether
   *  the wave clears in a day or a month. */
  hunter: {
    gasCostEth: WAD / 500n,
    marginRequired: 2,
    scanLatencyHours: 6,
    count: 5,
    gasWarEscalationWad: (4n * WAD) / 10n,
    maxReportsPerHour: 4,
    startingEth: 5n * WAD,
  },

  /** REDACTED. Default "hunter". Stable ids so histories stay comparable. */
  hunterIdPrefix: 'hunter',

  /** REDACTED. Outside demand — see the interface for why it has to exist.
   *  Six traders, mildly buy-biased, each acting on roughly one tick in eight.
   *  The bias is 55/45 rather than 50/50 because a protocol whose issuance is
   *  being distributed has to be absorbing some net inflow for the multiplier
   *  to be anywhere but its floor; at 55/45 the multiplier drifts upward in
   *  quiet conditions and turns over when the bankers sell, which is the
   *  regime the study is about. This is the parameter that most directly sets
   *  how much room the counterfactual has to move in, and it should be the
   *  first thing a sensitivity sweep varies. */
  externalDemand: {
    traders: 6,
    startingEth: 250n * WAD,
    activityWad: WAD / 8n,
    buyBiasWad: (55n * WAD) / 100n,
    maxTradeFractionWad: WAD / 25n,
  },

  /** REDACTED. Default "market". */
  externalTraderIdPrefix: 'market',

  /** SENSITIVITY OVERRIDE — normally null. See the interface. */
  dormantGenesisBranchesOverride: null,

  /** REDACTED. Default 3 days.
   *  A wave is a run of revocations with no three-day silence inside it. The
   *  synchronized genesis cohort produces continuous reporting for as long as
   *  the hunters take to clear it — days, at the default throughput — so it
   *  comes out as a single wave. The Casual lapses that follow are sporadic
   *  and separated by more than three days, so each is labelled apart from it.
   *  The analysis therefore reads `waveIndex === 1` as the genesis wave and
   *  everything above it as the tail. */
  waveGapHours: 24 * 3,

  /** The counterfactual lever, on by default. `runPaired` turns it off in the
   *  control world and changes nothing else. */
  revocationEnabled: true,
}
