/**
 * Per-charter daily state for the instrument at the top of the report.
 *
 * Replays the same cell and seed the report's charts already use, and records
 * what every one of the thousand charters was doing on each of the ninety-one
 * days. The daily aggregates in the output are checked against the aggregates
 * the charts are drawn from: if they disagree, this export is wrong, not the
 * page.
 *
 * No positions are exported. The instrument computes them from the charter
 * index, so the layout is deterministic and costs nothing to transfer.
 *
 *   pnpm tsx packages/study/scripts/cohort-export.ts
 */

import { gzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  charterAccrued,
  configForArm,
  createWorld,
  dormancyTicks,
  populateGenesisCohort,
  resolveConfig,
  soulbound,
  type TickSnapshot,
  type World,
} from '@thirty-first-day/protocol'

import { cellId } from '../src/cells.js'
import { baselineOverrides } from '../src/config/axes.js'
import { runOne } from '../src/runCell.js'

const ROOT = resolve(process.cwd())
const OUT = join(ROOT, 'apps', 'report', 'public')
const SEED = 1_000_000
const HORIZON = 90

/**
 * Per-charter state.
 *
 * `dormant` is not a protocol term — whitepaper 10 knows only "reportable" or
 * not. It is the half-way mark: a charter that has been idle for at least half
 * the dormancy window and is on course to become reportable unless its owner
 * acts. It exists so the instrument can show the wave building before anything
 * is revoked, which is most of the point of watching it.
 */
const ACTIVE = 0
const DORMANT = 1
const REPORTABLE = 2
const REVOKED = 3

const overrides = baselineOverrides()
const cfg = resolveConfig(overrides)
const dormancy = dormancyTicks(cfg)
const halfway = Math.floor(dormancy / 2)

// Built exactly as `runCell.runOne` builds the treatment arm, so the histories
// are the same run. The arms are independent worlds, so ticking one alone
// produces what ticking all of them produces.
const world: World = createWorld(configForArm(soulbound(cfg), 'treatment'), SEED)
populateGenesisCohort(world)

const charterIds = [...world.state.charters.keys()].sort((a, b) => a - b)
const charters = charterIds.length

const state: number[][] = []
const branches: number[][] = []
const rawBalance: bigint[][] = []
const daily: Array<Record<string, number | string>> = []

function snapshotCharters(): void {
  const s = world.state
  const stateRow = new Array<number>(charters)
  const branchRow = new Array<number>(charters)
  const balanceRow = new Array<bigint>(charters)
  for (let i = 0; i < charters; i++) {
    const charter = s.charters.get(charterIds[i] as number)
    if (charter === undefined || !charter.alive) {
      stateRow[i] = REVOKED
      branchRow[i] = 0
      balanceRow[i] = 0n
      continue
    }
    const idle = s.tick - charter.lastInteractionTick
    stateRow[i] =
      idle >= dormancy ? REPORTABLE : idle >= halfway ? DORMANT : ACTIVE
    branchRow[i] = charter.branchIds.length
    balanceRow[i] = charterAccrued(s, charter)
  }
  state.push(stateRow)
  branches.push(branchRow)
  rawBalance.push(balanceRow)
}

function recordDay(day: number, snapshot: TickSnapshot | null): void {
  if (snapshot === null) {
    // Day 0: the genesis state, before a single tick. Computed from the same
    // expressions the snapshot uses, because there is no snapshot yet.
    daily.push({
      day: 0,
      liveCharters: world.state.liveCharters,
      totalBranches: world.state.totalBranches,
      reportable: 0,
      revokedCumulative: 0,
      multiplier: Number(world.state.policy.multiplier) / 1e18,
      yieldPerBranchPerDay: Number(world.yieldPerBranchPerDay()) / 1e18,
      regime: 'contraction',
    })
    return
  }
  daily.push({
    day,
    liveCharters: snapshot.liveCharters,
    totalBranches: snapshot.totalBranches,
    reportable: snapshot.reportableCharters,
    revokedCumulative: snapshot.cumulativeRevoked,
    multiplier: Number(snapshot.multiplier) / 1e18,
    yieldPerBranchPerDay: Number(snapshot.yieldPerBranchPerDay) / 1e18,
    regime: snapshot.regime,
  })
}

