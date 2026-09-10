# Mechanics

Every rule implemented in `packages/protocol`, keyed to the whitepaper section
it comes from, with a pointer to the code that enforces it.

This document is normative for the model. If the code and this file disagree,
one of them is a bug. The companion artifacts are
`packages/protocol/src/invariants.spec.ts`, which asserts the structural claims
made here after every tick of every scenario,
`packages/protocol/src/study.spec.ts`, which asserts the claims the study
depends on, and [`findings.md`](./findings.md), which records the places where
the whitepaper had to be interpreted.

Sections numbered `§n` are whitepaper sections. Sections marked **[study]** are
modelling layers this repository adds on top; the whitepaper does not describe
them, and each says why it has to exist.

---

## 0. Reading conventions

| Convention | Rule | Code |
| --- | --- | --- |
| Value | Every token and ETH amount is a `bigint` in wei, 18 decimals. There are no floats in state. | `src/types.ts` |
| Fractions | Rates, multipliers and probabilities are WAD fixed point: `1e18 === 1.0`. Percentages that the whitepaper states as percentages are basis points. | `src/math/fixed.ts` |
| `number` | Used only for counts — ticks, branch counts, ids. Never for value. | — |
| Time | One tick is one hour. A day is 24 ticks. An epoch is `epochDays` days. | `src/config/defaults.ts` |
| Randomness | Seeded xoshiro128\*\*, one independent stream per `(seed, agentId, purpose)`. No `Math.random`, no `Date.now`. | `src/rng/xoshiro128.ts`, `src/rng/derive.ts` |
| Determinism | Same seed + same config produces a byte-identical `world.history`. Asserted in `determinism > same seed and config produce a byte-identical history`. | `src/world.ts` |
| Rounding | Proportional splits floor, and the floor remainder is spread one wei at a time across the participants in a fixed order, so that every accounting identity closes with `===` rather than to within a tolerance. | `src/core/ledger.ts` |

### The order of an hour

`world.tick()` does exactly this, in this order (`src/world.ts:tick`):

1. Clear the per-tick instrumentation counters.
2. Roll the trailing withdrawal window forward one tick (§9).
3. If the tick opens a day, open the license auction for that day (§7).
4. Accrue one hour of the issuance stream (§5, §6).
5. Run the contraction vault's hourly buyback-and-burn (§11).
6. Fix the bounty-hunter profitability floor for the hour, at the price the
   hunters will see when they act. It does not move again until the next tick,
   so every hunter in an hour sees the same market regardless of the order
   agents happen to run in.
7. Ask every registered agent for actions, in registration order, and apply
   them in the order returned. Rejected actions are recorded, not thrown.
8. If the tick ends an epoch, close it: route protocol ETH (§11), then move
   the issuance multiplier (§4, §5).
9. Advance the clock and append a snapshot to `world.history`.

---

## §3 — $STANDARD

| Rule | Implementation |
| --- | --- |
| ERC-20 semantics, 18 decimals. | Balances are `bigint` wei throughout. |
| Hard cap 1e9. | `config.hardCapTokens` |
| 100e6 pre-minted as protocol-owned liquidity, locked in the pool forever. | `createPool` seeds `standardReserve` with `config.polPremintTokens`; the pool exposes no liquidity-removal path at all. `src/core/pool.ts` |
| Issuance budget 900e6. When cumulative issuance reaches it, base issuance stops permanently. | `accrueIssuance` returns zero once `cumulativeIssuance >= issuanceBudgetTokens` and latches `state.issuanceHalted`. `src/core/ledger.ts` |
| Issuance credits a ledger balance. Tokens are MINTED only on withdrawal. | Issuance moves `ledger.rewardIndex`; `token.cumulativeMints` moves only in `mintLedgerValue` and `burnLedgerValue`. |
| `circulating = 100e6 + cumulativeMints - cumulativeBurns` | `circulatingSupply` |
| `maxSupply = 1e9 - cumulativeBurns`, never increases | `maxSupply` |

### The two kinds of mint

`cumulativeMints` sums two things that behave completely differently, so the
model keeps them apart and reports both:

| Field | What it is |
| --- | --- |
| `mintedToWallets` | Real ERC-20 mints that land in an address and can be sold: withdrawal proceeds, branch-retirement payouts, the 30% revocation payout (§10), informant bounties. |
| `notionalMints` | The bookkeeping counterpart to burning ledger value that was never minted — the burned half of a resolution fee (§9), the burned share of a revocation fee (§10). No address ever holds any of it. |

