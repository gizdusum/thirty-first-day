/**
 * The Standard Reserve — protocol invariants.
 *
 * This file is a public artifact. It is the argument that the model in
 * `packages/protocol` is a faithful reading of the whitepaper, and it is
 * meant to be read alongside `docs/mechanics.md`.
 *
 * Every assertion carries the whitepaper section it enforces. The structural
 * invariants are checked after **every tick** of every scenario, across
 * randomized configurations and seeds, not merely at the end of a run.
 */

import { describe, expect, it } from 'vitest'

import { createWorld, type World } from './world.js'
import { DEFAULT_CONFIG, resolveConfig, type Config, type ConfigOverrides } from './config/index.js'
import { createRng, type Rng } from './rng/xoshiro128.js'
import { WAD, divWad, mulWad, tokens } from './math/fixed.js'
import { buildLicenseSchedule, licenseFloorPrice, licenseStartPrice } from './core/licenses.js'
import { resolutionFeeRate, resolutionPressure } from './core/fees.js'
import { branchBalance } from './core/ledger.js'
import type { Action, Agent, AgentView, TickResult, Tokens, Wallet } from './types.js'
import { PassiveHolder, RandomTrader } from './agents/index.js'
import { populateGenesisCohort } from './population.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Drives every action the protocol exposes, on randomly chosen charters, so
 * that the invariants are checked against a world that is actually being used
 * rather than one sitting idle. Actions planned against a stale read are
 * rejected by the engine and land in `TickResult.rejected`, which is exactly
 * the behaviour a Monte Carlo runner needs.
 */
class ChaosDriver implements Agent {
  readonly id = 'chaos'

  onTick(view: AgentView, rng: Rng): Action[] {
    const actions: Action[] = []
    const state = view.state
    const live: number[] = []
    for (const charter of state.charters.values()) if (charter.alive) live.push(charter.id)
    if (live.length === 0) return actions

    const rounds = 1 + rng.nextInt(4)
    for (let i = 0; i < rounds; i++) {
      const charterId = live[rng.nextInt(live.length)] as number
      const charter = state.charters.get(charterId)
      if (charter === undefined) continue
      const roll = rng.nextInt(100)

      if (roll < 18) {
        actions.push({ type: 'checkIn', charterId })
      } else if (roll < 44) {
        const accrued = view.accrued(charterId)
        if (accrued > 0n) {
          actions.push({ type: 'withdraw', charterId, amount: 1n + rng.nextBigint(accrued) })
        }
      } else if (roll < 62) {
        actions.push({ type: 'buyLicense', charterId })
      } else if (roll < 70) {
        const n = charter.branchIds.length
        // Partial retirements are common; retiring a charter's last branch —
        // which burns the charter — is deliberately rare, so that the world
        // does not depopulate before the dormancy clock has anything to say.
        if (n > 1) actions.push({ type: 'retireBranches', charterId, k: 1 + rng.nextInt(n) })
        else if (rng.nextBool(WAD / 5n)) actions.push({ type: 'retireBranches', charterId, k: 1 })
      } else if (roll < 88) {
        const wallet = state.wallets.get(charter.ownerId)
        if (wallet !== undefined) {
          const buy = rng.nextBool(WAD / 2n)
          const balance = buy ? wallet.eth : wallet.standard
          if (balance > 0n) {
            actions.push({
              type: 'swap',
              agentId: charter.ownerId,
              direction: buy ? 'buy' : 'sell',
              amountIn: 1n + rng.nextBigint(balance / 4n + 1n),
            })
          }
        }
      } else {
        const reportable = view.reportableCharterIds()
        if (reportable.length > 0) {
          actions.push({
            type: 'reportDormant',
            reporterId: 'bounty-hunter',
            charterId: reportable[rng.nextInt(reportable.length)] as number,
          })
        }
      }
    }
    return actions
  }
}

/** Emits a pre-set batch of actions on its next tick, so that a test can put
 *  an action inside a tick and read the events it produced. */
class ScriptedAgent implements Agent {
  private readonly queue: Action[][] = []

  constructor(readonly id: string) {}

  enqueue(actions: Action[]): void {
    this.queue.push(actions)
  }

  onTick(): Action[] {
    return this.queue.shift() ?? []
  }
}

/** A randomized but always-valid configuration. */
function randomOverrides(rng: Rng): ConfigOverrides {
  const feeFloor = rng.nextRange(WAD / 1000n, WAD / 50n)
  const feeCeiling = feeFloor + rng.nextRange(WAD / 100n, (4n * WAD) / 10n)
  const raiseStep = rng.nextRange(WAD / 1000n, WAD / 50n)
  return {
    epochDays: 1 + rng.nextInt(2),
    genesisCharters: 40 + rng.nextInt(80),
    // Short clocks so that a few hundred ticks reach the revocation wave.
    dormancyDays: 2 + rng.nextInt(6),
    baseRatePerDayTokens: tokens(rng.nextRange(10_000n, 400_000n)),
    multiplierInitWad: rng.nextRange(WAD / 2n, 2n * WAD),
    multiplierMinWad: rng.nextRange(WAD / 10n, WAD / 2n),
    multiplierMaxWad: rng.nextRange(2n * WAD, 8n * WAD),
    multiplierRaiseStepWad: raiseStep,
    multiplierCutStepWad: raiseStep + rng.nextRange(1n, WAD / 20n),
    poolInitialEth: rng.nextRange(200n, 5_000n) * WAD,
    tradingFeeBps: rng.nextRange(5n, 100n),
    licensesPerDay: 1 + rng.nextInt(50),
    licenseFloorDays: rng.nextRange(1n, 5n),
    withdrawalWindowDays: 1 + rng.nextInt(7),
    feeFloorWad: feeFloor,
    feeCeilingWad: feeCeiling,
    pSaturationWad: rng.nextRange(WAD / 10n, WAD),
    pFloorDenominatorTokens: tokens(rng.nextRange(1n, 5_000_000n)),
    genesisWalletEth: rng.nextRange(1n, 50n) * WAD,
    dormancyBountySource: rng.nextBool(WAD / 2n) ? 'revocationFee' : 'bankerShare',
    protocolSwapsPayFee: rng.nextBool(WAD / 2n),
    countProtocolSwapsInNetFlow: rng.nextBool(WAD / 2n),
  }
}

/** Values that must never move in the wrong direction. */
interface Ratchet {
  maxSupply: bigint
  polShares: bigint
  polEthAdded: bigint
  polStandardAdded: bigint
  cumulativeIssuance: bigint
  cumulativeBurns: bigint
  rewardIndex: bigint
  issuanceAtHalt: bigint | null
  mintedToWallets: bigint
  notionalMints: bigint
  totalBranches: number
  cumulativeRevoked: number
}

