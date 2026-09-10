# Findings

Places where building an executable model of The Standard Reserve required a
decision the whitepaper does not make.

Each entry says what the ambiguity is, quotes or paraphrases the text it comes
from, explains why it changes results rather than just wording, and states what
the model does about it. Where a finding is genuinely two readings rather than
an error, both readings are implemented and selectable, so the study can report
the difference instead of asserting one is correct.

None of these are objections to the design. They are the questions that could
not be left open once the rules had to run.

**Index**

| Id | Section | Claim |
| --- | --- | --- |
| [F-01](#f-01--the-revocation-split-sums-to-102) | §10 | The revocation split sums to 102% of the dormant balance. |
| [F-02](#f-02--the-two-p_start-rules-disagree-after-a-revocation-wave) | §7 | The two `P_start` rules can disagree once branches are destroyed, and the falling-price auction would then rise. |
| [F-03](#f-03--the-daily-license-supply-is-unspecified-and-it-bounds-the-answer) | §8 | The daily license supply is unspecified, and it bounds how violent the dormancy wave is. |
| [F-04](#f-04--is-cutstep--raisestep-a-protocol-rule-or-a-default) | §5 | "cutStep > raiseStep by design" — a protocol rule, or the intended default? |
| [F-05](#f-05--does-one-charter-per-wallet-survive-the-transfer-switch) | §6, §12 | Whether one-charter-per-wallet survives transferability, and what accumulation would mean. |
| [F-06](#f-06--a-seat-sale-is-capital-entering-the-economy-that-the-flow-signal-cannot-see) | §2, §12 | A seat sale moves ETH into the economy without touching the pool, so the flow signal never sees it. |

---

## F-01 — The revocation split sums to 102%

**Claim.** Section 10 assigns 102% of a dormant charter's accrued balance:
2% to the informant, 70% to the revocation fee, and "the remaining 30%" to the
dormant banker. Two of those three figures can hold; not all three.

**The text.** Section 10 describes what happens when a dormant charter is
reported:

- "informant bounty = 2% of the dormant accrued balance, capped at 100,000
  tokens"
- "the dormant banker pays a 70% revocation fee: half burned, half credited pro
  rata to the accrued balances of all still-active branches"
- "the remaining 30% is MINTED to the dormant banker's wallet"

2 + 70 + 30 = 102.

**Why it matters.** This is not a rounding question. The three quantities have
different destinations, and which one absorbs the 2% changes different things:

- Charged to the **revocation fee**, the informant is paid out of the
  protocol's own take. The banker still receives exactly 30%, and the amounts
  burned and redistributed each fall by 1% of the dormant balance. Less supply
  is destroyed, and surviving branches receive slightly less.
- Charged to the **banker's share**, the informant is paid by the banker. The
  banker receives 28%, and the burn and the redistribution are untouched.

On a single revocation the difference is 2% of one balance. Across a
synchronized wave of several hundred charters it is a systematic difference in
how much supply is burned versus minted into wallets — and the minted portion
is the part that can be sold, which is the channel by which a revocation wave
turns into negative net flow, a lower multiplier, and lower yield for everyone
who stayed. It is exactly the quantity this study is trying to measure, so it
cannot be left as a rounding difference.

There is a third reading — that the informant's 2% is paid from somewhere
outside the dormant balance entirely — but nothing in section 10 suggests a
source, so the model does not implement it.

**What the model does.** The default is to fund the bounty from the 70%
revocation fee, before that fee's 50/50 split:

```
bounty        = min(2% × B, 100,000)
revocationFee = 70% × B
bankerShare   = B − revocationFee            // exactly 30%
feePot        = revocationFee − bounty
burned        = 50% × feePot
redistributed = feePot − burned
```

This preserves the two figures section 10 states most emphatically — the 70%
penalty and the banker's 30% — and treats the bounty as a carve-out from the
protocol's take rather than an extra levy on the banker.

The alternative reading is selectable as
`config.dormancyBountySource = 'bankerShare'`, which charges the bounty to the
30% instead and leaves the fee whole. The randomized invariant sweep runs both.

Under either setting the split closes exactly, with no wei unaccounted for:

```
bounty + burned + redistributed + bankerShare === dormantBalance
```

That identity is asserted on every revocation event in every scenario
(`invariants.spec.ts`), and the two readings are asserted separately in
`study.spec.ts` — 30% under the default, 28% under the alternative.

**What would settle it.** A statement of which of the three percentages is the
residual. If the intent is that the informant is paid by the protocol, the
banker's 30% is right and the fee is effectively 68% net. If the intent is that
the banker funds the whole penalty, "the remaining 30%" should read 28%.

---

## F-02 — The two `P_start` rules disagree after a revocation wave

**Claim.** Section 7 gives two rules for the opening price of the daily
license auction. After branches are destroyed, they can disagree in a way that
makes the falling-price auction ascend.

**The text.** Section 7 defines the auction as

```
P(t)    = P_start × (P_floor / P_start) ^ (t / 24h)
P_start = 2 × P_last          where P_last is the lowest price that sold yesterday
P_start = 2 × P_floor         if nothing sold yesterday
P_floor = licenseFloorDays × (baseRatePerDay × m / totalBranches)
```

**Why it matters.** `P_last` is bounded below by *yesterday's* floor — that is
the lowest the auction could have gone. But the floor is a function of `m` and
`totalBranches`, and `totalBranches` falls when charters are revoked
(section 10). Destroying branches raises the floor overnight.

So a day can open with `2 × P_last` sitting below today's `P_floor`. The decay
ratio `P_floor / P_start` is then greater than 1, and `P(t)` increases through
the day: the falling-price auction runs backwards. Every hour, a license costs
more than it did the hour before, and the auction never reaches its floor
because it started underneath it.

This is not a corner case that only a fuzzer finds. It is reachable precisely
in the scenario this repository exists to study. A synchronized dormancy wave
destroys branches over a small number of days; each of those days lifts the
floor while `P_last` reflects a market that had more branches in it. In the
default configuration a wave of ~300 charters out of 1,000 removes roughly 8%
of live branches, which lifts the floor by about the same proportion, and
`P_last` on a quiet day can be within 2x of the floor. The two are close enough
to cross.

It is worth being clear about the scope: away from mass revocation,
`totalBranches` only grows (licenses are bought far more often than branches
are retired), so the floor drifts *down* and the two rules never conflict. This
is a revocation-only pathology, which is likely why it has not surfaced.

**What the model does.** It anchors `P_start` on whichever of the two is
higher:

```
P_start = 2 × max(P_last, P_floor)
```

This reduces to each stated rule whenever they agree: if `P_last ≥ P_floor` it
is `2 × P_last`, and if nothing sold — where `P_last` is undefined — it is
`2 × P_floor`. It guarantees a decay ratio of at most 1/2, so the auction falls
strictly every hour of every day and always ends above its floor.

The model also fixes `P_start` and `P_floor` when the day opens rather than
recomputing them hourly (`config.licenseCurveFixedAtDayOpen`, default true).
Without that, a revocation landing at 14:00 would raise the quoted price
mid-afternoon even with the anchor rule in place. Both properties — strictly
decreasing within the day, never below the floor — are asserted after every
tick of every scenario, and over 200 randomised curves in `invariants.spec.ts`.

**What would settle it.** A statement of what the auction should do on a day
when yesterday's clearing price is below today's floor. The model's answer is
one reasonable one; another would be to clamp `P_floor` so it can never rise
above `P_last`, which would keep the auction falling but let the floor stop
tracking one branch's yield during exactly the period when that yield is
changing fastest. A third would be to compute the floor from the branch count
as it stood at the start of the previous day. These differ in how quickly the
license price responds to a revocation wave, which is a real economic choice
and probably belongs in the whitepaper rather than in an implementation.

---

## F-03 — The daily license supply is unspecified, and it bounds the answer

**Claim.** Whitepaper §8 sets the license auction's daily inventory without
giving a number, and that number turns out to bound the answer to the question
this study exists to ask.

**The text.** §8 describes the allocation rules — first come, first served at
the current price, no bids, no refunds, unsold inventory never rolls over, at
most three per charter per day, at most ten branches per charter — and states
the daily count as a default of 100. §7 defines the price. Neither section
explains where 100 comes from or what it is trading off.

**Why it matters.** The dormancy question is: when the first synchronized wave
of revocations lands on day 31, how far does the branch count fall, and so how
much does every surviving branch's yield rise?

The answer depends almost entirely on how many branches the dormant cohort is
holding when the wave arrives, and that is not a free parameter — it emerges.
Charters that never buy a license still hold the single branch they minted
with. Charters that do buy expand. So the dormant cohort's share of *branches*
drifts below its share of *charters* over the thirty days before the wave, and
it is the branch share that determines the size of the shock.

How fast that drift happens is set by exactly two numbers: `licensesPerDay` and
`maxLicensesPerCharterPerDay`. At the defaults, the whole active cohort can add
at most 100 branches a day and no charter can add more than three. Over thirty
days that is a hard ceiling of 3,000 new branches against 1,000 genesis ones —
and in practice fewer, because the auction's falling price and the payback
horizon mean many days do not clear.

The measured consequence at the default parameterisation: on day 31 the dormant
cohort is about 30% of live charters and about 8% of live branches. The wave
destroys roughly 30% of charters and roughly 8% of `N`. Had the auction been
uncapped, the dormant share of branches would be smaller still and the wave
correspondingly gentler; had it been much tighter, the two shares would be
closer together and the shock much larger.

In other words, a parameter the whitepaper leaves open is the main determinant
of how violent the protocol's own dormancy rule is. That is not an error — it
is a design degree of freedom — but it should be a stated one, because it reads
at present as an incidental default.

**What the model does.** It treats `licensesPerDay` as a first-class axis of
the study rather than a default, sweeping 25, 50, 100, 200, 400 and effectively
unlimited, with `maxLicensesPerCharterPerDay` swept alongside it at 1, 3, 5 and
10. Both shares are recorded separately in every snapshot as
`dormantCohort.charterShare` and `dormantCohort.branchShare`, so the mechanism
is visible rather than inferred, and nothing in the model ever sets the branch
share directly. A clearly-marked sensitivity override,
`dormantGenesisBranchesOverride`, exists to test how much the results move with
that share, and is `null` in the base case.

**What would settle it.** A statement of what the daily license count is for.
If it is a throughput or congestion limit, it should be expressed against the
thing being limited. If it is a dilution control — a deliberate cap on how fast
the branch base can grow — then it interacts with §10 in a way worth saying out
loud, because it is what decides whether the thirty-first day is a tremor or a
step change.

---

## F-04 — Is `cutStep > raiseStep` a protocol rule or a default?

**Claim.** §5 says the multiplier's down-step exceeds its up-step "by design",
which can be read as a constraint the protocol enforces or as a description of
the intended parameterisation. The two readings differ in whether the symmetric
case is a configuration or a bug.

**The text.** §5 gives the policy rule

```
m_{n+1} = clamp(m_n + (signal_n > 0 ? raiseStep : −cutStep), mMin, mMax)
```

and adds that `cutStep > raiseStep` by design, with both configurable.

**Why it matters.** This is a smaller point than F-01 or F-03, and it surfaced
only because the study needed the symmetric case.

The asymmetry has a consequence §5 does not discuss. Under flow that is
directionless but volatile — a fair coin on the sign of `F_n`, epoch after
epoch — the multiplier does not stay put. Up-steps and down-steps arrive in
equal numbers, but the down-steps are three times larger at the default
parameterisation, so `m` ratchets downward under pure noise. Issuance falls in
a market that did nothing.

Whether that is intended matters, and the way to find out is to run the same
choppy market with the asymmetry removed and difference the two. That requires
`cutStep == raiseStep`, which the first version of this model rejected at
config validation, having read "by design" as a rule.

**What the model does.** Reads it as a statement about the intended
parameterisation rather than a protocol constraint, and admits the symmetric
case. `validateConfig` now requires only `cutStep >= raiseStep`; the default
configuration still has the strict inequality, and a test asserts that it does.
The study sweeps `cutRaiseRatio` at 1:1, 2:1, 3:1 and 5:1, with 1:1 present
specifically as the control for whether the asymmetry is what produces the
ratchet under the `chop` demand regime.

**What would settle it.** A sentence saying whether a deployment is permitted
to configure a symmetric policy. If it is not, the constraint belongs in the
protocol's own validation and the study's 1:1 cells are hypothetical. If it is,
the ratchet under directionless volatility is a property worth documenting next
to the rule that produces it.

---

## F-05 — Does one-charter-per-wallet survive the transfer switch?

**Claim.** Whitepaper §6 limits genesis to one charter per wallet. §12 lets
charters be transferred. The text does not say whether the limit applies after
a transfer, and the two readings produce different protocols.

**The text.** §6 describes the genesis mint as one charter per wallet. §12
describes the one-way switch and what it enables: "selling a charter becomes a
second exit path: the seat moves whole, branches and balance included. A seat
sale is an exit with zero sell pressure on $STANDARD; the buyer replaces the
seller one for one."

"The buyer replaces the seller one for one" is about the seat, not obviously
about the buyer's holdings. Nothing in either section says whether a wallet
that already holds a charter may buy another.

**Why it matters.** A branch is a claim on a fixed pro-rata share of every
epoch's issuance (§6). If seats can be accumulated, issuance concentrates —
and unlike the license auction, which caps a charter at three purchases a day
and ten branches in total (§8), the seat market has no cap of its own. The
per-charter limits stop one *charter* growing without bound; they say nothing
about one *wallet* holding many charters.

The mechanism is worth being concrete about. The dormancy wave puts a large
number of seats on the market at once, at prices set by a seller's alternative
of losing 70% (§10). Those are distressed prices. A buyer with capital during
that window is buying issuance claims cheaply, in volume, from people whose
alternative is worse. Whether the protocol permits that is a governance
question that the transfer switch quietly answers by default, and the answer
depends on a limit nobody has said applies.

The two readings also differ in what the switch is *for*. Read with the limit,
transferability is a liquidity feature: it gives a leaving banker a better exit
and hands the seat to someone new. Read without it, transferability is also a
consolidation mechanism.

**What the model does.** Implements both, behind
`config.postTransferCharterLimit`:

- `1` — a wallet holds at most one charter, ever. This is the **default**, as
  the conservative reading: it changes nothing about §6's invariant, and it
  means the study's base case does not assume a permission the whitepaper
  never granted.
- `Infinity` — seats can be accumulated without limit.

When accumulation is allowed the model measures what happens to it:
`largestHolderBranchShare` and `concentrationHHI`, a Herfindahl index over
branch ownership, are recorded in every snapshot. Both are reported as zero —
not computed — while charters are soulbound, because ownership is then one
charter per wallet by construction and a full scan every tick would cost every
non-transfer cell something for a known answer.

`postTransferCharterLimit` is an axis of the study, held at a switch day of 15
so that the limit is measuring something rather than sitting inert.

**What would settle it.** A sentence in §12 saying whether §6's limit is a
genesis-allocation rule or a standing invariant. If it is standing, the
protocol needs to enforce it on transfer, which is a real constraint on the
contract and not only on the mint. If it is not, the concentration dynamics of
a distressed seat market during a revocation wave deserve their own paragraph.

---

## F-06 — A seat sale is capital entering the economy that the flow signal cannot see

**Claim.** Whitepaper §2 says "There is exactly one place ETH enters or leaves
this economy: through trading." §12's transfer switch creates a second place.
This is a consequence of the switch, not a flaw in it — but it is a
consequence that nothing in the document notes, and the monetary policy in §5
is built on the assumption that §2 holds.

**The text.** §2 states the single-entry property. §4 defines the net flow
signal as `F_n = gross ETH in from buys − gross ETH out from sells, measured at
the pool`, and §5 drives the issuance multiplier from it. §12 says a seat sale
is "an exit with zero sell pressure on $STANDARD".

That last phrase is exactly right, and it is the whole point of the feature. A
banker who retires and sells has to push their balance through the pool; a
banker who sells their seat does not. The pool is untouched.

But the ETH the buyer pays is not nothing. It is new capital, coming from
outside, buying a claim on future issuance. It goes wallet to wallet. It never
crosses the pool boundary, so `F_n` never counts it — and `F_n` is the only
thing the protocol uses to decide whether the economy is expanding or
contracting.

**Why it matters.** The signal is a proxy for demand. While charters are
soulbound the proxy is exact, because §2 holds: every wei of interest in the
protocol has to arrive through the pool, so measuring the pool measures
everything. Once seats are transferable, demand for a claim on issuance has a
second route in, and the proxy becomes partial. A protocol can be attracting
substantial new capital and cutting its own issuance at the same time, because
the capital arrived somewhere it was not looking.

**How large.** The model tracks it as its own series, `seatMarketEthVolume`,
alongside `ethVolumeByOrigin`. On one 45-day run at the whitepaper defaults
with the switch thrown on day 15 (`pnpm tsx packages/study/scripts/first-look.ts 15 1000000 45`):

| | |
| --- | --- |
| Seat market volume, cumulative | **206.7 ETH** |
| All sell-side pool volume `F_n` did see | 748.7 ETH |
| The blind spot as a share of it | **27.6%** |
| The blind spot as a share of the pool's own ETH reserve | **7.9%** |

Rather more than a rounding error, and it arrives concentrated in the days
around the wave, which is exactly when the multiplier is moving fastest. It is
also, in that run, directionally *opposed* to what the signal was reading: the
seat market was absorbing sellers who would otherwise have pushed 30% payouts
through the pool, so the signal saw less selling than the soulbound arm and
`m` finished 0.16 higher — while a further 206.7 ETH of genuine buying interest
went entirely unrecorded.

One seed is one seed. The size of the blind spot is an axis of the study, not a
number to quote as settled; what is settled is that it exists and is not small.

**What the model does.** Records it separately and never folds it into `F_n`,
because folding it in would be inventing a protocol rule. `F_n` in the model
sees exactly what §4 says it sees: gross ETH crossing the pool. A seat sale
moves ETH directly between two wallets, pays no trading fee, and never reaches
the fee engine — asserted, against an identical world that did not sell, in
`seats.spec.ts` and in
`pnpm tsx packages/study/scripts/seat-sale.ts`.

**What would settle it.** A decision about whether §2's single-entry property
is a description or a requirement. If it is a description, §2 needs a caveat
once §12 is live. If it is a requirement — if the policy in §5 depends on
seeing all capital flow — then either seat sales need to route through the pool
(which would destroy the zero-sell-pressure property that makes them
attractive) or the signal needs a second input. That is a design choice with
real trade-offs, and it should be made deliberately rather than inherited from
the order in which two sections were written.