`cumulativeMints === mintedToWallets + notionalMints` exactly, so §3.1 is
unchanged. The split matters because `mintedToWallets` is the number the study
reports as **sell-pressure supply**: it is the part of a revocation that can
reach the pool. Lumping it together with a bookkeeping entry would overstate it
by the size of the burn.

Both are asserted every tick, and each is checked to move only for its own
reason: `notionalMints` in lockstep with `burnedFromLedger`, `mintedToWallets`
only when an address is actually credited. Every wei of `mintedToWallets` is
attributed to an address and a reason in `state.credits`, and the sum of those
records equals it.

Burns are attributed too — `burnsBySource` splits `cumulativeBurns` into
`license` (§7), `buyback` (§11), `resolutionFee` (§9) and `revocationFee` (§10)
— and the last two sum to exactly `notionalMints`, because those are the only
two rules that burn value that was never minted.

One more identity closes the loop: every circulating token can be **located**.

```
walletsHeld + poolStandardReserve + pendingPolStandard
  === 100e6 + mintedToWallets - burnsBySource.license - burnsBySource.buyback
```

### Burning value that was never minted

Three rules burn value that only ever existed as a ledger entry: half the
resolution fee (§9), half the revocation fee (§10), and any redistribution with
no eligible recipient. Incrementing only `cumulativeBurns` would reduce
`circulating` by tokens that were never in circulation, breaking §3.1.

`burnLedgerValue` therefore increments **both** `cumulativeMints` and
`cumulativeBurns`. `circulating` is unchanged, and
`maxSupply = 1e9 - cumulativeBurns` falls — which is the correct economics:
burnt ledger value can never be issued to anyone again.

A useful consequence: because all minting is fed by the ledger, and the ledger
is fed only by issuance,

```
cumulativeMints === mintedFromLedger + burnedFromLedger <= cumulativeIssuance <= 900e6
```

so `circulating <= maxSupply` holds for free. All four statements are asserted
every tick.

### The ledger closure

```
sum(all live branch balances) + mintedFromLedger + burnedFromLedger === cumulativeIssuance
```

Every token ever issued is, at any instant, exactly one of: still accrued at the
bank, minted out to a wallet, or burned out of the ledger. Fee and revocation
redistributions are internal transfers and appear on neither side. Asserted
every tick.

---

## §4 — The net flow signal

| Rule | Implementation |
| --- | --- |
| `F_n` = gross ETH in from buys − gross ETH out from sells, measured at the pool, per epoch. | `policy.currentEpochNetFlow`, moved by `doSwap` using `SwapResult.grossEth` — the amount crossing the pool boundary *before* the trading fee. |
| `signal_n = F_{n-1} + F_{n-2}` — the slow lever, which issuance reacts to. | `closeEpoch` reads the last two entries of `policy.netFlowHistory`, which does **not** yet contain the epoch being closed. Missing history reads as zero. |
| Fee routing reacts to `sign(F_n)` of the CURRENT epoch only — the fast lever. | `closeEpoch` routes to `expansion` if `netFlow > 0`, else `contraction`, using the epoch it is closing. |

The two levers are deliberately out of phase: the fast lever responds to the
epoch that just ended, the slow lever to the two before it.

**Protocol swaps are not market flow.** The POL zap and the contraction vault's
buyback are the protocol trading with itself. Counting them as inflow would let
the contraction vault manufacture a positive `F_n`, flip the routing to
expansion and raise `m` — a feedback loop the signal is plainly not meant to
contain. `config.countProtocolSwapsInNetFlow` defaults to `false`; it is
selectable so the study can measure the difference.

---

## §5 — Monetary policy

```
m_{n+1} = clamp(m_n + (signal_n > 0 ? raiseStep : -cutStep), mMin, mMax)
I_n     = baseRatePerDay * epochDays * m_n
```

| Rule | Implementation |
| --- | --- |
| The step is applied once per epoch and clamped. | `closeEpoch`, `clampBig` |
| `cutStep > raiseStep` by design. | Enforced by `validateConfig`, which rejects any config where it does not hold. |
| `I_n` is split pro rata across all live branches. | `accrueIssuance` |
| The stream is continuous; the model evaluates it hourly. | `I_tick = I_n / ticksPerEpoch`, credited every tick. |

A signal of exactly zero cuts, because the rule is written `signal_n > 0`. The
first epoch of any world therefore cuts, since there is no history to read at
all. This is the literal rule and the model does not soften it.

---

## §6 — Charters and branches