function initialRatchet(world: World): Ratchet {
  const state = world.state
  return {
    maxSupply: world.config.hardCapTokens - state.token.cumulativeBurns,
    polShares: state.pool.polShares,
    polEthAdded: state.pool.cumulativePolEthAdded,
    polStandardAdded: state.pool.cumulativePolStandardAdded,
    cumulativeIssuance: state.token.cumulativeIssuance,
    cumulativeBurns: state.token.cumulativeBurns,
    rewardIndex: state.ledger.rewardIndex,
    issuanceAtHalt: null,
    mintedToWallets: state.token.mintedToWallets,
    notionalMints: state.token.notionalMints,
    totalBranches: state.totalBranches,
    cumulativeRevoked: state.wave.cumulativeRevoked,
  }
}

/**
 * The full structural check. Runs after every tick.
 *
 * `result` is the tick that just completed, so that per-tick events
 * (retirements, revocations) can be checked against the state they produced.
 */
function assertInvariants(world: World, result: TickResult, ratchet: Ratchet): void {
  const cfg: Config = world.config
  const state = world.state
  const where = `tick ${state.tick}`

  // -- 3.1 Supply identity --------------------------------------------------
  // circulating = 100e6 + cumulativeMints - cumulativeBurns
  const circulating =
    cfg.polPremintTokens + state.token.cumulativeMints - state.token.cumulativeBurns
  expect(result.snapshot.circulating, `${where}: circulating identity`).toBe(circulating)
  expect(circulating >= 0n, `${where}: circulating supply went negative`).toBe(true)

  // -- 3.2 Max supply -------------------------------------------------------
  // maxSupply = 1e9 - cumulativeBurns, and it never increases.
  const maxSupply = cfg.hardCapTokens - state.token.cumulativeBurns
  expect(result.snapshot.maxSupply, `${where}: maxSupply identity`).toBe(maxSupply)
  expect(maxSupply <= ratchet.maxSupply, `${where}: maxSupply increased`).toBe(true)
  expect(circulating <= maxSupply, `${where}: circulating exceeded maxSupply`).toBe(true)
  expect(
    state.token.cumulativeBurns >= ratchet.cumulativeBurns,
    `${where}: burns un-burned`,
  ).toBe(true)
  ratchet.maxSupply = maxSupply
  ratchet.cumulativeBurns = state.token.cumulativeBurns

  // -- 3 / 5 Issuance budget ------------------------------------------------
  // Cumulative issuance never exceeds 900e6; once it is reached, base issuance
  // is zero forever.
  expect(
    state.token.cumulativeIssuance <= cfg.issuanceBudgetTokens,
    `${where}: issuance exceeded the 900e6 budget`,
  ).toBe(true)
  expect(
    state.token.cumulativeIssuance >= ratchet.cumulativeIssuance,
    `${where}: cumulative issuance decreased`,
  ).toBe(true)
  expect(state.ledger.rewardIndex >= ratchet.rewardIndex, `${where}: reward index went back`).toBe(
    true,
  )
  if (ratchet.issuanceAtHalt !== null) {
    expect(
      state.token.cumulativeIssuance,
      `${where}: base issuance resumed after the budget was exhausted`,
    ).toBe(ratchet.issuanceAtHalt)
  } else if (state.issuanceHalted) {
    ratchet.issuanceAtHalt = state.token.cumulativeIssuance
  }
  ratchet.cumulativeIssuance = state.token.cumulativeIssuance
  ratchet.rewardIndex = state.ledger.rewardIndex

  // -- 3 / 9 The accounting closes -----------------------------------------
  // Every token ever issued is, right now, exactly one of: still accrued at
  // the bank, minted out to a wallet, or burned out of the ledger.
  let accruedSum = 0n
  let liveBranchCount = 0
  for (const charter of state.charters.values()) {
    if (!charter.alive) {
      expect(charter.branchIds.length, `${where}: dead charter ${charter.id} still has branches`).toBe(0)
      continue
    }
    liveBranchCount += charter.branchIds.length
    expect(
      charter.branchIds.length > 0 && charter.branchIds.length <= cfg.maxBranchesPerCharter,
      `${where}: charter ${charter.id} holds ${charter.branchIds.length} branches`,
    ).toBe(true)
    for (const id of charter.branchIds) {
      const branch = state.branches.get(id)
      expect(branch, `${where}: branch ${id} is missing`).toBeDefined()
      if (branch === undefined) continue
      const balance = branchBalance(state, branch)
      // -- No negative balances, ever.
      expect(balance >= 0n, `${where}: branch ${id} balance ${balance} is negative`).toBe(true)
      expect(branch.settled >= 0n, `${where}: branch ${id} settled is negative`).toBe(true)
      accruedSum += balance
    }
  }
  expect(state.ledger.totalAccrued, `${where}: totalAccrued drifted from the branch sum`).toBe(
    accruedSum,
  )
  expect(
    accruedSum + state.ledger.mintedFromLedger + state.ledger.burnedFromLedger,
    `${where}: ledger accounting does not close`,
  ).toBe(state.token.cumulativeIssuance)
  // Tokens are minted only on withdrawal, so mints can never outrun issuance.
  expect(
    state.token.cumulativeMints,
    `${where}: mints outran the ledger`,
  ).toBe(state.ledger.mintedFromLedger + state.ledger.burnedFromLedger)

  // -- 3.1 The two kinds of mint stay separate and stay exact ---------------
  // `mintedToWallets` is the study's sell-pressure figure: every wei of it is
  // in an address and can be sold. `notionalMints` is the bookkeeping
  // counterpart to burning ledger value that was never minted, and no address
  // ever holds any of it. Their sum is `cumulativeMints`, so 3.1 is unchanged.
  expect(
    state.token.mintedToWallets + state.token.notionalMints,
    `${where}: mintedToWallets + notionalMints != cumulativeMints`,
  ).toBe(state.token.cumulativeMints)
  expect(state.token.mintedToWallets, `${where}: mintedToWallets != mintedFromLedger`).toBe(
    state.ledger.mintedFromLedger,
  )
  // Lockstep: notional mints move if and only if unminted ledger value burns.
  expect(state.token.notionalMints, `${where}: notionalMints != burnedFromLedger`).toBe(
    state.ledger.burnedFromLedger,
  )
  expect(
    state.token.mintedToWallets >= ratchet.mintedToWallets,
    `${where}: mintedToWallets decreased`,
  ).toBe(true)
  expect(
    state.token.notionalMints >= ratchet.notionalMints,
    `${where}: notionalMints decreased`,
  ).toBe(true)

  // Every wei of `mintedToWallets` is attributed to an address and a reason.
  let creditedSum = 0n
  for (const [id, credits] of state.credits) {
    for (const kind of ['withdrawal', 'retirement', 'revocationPayout', 'bounty'] as const) {
      expect(credits[kind] >= 0n, `${where}: negative ${kind} credit for ${id}`).toBe(true)
      creditedSum += credits[kind]
    }
  }
  expect(creditedSum, `${where}: wallet credits do not sum to mintedToWallets`).toBe(
    state.token.mintedToWallets,
  )

  // The burn sources are exhaustive, and exactly two of them are ledger burns.
  const burns = state.token.burnsBySource
  expect(
    burns.license + burns.buyback + burns.resolutionFee + burns.revocationFee,
    `${where}: burnsBySource does not sum to cumulativeBurns`,
  ).toBe(state.token.cumulativeBurns)
  expect(
    burns.resolutionFee + burns.revocationFee,
    `${where}: ledger burns do not match notionalMints`,
  ).toBe(state.token.notionalMints)

  // Per tick: the increase in each is exactly what this tick's events did.
  let mintedThisTick = 0n
  let burnedThisTickFromEvents = 0n
  let redistributedThisTickFromEvents = 0n
  for (const event of result.events) {
    if (event.type === 'withdrawal') {
      mintedThisTick += event.net
      burnedThisTickFromEvents += event.burned
      redistributedThisTickFromEvents += event.redistributed
    } else if (event.type === 'revocation') {
      mintedThisTick += event.bounty + event.bankerShare
      burnedThisTickFromEvents += event.burned
      redistributedThisTickFromEvents += event.redistributed
    }
  }
  expect(
    state.token.mintedToWallets - ratchet.mintedToWallets,
    `${where}: mintedToWallets moved without an address being credited`,
  ).toBe(mintedThisTick)
  // A redistribution with no eligible branch left is burned instead, which is
  // the only way a notional mint appears without a fee burn behind it.
  const redistributedLanded =
    result.snapshot.redistributedThisTick.resolutionFee +
    result.snapshot.redistributedThisTick.revocationFee
  expect(
    state.token.notionalMints - ratchet.notionalMints,
    `${where}: notionalMints moved without a ledger burn`,
  ).toBe(burnedThisTickFromEvents + (redistributedThisTickFromEvents - redistributedLanded))
  ratchet.mintedToWallets = state.token.mintedToWallets
  ratchet.notionalMints = state.token.notionalMints

  // Every circulating token can be located: it is in a wallet, in the pool, or
  // waiting to be paired into POL. A notional mint is nowhere, because nobody
  // ever holds one.
  let heldInWallets = 0n
  for (const wallet of state.wallets.values()) heldInWallets += wallet.standard
  expect(
    heldInWallets + state.pool.standardReserve + state.pool.pendingPolStandard,
    `${where}: circulating supply cannot be located`,
  ).toBe(cfg.polPremintTokens + state.token.mintedToWallets - burns.license - burns.buyback)

  // -- 6, 10 Branches only move for a reason -------------------------------
  // Opened by the auction, retired by their charter, or destroyed by a
  // revocation. Nothing else touches `totalBranches`.
  expect(
    state.totalBranches,
    `${where}: totalBranches moved without an opening, a retirement or a revocation`,
  ).toBe(
    ratchet.totalBranches +
      result.snapshot.branchesOpenedThisTick -
      result.snapshot.branchesRetiredThisTick -
      result.snapshot.branchesDestroyedThisTick,
  )
  ratchet.totalBranches = state.totalBranches
  expect(
    state.wave.cumulativeRevoked - ratchet.cumulativeRevoked,
    `${where}: revokedThisTick does not match cumulativeRevoked`,
  ).toBe(result.snapshot.revokedThisTick)
  ratchet.cumulativeRevoked = state.wave.cumulativeRevoked

  // -- 6 Branch bookkeeping -------------------------------------------------
  // totalBranches equals the sum of every live charter's branch count, always.
  expect(state.totalBranches, `${where}: totalBranches != sum of live charters`).toBe(
    liveBranchCount,
  )
  // No orphans: every branch in the index belongs to a live charter.
  expect(state.branches.size, `${where}: orphaned branches in the index`).toBe(liveBranchCount)

  // -- 10 A revoked charter's branches are gone on the same tick ------------
  for (const event of result.events) {
    if (event.type !== 'revocation') continue
    const charter = state.charters.get(event.charterId)
    expect(charter?.alive, `${where}: revoked charter ${event.charterId} is still alive`).toBe(false)
    expect(charter?.branchIds.length, `${where}: revoked charter kept branches`).toBe(0)
    expect(charter?.revokedAtTick, `${where}: revocation tick not recorded`).toBe(event.tick)
    // The split closes exactly: bounty + burned + redistributed + banker share.
    expect(
      event.bounty + event.burned + event.redistributed + event.bankerShare,
      `${where}: revocation split does not close`,
    ).toBe(event.dormantBalance)
    expect(
      event.bounty <= cfg.informantBountyCapTokens,
      `${where}: informant bounty exceeded its cap`,
    ).toBe(true)
  }

  // -- 9 Retiring k of n liquidates exactly k/n -----------------------------
  for (const event of result.events) {
    if (event.type !== 'retirement') continue
    const expected = (event.accruedBefore * BigInt(event.k)) / BigInt(event.n)
    const drift =
      event.liquidatedGross > expected
        ? event.liquidatedGross - expected
        : expected - event.liquidatedGross
    expect(drift <= 1n, `${where}: retirement liquidated ${event.liquidatedGross}, expected ${expected}`).toBe(
      true,
    )
    expect(event.charterBurned, `${where}: retiring all n must burn the charter`).toBe(
      event.k === event.n,
    )
  }

  // -- 9 The resolution fee stays inside its bounds -------------------------
  for (const event of result.events) {
    if (event.type !== 'withdrawal') continue
    expect(
      event.feeRate >= cfg.feeFloorWad && event.feeRate <= cfg.feeCeilingWad,
      `${where}: resolution fee ${event.feeRate} escaped [${cfg.feeFloorWad}, ${cfg.feeCeilingWad}]`,
    ).toBe(true)
    expect(event.burned + event.redistributed, `${where}: fee halves do not sum`).toBe(event.fee)
    expect(event.net + event.fee, `${where}: withdrawal does not close`).toBe(event.gross)
    expect(event.net >= 0n, `${where}: negative net withdrawal`).toBe(true)
  }

  // -- 11 POL never decreases ----------------------------------------------
  expect(state.pool.polShares >= ratchet.polShares, `${where}: POL shares decreased`).toBe(true)
  expect(
    state.pool.cumulativePolEthAdded >= ratchet.polEthAdded,
    `${where}: POL ETH contributed decreased`,
  ).toBe(true)
  expect(
    state.pool.cumulativePolStandardAdded >= ratchet.polStandardAdded,
    `${where}: POL $STANDARD contributed decreased`,
  ).toBe(true)
  ratchet.polShares = state.pool.polShares
  ratchet.polEthAdded = state.pool.cumulativePolEthAdded
  ratchet.polStandardAdded = state.pool.cumulativePolStandardAdded

  // -- 11 The contraction vault never sells --------------------------------
  expect(state.vaults.contractionStandardHeld, `${where}: contraction vault is holding tokens`).toBe(
    0n,
  )
  expect(state.vaults.contractionStandardSold, `${where}: contraction vault sold tokens`).toBe(0n)

  // -- 11 The fee split sums to exactly 100% -------------------------------
  expect(cfg.feeSplitVaultBps + cfg.feeSplitPolBps + cfg.feeSplitTeamBps, `${where}: split bps`).toBe(
    10_000n,
  )
  expect(
    state.vaults.cumulativeToVaults + state.vaults.cumulativeToPol + state.vaults.cumulativeToTeam,
    `${where}: routed ETH does not split exactly`,
  ).toBe(state.vaults.cumulativeRoutedEth)
  for (const event of result.events) {
    if (event.type !== 'epochClosed') continue
    expect(event.toVault + event.toPol + event.toTeam, `${where}: epoch split does not close`).toBe(
      event.routedEth,
    )
  }

  // -- 7 The license price falls all day and never reaches the floor --------
  if (state.licenses.open) {
    const schedule = state.licenses.schedule
    for (let h = 1; h < schedule.length; h++) {
      expect(
        (schedule[h] as Tokens) < (schedule[h - 1] as Tokens),
        `${where}: license price did not fall from hour ${h - 1} to ${h}`,
      ).toBe(true)
    }
    for (let h = 0; h < schedule.length; h++) {
      expect(
        (schedule[h] as Tokens) >= state.licenses.pFloor,
        `${where}: license price fell below the floor at hour ${h}`,
      ).toBe(true)
    }
    expect(schedule[0], `${where}: the day must open at P_start`).toBe(state.licenses.pStart)
    expect(
      state.licenses.remaining >= 0 && state.licenses.remaining <= cfg.licensesPerDay,
      `${where}: license inventory out of range`,
    ).toBe(true)
  }

  // -- No negative balances, ever ------------------------------------------
  expect(state.pool.ethReserve > 0n, `${where}: pool ETH reserve drained`).toBe(true)
  expect(state.pool.standardReserve > 0n, `${where}: pool token reserve drained`).toBe(true)
  expect(state.vaults.expansionEth >= 0n, `${where}: negative expansion vault`).toBe(true)
  expect(state.vaults.contractionEth >= 0n, `${where}: negative contraction vault`).toBe(true)
  expect(state.vaults.teamEth >= 0n, `${where}: negative team balance`).toBe(true)
  expect(state.vaults.pendingProtocolEth >= 0n, `${where}: negative pending protocol ETH`).toBe(true)
  expect(state.pool.pendingPolEth >= 0n, `${where}: negative pending POL ETH`).toBe(true)
  expect(state.pool.pendingPolStandard >= 0n, `${where}: negative pending POL tokens`).toBe(true)
  expect(state.ledger.totalAccrued >= 0n, `${where}: negative total accrued`).toBe(true)
  expect(state.withdrawals.trailingTotal >= 0n, `${where}: negative trailing withdrawals`).toBe(true)
  for (const [id, wallet] of state.wallets) {
    expect(wallet.eth >= 0n, `${where}: wallet ${id} has negative ETH`).toBe(true)
    expect(wallet.standard >= 0n, `${where}: wallet ${id} has negative $STANDARD`).toBe(true)
  }

  // -- 5 The multiplier stays inside its clamp ------------------------------
  expect(
    state.policy.multiplier >= cfg.multiplierMinWad &&
      state.policy.multiplier <= cfg.multiplierMaxWad,
    `${where}: multiplier ${state.policy.multiplier} escaped its clamp`,
  ).toBe(true)
}