snapshotCharters()
recordDay(0, null)

for (let day = 1; day <= HORIZON; day++) {
  let last: TickSnapshot | null = null
  for (let t = 0; t < cfg.ticksPerDay; t++) last = world.tick().snapshot
  world.history.length = 0
  snapshotCharters()
  recordDay(day, last)
}

// ---------------------------------------------------------------------------
// Normalise the balance to a byte
// ---------------------------------------------------------------------------

let maxBalance = 0n
for (const row of rawBalance) for (const v of row) if (v > maxBalance) maxBalance = v
const balance = rawBalance.map((row) =>
  row.map((v) => (maxBalance === 0n ? 0 : Number((v * 255n) / maxBalance))),
)

// ---------------------------------------------------------------------------
// Check it against the run the charts are drawn from
// ---------------------------------------------------------------------------

process.stdout.write('verifying against the charts’ own replay ... ')
const reference = runOne(overrides, SEED, HORIZON)
const referenceDaily = reference.daily.treatment ?? []
if (referenceDaily.length !== HORIZON) {
  throw new Error(`reference has ${referenceDaily.length} days, expected ${HORIZON}`)
}
for (let i = 0; i < HORIZON; i++) {
  const ref = referenceDaily[i] as TickSnapshot
  const mine = daily[i + 1] as Record<string, number | string>
  const checks: Array<[string, number | string, number | string]> = [
    ['liveCharters', mine['liveCharters'] as number, ref.liveCharters],
    ['totalBranches', mine['totalBranches'] as number, ref.totalBranches],
    ['reportable', mine['reportable'] as number, ref.reportableCharters],
    ['revokedCumulative', mine['revokedCumulative'] as number, ref.cumulativeRevoked],
    ['multiplier', mine['multiplier'] as number, Number(ref.multiplier) / 1e18],
    [
      'yieldPerBranchPerDay',
      mine['yieldPerBranchPerDay'] as number,
      Number(ref.yieldPerBranchPerDay) / 1e18,
    ],
    ['regime', mine['regime'] as string, ref.regime],
  ]
  for (const [name, got, want] of checks) {
    if (got !== want) {
      throw new Error(`day ${i + 1}: ${name} is ${String(got)}, the charts say ${String(want)}`)
    }
  }
}
console.log('all 90 days match')

// The per-charter totals have to add up to the aggregates too.
for (let day = 0; day <= HORIZON; day++) {
  const stateRow = state[day] as number[]
  const branchRow = branches[day] as number[]
  const live = stateRow.filter((v) => v !== REVOKED).length
  const reportable = stateRow.filter((v) => v === REPORTABLE).length
  const branchTotal = branchRow.reduce((a, b) => a + b, 0)
  const agg = daily[day] as Record<string, number>
  if (live !== agg['liveCharters']) throw new Error(`day ${day}: live charters disagree`)
  if (branchTotal !== agg['totalBranches']) throw new Error(`day ${day}: branch totals disagree`)
  if (reportable !== agg['reportable']) throw new Error(`day ${day}: reportable counts disagree`)
}
console.log('per-charter rows sum to the aggregates on all 91 days')

// ---------------------------------------------------------------------------

const payload = {
  cellId: cellId(overrides, HORIZON),
  seed: SEED,
  days: HORIZON + 1,
  charters,
  replay: `pnpm study replay ${cellId(overrides, HORIZON)} ${SEED}`,
  maxBalanceTokens: Number(maxBalance) / 1e18,
  legend: { active: ACTIVE, dormant: DORMANT, reportable: REPORTABLE, revoked: REVOKED },
  state,
  branches,
  balance,
  daily,
}

mkdirSync(OUT, { recursive: true })
const json = JSON.stringify(payload)
const path = join(OUT, 'cohort.json')
writeFileSync(path, json)
const gz = gzipSync(Buffer.from(json)).length
console.log('')
console.log(`wrote ${path}`)
console.log(`  ${charters} charters x ${HORIZON + 1} days`)
console.log(`  raw       ${(json.length / 1024).toFixed(0)} KB`)
console.log(`  gzipped   ${(gz / 1024).toFixed(0)} KB   (budget 300 KB)`)
if (gz > 300 * 1024) {
  console.error('OVER BUDGET')
  process.exitCode = 1
}