| Rule | Implementation |
| --- | --- |
| A charter holds 1..10 branches. | `config.maxBranchesPerCharter`; asserted every tick for every live charter. |
| 1000 charters at genesis, one branch each, all created at t = 0. | `genesis()` in `src/world.ts` |
| Charter auctions are out of scope (§6: the daily count starts at zero). | No charter is ever created after genesis. `state.nextCharterId` exists but is never consumed. |
| Each branch is one equal share of every epoch's issuance. | `accrueIssuance` credits `perBranch = I_tick / totalBranches` to the index. |
| Issuance streams continuously; per-second accrual evaluated on an hourly tick. | One tick's worth is credited per tick. |
| A branch opened mid-epoch earns strictly pro rata to the time it has existed. | A new branch snapshots `indexAt = ledger.rewardIndex` at creation, so it earns nothing for any hour before it existed. |
| Retiring `k` of `n` branches liquidates exactly `k/n` of the charter's accrued balance and destroys those `k` branches permanently. | `doRetireBranches`: `liquidated = accrued * k / n`, the residue is handed back to the survivors, the `k` branches are deleted from the index and `totalBranches` falls on the same tick. |
| Retiring all `n` burns the charter. | `charter.alive = false`; every subsequent action on it is rejected with `CHARTER_BURNED`. |

### The accrual index

A branch's balance is `settled + (ledger.rewardIndex - indexAt)`. Issuance is
therefore O(1) in the number of branches: one addition to the index per tick.
Only redistributions (§9, §10), which are pro rata *to balances* rather than
per branch, walk the branch set.

---

## §7 — The license auction

```
P(t)    = P_start * (P_floor / P_start) ^ (t / 24h)      t = hours since the day opened
P_start = 2 * P_last                                      P_last = lowest price that sold yesterday
P_start = 2 * P_floor                                     if nothing sold yesterday
P_floor = licenseFloorDays * (baseRatePerDay * m / totalBranches)
```

| Rule | Implementation |
| --- | --- |
| Daily, falling price, paid in $STANDARD. | `buildLicenseSchedule` builds the day's 24 hourly prices when the day opens. |
| 100% of the payment is burned. | `doBuyLicense` debits the wallet and calls `burnCirculating`. |
| The floor tracks one branch's yield over `licenseFloorDays` days; default 2. | `licenseFloorPrice` |
| `P_start` is twice the anchor. | `config.licenseStartMultiple`; `licenseStartPrice` |

The curve is evaluated on the hourly tick, so the day is a 24-entry schedule
built by taking the 24th root of the decay ratio once and stepping. This
reproduces the continuous curve exactly at each hour and makes strict
monotonicity a property of the construction rather than of repeated rounding.
Because `P_start >= 2 * P_floor`, the per-hour step is at most `0.5^(1/24)`, so
the schedule falls strictly and `P(23h)` is still above the floor — the floor is
reached at `t = 24h`, which is when the day closes. Both are asserted every tick
and over 200 randomized curves.