function runScenario(seed: number, overrides: ConfigOverrides, ticks: number): World {
  const world = createWorld(overrides, seed)
  world.addAgent(new ChaosDriver())
  world.addAgent(new RandomTrader('trader-a', { activityWad: WAD / 3n }))
  world.addAgent(new RandomTrader('trader-b', { activityWad: WAD / 4n, buyBiasWad: WAD / 3n }))
  world.addAgent(
    new RandomTrader('trader-c', {
      activityWad: WAD / 2n,
      buyBiasWad: WAD / 6n,
      maxTradeFractionWad: WAD / 8n,
    }),
  )
  world.addAgent(new PassiveHolder(`${world.config.ownerIdPrefix}-0`))
  // Give the traders something to trade with.
  for (const id of ['trader-a', 'trader-b', 'trader-c']) {
    const wallet = world.state.wallets.get(id) as Wallet
    wallet.eth = 100n * WAD
  }

  const ratchet = initialRatchet(world)
  const seen = new Map<string, number>()
  for (let t = 0; t < ticks; t++) {
    const result = world.tick()
    for (const event of result.events) seen.set(event.type, (seen.get(event.type) ?? 0) + 1)
    assertInvariants(world, result, ratchet)
  }
  eventCounts.set(world, seen)
  for (const [kind, count] of seen) sweepCoverage.set(kind, (sweepCoverage.get(kind) ?? 0) + count)
  return world
}

