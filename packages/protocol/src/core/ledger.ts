/**
 * The accrued-balance ledger.
 *
 * Issuance credits a ledger balance; tokens are minted only on withdrawal
 * (whitepaper 3). Branch balances are held with an index so that per-tick
 * accrual is O(1) in the number of branches:
 *
 *   balance(branch) = branch.settled + (ledger.rewardIndex - branch.indexAt)
 *
 * `rewardIndex` accumulates tokens-per-branch. A branch created mid-epoch
 * snapshots the index at creation and therefore earns strictly pro rata to the
 * time it has existed (whitepaper 6).
 *
 * Every routine here is exact to the wei. Proportional splits floor, and the
 * floor remainder is spread one wei at a time over the participants in id
 * order, so that the ledger closure
 *
 *   sum(balances) + mintedFromLedger + burnedFromLedger === cumulativeIssuance
 *
 * holds with equality, not to within a tolerance.
 */

import { divExact, mulWad, prepareDivisor } from '../math/fixed.js'
import type { Config } from '../config/index.js'
import { ticksPerEpoch } from '../config/index.js'
import type {
  Branch,
  BurnSource,
  Charter,
  CreditKind,
  Tokens,
  WalletCredits,
  WorldState,
} from '../types.js'

export function branchBalance(state: WorldState, branch: Branch): Tokens {
  return branch.settled + (state.ledger.rewardIndex - branch.indexAt)
}

export function settleBranch(state: WorldState, branch: Branch): Tokens {
  branch.settled = branch.settled + (state.ledger.rewardIndex - branch.indexAt)
  branch.indexAt = state.ledger.rewardIndex
  return branch.settled
}

export function requireBranch(state: WorldState, id: number): Branch {
  const branch = state.branches.get(id)
  if (branch === undefined) throw new Error(`ledger: branch ${id} does not exist`)
  return branch
}

export function charterAccrued(state: WorldState, charter: Charter): Tokens {
  let total = 0n
  for (const id of charter.branchIds) total += branchBalance(state, requireBranch(state, id))
  return total
}

/** Every live branch id, in charter id then branch id order. Deterministic. */
export function liveBranchIds(state: WorldState): number[] {
  const ids: number[] = []
  for (const charter of state.charters.values()) {
    if (!charter.alive) continue
    for (const id of charter.branchIds) ids.push(id)
  }
  return ids
}

/**
 * Every live branch, in the same order as `liveBranchIds`.
 *
 * The order is load-bearing: the floor remainder of a redistribution is spread
 * one wei at a time in participant order, so a different traversal would move
 * dust between branches. `World` caches this array and rebuilds it only when
 * the branch set changes.
 */
export function liveBranches(state: WorldState): Branch[] {
  const branches: Branch[] = []
  for (const charter of state.charters.values()) {
    if (!charter.alive) continue
    for (const id of charter.branchIds) {
      const branch = state.branches.get(id)
      if (branch !== undefined) branches.push(branch)
    }
  }
  return branches
}

export interface IssuanceResult {
  perBranch: Tokens
  total: Tokens
  halted: boolean
}

/**
 * One hour of base issuance — whitepaper 5.
 *
 *   I_n      = baseRatePerDay * epochDays * m_n     (per epoch)
 *   I_tick   = I_n / ticksPerEpoch                  (the per-second stream,
 *                                                    evaluated hourly)
 *
 * Split pro rata across all live branches. The split floors, and only
 * `perBranch * totalBranches` is actually issued — the sub-wei remainder is
 * never credited and stays inside the budget, which keeps `cumulativeIssuance`
 * exactly equal to what the branches received.
 */
