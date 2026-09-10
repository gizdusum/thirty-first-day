/**
 * Protocol state, action and event types.
 *
 * Value-bearing fields are `bigint`. `Wei` and `Tokens` are both 18-decimal
 * bigints; `Wad` is an 18-decimal fixed-point fraction. They are aliases, not
 * branded types — the distinction is documentary.
 */

export type Wei = bigint
export type Tokens = bigint
export type Wad = bigint

export interface Wallet {
  eth: Wei
  standard: Tokens
}

/**
 * Why an address was credited with newly minted $STANDARD.
 *
 * Every wei of `token.mintedToWallets` is attributable to exactly one of
 * these, which is what makes the study's sell-pressure figure exact rather
 * than inferred.
 */
export type CreditKind = 'withdrawal' | 'retirement' | 'revocationPayout' | 'bounty'

export interface WalletCredits {
  withdrawal: Tokens
  retirement: Tokens
  revocationPayout: Tokens
  bounty: Tokens
}

/** Where a burn came from. The four sources are exhaustive. */
export type BurnSource = 'license' | 'buyback' | 'resolutionFee' | 'revocationFee'

export interface BurnsBySource {
  license: Tokens
  buyback: Tokens
  resolutionFee: Tokens
  revocationFee: Tokens
}

/**
 * Why tokens were sold into the pool.
 *
 * `revocationPayout` is the one the study cares about: it is the mechanism by
 * which a revocation wave turns into negative net flow, which cuts `m`, which
 * cuts everyone's yield.
 */
export type SellOrigin = 'retirement' | 'revocationPayout' | 'trader'

export interface EthVolumeByOrigin {
  retirement: Wei
  revocationPayout: Wei
  trader: Wei
}

/**
 * The genesis banker archetypes (see `docs/mechanics.md`).
 *
 * The archetype is a property of the charter's owner, fixed at genesis. It
 * determines behaviour, and behaviour — not a free parameter — determines how
 * many branches the dormant cohort holds when the wave arrives.
 */
export type Archetype = 'committed' | 'trader' | 'casual' | 'tourist' | 'lost'

export const ARCHETYPES: readonly Archetype[] = [
  'committed',
  'trader',
  'casual',
  'tourist',
  'lost',
] as const

/**
 * One branch: one equal share of every epoch's issuance.
 *
 * Accrual uses an index. `rewardIndex` on the ledger accumulates
 * tokens-per-branch; a branch's live balance is
 * `settled + (rewardIndex - indexAt)`. A branch opened mid-epoch snapshots
 * `indexAt` at creation and therefore earns strictly pro rata to the time it
 * has existed (whitepaper 6).
 */
export interface Branch {
  readonly id: number
  readonly charterId: number
  /** Balance already materialised into the branch. */
  settled: Tokens
  /** Value of `ledger.rewardIndex` when this branch was last settled. */
  indexAt: Tokens
  readonly openedTick: number
}

export interface Charter {
  readonly id: number
  /**
   * Mutable only through a completed seat sale (whitepaper 12). Soulbound
   * until the one-way transfer switch is thrown, and there is no other code
   * path that writes it.
   */
  ownerId: string
  /** Live branches, in creation order. Length is in `[1, maxBranchesPerCharter]`. */
  branchIds: number[]
  alive: boolean
  /** Tick of the owner's last charter-scoped interaction (whitepaper 10). */
  lastInteractionTick: number
  /** Licenses bought in the current auction day (whitepaper 8). */
  licensesBoughtToday: number
  readonly genesis: boolean
  /** The archetype of the charter's *original* owner. Never changes on sale. */
  readonly archetype: Archetype
  /** Set once the seat has been sold at least once. */
  transferred: boolean
  /** Tick at which the charter was revoked, if it was. */
  revokedAtTick: number | null
}

export interface PoolState {
  ethReserve: Wei
  standardReserve: Tokens
  /**
   * Protocol-owned liquidity, as LP shares. All liquidity in this pool is
   * protocol-owned and no code path burns shares, so this is monotonically
   * non-decreasing by construction (whitepaper 11).
   */
  polShares: bigint
  cumulativePolEthAdded: Wei
  cumulativePolStandardAdded: Tokens
  /** POL budget not yet pairable; rolls forward. Never sold. */
  pendingPolEth: Wei
  pendingPolStandard: Tokens
}