**When the two `P_start` rules disagree** — [F-02](./findings.md#f-02--the-two-p_start-rules-disagree-after-a-revocation-wave).
`P_last` is bounded below by *yesterday's* floor, while today's floor moves with
`m` and `totalBranches` — a revocation wave destroys branches and lifts the
floor overnight, so `P_last` can open below today's floor and the "falling"
auction would rise. The model takes `P_start = 2 * max(P_last, P_floor)`, which
reduces to each stated rule whenever they agree and keeps the auction falling
when they do not. This is only reachable in the presence of mass revocation:
away from it `totalBranches` only grows and the floor drifts down.

If there are no live branches, `P_floor` is zero and the auction does not open
that day.

---

## §8 — License allocation

| Rule | Implementation |
| --- | --- |
| 100 licenses per day. | `config.licensesPerDay` |
| Max 3 per charter per day. | `charter.licensesBoughtToday`, reset for every charter when a day opens. |
| First come, first served at the current price. | Actions are applied in the order agents return them; there is no bidding, no ordering by price. |
| No bids, no refunds. | There is no bid or refund path in the action set. |
| Unsold inventory never rolls over. | `openAuctionDay` sets `remaining = licensesPerDay` unconditionally. |
| Max 10 branches per charter. | `config.maxBranchesPerCharter`, checked before the payment is taken. |

---

## §9 — Withdrawal and the resolution fee

```
P    = W / max(D + W, pFloorDenominator)
fee  = feeFloor + (feeCeiling - feeFloor) * min(P / pSaturation, 1)^2
```

* `W` — tokens withdrawn system-wide over the trailing 7 days.
* `D` — everything still held at the bank, i.e. all unwithdrawn accrued balances.

| Rule | Implementation |
| --- | --- |
| Quadratic interpolation from `feeFloor` to `feeCeiling` in `P`, saturating at `pSaturation`. | `resolutionFeeRate`, `src/core/fees.ts` |
| The rate LOCKS at the moment of commit. | `settleWithdrawal` reads `P` and the rate before it burns, credits or mints anything. At hourly granularity commit and execution fall in the same tick, so the lock is exact. |
| Half of every fee is burned. | `feeBurnShareBps`, then `burnLedgerValue`. |
| The other half is credited pro rata to the accrued balances of branches that did NOT exit. | `redistributePro` over `liveBranchIds(state)`, called *after* any retired branches have already been deleted, so they cannot receive a share of their own fee. |

`W` is a ring buffer of per-tick withdrawal totals, `7 * 24` slots deep. It
includes the withdrawal currently being committed; `D` is read after the debit.
The two together mean `D + W` is invariant to the size of the withdrawal in
flight — it always equals the bank plus the trailing week as they stood before
it.

The fee curve is non-decreasing everywhere, strictly increasing below
saturation, flat above it, and never leaves `[feeFloor, feeCeiling]`. Asserted
over 50 randomized configurations at 1001 points each, and on every withdrawal
event in every scenario.

**Retirement is a withdrawal.** Retiring `k` of `n` liquidates `k/n` of the
charter's accrued balance and that liquidation pays the resolution fee like any
other withdrawal. The `k/n` figure is the *gross* — asserted exact to within
1 wei on every retirement event.

---

## §10 — Dormancy

This is the subject of the study.

| Rule | Implementation |
| --- | --- |
| A charter whose owner has not interacted for `dormancyDays` (default 30) becomes REPORTABLE. | `state.tick - charter.lastInteractionTick >= dormancyDays * 24` |
| Any address may report it. | `reportDormant(reporterId, charterId)` accepts any string id and creates a wallet for it on demand. |
| Informant bounty = 2% of the dormant accrued balance, capped at 100_000 tokens. | `informantBountyBps`, `informantBountyCapTokens` |
| The dormant banker pays a 70% revocation fee: half burned, half credited pro rata to the accrued balances of all still-active branches. | `revocationFeeBps`, `revocationBurnShareBps` |
| All of that charter's branches are destroyed; `totalBranches` decreases. | Branches are deleted and `totalBranches` reduced **before** the redistribution, so the destroyed branches take no part in it. Asserted on the same tick as the report. |
| The charter NFT burns. | `charter.alive = false`, `revokedAtTick` recorded. |
| The remaining 30% is MINTED to the dormant banker's wallet. | `mintLedgerValue(state, charter.ownerId, bankerShare)` |
| Any interaction resets the clock. | `checkIn`, `buyLicense`, `retireBranches` and `withdraw` all set `lastInteractionTick`. |
| A zero-cost `checkIn()` exists and resets it. | `doCheckIn` touches nothing but the clock. |
| Reporting is an explicit agent action, never automatic. | Nothing in `tick()` revokes anything. Reports come from `BountyHunterPool`, which pays gas for each one. A dormant charter that nobody reports keeps accruing indefinitely — asserted. |

Because all 1000 genesis charters are created at `t = 0` (§6), the whole cohort's
dormancy clock starts together. At tick 719 no genesis charter is reportable; at
tick 720 — the start of the thirty-first day — every one of them that has not
interacted is. That is the wave this repository exists to study, and it is
asserted directly.

### A pool swap is not a charter interaction

The dormancy clock is a property of the charter. The pool does not know which
charter, if any, a swapper holds, and the whitepaper's rule is about the charter
owner's interaction with *the charter*. `swap` therefore does not reset the
clock. A banker who trades all day and never touches their charter still goes
dormant.

### The 102% problem — [F-01](./findings.md#f-01--the-revocation-split-sums-to-102)

§10 assigns 2% to the informant, 70% to the revocation fee and "the remaining
30%" to the banker. That is 102% of the dormant balance. The section is
over-determined and something has to give. `findings.md` sets out both readings
and why the choice moves the study's headline number; this is what the model
does.

The model funds the bounty out of the 70% fee, before the fee's 50/50 split:

```
bounty        = min(2% * B, 100_000)
revocationFee = 70% * B
bankerShare   = B - revocationFee          // exactly 30%
feePot        = revocationFee - bounty
burned        = 50% * feePot
redistributed = feePot - burned
```

This preserves the two figures the section states most emphatically — the
banker's 30% and the 70% penalty — and treats the bounty as a carve-out from the
protocol's own take rather than an extra levy on the banker. The alternative
reading charges the bounty to the banker's 30% instead; it is selectable as
`config.dormancyBountySource = 'bankerShare'` so the study can measure whether
the choice matters. The randomized sweep runs both.

Either way the split closes exactly:

```
bounty + burned + redistributed + bankerShare === dormantBalance
```

Asserted on every revocation event.

---

## §11 — The fee engine

| Rule | Implementation |
| --- | --- |
| All protocol ETH routes each epoch: 70% to the active vault, 15% to POL, 15% to team. | `closeEpoch`. The vault and POL shares are taken in basis points; **the team takes the remainder**, so the three shares sum to exactly the routed amount with no dust left behind at any size. |
| Active vault = expansion if `F_n > 0`, else contraction. | `closeEpoch`, using the epoch being closed (§4, fast lever). |
| POL: half swapped to $STANDARD, paired, added forever. | `deployPol`. Adding liquidity mints shares; nothing ever burns them. |
| Contraction vault, hourly: `spend_tick = min(0.10 * V, 0.002 * R)`. | `runContractionVault`, where `V` is the vault's ETH and `R` the pool's ETH reserve. |
| Everything bought is burned. | `burnCirculating` in the same call. |
| Unspent balance rolls forward. | The vault is only ever debited by what it spends. |
| The vault can never sell. | There is no code path that sells from it. `contractionStandardHeld` and `contractionStandardSold` are structurally zero and asserted zero every tick. |
| POL never decreases. | `polShares`, `cumulativePolEthAdded` and `cumulativePolStandardAdded` are monotonically non-decreasing, asserted every tick. |

### Why the POL zap leaves a remainder

The zap swaps half the POL budget for $STANDARD, which moves the price, so the
two halves no longer pair at the post-swap ratio. Which side binds depends on
whether the zap paid a trading fee: fee-exempt, the swap returns more
$STANDARD than the remaining ETH can pair with, so the ETH is fully deployed
and tokens are left over; with a fee charged, the token side can bind instead.
`deployPol` handles both, and whatever cannot be paired this epoch is carried
in `pendingPolEth` / `pendingPolStandard` and paired later. Neither is ever
sold: POL only grows.

### The pool

Constant-product ETH ⇄ $STANDARD with a trading fee paid in ETH
(`src/core/pool.ts`). Price impact is real for everyone: buys, sells, the
contraction vault's buybacks and POL additions all move the reserves before the
next action reads them. On a buy the fee is taken off the top and only the
remainder enters the reserve; on a sell the fee is skimmed from the ETH leaving
the reserve. Either way `SwapResult.grossEth` is the amount that crossed the
pool boundary — the quantity §4 measures.

**Protocol swaps are fee-exempt** by default
(`config.protocolSwapsPayFee = false`). Charging the protocol a fee on its own
buyback would route protocol ETH straight back into the protocol's own fee
accumulator for no modelled benefit. The flag is selectable and the sweep runs
both settings.

---

## [study] Random number streams

Nothing in the package calls `Math.random` or `Date.now`. All randomness comes
from xoshiro128\*\*, and — this is the part that matters — **not from a single
sequence**. Every agent gets its own stream, and each distinct kind of decision
gets its own stream within that:

```
stream = xoshiro128**( FNV-1a("<seed>|<agentId>|<purpose>") )
```

`world.rngFor(agentId, purpose)` creates streams on first use and caches them;
`onTick` hands each agent `rngFor(agent.id, 'onTick')`. The world's own
randomness is namespaced the same way: `$world / cohort` for the genesis
archetype shuffle, and the hunter pool's contest draws come from its own agent
stream.

The reason is the paired counterfactual. A single shared generator would mean
that the moment the treatment world takes one draw the control world does not —
a hunter resolving a contest, say — every subsequent draw in that world is
shifted by one, and the two histories diverge everywhere, for reasons that have
nothing to do with revocation. Differences measured against such a control
would be mostly noise. With per-agent streams an extra draw is local to the
agent and purpose that took it.

Agents help by drawing a **fixed number of values per tick** regardless of what
they end up doing — `BankerAgent` takes its rolls at the top of `onTick` and
then branches on them, and `BountyHunterPool` draws once per hunter per hour
whether or not that hunter submits. An agent's stream position therefore
depends only on how many ticks it has lived through.

`study.spec.ts` asserts both halves of this: that treatment and control produce
byte-identical histories when nothing ever goes dormant, and that when they *do*
diverge, an agent unrelated to revocation is still at exactly the same stream
position in both arms.

---

## [study] The genesis cohort

The whitepaper treats the 1000 genesis bankers as one homogeneous set. They are
not, and the difference is the study. Five archetypes, mixed in configurable
proportions that must sum to exactly 10,000 bps:

| Archetype | Behaviour | Default share |
| --- | --- | --- |
| Committed | Checks in reliably, buys a license whenever it pays back inside its horizon, rarely withdraws. | 30% |
| Trader | Active. Withdraws, sells, buys licenses, occasionally retires a branch. Resets its clock as a side effect of acting. | 15% |
| Casual | Irregular. Acts with probability `p` each week, so it can lapse past thirty days and come back. | 25% |
| Tourist | Minted and never returned. Goes dormant on day 30 by construction. | 20% |
| Lost | Keys gone. Never returns, never sells, and its 30% payout sits in the wallet forever. | 10% |

Archetypes are assigned by exact count and then **shuffled across charter ids**
using the `$world / cohort` stream. The shuffle is not cosmetic: charter id
order is the order agents are registered and therefore the order actions are
applied, and the license auction is first come, first served (§8). Laid out in
blocks, the committed cohort would always bid first.

### The branch share is not a parameter

This is the single most important modelling detail in the study, and the model
goes out of its way not to assume it.

Tourists and Lost never buy a license, so on day 30 they are still holding the
one branch they minted with. Committed bankers have been buying licenses for a
month and hold several. The dormant cohort's share of **charters** is therefore
much larger than its share of **branches** — and it is the branch share, not the
charter share, that decides how far `totalBranches` falls, and so how much
everyone else's yield rises.

At the default settings, on the thirty-first day: about 30% of live charters are
reportable, and they hold about 8% of live branches. Nothing sets that 8%. It is
what falls out of the archetypes' behaviour over thirty days.

Both are recorded separately in every snapshot as
`dormantCohort.charterShare` and `dormantCohort.branchShare`, over the charters
that are reportable at that instant.

For sensitivity analysis, and marked clearly as an override,
`config.dormantGenesisBranchesOverride` lets Tourist and Lost charters open with
more than one branch at genesis. It is `null` in the base case.

---

## [study] Bounty hunter economics

§10 says any address may report a dormant charter, and that the informant takes
2% of the dormant balance capped at 100,000 tokens. It does not say what
reporting costs. Once it costs something, three things follow.

**1. There is a profitability floor.** A hunter values the bounty in ETH at the
current pool price and submits only if that clears `gasCostEth × marginRequired`.
Below some dormant balance it never does:

```
requiredEth  = gasCostEth × marginRequired
bountyNeeded = requiredEth / poolPrice
floorTokens  = bountyNeeded / 0.02
```

Charters below it are never reported. They keep their branches, keep accruing,
and dilute every active banker for as long as the protocol runs. The floor is a
first-class metric — `profitabilityFloorTokens`, recomputed every tick as the
price moves — and `ghostsBelowFloor` records how many charters are under it and
how many branches they are holding. Because the floor moves inversely with the
pool price, it rises exactly when a wave has depressed the price and the backlog
is largest.

When the 100,000-token cap makes the threshold unreachable at any balance,
`profitabilityFloorUnreachable` is set and the reported figure is the
hypothetical uncapped requirement, so the series stays continuous.

**2. Hunters compete, and contention raises the gas.** All hunters see the same
ranked list — biggest ghosts first — and each picks a target among the top
`maxReportsPerHour` candidates. When several land on the same charter:

```
gas(c) = gasCostEth × (1 + gasWarEscalationWad × (c − 1))
```

The contender count sets the gas and the gas decides who is still willing, so
the two are solved together by iteration; the group only shrinks, so it
terminates. One submission is included by a seeded draw among the contenders.
**The losers still pay gas.** Gas leaves the model entirely — it is a network
cost, not protocol revenue, so it is not routed by the fee engine.

**3. Throughput is bounded.** `maxReportsPerHour` caps how many reports can
land in one hour, enforced by the world rather than trusted to the agent. With
a synchronized thousand-charter wave, this is what decides whether the backlog
clears in a day or a month.

The hunters are modelled as one pool agent because simultaneity has to be
resolved somewhere — on a real chain the block builder decides which of several
competing reports lands. Each hunter still has its own address and its own ETH
balance and pays its own gas. Reporting remains an explicit agent action:
nothing in `tick()` revokes anything.

---

## [study] Waves

Because every genesis charter is created at `t = 0` (§6) and the clock resets
only on interaction (§10), everyone who never acts becomes reportable **in the
same hour**: tick 720, the start of the thirty-first day. At tick 719 nothing is
reportable; at tick 720 the whole non-interacting cohort is.

Revocations are labelled with a `waveIndex`. A wave is a run of revocations with
no `waveGapHours` silence inside it (default 3 days). The synchronized genesis
cohort produces continuous reporting for as long as bounded hunter throughput
takes to clear it, so it comes out as a single wave — `waveIndex === 1`. The
Casual cohort's later lapses are sporadic and separated by more than the gap, so
each is labelled above it. The analysis reads wave 1 as the genesis wave and
everything above it as the tail.

Per-tick wave instrumentation: `reportableCharters`, `revokedThisTick`,
`branchesDestroyedThisTick`, `cumulativeRevoked`, `waveIndex`, alongside
`branchesOpenedThisTick` and `branchesRetiredThisTick` so that every movement in
`totalBranches` is attributable:

```
totalBranches(t) === totalBranches(t−1) + opened − retired − destroyed
```

`reportableCharters` is measured at the end of the hour, so with hunters running
it is the backlog they have not cleared yet rather than the number that became
reportable.

---

## [study] What happens to the 30% payout

The revocation payout is a real mint into the least committed hands in the
system. What those hands do with it is the mechanism that closes the loop:
payouts get sold, that is negative net flow (§4), which cuts `m` (§5), which
cuts everyone's yield.

A revoked banker sells `payout.sellFractionWad` of the payout, spread evenly
over `payout.sellOverHours`. The Lost cohort never sells, by definition — the
payout sits in its wallet forever, and `study.spec.ts` asserts that a revoked
Lost banker's balance is exactly the sum of everything ever credited to it.

Every sell into the pool carries an **origin**:

| Origin | What it is |
| --- | --- |
| `revocationPayout` | The 30% mint from a revocation, being sold. |
| `retirement` | Proceeds of a branch retirement (§9), being sold. |
| `trader` | Ordinary trading. |

ETH volume is accumulated by origin per tick, per epoch (carried on the
`epochClosed` event) and cumulatively (in the snapshot). That is what lets the
study say how much of a post-day-31 issuance cut traces back to revocation
payouts specifically rather than to ordinary selling.

---

## [study] Outside demand

Not a whitepaper concept and not part of the protocol: it is the rest of the
market. `config.externalDemand` registers a few mildly buy-biased traders.

They exist because without them the only flow through the pool is bankers
selling what they withdraw, `F_n` is negative in every epoch, `m` pins to `mMin`
on the second day and stays there — and a study about what a revocation wave
does to issuance has nothing left to measure. With them the multiplier sits in
the interior of its clamp when the wave arrives and has room to move.

This is the parameter that most directly sets how much room the counterfactual
has, and it should be the first thing a sensitivity sweep varies.

---

## [study] The paired counterfactual

`runPaired(config, seed)` builds two worlds from the same config and seed. The
treatment world is as configured. The control world differs in exactly one
setting — `revocationEnabled: false` — which makes `isReportable` return false
for every charter, so dormant charters are never reported, keep their branches
and keep accruing. `runPaired` refuses a config whose treatment arm already has
revocation disabled, and the arms are asserted to be identical in every other
config field.

Every result in the study is then a difference against a matched control rather
than a comparison across configurations. The soundness of that rests entirely on
the RNG streams staying aligned, which is why they are per-agent — see
[Random number streams](#study-random-number-streams) above.

---

## Where the whitepaper is silent

Every one of these is a **REDACTED** entry in
`packages/protocol/src/config/defaults.ts`, with the default and the full
reasoning at the definition. None of them is hardcoded anywhere else in the
package.

| Parameter | Default | One-line reason |
| --- | --- | --- |
| `epochDays` | 1 | Every other cadence in the document is daily. |
| `baseRatePerDayTokens` | 500_000 | Makes the 900e6 budget last ~4.9 years at `m = 1`, so day 31 sits deep inside the issuance regime. |
| `multiplierInitWad` | 1.0 | The only neutral start; makes `baseRatePerDay` mean what its name says on day one. |
| `multiplierMinWad` | 0.25 | A floor of zero would zero out branch yield, which zeroes the license floor price (§7) and collapses the auction. |
| `multiplierMaxWad` | 4.0 | Symmetric with the floor on a log scale. |
| `multiplierRaiseStepWad` | +0.01 | ~300 epochs from 1.0 to the ceiling. |
| `multiplierCutStepWad` | −0.03 | 3:1 against the raise step: sustained outflow unwinds three epochs of expansion per epoch. |
| `poolInitialEth` | 2_000 ETH | Opens spot at 50_000 $STANDARD/ETH and gives enough depth that price impact comes from cohorts, not individuals. |
| `tradingFeeBps` | 30 | The constant-product convention. |
| `protocolSwapsPayFee` | false | Avoids routing protocol ETH back into the protocol's own fee accumulator. |
| `countProtocolSwapsInNetFlow` | false | Stops the contraction vault manufacturing a positive `F_n`. |
| `licenseCurveFixedAtDayOpen` | true | `P_floor` moves with `m` and `totalBranches`; a revocation wave would otherwise make the "falling" auction jump upward mid-day. |
| `pFloorDenominatorTokens` | 1e6 | Two days of base issuance: binds only when the bank is genuinely drained, inert otherwise. |
| `feeFloorWad` | 1% | The resting cost of leaving the bank: a real friction, not a lock. |
| `feeCeilingWad` | 35% | Must bite during a run but stay under §10's 70%, or a dormant banker would rather be revoked than withdraw. |
| `pSaturationWad` | 0.5 | The point at which a week of withdrawals equals everything still at the bank. |
| `dormancyBountySource` | `revocationFee` | Resolves §10's 102%. See above. |
| `expansionVaultPolicy` | `hold` | §11 gives a spend rule for the contraction vault and none for the expansion vault; rather than invent one, it accumulates and reports. |
| `ownerIdPrefix` | `banker` | Owner addresses are opaque ids; only stability across runs matters. |
| `genesisWalletEth` | 10 ETH | Enough to buy a license at plausible prices; not enough to move the pool alone. |
| `genesisWalletStandard` | 0 | Every token a banker holds must be withdrawn (§9) or bought — which is the point of the study. |
| `cohortMixBps` | 30/15/25/20/10 | A deliberately unflattering but not catastrophic reading of a genesis mint. The 20% Tourist share is what the results are most sensitive to, and the first thing a chain-history study should replace. |
| `committed.*` | 5-day check-in, 45-day payback horizon | The interval is comfortably inside the 30-day clock. The horizon is what makes committed expansion level off as the yield dilutes, instead of running to the 10-branch cap on day one. |
| `trader.*`, `casual.*` | see `defaults.ts` | A 55% weekly action probability gives Casual a mean gap near 1.8 weeks and a tail past 30 days often enough to produce a real secondary wave. |
| `payout.sellFractionWad` / `sellOverHours` | 70% over 7 days | The assumption that a wallet quiet for a month, handed liquid tokens by a stranger's transaction, is mostly a seller. |
| `hunter.gasCostEth` | 0.002 ETH | A plausible cost for one report. This and the pool price are what set the profitability floor. |
| `hunter.marginRequired` | 2 | What a searcher running an inventory of targets would want before spending gas. Quantised to six decimals on the way into state. |
| `hunter.scanLatencyHours` | 6 | Hunters poll; they do not watch every block. |
| `hunter.count` | 5 | Enough that contests are routine rather than exceptional. |
| `hunter.gasWarEscalationWad` | 0.4 | Five contenders each pay 2.6x base — a contested hour is a gas auction. |
| `hunter.maxReportsPerHour` | 4 | The throughput bound. Against a synchronized 1000-charter wave this is what decides whether the backlog clears in a day or a month. |
| `externalDemand.*` | 6 traders, 55/45 buy bias | See [Outside demand](#study-outside-demand). Without it `m` pins to its floor and the study has nothing to measure. |
| `waveGapHours` | 3 days | Long enough that the genesis wave is one label, short enough that the Casual tail is separated from it. |
| `dormantGenesisBranchesOverride` | `null` | A **sensitivity override**, off in the base case. The dormant cohort's branch share is meant to emerge from behaviour, not be set. |

---

## Out of scope in this package

* **Charter auctions.** §6 states the daily count starts at zero, so only the
  1000 genesis charters exist. `state.nextCharterId` is reserved and unused.
* **The expansion vault's deployment strategy.** It accumulates and is reported
  every tick; a later prompt can give it a policy without touching any of the
  accounting here.
* **Gas, except for reports.** Only `submitReport` costs gas. Withdrawing,
  checking in, buying a license and swapping are all free, which flatters the
  Committed and Trader archetypes and understates how much friction a real
  banker faces.
* **Hunter treasury management.** Hunters hold the $STANDARD they are paid and
  never sell it, so their bounties add no sell pressure. They also never top up
  their ETH, so a long enough run will eventually price them out.
* **The expansion vault's deployment strategy.** It accumulates and is reported
  every tick; a later prompt can give it a policy without touching any of the
  accounting here.
* **Charter auctions.** §6 states the daily count starts at zero, so only the
  1000 genesis charters exist.
* **The Monte Carlo runner, charts and UI.**