export function accrueIssuance(state: WorldState, cfg: Config): IssuanceResult {
  const remainingBudget = cfg.issuanceBudgetTokens - state.token.cumulativeIssuance
  if (remainingBudget <= 0n) {
    state.issuanceHalted = true
    return { perBranch: 0n, total: 0n, halted: true }
  }
  if (state.totalBranches <= 0) return { perBranch: 0n, total: 0n, halted: false }

  // `baseRatePerDay * epochDays`, expressed in whole hours so that a
  // fractional epoch length stays exact. For an integer `epochDays` this is
  // bit-identical to `baseRatePerDay * epochDays`.
  const epochTicks = ticksPerEpoch(cfg)
  const perEpochRate = (cfg.baseRatePerDayTokens * BigInt(epochTicks)) / BigInt(cfg.ticksPerDay)
  const perEpoch = mulWad(perEpochRate, state.policy.multiplier)
  let perTick = perEpoch / BigInt(epochTicks)
  if (perTick > remainingBudget) perTick = remainingBudget

  const branches = BigInt(state.totalBranches)
  const perBranch = perTick / branches
  const total = perBranch * branches
  if (total === 0n) return { perBranch: 0n, total: 0n, halted: false }

  state.ledger.rewardIndex += perBranch
  state.ledger.totalAccrued += total
  state.token.cumulativeIssuance += total

  const halted = state.token.cumulativeIssuance >= cfg.issuanceBudgetTokens
  if (halted) state.issuanceHalted = true
  return { perBranch, total, halted }
}

/**
 * Credit `amount` pro rata to the accrued balances of `participants`.
 *
 * Used by the resolution fee (whitepaper 9, to branches that did not exit) and
 * by revocation (whitepaper 10, to all still-active branches). If there is
 * nothing eligible, or every eligible branch is empty, the amount is burned
 * from the ledger instead — it cannot be left unassigned without breaking the
 * closure.
 *
 * `total` must be the exact sum of the participants' balances. Every caller
 * passes all live branches, whose sum the ledger already maintains as
 * `totalAccrued`, so it is passed in rather than recomputed — that recompute
 * was a second full pass over every branch on every withdrawal.
 */
export function redistributePro(
  state: WorldState,
  amount: Tokens,
  participants: readonly Branch[],
  total: Tokens,
  source: Extract<BurnSource, 'resolutionFee' | 'revocationFee'>,
): { distributed: Tokens; burned: Tokens } {
  if (amount <= 0n) return { distributed: 0n, burned: 0n }

  if (participants.length === 0 || total <= 0n) {
    burnLedgerValue(state, amount, source)
    return { distributed: 0n, burned: amount }
  }

  // Single pass. A branch's balance is `settled + (rewardIndex - indexAt)`, so
  // a credit can be added straight to `settled` without materialising the
  // pending issuance first — the balance comes out the same either way, and
  // this is the hottest loop in the model by a wide margin.
  const index = state.ledger.rewardIndex
  let distributed = 0n
  // A branch's balance never exceeds the total, so every numerator here is at
  // most `amount * total`; that is the bound Barrett needs.
  const divisor = prepareDivisor(total, amount * total)
  if (divisor === null) {
    for (let i = 0; i < participants.length; i++) {
      const branch = participants[i] as Branch
      const balance = branch.settled + (index - branch.indexAt)
      const share = (amount * balance) / total
      branch.settled += share
      distributed += share
    }
  } else {
    for (let i = 0; i < participants.length; i++) {
      const branch = participants[i] as Branch
      const balance = branch.settled + (index - branch.indexAt)
      const share = divExact(amount * balance, divisor)
      branch.settled += share
      distributed += share
    }
  }
  // Spread the floor remainder one wei at a time, in participant order.
  let remainder = amount - distributed
  for (let i = 0; remainder > 0n; i = (i + 1) % participants.length) {
    ;(participants[i] as Branch).settled += 1n
    remainder -= 1n
    distributed += 1n
  }

  state.ledger.totalAccrued += distributed
  state.tickRedistributed[source] += distributed
  return { distributed, burned: 0n }
}

/**
 * Debit exactly `amount` from a charter, proportionally across its branches.
 * The caller is responsible for what happens to the value afterwards.
 */
export function debitCharter(state: WorldState, charter: Charter, amount: Tokens): void {
  if (amount < 0n) throw new RangeError('debitCharter: negative amount')
  if (amount === 0n) return

  const branches = charter.branchIds.map((id) => requireBranch(state, id))
  let total = 0n
  for (const branch of branches) total += settleBranch(state, branch)
  if (amount > total) throw new RangeError('debitCharter: amount exceeds accrued balance')

  let taken = 0n
  const takes = branches.map((branch) => {
    const take = (amount * branch.settled) / total
    taken += take
    return take
  })
  // Assign the floor remainder one wei at a time to branches with headroom.
  let remainder = amount - taken
  for (let i = 0; remainder > 0n; i = (i + 1) % branches.length) {
    const branch = branches[i] as Branch
    if (branch.settled - (takes[i] as Tokens) > 0n) {
      takes[i] = (takes[i] as Tokens) + 1n
      remainder -= 1n
    }
  }
  for (let i = 0; i < branches.length; i++) {
    ;(branches[i] as Branch).settled -= takes[i] as Tokens
  }
  state.ledger.totalAccrued -= amount
}