export interface TokenState {
  /**
   * Tokens ever minted. Kept as the exact sum of `mintedToWallets` and
   * `notionalMints` so that the whitepaper 3.1 supply identity is unchanged.
   */
  cumulativeMints: Tokens
  /**
   * Real ERC-20 mints that landed in an address and can be sold: withdrawal
   * proceeds, branch-retirement payouts, the 30% revocation payout, informant
   * bounties. This is the number the study reports as sell-pressure supply.
   */
  mintedToWallets: Tokens
  /**
   * The bookkeeping counterpart to burning ledger value that was never minted
   * — the burned half of a resolution fee, the burned share of a revocation
   * fee. No address is ever credited with any of it. It exists only so that
   * `circulating = 100e6 + mints - burns` stays true while
   * `maxSupply = 1e9 - burns` falls.
   */
  notionalMints: Tokens
  cumulativeBurns: Tokens
  burnsBySource: BurnsBySource
  /** Base issuance credited to the ledger to date. Capped at the budget. */
  cumulativeIssuance: Tokens
}

export interface LedgerState {
  /** Cumulative tokens-per-branch. Monotonically non-decreasing. */
  rewardIndex: Tokens
  /** Sum of every live branch's balance. Maintained incrementally. */
  totalAccrued: Tokens
  /** Ledger value minted out to wallets: net withdrawals, bounties, banker shares. */
  mintedFromLedger: Tokens
  /** Ledger value burned: resolution-fee burns, revocation burns, undistributable dust. */
  burnedFromLedger: Tokens
}

export interface PolicyState {
  /** `m`, the issuance multiplier, WAD (whitepaper 5). */
  multiplier: Wad
  /** `F_n` per closed epoch, oldest first (whitepaper 4). */
  netFlowHistory: Wei[]
  /** `F` accumulating for the epoch currently open. */
  currentEpochNetFlow: Wei
  /** `signal_n = F_{n-1} + F_{n-2}` used for the most recent policy update. */
  lastSignal: Wei
  /** Sign of `F_n` for the most recently closed epoch; routes fees. */
  lastEpochNetFlow: Wei
  /** ETH volume by sell origin within the epoch currently open. */
  epochEthVolumeByOrigin: EthVolumeByOrigin
  /** ETH volume by sell origin over the last closed epoch. */
  lastEpochEthVolumeByOrigin: EthVolumeByOrigin
}

export interface LicenseDayState {
  /** Auction day index, `floor(tick / 24)`. */
  day: number
  open: boolean
  pStart: Tokens
  pFloor: Tokens
  /** 24 hourly prices, strictly decreasing (whitepaper 7). */
  schedule: Tokens[]
  remaining: number
  soldToday: number
  /** Lowest price that sold today; the auction falls, so this is the last sale. */
  lowestSoldPrice: Tokens | null
  /** Yesterday's `lowestSoldPrice`, i.e. `P_last`. */
  previousLowestSoldPrice: Tokens | null
}

export interface VaultState {
  /** ETH collected from trading fees, awaiting the epoch-close routing. */
  pendingProtocolEth: Wei
  expansionEth: Wei
  contractionEth: Wei
  teamEth: Wei
  /**
   * $STANDARD held by the contraction vault. Structurally always zero: the
   * vault burns everything it buys in the same tick, and no code path sells
   * from it (whitepaper 11).
   */
  contractionStandardHeld: Tokens
  /** Tokens the contraction vault has ever sold. Must stay zero. */
  contractionStandardSold: Tokens
  cumulativeBuybackEth: Wei
  cumulativeBuybackBurned: Tokens
  cumulativeRoutedEth: Wei
  cumulativeToVaults: Wei
  cumulativeToPol: Wei
  cumulativeToTeam: Wei
}

export interface WithdrawalWindow {
  /** Per-tick withdrawal totals over the trailing window. */
  ring: Tokens[]
  cursor: number
  /** Sum of `ring`. This is `W` in whitepaper 9. */
  trailingTotal: Tokens
}

