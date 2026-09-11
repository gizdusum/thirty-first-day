import type { ReactNode } from 'react'

import {
  BranchesChart,
  LicensesChart,
  MultiplierChart,
  YieldChart,
  type Exemplar,
  type LicenseLevel,
} from '../components/charts'
import exemplarData from '../data/exemplar.json'
import licensesData from '../data/licenses.json'

const REPO = 'https://github.com/thirty-first-day/thirty-first-day'
const exemplar = exemplarData as unknown as Exemplar & { replay: string; cellId: string; seed: number }
const licenses = (licensesData as { levels: LicenseLevel[] }).levels

function Replay({ children }: { children: ReactNode }) {
  return <p className="replay">{children}</p>
}

export default function Page() {
  return (
    <main className="page">
      <header className="masthead">
        <p className="dateline">An independent study &middot; 11 September 2026</p>
        <h1>The Thirty-First Day</h1>
        <p className="subtitle">
          An independent study of what happens to The Standard Reserve when its first wave of
          dormant genesis bankers is revoked.
        </p>
      </header>

      <div className="standfirst">
        <p>
          This is an unofficial study. It is not affiliated with, commissioned by, or endorsed by
          The Standard Reserve. It is a deterministic model of the protocol as the whitepaper
          describes it, run as a Monte Carlo experiment against a matched control, and everything
          on this page is reproducible from{' '}
          <a href={REPO}>the repository</a> in one command. The method is in{' '}
          <a href={`${REPO}/blob/main/docs/mechanics.md`}>mechanics.md</a>, the experimental design
          in <a href={`${REPO}/blob/main/docs/experimental-design.md`}>experimental-design.md</a>,
          and the six places the whitepaper had to be interpreted in{' '}
          <a href={`${REPO}/blob/main/docs/findings.md`}>findings.md</a>. Where a result is null, it
          is reported as a null.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">1</span>Why the thirty-first day
      </h2>
      <p>
        A thousand Genesis Charters mint in the same hour. They are soulbound at launch (&sect;6),
        so there is no exit by sale. The dormancy clock resets only on interaction, and after thirty
        days without one a charter becomes reportable by any address (&sect;10).
      </p>
      <p>
        Those two facts compose into a third that neither section states. Because every charter
        starts its clock at the same instant, everyone who never acts becomes reportable{' '}
        <em>within the same hour</em>. This is not a trickle of abandoned accounts discovered one by
        one. It is a single synchronized event, and it has a date.
      </p>
      <p>
        In the model, at tick 719 no genesis charter is reportable. At tick 720 every one that has
        not interacted is. At the whitepaper defaults that is about 30% of live charters, arriving
        at once.
      </p>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">2</span>Finding one &mdash; the bank cannot see it
      </h2>

      <div className="pull">
        <div className="figure">0.0000</div>
        <div className="caption">
          Change in the issuance multiplier on day 31, treatment against control. Exactly zero, in
          all 200 seeds, with zero variance.
        </div>
      </div>

      <p>
        This is not a statistical result and it does not need a confidence interval. It follows from
        the rule. &sect;4 sets <code>signal(n) = F(n&minus;1) + F(n&minus;2)</code> &mdash; the policy signal for an
        epoch is the net flow of the <em>two preceding</em> epochs.
        The first revocations land six hours into day 30. The epoch that closes as the wave arrives
        is still reading flow from two epochs earlier, both of them entirely pre-wave. The
        multiplier cannot move in response until two epoch closes later.
      </p>
      <p>
        <strong>Two epochs, not two days.</strong> The whitepaper indexes policy by epoch{' '}
        <code>n</code> and never states how long an epoch is. The model assumes one day, because
        every other cadence in the document is daily &mdash; the auction, the dormancy clock, the
        base issuance rate. If an epoch is six hours the blind window is half a day; if it is three
        days the protocol is blind for most of a week while several hundred charters are revoked.
        How long the bank is actually blind for is set by a number only the team has. That is the
        first of three places this study can do no more than hand a question back.
      </p>

      <figure>
        <MultiplierChart data={exemplar} />
        <figcaption>
          The issuance multiplier, treatment against control, one exemplar seed. The shaded band is
          the two-epoch window in which the policy signal is still reading pre-wave flow. The paths
          are identical through it, by construction.
        </figcaption>
        <Replay>{exemplar.replay}</Replay>
      </figure>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">3</span>Finding two &mdash; the survivors get a bigger share of a
        smaller issue
      </h2>
      <p>Two effects, both clear of zero, pointing in opposite directions.</p>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th className="wrap">Metric, treatment &minus; control</th>
              <th>Mean</th>
              <th>95% CI</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="wrap">Yield per branch per day, at day 45</td>
              <td>+8.73</td>
              <td>[+7.43, +9.98]</td>
            </tr>
            <tr>
              <td className="wrap">Issuance multiplier, integrated over days 31&ndash;90</td>
              <td>&minus;1.451</td>
              <td>[&minus;1.974, &minus;0.922]</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        Every surviving branch earns 6.1% more at day 45 &mdash; the control level is 143.0 tokens
        per branch per day. But the protocol issues <em>less in total</em> over the window: the
        multiplier integral falls by 1.45 multiplier-days. Fewer branches raise the per-branch
        share; the revocation payouts being sold push net flow negative, which cuts the multiplier,
        which shrinks what is being shared.
      </p>

      <h3>How much of the cut is the payouts</h3>
      <p>
        &sect;10 mints 30% of a revoked balance into the dormant banker&rsquo;s wallet. Some of it
        gets sold. To separate &ldquo;the multiplier fell after day 31&rdquo; from &ldquo;the
        multiplier fell <em>because of</em> payout selling&rdquo;, the study runs a third arm that
        is identical to the treatment in every respect except that the payout is minted and never
        reaches the pool. The difference between the treatment and that arm is the part of the cut
        that payout selling caused; the rest is everything else revocation does.
      </p>
      <p>
        It comes to <strong>31.9%</strong>, CI [14.8%, 48.3%], over the 171 of 200 seeds in which
        the multiplier fell at all. Wide, but clear of both zero and one: neither &ldquo;payout
        selling is the whole story&rdquo; nor &ldquo;payout selling is irrelevant&rdquo; survives.
        Across suite B the figure moves with how much of the payout actually reaches the pool
        &mdash; 0% when the sell fraction is zero, 8.4% at a half, 32.5% at one. A dose-response
        that lands on zero when the dose is zero is the best evidence available that the arm
        measures what it claims to.
      </p>

      <div className="note">
        <p>
          <strong>Robustness.</strong> Across 40 cells and 2,000 runs varying twelve factors, no
          axis moves the multiplier integral by even one noise band. The direction of this result
          survived everything we varied. It is also, for the same reason, a result whose{' '}
          <em>size</em> we cannot pin down from a single run &mdash; see section 7.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">4</span>Finding three &mdash; and the advantage does not last
      </h2>

      <div className="pull">
        <div className="figure">+1.39</div>
        <div className="caption">
          Yield per branch per day at day 90, treatment against control. CI [&minus;0.44, +3.17]
          &mdash; null.
        </div>
      </div>

      <p>
        The day-45 advantage is gone by day 90. The licence auction keeps selling, the branch base
        refills, and the survivors&rsquo; edge is competed away in about two months. Both arms end
        the window with <em>more</em> branches than they had at day 45: the wave is a step down in a
        rising series, not a collapse.
      </p>
      <p>
        This contradicts the intuitive reading, and the contradiction is worth sitting with.
        Destroying a third of the charters sounds as though it should permanently concentrate
        issuance among those who remain. It does not, and the reason is that the dormant cohort was
        never holding a third of the issuance. On day 31 they are about 30% of live charters and{' '}
        <strong>8.2% of live branches.</strong>
      </p>
      <p>
        Nothing in the model sets that 8.2%. It emerges: a branch is bought at the daily licence
        auction (&sect;7), and charters that never interact never buy one. Thirty days of committed
        bankers expanding, and tourists not, is what produces it. The wave destroys a large share of
        the <em>charters</em> and a small share of the <em>claims on issuance</em>.
      </p>

      <figure>
        <YieldChart data={exemplar} />
        <figcaption>
          Yield per branch per day. The treatment line runs above the control from the wave until
          about day 72, and the two are indistinguishable by day 90.
        </figcaption>
        <Replay>{exemplar.replay}</Replay>
      </figure>

      <figure>
        <BranchesChart data={exemplar} />
        <figcaption>
          Live branches. The step down at day 31 is the wave; the slope after it is the auction
          refilling the base. Both arms are still growing at day 90.
        </figcaption>
        <Replay>{exemplar.replay}</Replay>
      </figure>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">5</span>Finding four &mdash; all of it scales with a number that is
        not published
      </h2>
      <p>
        The daily licence supply is <code>REDACTED</code> in the whitepaper. It turns out to be the
        binding constraint on the whole question, because it caps how fast the active cohort can
        dilute the dormant one in the thirty days before the wave lands. Tighten it and the dormant
        cohort holds a larger share of branches when the clock runs out; loosen it and they hold
        less.
      </p>
      <p>
        Across its range it swings the supply minted into wallets by <strong>2.7x</strong> &mdash;
        from 3.13 million tokens at 25 licences a day to 1.16 million at 400. The effect on day-45
        yield is larger still at the tight end and then flattens: 35.2 tokens per branch per day at
        25 licences, 15.6 at 50, and between 7.7 and 10.0 at every setting from 100 upward, where
        the differences are inside the noise band. It is not a smooth dial. It is a steep region
        below the default and a flat one above it.
      </p>

      <figure>
        <LicensesChart levels={licenses} />
        <figcaption>
          Day-45 yield delta by daily licence supply, 50 seeds per level. Bars are the mean; the
          grey band is the 95% confidence interval. The whitepaper default is 100.
        </figcaption>
        <Replay>pnpm study report ofat</Replay>
      </figure>

      <h3>The gas cliff</h3>
      <p>
        Reporting a dormant charter costs gas, and the informant takes 2% of the dormant balance
        capped at 100,000 tokens (&sect;10). Below some balance the bounty does not cover the
        transaction. The study locates that boundary numerically for each cell rather than assuming
        it &mdash; for the baseline, the median ghost breaks even at a gas price of 0.0033 ETH per
        report.
      </p>
      <p>
        What it found on either side is not a gradient.
      </p>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Gas, relative to the boundary</th>
              <th>Supply minted, delta</th>
              <th>Wave cleared</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>0x &ndash; 0.5x</td>
              <td>1.635e6</td>
              <td>day 35.0</td>
            </tr>
            <tr>
              <td>1x</td>
              <td>1.647e6</td>
              <td>day 35.3</td>
            </tr>
            <tr>
              <td>2x</td>
              <td>0</td>
              <td>never</td>
            </tr>
            <tr>
              <td>4x</td>
              <td>0</td>
              <td>never</td>
            </tr>
            <tr>
              <td>8x</td>
              <td>0</td>
              <td>never</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        Between one and two times the boundary, the wave goes from fully collected in five days to
        never collected at all &mdash; zero revocations, in all fifty seeds. There is no partial
        regime in between. A protocol whose reporting costs drift up by a factor of two does not get
        a slower cleanup. It gets none, and every dormant charter dilutes every active one
        indefinitely.
      </p>

      <h3>And a loop that runs backwards</h3>
      <p>
        Loosening the licence auction to dampen the wave makes <em>more</em> ghosts uncollectable,
        not fewer. More licences means more branches; more branches means lower yield per branch;
        lower yield means smaller dormant balances by day 31; smaller balances mean a 2% bounty that
        no longer covers gas. At 25 to 100 licences a day the model leaves nothing uncollected; at
        400 and above it leaves a residue. The two unpublished parameters interact, and not in the
        same direction.
      </p>

      <h3>Where an L2 puts you</h3>
      <p>
        The Genesis Charter mint is announced for 14 September on Robinhood Chain. That matters here
        for exactly one thing. The 0.002 ETH default this study uses for a report is a mainnet
        figure; transaction fees on an L2 sit far below the 0.0033 ETH boundary the baseline
        calibrates to. <strong>At launch the profitability floor does not bind.</strong> The
        collected regime in the table above is the one that applies, and the dormancy mechanism
        should work as &sect;10 intends.
      </p>
      <p>
        Two caveats, because it is a cliff and not a slope. The boundary is not a property of the
        chain alone: it is{' '}
        <code>bounty &times; price / margin</code>, so a fall in the token price lowers it in ETH
        terms and moves a fixed fee closer to the edge. And an L2&rsquo;s fee market is not fixed
        &mdash; congestion, a change in data-availability costs, or a sequencer fee change all move
        it. Our result is stated as a function of gas rather than at a point precisely so that it
        stays usable when that number moves.
      </p>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">6</span>The soulbound switch
      </h2>
      <p>
        Charters launch soulbound, and &sect;12 describes a one-way switch that can later make them
        transferable. Selling a seat then becomes a second exit path: the seat moves whole, branches
        and balance included, with no sell pressure on the token, and the buyer replaces the seller
        one for one. The switch cannot be undone, and nobody has put a number on what its timing
        costs or saves.
      </p>
      <p>
        The study models it as a fourth arm, built only when a cell asks for it. With the switch
        thrown on day 15, on one exemplar seed:
      </p>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th className="wrap">Switch on day 15, against soulbound</th>
              <th>Day 31</th>
              <th>Day 90</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="wrap">Revocations avoided</td>
              <td>0</td>
              <td>144</td>
            </tr>
            <tr>
              <td className="wrap">Seats sold</td>
              <td>211</td>
              <td>381</td>
            </tr>
            <tr>
              <td className="wrap">Yield per branch per day</td>
              <td>&mdash;</td>
              <td>+48%</td>
            </tr>
            <tr>
              <td className="wrap">Live branches</td>
              <td>&minus;9</td>
              <td>&minus;309</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        <strong>Zero revocations avoided at day 31</strong>, despite 211 seats having already
        changed hands. The wave is throughput-bound, not backlog-bound: the reporters are saturated
        for the first days regardless, so clearing a hundred charters off the queue changes nothing
        until they would otherwise have caught up. The benefit is entirely a later phenomenon.
      </p>
      <p>
        By day 90 the picture is strange. 144 revocations avoided, yield per branch 48% higher
        &mdash; and <strong>309 fewer branches</strong>, not more. Transferability raises the
        per-branch yield mostly by stopping the branch base growing, because 381 seats passed to
        owners who never buy another licence. The net branch figure is two opposing effects &mdash;
        branches saved from revocation, less branches never bought &mdash; and it must not be read
        alone.
      </p>
      <div className="note">
        <p>
          That second effect is the assumption in this arm most likely to be wrong. The model gives
          a buyer exactly one behaviour beyond its valuation: it checks in, because somebody who has
          just paid for a seat does not let it be revoked for a 70% penalty when a check-in is free.
          It does not buy licences, because inventing a buying strategy the whitepaper does not
          describe would be inventing a result. A real buyer might well expand. Everything in this
          section moves if they do.
        </p>
      </div>

      <h3>A second door for capital</h3>
      <p>
        &sect;2 states that there is exactly one place ETH enters or leaves this economy: through
        trading. &sect;12 creates a second. A seat sale is new capital buying a claim on issuance,
        moving wallet to wallet, never crossing the pool &mdash; which is precisely why it carries
        no sell pressure, and precisely why the net flow signal in &sect;4 never counts a wei of it.
      </p>
      <p>
        On a 45-day run with the switch on day 15, the seat market moved{' '}
        <strong>206.7 ETH</strong> against 748.7 ETH of sell-side pool volume the signal did see
        &mdash; <strong>27.6%</strong>, and 7.9% of the pool&rsquo;s own ETH reserve. In that run it
        pointed against the signal: the market absorbed sellers who would otherwise have pushed
        payouts through the pool, so the signal read <em>less</em> selling and the multiplier
        finished 0.16 higher, while a further 206.7 ETH of genuine buying interest went entirely
        unrecorded. This is a consequence of the switch, not a flaw in it. But the policy in
        &sect;5 is built on &sect;2 holding, and after the switch it does not.
      </p>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">7</span>What we did not find
      </h2>
      <p>
        This section is not a footnote. A study that reports only what it found is not reporting
        what it did.
      </p>
      <ul>
        <li>
          <strong>The day-90 yield advantage is null.</strong> +1.39 tokens per branch per day, CI
          [&minus;0.44, +3.17]. It includes zero.
        </li>
        <li>
          <strong>In 29 of 200 seeds the multiplier did not fall at all</strong> over days 31&ndash;
          45. The attribution figure in section 3 is computed over the 171 where it did, and that is
          why its <code>n</code> is 171 rather than 200.
        </li>
        <li>
          <strong>The entire sensitivity ranking for the multiplier integral is null.</strong> No
          axis in the grid &mdash; not the dormancy rate, not the licence supply, not the demand
          regime, not the policy asymmetry &mdash; moves it by as much as one noise band. Suite A
          establishes that the mean effect is nonzero; nothing we varied changes it detectably.
        </li>
        <li>
          <strong>The per-charter licence cap does nothing.</strong> Three a day against one a day
          against ten a day moves supply minted by 0.0 noise bands. The daily inventory binds; the
          per-charter limit does not.
        </li>
        <li>
          <strong>Both readings of &sect;10&rsquo;s 102% ambiguity give the same answer.</strong>{' '}
          Whether the informant&rsquo;s 2% comes out of the protocol&rsquo;s fee or the
          banker&rsquo;s share moves supply minted by 0.1 noise bands. The ambiguity is real and
          worth resolving in the text; it does not change what this study measures.
        </li>
        <li>
          <strong>The number of competing reporters does not matter.</strong> One, four or sixteen
          moves supply minted by 0.1 noise bands. Contention changes who pays the gas, not how many
          charters get collected.
        </li>
        <li>
          <strong>
            Every delta except the token totals and the branch and charter counts sits inside its
            own single-seed noise band.
          </strong>{' '}
          The mean effects are clear; a single run of this protocol would not let you see most of
          them.
        </li>
      </ul>

      <div className="note">
        <p>
          <strong>What has not been run.</strong> The design has four suites. A (the baseline, 200
          seeds) and B (one factor at a time, 40 cells, 2,000 runs) are done and are what this page
          reports. C, a full factorial over the top three axes, has <em>not</em> been run and is not
          planned before the mint: at the measured throughput it is about three and a half hours,
          and the ranking from B already answers what it was there to answer. D, a Latin hypercube
          over the whole space at one seed a cell, was still running when this page was published;
          its only job is a single honest sentence of the form &ldquo;of 1,500 cells sampled, N
          showed a material difference and M did not&rdquo;, against the threshold in section 8. If
          it is not stated here, it had not finished.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">8</span>How it was done
      </h2>
      <p>
        The protocol is implemented as a deterministic model with no floating-point arithmetic in
        state: every token and ETH amount is an integer, and the accounting identities the
        whitepaper asserts hold exactly rather than to within a tolerance. One tick is one hour.
        Charters, branches, the constant-product pool, the licence auction, the resolution fee, the
        dormancy rule and the fee engine are each implemented against their section and checked
        against it.
      </p>
      <p>
        Every point of the grid is a <strong>paired run</strong>. A level is not a result; the
        result is the difference between the same world, the same seed and the same agents making
        the same decisions, with exactly one rule changed:
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Arm</th>
              <th className="wrap">What it isolates</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>control</td>
              <td className="wrap">Revocation disabled. The baseline everything is measured against.</td>
            </tr>
            <tr>
              <td>treatment</td>
              <td className="wrap">&sect;10 as written.</td>
            </tr>
            <tr>
              <td>noPayoutSell</td>
              <td className="wrap">
                As treatment, but the 30% payout never reaches the pool. Isolates the sell-pressure
                channel.
              </td>
            </tr>
            <tr>
              <td>transferable</td>
              <td className="wrap">
                As treatment, plus &sect;12&rsquo;s switch. Built only when a cell asks for it.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        What makes that sound is that the arms do not share a random sequence. Each agent draws from
        its own stream, derived from its identity and the kind of decision it is making, so a draw
        one arm takes and another does not shifts nothing else. Without it the arms would diverge
        for reasons unrelated to the rule being changed and every difference on this page would be
        partly noise. The test suite asserts it directly: with a cohort that never goes dormant, all
        four arms produce byte-identical histories.
      </p>

      <h3>What counts as a difference</h3>
      <p>
        Stated once, in one place, and applied everywhere. A cell shows a material difference on a
        metric when
      </p>
      <p className="mono">
        |delta| &gt; max( absoluteFloor(metric), 1.96 &times; sd<sub>A</sub>(metric) )
      </p>
      <p>
        &mdash; it must clear both a noise band measured from 200 seeds of the baseline cell with
        nothing changed at all, and an absolute floor in the metric&rsquo;s own units, chosen so
        that a difference below it would not change any decision a reader could make. Requiring both
        means nothing is reported that is merely detectable, and nothing that is merely large but
        indistinguishable from seed noise.
      </p>

      <h3>Checking</h3>
      <p>
        102 tests. Among them a property suite that asserts, after <em>every tick</em> of every
        scenario and across randomised configurations and seeds, every identity the whitepaper
        states: that circulating supply equals the premint plus mints less burns; that max supply
        only falls; that cumulative issuance never exceeds the budget and stops permanently when it
        is reached; that the ledger closes to the wei; that retiring <code>k</code> of{' '}
        <code>n</code> branches liquidates exactly <code>k/n</code>; that protocol-owned liquidity
        never decreases; that the fee split is exhaustive; and that no balance is ever negative.
      </p>
      <p>
        Making the grid affordable took the model from 8.4 seconds a run to 4.8 &mdash; a single-pass
        redistribution and an exact Barrett-reduction divide &mdash; without changing a single wei
        of any result. The determinism test was re-run after every optimisation. Suites A and B are
        2,200 paired runs; the full grid is 41 cells and about 20 hours of core time.
      </p>
      <p>
        <strong>Every number on this page is reproducible in one command.</strong> Clone the
        repository and run the command printed under any figure, or:
      </p>
      <Replay>pnpm study replay {`${exemplar.cellId} ${exemplar.seed}`}</Replay>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">9</span>Six places the whitepaper had to be interpreted
      </h2>
      <p>
        None of these are objections. They are the questions that could not be left open once the
        rules had to run, and in each case the model implements a stated reading &mdash; and, where
        there are two defensible ones, implements both and reports the difference.
      </p>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>&sect;</th>
              <th className="wrap">Claim</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <a href={`${REPO}/blob/main/docs/findings.md#f-01--the-revocation-split-sums-to-102`}>
                  F-01
                </a>
              </td>
              <td>10</td>
              <td className="wrap">The revocation split sums to 102% of the dormant balance.</td>
            </tr>
            <tr>
              <td>
                <a
                  href={`${REPO}/blob/main/docs/findings.md#f-02--the-two-p_start-rules-disagree-after-a-revocation-wave`}
                >
                  F-02
                </a>
              </td>
              <td>7</td>
              <td className="wrap">
                The two opening-price rules disagree after a wave, and the falling auction would
                rise.
              </td>
            </tr>
            <tr>
              <td>
                <a
                  href={`${REPO}/blob/main/docs/findings.md#f-03--the-daily-license-supply-is-unspecified-and-it-bounds-the-answer`}
                >
                  F-03
                </a>
              </td>
              <td>8</td>
              <td className="wrap">
                The daily licence supply is unspecified, and it bounds how violent the wave is.
              </td>
            </tr>
            <tr>
              <td>
                <a
                  href={`${REPO}/blob/main/docs/findings.md#f-04--is-cutstep--raisestep-a-protocol-rule-or-a-default`}
                >
                  F-04
                </a>
              </td>
              <td>5</td>
              <td className="wrap">
                Is the policy asymmetry a protocol rule or the intended default?
              </td>
            </tr>
            <tr>
              <td>
                <a
                  href={`${REPO}/blob/main/docs/findings.md#f-05--does-one-charter-per-wallet-survive-the-transfer-switch`}
                >
                  F-05
                </a>
              </td>
              <td>6, 12</td>
              <td className="wrap">
                Does one-charter-per-wallet survive transferability, and what would accumulation
                mean?
              </td>
            </tr>
            <tr>
              <td>
                <a
                  href={`${REPO}/blob/main/docs/findings.md#f-06--a-seat-sale-is-capital-entering-the-economy-that-the-flow-signal-cannot-see`}
                >
                  F-06
                </a>
              </td>
              <td>2, 12</td>
              <td className="wrap">
                A seat sale moves ETH into the economy without touching the pool, so the flow signal
                never sees it.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ------------------------------------------------------------------ */}

      <h2>
        <span className="num">10</span>What would settle it
      </h2>
      <p>Three questions, put as questions.</p>
      <ol>
        <li>
          <strong>How long is an epoch?</strong> It sets how long the blind window in finding one
          lasts &mdash; half a day, or most of a week.
        </li>
        <li>
          <strong>How many licences are sold a day?</strong> It scales everything in finding four,
          and it interacts with reporting costs in a direction that is not obvious.
        </li>
        <li>
          <strong>Which of &sect;10&rsquo;s three percentages is the residual?</strong> Two per cent
          to the informant, seventy to the fee, and &ldquo;the remaining thirty&rdquo; to the banker
          is a hundred and two.
        </li>
      </ol>
      <p>Publish the launch parameters and this study re-runs itself against them.</p>

      {/* ------------------------------------------------------------------ */}

      <footer>
        <p>
          Unofficial. Not affiliated with, commissioned by, or endorsed by The Standard Reserve. The
          model, the runner, the stored results and this page are MIT licensed.
        </p>
        <p>
          <a href={REPO}>Repository</a> &middot;{' '}
          <a href={`${REPO}/blob/main/docs/mechanics.md`}>Mechanics</a> &middot;{' '}
          <a href={`${REPO}/blob/main/docs/experimental-design.md`}>Experimental design</a> &middot;{' '}
          <a href={`${REPO}/blob/main/docs/findings.md`}>Findings</a> &middot;{' '}
          <a href={`${REPO}/blob/main/docs/results-suites-a-b.md`}>Full results</a>
        </p>
      </footer>
    </main>
  )
}