/**
 * Rewrite the balances of `branches` so that they sum to exactly `target`,
 * proportionally to what they hold now. Used when a partial retirement leaves
 * the charter's residue with the surviving branches.
 */
export function rebalanceBranches(
  state: WorldState,
  branches: readonly Branch[],
  target: Tokens,
): void {
  if (branches.length === 0) {
    if (target !== 0n) throw new RangeError('rebalanceBranches: no branches to hold the residue')
    return
  }
  let total = 0n
  for (const branch of branches) total += settleBranch(state, branch)

  if (total === 0n) {
    const each = target / BigInt(branches.length)
    let assigned = 0n
    for (const branch of branches) {
      branch.settled = each
      assigned += each
    }
    ;(branches[0] as Branch).settled += target - assigned
    return
  }

  let assigned = 0n
  const shares = branches.map((branch) => {
    const share = (target * branch.settled) / total
    assigned += share
    return share
  })
  let remainder = target - assigned
  for (let i = 0; remainder > 0n; i = (i + 1) % branches.length) {
    shares[i] = (shares[i] as Tokens) + 1n
    remainder -= 1n
  }
  for (let i = 0; i < branches.length; i++) {
    ;(branches[i] as Branch).settled = shares[i] as Tokens
  }
}

/**
 * Burn ledger value that was never minted.
 *
 * The supply identity in whitepaper 3.1 is
 * `circulating = 100e6 + mints - burns`. Value that only ever existed as a
 * ledger entry has to be minted before it can be burned, or the burn would
 * reduce `circulating` by tokens that were never in circulation. Minting and
 * burning together leaves `circulating` untouched and lowers
 * `maxSupply = 1e9 - burns`, which is the right economics: burnt ledger value
 * can never be issued again.
 */
export function burnLedgerValue(state: WorldState, amount: Tokens, source: BurnSource): void {
  if (amount <= 0n) return
  // `notionalMints` is the half of `cumulativeMints` that no address ever
  // holds. Keeping the two apart is what makes `mintedToWallets` — the
  // study's sell-pressure figure — exact.
  state.token.notionalMints += amount
  state.token.cumulativeMints += amount
  state.token.cumulativeBurns += amount
  state.token.burnsBySource[source] += amount
  state.ledger.burnedFromLedger += amount
}

/**
 * Mint ledger value into a wallet: a withdrawal, a retirement payout, a
 * revocation payout or an informant bounty.
 *
 * These are real ERC-20 mints. They land in an address and can be sold, which
 * is why they are counted separately from `notionalMints` and attributed to a
 * reason.
 */
export function mintLedgerValue(
  state: WorldState,
  ownerId: string,
  amount: Tokens,
  kind: CreditKind,
): void {
  if (amount <= 0n) return
  const wallet = state.wallets.get(ownerId)
  if (wallet === undefined) throw new Error(`ledger: wallet ${ownerId} does not exist`)
  wallet.standard += amount
  state.token.mintedToWallets += amount
  state.token.cumulativeMints += amount
  state.ledger.mintedFromLedger += amount
  creditsFor(state, ownerId)[kind] += amount
}

/** The credit record for an address, created on first use. */
export function creditsFor(state: WorldState, ownerId: string): WalletCredits {
  let credits = state.credits.get(ownerId)
  if (credits === undefined) {
    credits = { withdrawal: 0n, retirement: 0n, revocationPayout: 0n, bounty: 0n }
    state.credits.set(ownerId, credits)
  }
  return credits
}

/** Burn tokens that are already in circulation (license payments, buybacks). */
export function burnCirculating(
  state: WorldState,
  amount: Tokens,
  source: Extract<BurnSource, 'license' | 'buyback'>,
): void {
  if (amount <= 0n) return
  state.token.cumulativeBurns += amount
  state.token.burnsBySource[source] += amount
}

export function circulatingSupply(state: WorldState, cfg: Config): Tokens {
  return cfg.polPremintTokens + state.token.cumulativeMints - state.token.cumulativeBurns
}

export function maxSupply(state: WorldState, cfg: Config): Tokens {
  return cfg.hardCapTokens - state.token.cumulativeBurns
}