/** Bounty-hunter economics (see `docs/mechanics.md`). */
export interface HunterState {
  /**
   * The smallest dormant accrued balance whose 2% bounty clears
   * `gasCostEth * marginRequired` at the current pool price. Recomputed every
   * tick, before any hunter acts.
   */
  profitabilityFloorTokens: Tokens
  /**
   * True when the 100_000-token bounty cap makes the floor unreachable at the
   * current price: no dormant balance, however large, is worth reporting.
   * `profitabilityFloorTokens` then holds the hypothetical uncapped
   * requirement, so the series stays continuous.
   */
  profitabilityFloorUnreachable: boolean
  /**
   * The pool price the floor was computed at. Hunters value bounties at this
   * price rather than at the live price, so that every hunter in an hour sees
   * the same market regardless of the order agents happen to run in.
   */
  priceAtScanWad: Wad
  cumulativeGasSpentEth: Wei
  cumulativeReportsAttempted: number
  cumulativeReportsLanded: number
  reportsThisTick: number
}

/** A seat offered for sale (whitepaper 12). */
export interface SeatListing {
  charterId: number
  sellerId: string
  listedAtTick: number
}

/** One buyer's bid for one listed seat, valid for the tick it was placed in. */
export interface SeatBid {
  charterId: number
  buyerId: string
  /** The buyer's valuation, in ETH. */
  valuationEth: Wei
}

/**
 * The seat market (whitepaper 12).
 *
 * `enabled` is a one-way latch: nothing in the model sets it back to false.
 * While `charterTransfersEnabledAtDay` is null it never becomes true and every
 * field here stays at its zero value.
 */
export interface SeatMarketState {
  enabled: boolean
  enabledAtTick: number | null
  /** Live listings by charter id. A Map so membership and removal are O(1). */
  listings: Map<number, SeatListing>
  bids: SeatBid[]
  salesThisTick: number
  /**
   * Cumulative ETH paid for seats.
   *
   * This is the blind spot. Whitepaper 2 says "There is exactly one place ETH
   * enters or leaves this economy: through trading" — and a seat sale is
   * capital entering in exchange for a claim on issuance, entirely outside
   * that one place. `F_n` never sees a wei of it. See F-06.
   */
  cumulativeVolumeEth: Wei
  cumulativeSales: number
  cumulativeBranchesTransferred: number
  cumulativeBalanceTransferred: Tokens
  /** Listings that lapsed unmatched. */
  cumulativeExpired: number
}

/** Wave bookkeeping for the synchronized dormancy cohort (whitepaper 10). */
export interface WaveState {
  /** Index of the wave currently in progress, or the last one seen. 0 = none yet. */
  index: number
  /** Tick of the most recent revocation, used to detect a gap between waves. */
  lastRevocationTick: number | null
  revokedThisTick: number
  branchesDestroyedThisTick: number
  branchesRetiredThisTick: number
  branchesOpenedThisTick: number
  cumulativeRevoked: number
}