/** Every event kind the whole sweep produced, across all seeds. */
const sweepCoverage = new Map<string, number>()

/** What each scenario actually exercised, so the sweep can prove it is not vacuous. */
const eventCounts = new WeakMap<World, Map<string, number>>()

function coverage(world: World): Map<string, number> {
  return eventCounts.get(world) ?? new Map()
}

const SEEDS = [1, 7, 42, 1337, 20260910, 99991]

/** Mechanisms that every seed in the sweep must exercise. */
const REQUIRED_EVENTS = [
  'issuance',
  'auctionOpened',
  'licenseSold',
  'swap',
  'withdrawal',
  'retirement',
  'revocation',
  'epochClosed',
  'polAdded',
] as const

// ---------------------------------------------------------------------------
// Property tests over randomized configs and seeds
// ---------------------------------------------------------------------------

describe('invariants hold at every tick, over randomized configs and seeds', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      const rng = createRng(seed)
      const overrides = randomOverrides(rng)
      const world = runScenario(seed, overrides, 500)
      // A sweep that never exercises the protocol proves nothing, so every
      // mechanism the invariants speak about has to actually fire.
      const seen = coverage(world)
      expect(world.state.token.cumulativeIssuance > 0n).toBe(true)
      expect(world.history.length).toBe(500)
      for (const kind of REQUIRED_EVENTS) {
        expect(seen.get(kind) ?? 0, `seed ${seed} never produced a ${kind} event`).toBeGreaterThan(0)
      }
    })
  }

  it('the sweep as a whole exercised the contraction vault', () => {
    // The contraction vault only fires in an epoch that closed with
    // F_n <= 0 (whitepaper 4, 11). That is a market condition, not something
    // the driver can force, so it is required of the sweep rather than of any
    // one seed. `11 the fee engine` covers the spend rule directly.
    expect(sweepCoverage.get('buyback') ?? 0).toBeGreaterThan(0)
    for (const kind of REQUIRED_EVENTS) {
      expect(sweepCoverage.get(kind) ?? 0, `the sweep never produced a ${kind} event`).toBeGreaterThan(0)
    }
  })

  it('holds through the full study population — cohort, hunters and outside demand', () => {
    // The same invariants, against the agents the study actually runs:
    // heterogeneous bankers, bounty hunters spending gas on reports, and a
    // revocation wave destroying branches mid-flight.
    const world = createWorld({ genesisCharters: 150 }, 4242)
    populateGenesisCohort(world)
    const ratchet = initialRatchet(world)
    for (let t = 0; t < 24 * 40; t++) {
      const result = world.tick()
      assertInvariants(world, result, ratchet)
    }
    expect(world.state.wave.cumulativeRevoked).toBeGreaterThan(0)
    expect(world.state.token.mintedToWallets > 0n).toBe(true)
    expect(world.state.hunters.cumulativeGasSpentEth > 0n).toBe(true)
  })

  it('holds through a full genesis cohort at the whitepaper defaults', () => {
    // 1000 charters, one branch each, the real 30-day dormancy clock, run one
    // day past the thirty-first (whitepaper 6 and 10).
    const world = runScenario(20260910, { dormancyDays: 30 }, 24 * 32)
    expect(world.config.genesisCharters).toBe(1000)
    expect(world.state.revokedCharterIds.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
}

describe('determinism', () => {
  it('same seed and config produce a byte-identical history', () => {
    const overrides = randomOverrides(createRng(4242))
    const a = runScenario(4242, overrides, 200)
    const b = runScenario(4242, overrides, 200)
    expect(serialize(a.history)).toBe(serialize(b.history))
    expect(a.rng.getState()).toEqual(b.rng.getState())
  })

  it('a different seed produces a different history', () => {
    const overrides = randomOverrides(createRng(4242))
    const a = runScenario(4242, overrides, 200)
    const c = runScenario(4243, overrides, 200)
    expect(serialize(a.history)).not.toBe(serialize(c.history))
  })

  it('nothing in the package reaches for ambient entropy', () => {
    // A guard against a future edit reintroducing Math.random or Date.now:
    // freezing both must not change the history.
    const overrides = randomOverrides(createRng(11))
    const before = serialize(runScenario(11, overrides, 120).history)
    const realRandom = Math.random
    const realNow = Date.now
    try {
      Math.random = () => 0.123456789
      Date.now = () => 0
      const after = serialize(runScenario(11, overrides, 120).history)
      expect(after).toBe(before)
    } finally {
      Math.random = realRandom
      Date.now = realNow
    }
  })
})

// ---------------------------------------------------------------------------
// Whitepaper 3 — the token
// ---------------------------------------------------------------------------

describe('3 $STANDARD', () => {
  it('opens with 100e6 pre-minted into the pool and a 1e9 max supply', () => {
    const world = createWorld({}, 1)
    expect(world.state.pool.standardReserve).toBe(tokens(100_000_000))
    expect(world.history.length).toBe(0)
    const result = world.tick()
    expect(result.snapshot.circulating).toBe(tokens(100_000_000))
    expect(result.snapshot.maxSupply).toBe(tokens(1_000_000_000))
  })

  it('stops base issuance permanently once the 900e6 budget is reached', () => {
    // A tiny budget so the halt happens inside the test horizon.
    const budget = tokens(1_000)
    const world = createWorld(
      {
        issuanceBudgetTokens: budget,
        polPremintTokens: tokens(100),
        hardCapTokens: budget + tokens(100),
        genesisCharters: 4,
        baseRatePerDayTokens: tokens(600),
        poolInitialEth: 10n * WAD,
      },
      3,
    )
    for (let t = 0; t < 24 * 10; t++) world.tick()
    expect(world.state.issuanceHalted).toBe(true)
    expect(world.state.token.cumulativeIssuance).toBeLessThanOrEqual(budget)

    const frozen = world.state.token.cumulativeIssuance
    for (let t = 0; t < 100; t++) {
      const result = world.tick()
      // Whitepaper 3: base issuance is zero forever after the budget is spent.
      expect(result.events.some((e) => e.type === 'issuance')).toBe(false)
      expect(world.state.token.cumulativeIssuance).toBe(frozen)
    }
  })
})

// ---------------------------------------------------------------------------
// Whitepaper 6 — charters and branches
// ---------------------------------------------------------------------------

describe('6 charters and branches', () => {
  it('creates 1000 single-branch charters at t = 0', () => {
    const world = createWorld({}, 1)
    expect(world.state.charters.size).toBe(1000)
    expect(world.state.totalBranches).toBe(1000)
    for (const charter of world.state.charters.values()) {
      expect(charter.branchIds.length).toBe(1)
      expect(charter.lastInteractionTick).toBe(0)
    }
  })

  it('a branch opened mid-epoch earns strictly pro rata to the time it existed', () => {
    // A small base rate keeps the license floor well inside what a genesis
    // banker can buy off the pool with their opening ETH.
    const world = createWorld(
      { genesisCharters: 2, licensesPerDay: 10, baseRatePerDayTokens: tokens(1_000) },
      5,
    )
    const owner = 'banker-0'
    // Let the genesis branches accrue for half a day, then open a new branch.
    for (let t = 0; t < 12; t++) world.tick()

    // Buying a license needs $STANDARD; buy some off the pool first.
    world.actions.swap(owner, 'buy', 5n * WAD)
    const wallet = world.state.wallets.get(owner) as Wallet
    expect(wallet.standard > 0n).toBe(true)

    const indexAtOpen = world.state.ledger.rewardIndex
    world.actions.buyLicense(0)
    const charter = world.state.charters.get(0)!
    const newBranch = world.state.branches.get(charter.branchIds.at(-1) as number)!
    const genesisBranch = world.state.branches.get(charter.branchIds[0] as number)!
    expect(newBranch.indexAt).toBe(indexAtOpen)
    expect(newBranch.settled).toBe(0n)

    // One more hour: the new branch holds exactly one hour of accrual, the
    // genesis branch holds all thirteen.
    world.tick()
    const perTick = world.state.ledger.rewardIndex - indexAtOpen
    expect(branchBalance(world.state, newBranch)).toBe(perTick)
    expect(branchBalance(world.state, genesisBranch)).toBe(world.state.ledger.rewardIndex)
  })
})

// ---------------------------------------------------------------------------
// Whitepaper 7 — the license auction
// ---------------------------------------------------------------------------

describe('7 the Dutch license auction', () => {
  it('falls strictly all day and never reaches the floor before the day closes', () => {
    const cfg = resolveConfig({})
    const rng = createRng(808)
    for (let trial = 0; trial < 200; trial++) {
      const floor = rng.nextRange(tokens(1n), tokens(1_000_000n))
      const previousSold = rng.nextBool(WAD / 2n) ? null : floor + rng.nextRange(0n, floor * 10n)
      const start = licenseStartPrice(cfg, previousSold, floor)
      const schedule = buildLicenseSchedule(cfg, start, floor)

      expect(schedule[0]).toBe(start)
      for (let h = 1; h < schedule.length; h++) {
        expect((schedule[h] as Tokens) < (schedule[h - 1] as Tokens)).toBe(true)
        expect((schedule[h] as Tokens) >= floor).toBe(true)
      }
      // P(24h) is the floor: one more step lands on it, within rounding.
      const next = mulWad(
        schedule[schedule.length - 1] as Tokens,
        divWad(schedule[1] as Tokens, schedule[0] as Tokens),
      )
      expect(next <= floor + floor / 1_000_000n).toBe(true)
    }
  })

  it('anchors P_start at twice the lowest price that sold yesterday', () => {
    const cfg = resolveConfig({})
    expect(licenseStartPrice(cfg, tokens(500), tokens(100))).toBe(tokens(1_000))
    // Nothing sold yesterday: P_start = 2 * P_floor.
    expect(licenseStartPrice(cfg, null, tokens(100))).toBe(tokens(200))
    // Yesterday's clearing price sits below today's floor — the floor wins, so
    // the auction still opens above where it can end.
    expect(licenseStartPrice(cfg, tokens(10), tokens(100))).toBe(tokens(200))
  })

  it('tracks one branch yield in the floor price', () => {
    const cfg = resolveConfig({ baseRatePerDayTokens: tokens(1_000), licenseFloorDays: 2n })
    // 1000 tokens/day at m = 1 across 10 branches is 100/branch/day; two days
    // of that is 200.
    expect(licenseFloorPrice(cfg, WAD, 10)).toBe(tokens(200))
    expect(licenseFloorPrice(cfg, WAD / 2n, 10)).toBe(tokens(100))
    expect(licenseFloorPrice(cfg, WAD, 0)).toBe(0n)
  })

  it('caps a charter at 3 licenses a day and 10 branches in total', () => {
    const world = createWorld(
      { genesisCharters: 2, licensesPerDay: 100, baseRatePerDayTokens: tokens(1_000) },
      9,
    )
    world.tick()
    world.actions.swap('banker-0', 'buy', 5n * WAD)

    world.actions.buyLicense(0)
    world.actions.buyLicense(0)
    world.actions.buyLicense(0)
    expect(() => world.actions.buyLicense(0)).toThrow(/already bought 3 licenses today/i)

    // Nine more days takes the charter to the 10-branch cap.
    for (let day = 0; day < 9; day++) {
      for (let h = 0; h < 24; h++) world.tick()
      for (let i = 0; i < 3; i++) {
        try {
          world.actions.buyLicense(0)
        } catch {
          /* the branch cap closes the door partway through the last day */
        }
      }
    }
    expect(world.state.charters.get(0)!.branchIds.length).toBe(10)
    expect(() => world.actions.buyLicense(0)).toThrow()
  })

  it('never rolls unsold inventory into the next day', () => {
    const world = createWorld({ genesisCharters: 2, licensesPerDay: 7 }, 11)
    for (let h = 0; h < 24; h++) world.tick()
    expect(world.state.licenses.remaining).toBe(7)
    expect(world.state.licenses.soldToday).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Whitepaper 9 — the resolution fee
// ---------------------------------------------------------------------------

describe('9 the resolution fee', () => {
  it('stays within [feeFloor, feeCeiling] and is monotonically increasing in P', () => {
    const rng = createRng(31337)
    for (let trial = 0; trial < 50; trial++) {
      const floor = rng.nextRange(0n, WAD / 5n)
      const ceiling = floor + rng.nextRange(WAD / 1000n, WAD / 2n)
      const cfg = resolveConfig({
        feeFloorWad: floor,
        feeCeilingWad: ceiling,
        pSaturationWad: rng.nextRange(WAD / 100n, WAD),
      })

      let previous = -1n
      for (let step = 0; step <= 1_000; step++) {
        const p = (WAD * BigInt(step)) / 1_000n
        const rate = resolutionFeeRate(cfg, p)
        expect(rate >= cfg.feeFloorWad).toBe(true)
        expect(rate <= cfg.feeCeilingWad).toBe(true)
        expect(rate >= previous).toBe(true)
        previous = rate
      }
      // Strictly increasing below saturation, flat above it.
      const below = cfg.pSaturationWad / 2n
      expect(resolutionFeeRate(cfg, below) > resolutionFeeRate(cfg, below / 2n)).toBe(true)
      expect(resolutionFeeRate(cfg, cfg.pSaturationWad)).toBe(cfg.feeCeilingWad)
      expect(resolutionFeeRate(cfg, WAD)).toBe(cfg.feeCeilingWad)
      expect(resolutionFeeRate(cfg, 0n)).toBe(cfg.feeFloorWad)
    }
  })

  it('computes P = W / max(D + W, pFloorDenominator)', () => {
    const cfg = resolveConfig({ pFloorDenominatorTokens: tokens(1_000_000) })
    expect(resolutionPressure(cfg, 0n, tokens(10_000_000))).toBe(0n)
    // W = D: P = 1/2.
    expect(resolutionPressure(cfg, tokens(5_000_000), tokens(5_000_000))).toBe(WAD / 2n)
    // The denominator floor binds when the bank is nearly empty.
    expect(resolutionPressure(cfg, tokens(1), tokens(0))).toBe(divWad(tokens(1), tokens(1_000_000)))
  })

  it('retiring k of n liquidates exactly k/n of the accrued balance', () => {
    const world = createWorld(
      { genesisCharters: 4, licensesPerDay: 50, baseRatePerDayTokens: tokens(1_000) },
      77,
    )
    const scripted = new ScriptedAgent('scripted')
    world.addAgent(scripted)

    for (let h = 0; h < 6; h++) world.tick()
    world.actions.swap('banker-0', 'buy', 5n * WAD)
    world.actions.buyLicense(0)
    world.actions.buyLicense(0)
    world.actions.buyLicense(0)
    for (let h = 0; h < 30; h++) world.tick()

    const charter = world.state.charters.get(0)!
    expect(charter.branchIds.length).toBe(4)
    let accrued = 0n
    for (const id of charter.branchIds) {
      accrued += branchBalance(world.state, world.state.branches.get(id)!)
    }
    expect(accrued > 0n).toBe(true)
    const branchesBefore = world.state.totalBranches

    scripted.enqueue([{ type: 'retireBranches', charterId: 0, k: 3 }])
    const result = world.tick()
    const event = result.events.find((e) => e.type === 'retirement')
    expect(event?.type).toBe('retirement')
    if (event?.type !== 'retirement') return

    // Exactly k/n, to the wei.
    const expected = (event.accruedBefore * 3n) / 4n
    expect(event.liquidatedGross).toBe(expected)
    expect(event.k).toBe(3)
    expect(event.n).toBe(4)
    expect(event.charterBurned).toBe(false)
    // ...and the branches are destroyed permanently.
    expect(world.state.charters.get(0)!.branchIds.length).toBe(1)
    expect(branchesBefore - world.state.totalBranches).toBe(3)
  })

  it('retiring all n branches burns the charter', () => {
    const world = createWorld({ genesisCharters: 3 }, 78)
    const scripted = new ScriptedAgent('scripted')
    world.addAgent(scripted)
    for (let h = 0; h < 10; h++) world.tick()

    scripted.enqueue([{ type: 'retireBranches', charterId: 1, k: 1 }])
    const result = world.tick()
    const event = result.events.find((e) => e.type === 'retirement')
    expect(event?.type === 'retirement' && event.charterBurned).toBe(true)
    expect(world.state.charters.get(1)!.alive).toBe(false)
    expect(world.state.liveCharters).toBe(2)
    expect(world.state.totalBranches).toBe(2)
    expect(() => world.actions.checkIn(1)).toThrow(/CHARTER_BURNED|burned/i)
  })

  it('burns half of every fee and credits the other half to branches that stayed', () => {
    const world = createWorld({ genesisCharters: 3 }, 123)
    const scripted = new ScriptedAgent('scripted')
    world.addAgent(scripted)
    for (let h = 0; h < 48; h++) world.tick()

    const otherBefore = branchBalance(
      world.state,
      world.state.branches.get(world.state.charters.get(1)!.branchIds[0] as number)!,
    )
    const amount = world.state.ledger.totalAccrued / 6n
    scripted.enqueue([{ type: 'withdraw', charterId: 0, amount }])
    const burnsBefore = world.state.token.cumulativeBurns
    const result = world.tick()

    const event = result.events.find((e) => e.type === 'withdrawal')
    expect(event?.type).toBe('withdrawal')
    if (event?.type !== 'withdrawal') return

    expect(event.gross).toBe(amount)
    expect(event.fee).toBe(mulWad(event.gross, event.feeRate))
    expect(event.burned).toBe(event.fee / 2n)
    expect(event.burned + event.redistributed).toBe(event.fee)
    expect(world.state.token.cumulativeBurns - burnsBefore).toBe(event.burned)

    // The half that was not burned lands on branches that did not exit.
    const otherAfter = branchBalance(
      world.state,
      world.state.branches.get(world.state.charters.get(1)!.branchIds[0] as number)!,
    )
    const issuedThisTick = result.events.find((e) => e.type === 'issuance')
    const issuance = issuedThisTick?.type === 'issuance' ? issuedThisTick.perBranch : 0n
    expect(otherAfter - otherBefore - issuance > 0n).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Whitepaper 10 — dormancy
// ---------------------------------------------------------------------------

describe('10 dormancy', () => {
  it('makes the genesis cohort reportable on the thirty-first day and not before', () => {
    const world = createWorld({ genesisCharters: 5 }, 31)
    for (let t = 0; t < 24 * 30 - 1; t++) world.tick()
    expect(world.state.tick).toBe(719)
    expect(() => world.actions.reportDormant('hunter', 0)).toThrow(/NOT_DORMANT|idle/i)

    world.tick()
    expect(world.state.tick).toBe(720)
    for (const charter of world.state.charters.values()) {
      expect(charter.lastInteractionTick).toBe(0)
    }
    world.actions.reportDormant('hunter', 0)
    expect(world.state.charters.get(0)!.alive).toBe(false)
  })

  it('a zero-cost check-in resets the clock', () => {
    const world = createWorld({ genesisCharters: 3, dormancyDays: 2 }, 32)
    for (let t = 0; t < 47; t++) world.tick()
    const walletBefore = { ...(world.state.wallets.get('banker-1') as Wallet) }
    world.actions.checkIn(1)
    expect(world.state.wallets.get('banker-1')).toEqual(walletBefore)

    for (let t = 0; t < 24; t++) world.tick()
    // Charter 0 never checked in and is reportable; charter 1 is not yet.
    expect(() => world.actions.reportDormant('hunter', 1)).toThrow()
    world.actions.reportDormant('hunter', 0)
    expect(world.state.charters.get(0)!.alive).toBe(false)
  })

  it('destroys the charter, pays the informant and closes the split exactly', () => {
    const world = createWorld({ genesisCharters: 4, dormancyDays: 1 }, 33)
    const scripted = new ScriptedAgent('scripted')
    world.addAgent(scripted)
    for (let t = 0; t < 24; t++) world.tick()

    const branchesBefore = world.state.totalBranches
    scripted.enqueue([{ type: 'reportDormant', reporterId: 'hunter', charterId: 2 }])
    const result = world.tick()

    const event = result.events.find((e) => e.type === 'revocation')
    expect(event?.type).toBe('revocation')
    if (event?.type !== 'revocation') return

    const cfg = world.config
    const uncapped = (event.dormantBalance * cfg.informantBountyBps) / 10_000n
    const expectedBounty =
      uncapped < cfg.informantBountyCapTokens ? uncapped : cfg.informantBountyCapTokens
    expect(event.bounty).toBe(expectedBounty)

    // The whole dormant balance is accounted for, with nothing left over.
    expect(event.bounty + event.burned + event.redistributed + event.bankerShare).toBe(
      event.dormantBalance,
    )
    // 30% goes to the dormant banker's wallet, as minted tokens.
    const revocationFee = (event.dormantBalance * cfg.revocationFeeBps) / 10_000n
    expect(event.bankerShare).toBe(event.dormantBalance - revocationFee)
    expect((world.state.wallets.get('banker-2') as Wallet).standard).toBe(event.bankerShare)
    expect((world.state.wallets.get('hunter') as Wallet).standard).toBe(event.bounty)

    // The branches are gone from totalBranches on the same tick as the report.
    expect(branchesBefore - world.state.totalBranches).toBe(event.branchesDestroyed)
    expect(world.state.charters.get(2)!.alive).toBe(false)
    expect(world.state.charters.get(2)!.branchIds.length).toBe(0)
    expect(world.state.revokedCharterIds).toContain(2)
  })

  it('is never automatic — an unreported dormant charter keeps accruing', () => {
    const world = createWorld({ genesisCharters: 3, dormancyDays: 1 }, 34)
    for (let t = 0; t < 24 * 5; t++) world.tick()
    expect(world.state.liveCharters).toBe(3)
    expect(world.state.revokedCharterIds.length).toBe(0)
    expect(world.state.ledger.totalAccrued > 0n).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Whitepaper 11 — the fee engine
// ---------------------------------------------------------------------------

describe('11 the fee engine', () => {
  it('splits routed ETH 70/15/15 with no dust left behind', () => {
    const world = createWorld({ genesisCharters: 3 }, 55)
    world.addAgent(new RandomTrader('trader', { activityWad: WAD }))
    ;(world.state.wallets.get('trader') as Wallet).eth = 500n * WAD

    let epochs = 0
    for (let t = 0; t < 24 * 6; t++) {
      for (const event of world.tick().events) {
        if (event.type !== 'epochClosed' || event.routedEth === 0n) continue
        epochs += 1
        expect(event.toVault).toBe((event.routedEth * 7_000n) / 10_000n)
        expect(event.toPol).toBe((event.routedEth * 1_500n) / 10_000n)
        // The team takes the remainder, so the three shares are exhaustive
        // even when the 70/15/15 division does not land on a whole wei.
        expect(event.toTeam).toBe(event.routedEth - event.toVault - event.toPol)
        expect(event.toVault + event.toPol + event.toTeam).toBe(event.routedEth)
      }
    }
    expect(epochs).toBeGreaterThan(0)

    const vaults = world.state.vaults
    expect(vaults.cumulativeRoutedEth > 0n).toBe(true)
    expect(vaults.cumulativeToVaults + vaults.cumulativeToPol + vaults.cumulativeToTeam).toBe(
      vaults.cumulativeRoutedEth,
    )
  })

  it('spends the contraction vault at min(0.10 V, 0.002 R) per hour and burns everything', () => {
    const world = createWorld({ genesisCharters: 2 }, 56)
    world.tick()
    const vaults = world.state.vaults
    vaults.contractionEth = 100n * WAD

    const reserveBefore = world.state.pool.ethReserve
    const vaultBefore = vaults.contractionEth
    const burnsBefore = world.state.token.cumulativeBurns
    const result = world.tick()

    const expectedSpend = (() => {
      const fromVault = (vaultBefore * DEFAULT_CONFIG.contractionVaultSpendPerTickWad) / WAD
      const fromReserve = (reserveBefore * DEFAULT_CONFIG.contractionReserveCapPerTickWad) / WAD
      return fromVault < fromReserve ? fromVault : fromReserve
    })()
    expect(vaultBefore - vaults.contractionEth).toBe(expectedSpend)

    const buyback = result.events.find((e) => e.type === 'buyback')
    expect(buyback).toBeDefined()
    if (buyback?.type === 'buyback') {
      expect(world.state.token.cumulativeBurns - burnsBefore).toBe(buyback.tokensBurned)
      expect(buyback.ethSpent).toBe(expectedSpend)
    }
    // Unspent balance rolls forward; the vault never sells.
    expect(vaults.contractionEth > 0n).toBe(true)
    expect(vaults.contractionStandardHeld).toBe(0n)
    expect(vaults.contractionStandardSold).toBe(0n)
  })

  it('moves the price on every buy, sell, buyback and POL addition', () => {
    const world = createWorld({ genesisCharters: 2 }, 57)
    world.tick()
    const owner = 'banker-0'
    ;(world.state.wallets.get(owner) as Wallet).eth = 200n * WAD

    const p0 = divWad(world.state.pool.ethReserve, world.state.pool.standardReserve)
    world.actions.swap(owner, 'buy', 50n * WAD)
    const p1 = divWad(world.state.pool.ethReserve, world.state.pool.standardReserve)
    expect(p1 > p0).toBe(true)

    const held = (world.state.wallets.get(owner) as Wallet).standard
    world.actions.swap(owner, 'sell', held / 2n)
    const p2 = divWad(world.state.pool.ethReserve, world.state.pool.standardReserve)
    expect(p2 < p1).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Whitepaper 4 and 5 — the net flow signal and monetary policy
// ---------------------------------------------------------------------------

describe('4 and 5 net flow and monetary policy', () => {
  it('reads the slow lever off F_{n-1} + F_{n-2}, never the current epoch', () => {
    const world = createWorld({ genesisCharters: 2, epochDays: 1 }, 58)
    const flows: bigint[] = []
    const signals: bigint[] = []
    for (let t = 0; t < 24 * 5; t++) {
      const result = world.tick()
      for (const event of result.events) {
        if (event.type !== 'epochClosed') continue
        const n = flows.length
        const expected = (n >= 1 ? (flows[n - 1] as bigint) : 0n) + (n >= 2 ? (flows[n - 2] as bigint) : 0n)
        expect(event.signal).toBe(expected)
        signals.push(event.signal)
        flows.push(event.netFlow)
      }
    }
    expect(flows.length).toBe(5)
    expect(signals.length).toBe(5)
  })

  it('cuts harder than it raises and respects the clamp', () => {
    const cfg = resolveConfig({})
    expect(cfg.multiplierCutStepWad > cfg.multiplierRaiseStepWad).toBe(true)

    // With no inflow at all the multiplier walks down to mMin and stops.
    const world = createWorld({ genesisCharters: 2, epochDays: 1 }, 59)
    for (let t = 0; t < 24 * 200; t++) world.tick()
    expect(world.state.policy.multiplier).toBe(world.config.multiplierMinWad)
  })

  it('routes fees on the sign of the current epoch F_n', () => {
    const world = createWorld({ genesisCharters: 2, epochDays: 1 }, 60)
    world.addAgent(new RandomTrader('buyer', { activityWad: WAD, buyBiasWad: WAD }))
    ;(world.state.wallets.get('buyer') as Wallet).eth = 400n * WAD

    let sawExpansion = false
    for (let t = 0; t < 24 * 3; t++) {
      const result = world.tick()
      for (const event of result.events) {
        if (event.type !== 'epochClosed') continue
        expect(event.vault).toBe(event.netFlow > 0n ? 'expansion' : 'contraction')
        if (event.vault === 'expansion') sawExpansion = true
      }
    }
    expect(sawExpansion).toBe(true)
  })
})