export interface WorldState {
  tick: number
  epoch: number
  day: number
  token: TokenState
  ledger: LedgerState
  pool: PoolState
  policy: PolicyState
  licenses: LicenseDayState
  vaults: VaultState
  withdrawals: WithdrawalWindow
  hunters: HunterState
  wave: WaveState
  seatMarket: SeatMarketState
  /** Trailing multiplier ring, for the buyer's expectation model. */
  multiplierTrailing: { ring: Wad[]; cursor: number; sum: Wad; filled: number }
  charters: Map<number, Charter>
  /** Charter ids by owner, fixed at genesis. Keeps per-agent reads O(1). */
  chartersByOwner: Map<string, number[]>
  branches: Map<number, Branch>
  wallets: Map<string, Wallet>
  /** Every mint into an address, by reason. Sums to `token.mintedToWallets`. */
  credits: Map<string, WalletCredits>
  /** Live branches across all live charters. */
  totalBranches: number
  liveCharters: number
  revokedCharterIds: number[]
  nextCharterId: number
  nextBranchId: number
  /** Base issuance has permanently stopped (budget exhausted). */
  issuanceHalted: boolean
  /** Cumulative ETH that has left the pool, by why it was sold. */
  ethVolumeByOrigin: EthVolumeByOrigin
  /** ETH that left the pool during the tick in progress, by origin. */
  tickEthVolumeByOrigin: EthVolumeByOrigin
  /** Ledger value handed back to branches during the tick in progress. */
  tickRedistributed: { resolutionFee: Tokens; revocationFee: Tokens }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: 'checkIn'; charterId: number }
  | { type: 'buyLicense'; charterId: number }
  | { type: 'retireBranches'; charterId: number; k: number }
  | { type: 'withdraw'; charterId: number; amount: Tokens }
  | { type: 'reportDormant'; reporterId: string; charterId: number }
  | {
      type: 'swap'
      agentId: string
      direction: 'buy' | 'sell'
      amountIn: bigint
      /** Why the tokens are being sold. Ignored on a buy; defaults to 'trader'. */
      origin?: SellOrigin
    }
  /** Offer a seat for sale. Rejected while charters are soulbound. */
  | { type: 'listSeat'; charterId: number }
  | { type: 'unlistSeat'; charterId: number }
  /** Bid for a listed seat. Valid only for the clearing tick it is placed in. */
  | { type: 'bidForSeat'; buyerId: string; charterId: number; valuationEth: Wei }
  /**
   * One bounty hunter's submission against one dormant charter.
   *
   * The hunter pool resolves the economics before this reaches the world: who
   * is willing at what gas, and — when several submit against the same charter
   * in the same hour — which submission is the one that lands. That is the
   * agent's job, and it is what block ordering does on a real chain. The world
   * charges the gas either way, records the attempt, and performs the
   * revocation only for the included submission.
   */
  | {
      type: 'submitReport'
      hunterId: string
      charterId: number
      /** Gas this submission pays, win or lose. */
      gasEth: Wei
      /** How many hunters submitted against this charter this hour. */
      contenders: number
      /** The bounty's value in ETH at the price the hunter used. */
      bountyValueEth: Wei
      /** What that value had to clear for the hunter to be willing. */
      requiredEth: Wei
      /** Whether this is the submission that lands. */
      included: boolean
    }

export type ActionType = Action['type']

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export interface RejectedAction {
  action: Action
  code: string
  message: string
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type Event =
  | { type: 'issuance'; tick: number; perBranch: Tokens; total: Tokens; branches: number }
  | { type: 'issuanceHalted'; tick: number; cumulativeIssuance: Tokens }
  | { type: 'auctionOpened'; tick: number; day: number; pStart: Tokens; pFloor: Tokens }
  | { type: 'licenseSold'; tick: number; charterId: number; price: Tokens; branchId: number }
  | {
      type: 'swap'
      tick: number
      agentId: string
      direction: 'buy' | 'sell'
      grossEth: Wei
      feeEth: Wei
      tokenAmount: Tokens
      protocol: boolean
      origin: SellOrigin
    }
  | {
      type: 'withdrawal'
      tick: number
      charterId: number
      kind: CreditKind
      gross: Tokens
      feeRate: Wad
      fee: Tokens
      burned: Tokens
      redistributed: Tokens
      net: Tokens
      p: Wad
    }
  | {
      type: 'retirement'
      tick: number
      charterId: number
      k: number
      n: number
      /** The charter's accrued balance immediately before the retirement. */
      accruedBefore: Tokens
      liquidatedGross: Tokens
      charterBurned: boolean
    }
  | {
      type: 'revocation'
      tick: number
      charterId: number
      archetype: Archetype
      reporterId: string
      waveIndex: number
      dormantBalance: Tokens
      bounty: Tokens
      burned: Tokens
      redistributed: Tokens
      bankerShare: Tokens
      branchesDestroyed: number
      /** `m` at the moment of the report. */
      multiplier: Wad
      totalBranchesBefore: number
      totalBranchesAfter: number
      yieldPerBranchBefore: Tokens
      yieldPerBranchAfter: Tokens
    }
  | {
      /** One hunter's participation in one contest. Emitted for winner and losers alike. */
      type: 'hunterReport'
      tick: number
      hunterId: string
      charterId: number
      contenders: number
      gasPaidEth: Wei
      bountyValueEth: Wei
      requiredEth: Wei
      won: boolean
    }
  | { type: 'checkIn'; tick: number; charterId: number }
  | {
      type: 'epochClosed'
      tick: number
      epoch: number
      netFlow: Wei
      signal: Wei
      multiplierBefore: Wad
      multiplierAfter: Wad
      routedEth: Wei
      toVault: Wei
      vault: 'expansion' | 'contraction'
      toPol: Wei
      toTeam: Wei
      ethVolumeByOrigin: EthVolumeByOrigin
    }
  | { type: 'transfersEnabled'; tick: number; day: number }
  | { type: 'seatListed'; tick: number; charterId: number; sellerId: string }
  | { type: 'seatListingExpired'; tick: number; charterId: number; sellerId: string }
  | {
      type: 'seatSale'
      tick: number
      charterId: number
      sellerId: string
      /** The archetype of the seat's original owner. */
      sellerArchetype: Archetype
      buyerId: string
      priceEth: Wei
      reservationEth: Wei
      valuationEth: Wei
      branchCount: number
      accruedBalance: Tokens
    }
  | { type: 'buyback'; tick: number; ethSpent: Wei; tokensBurned: Tokens }
  | { type: 'polAdded'; tick: number; eth: Wei; standard: Tokens; sharesMinted: bigint }

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * The per-tick record kept in `world.history`.
 *
 * It carries everything the Monte Carlo runner needs, so that nothing has to
 * be re-derived from state after a run. Aggregates only — a full deep copy of
 * every branch each hour would dominate memory in a sweep. All structural
 * invariants are checked against live `world.state` after each tick.
 */
export interface TickSnapshot {
  tick: number
  epoch: number
  day: number

  // -- Supply -------------------------------------------------------------
  circulating: Tokens
  maxSupply: Tokens
  cumulativeMints: Tokens
  mintedToWallets: Tokens
  notionalMints: Tokens
  cumulativeBurns: Tokens
  burnsBySource: BurnsBySource
  cumulativeIssuance: Tokens
  issuanceHalted: boolean

  // -- Ledger -------------------------------------------------------------
  totalAccrued: Tokens
  mintedFromLedger: Tokens
  burnedFromLedger: Tokens
  redistributedThisTick: { resolutionFee: Tokens; revocationFee: Tokens }
  trailingWithdrawals: Tokens
  resolutionPressure: Wad
  resolutionFeeRate: Wad

  // -- Charters and branches ----------------------------------------------
  totalBranches: number
  liveCharters: number
  yieldPerBranchPerDay: Tokens
  branchesOpenedThisTick: number
  branchesRetiredThisTick: number

  // -- Policy -------------------------------------------------------------
  multiplier: Wad
  epochIndex: number
  /** `F_n` accumulated so far in the epoch currently open. */
  currentEpochNetFlow: Wei
  /** `F_n` of the last closed epoch — the fast lever's input. */
  lastEpochNetFlow: Wei
  /** `signal_n = F_{n-1} + F_{n-2}` of the last policy update. */
  signal: Wei
  /** Which vault the last epoch close funded. */
  regime: 'expansion' | 'contraction'

  // -- Pool and treasury ---------------------------------------------------
  poolPrice: Wad
  poolEthReserve: Wei
  poolStandardReserve: Tokens
  polShares: bigint
  polEth: Wei
  polStandard: Tokens
  expansionVaultEth: Wei
  contractionVaultEth: Wei
  teamEth: Wei
  pendingProtocolEth: Wei
  ethVolumeByOrigin: EthVolumeByOrigin

  // -- Auction -------------------------------------------------------------
  licensePrice: Tokens
  licenseFloor: Tokens
  licensesRemaining: number
  licensesSoldToday: number

  // -- Dormancy ------------------------------------------------------------
  reportableCharters: number
  revokedThisTick: number
  branchesDestroyedThisTick: number
  cumulativeRevoked: number
  waveIndex: number
  profitabilityFloorTokens: Tokens
  profitabilityFloorUnreachable: boolean
  ghostsBelowFloor: { count: number; branches: number }
  /**
   * The currently-reportable charters as a share of live charters, and of live
   * branches. Both emerge from behaviour: charters that never buy licenses
   * hold one branch while committed bankers expand, so the branch share is the
   * smaller number — which is what dampens the drop in N.
   */
  dormantCohort: { charterShare: Wad; branchShare: Wad }
  hunterGasSpentEth: Wei

  // -- The seat market (whitepaper 12) -------------------------------------
  transfersEnabled: boolean
  seatListingsOpen: number
  seatSalesThisTick: number
  cumulativeSeatSales: number
  /** Cumulative ETH paid for seats — capital the net flow signal never sees. */
  seatMarketEthVolume: Wei
  cumulativeBranchesTransferred: number
  /**
   * Ownership concentration over branches. Zero when charters are soulbound,
   * where ownership is one charter per wallet by construction and computing it
   * would cost every non-transfer cell a full scan for a known answer.
   */
  concentrationHHI: Wad
  largestHolderBranchShare: Wad
}

export interface TickResult {
  tick: number
  events: Event[]
  rejected: RejectedAction[]
  snapshot: TickSnapshot
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * A read-only window onto the world, scoped to one agent.
 *
 * Agents never mutate state directly: they return actions, which the world
 * validates and applies. An action the world rejects is recorded in
 * `TickResult.rejected` rather than thrown, so a badly-behaved agent cannot
 * abort a Monte Carlo run.
 */
export interface AgentView {
  readonly tick: number
  readonly day: number
  readonly epoch: number
  readonly agentId: string
  readonly config: import('./config/index.js').Config
  readonly state: Readonly<WorldState>
  wallet(): Readonly<Wallet>
  /** Live charters owned by this agent. */
  charterIds(): number[]
  accrued(charterId: number): Tokens
  branchCount(charterId: number): number
  /** ETH per whole $STANDARD, WAD. */
  spotPrice(): bigint
  /** The license price at this hour, or 0 if the auction is closed. */
  licensePrice(): Tokens
  licensesRemaining(): number
  /** One branch's issuance over one day at the current `m` and branch count. */
  yieldPerBranchPerDay(): Tokens
  isReportable(charterId: number): boolean
  reportableCharterIds(): number[]
  /** Everything ever minted to this agent, by reason. */
  credits(): Readonly<WalletCredits>
  /**
   * A private RNG stream for a named purpose.
   *
   * Separate from the stream handed to `onTick`, so that a decision an agent
   * only makes under some configurations cannot shift the draws it makes under
   * all of them. That is what lets the seat market be added without moving a
   * single result in a world where charters are soulbound.
   */
  stream(purpose: string): import('./rng/xoshiro128.js').Rng
  /** Whether seat transfers are currently possible (whitepaper 12). */
  transfersEnabled(): boolean
  /** Seats currently listed for sale, in listing order. */
  seatListings(): readonly SeatListing[]
  /** Whether this charter is already listed. O(1). */
  isSeatListed(charterId: number): boolean
  /** The seller's reservation price for a seat, in ETH. */
  seatReservationEth(charterId: number): Wei
  /** What a buyer would pay for a seat, under the documented valuation model. */
  valueSeat(charterId: number): {
    discountedBalanceEth: Wei
    npvEth: Wei
    totalEth: Wei
    expectedYieldPerBranchPerDay: Tokens
  }
  /** The smallest dormant balance worth reporting at the current price. */
  profitabilityFloor(): { tokens: Tokens; unreachable: boolean }
}

export interface Agent {
  readonly id: string
  /**
   * `rng` is this agent's own stream, derived from
   * `(seed, agentId, purpose)`. It is not shared with any other agent, so a
   * draw taken here never shifts anyone else's sequence — which is what makes
   * the paired counterfactual in `runPaired` clean.
   */
  onTick(view: AgentView, rng: import('./rng/xoshiro128.js').Rng): Action[]
}
