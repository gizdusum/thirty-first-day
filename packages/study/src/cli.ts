/**
 * The study CLI.
 *
 *   pnpm study run <suite> [--cells=a,b] [--seeds=N] [--workers=N] [--horizon=N]
 *   pnpm study replay <cellId> <seed>
 *   pnpm study report <suite> [--which=delta|deltaNoPayout|treatment|control]
 *   pnpm study cells <suite>
 *   pnpm study calibrate
 *
 * `replay` is the credibility mechanism. Every number that reaches the
 * published report must be reachable by one `replay` command, and that command
 * is printed next to the figure. Someone who doubts a chart reproduces the
 * exact point in one line.
 */

import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { Arm } from '@thirty-first-day/protocol'

import { METRIC_DISPLAY, rankAxes, summariseCell, toDisplay, type Which } from './aggregate.js'
import { calibrateGasBoundary } from './calibrate.js'
import type { CellSpec } from './cells.js'
import { baselineOverrides } from './config/axes.js'
import { METRIC_PATHS, readMetric } from './metrics.js'
import { noiseBands, thresholdFor } from './materiality.js'
import { defaultWorkerCount } from './pool.js'
import { runOne } from './runCell.js'
import { executeSuite, pendingTasks } from './execute.js'
import { existsSync, renameSync } from 'node:fs'

import { cellPath, readCellResults, readManifest, writeManifest } from './storage.js'
import {
  buildBaseline,
  buildFactorial,
  buildOfat,
  buildSample,
  totalRuns,
  type Suite,
  type SuiteName,
} from './suites.js'

/**
 * Where `runs/` lives. Defaults to the working directory; `--root` points it
 * elsewhere, which is what makes it possible to rehearse a migration against a
 * copy before running it on the real results.
 */
let ROOT = resolve(process.cwd())

interface Args {
  command: string
  positional: string[]
  flags: Record<string, string>
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq < 0) flags[arg.slice(2)] = 'true'
      else flags[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else positional.push(arg)
  }
  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags }
}

function gitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

/** The gas boundary, read from a previous calibration or measured now. */
function gasBoundary(horizonDays: number): bigint {
  const manifest = readManifest(ROOT)
  for (const entry of Object.values(manifest.suites)) {
    if (entry.gasBoundaryWei !== null && entry.horizonDays === horizonDays) {
      return BigInt(entry.gasBoundaryWei)
    }
  }
  return calibrateGasBoundary(baselineOverrides(), 1_000_000).boundaryWei
}

function buildNamedSuite(name: string, flags: Record<string, string>): Suite {
  const horizonDays = flags['horizon'] !== undefined ? Number(flags['horizon']) : 90
  const seeds = flags['seeds'] !== undefined ? Number(flags['seeds']) : undefined
  const options = { horizonDays, gasBoundaryWei: gasBoundary(horizonDays) }
  switch (name as SuiteName) {
    case 'baseline':
      return buildBaseline(seeds === undefined ? options : { ...options, seeds })
    case 'ofat':
      return buildOfat(seeds === undefined ? options : { ...options, seeds })
    case 'factorial': {
      const axes = (flags['axes'] ?? '').split(',').filter(Boolean)
      if (axes.length === 0) {
        throw new Error('factorial needs --axes=a,b,c — the top three from suite B')
      }
      return buildFactorial(axes, seeds === undefined ? options : { ...options, seeds })
    }
    case 'sample':
      return buildSample(
        flags['cells'] === undefined ? options : { ...options, cells: Number(flags['cells']) },
      )
    default:
      throw new Error(`unknown suite ${name}`)
  }
}

/** Every cell of every suite, so `replay` can resolve an id. */
function allCells(horizonDays: number): CellSpec[] {
  const options = { horizonDays, gasBoundaryWei: gasBoundary(horizonDays) }
  const suites: Suite[] = [buildBaseline(options), buildOfat(options), buildSample(options)]
  const cells: CellSpec[] = []
  for (const suite of suites) cells.push(...suite.cells)
  return cells
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function commandRun(args: Args): Promise<void> {
  const name = args.positional[0]
  if (name === undefined) throw new Error('usage: study run <suite>')
  const suite = buildNamedSuite(name, args.flags)
  const horizonDays = suite.cells[0]?.horizonDays ?? 90
  const workers =
    args.flags['workers'] !== undefined ? Number(args.flags['workers']) : defaultWorkerCount()
  const cellIds = args.flags['cells']?.split(',').filter(Boolean)

  const { tasks, skipped } = pendingTasks(ROOT, suite, cellIds)
  console.log(`suite ${suite.name}: ${suite.cells.length} cells, ${totalRuns(suite)} runs total`)
  console.log(`  ${skipped} already done, ${tasks.length} to run, ${workers} workers`)

  const wallStart = Date.now()
  let lastLog = 0
  const report = await executeSuite({
    root: ROOT,
    suite,
    workers,
    gitSha: gitSha(),
    gasBoundaryWei: gasBoundary(horizonDays),
    ...(cellIds === undefined ? {} : { cellIds }),
    onResult: (_result, info) => {
      const now = Date.now()
      if (now - lastLog > 5_000 || info.done === info.total) {
        lastLog = now
        const elapsed = (now - wallStart) / 1000
        const rate = info.done / elapsed
        const eta = rate > 0 ? (info.total - info.done) / rate : 0
        console.log(
          `  ${info.done}/${info.total}  ${rate.toFixed(2)} runs/s  elapsed ${elapsed.toFixed(0)}s  eta ${eta.toFixed(0)}s`,
        )
      }
    },
  })

  if (report.ran === 0) console.log('nothing to do')
  else {
    console.log(
      `done in ${report.seconds.toFixed(0)}s  (${(report.ran / report.seconds).toFixed(2)} runs/s)`,
    )
  }
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

function commandReplay(args: Args): void {
  const [id, seedText] = args.positional
  if (id === undefined || seedText === undefined) {
    throw new Error('usage: study replay <cellId> <seed>')
  }
  const seed = Number(seedText)
  const horizonDays = args.flags['horizon'] !== undefined ? Number(args.flags['horizon']) : 90
  const cell = allCells(horizonDays).find((c) => c.id === id)
  if (cell === undefined) throw new Error(`no cell with id ${id} at horizon ${horizonDays}`)

  console.log(`cell   ${cell.id}  ${cell.label}`)
  console.log(`axis   ${cell.axis ?? '(baseline)'} = ${cell.level}`)
  console.log(`seed   ${seed}   horizon ${cell.horizonDays} days`)
  console.log('')

  const started = Date.now()
  const run = runOne(cell.overrides, seed, cell.horizonDays, { keepHourly: true })
  console.log(`replayed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(
    `arms: ${run.arms.join(', ')}    hourly snapshots retained: ${run.arms
      .map((a: Arm) => `${a}=${run.hourly?.[a]?.length ?? 0}`)
      .join(' ')}`,
  )
  console.log('')

  const width = 34
  console.log(
    armHeader(width, run.arms),
  )
  for (const path of METRIC_PATHS) {
    const cells = run.arms.map((arm: Arm) => {
      const level = run.metrics.levels[arm]
      return level === null || level === undefined ? '—' : fmt(toDisplay(readMetric(level, path), path))
    })
    const delta = toDisplay(readMetric(run.metrics.delta, path), path)
    console.log(
      path.padEnd(width) + cells.map((s) => s.padStart(16)).join('') + fmt(delta).padStart(16),
    )
  }
  console.log('')
  const t = run.metrics.treatment
  console.log('treatment only')
  console.log(`  revocations                   ${t.revocations}`)
  console.log(`  valueDestroyedByRevocation    ${fmt(Number(t.valueDestroyedByRevocation) / 1e18)} tokens`)
  console.log(`  valueReturnedToBankers        ${fmt(Number(t.valueReturnedToBankers) / 1e18)} tokens`)
  console.log(`  valueRedistributedToActives   ${fmt(Number(t.valueRedistributedToActives) / 1e18)} tokens`)
  console.log(`  bountiesPaid                  ${fmt(Number(t.bountiesPaid) / 1e18)} tokens`)
  console.log(`  hunterGasSpentEth             ${fmt(Number(t.hunterGasSpentEth) / 1e18)} ETH`)
  console.log(`  waveClearedOnDay              ${t.waveClearedOnDay ?? 'never'}`)
  console.log(
    `  ghostsNeverCollected          ${t.ghostsNeverCollected.count} charters, ${t.ghostsNeverCollected.branches} branches, ${fmt(Number(t.ghostsNeverCollected.balance) / 1e18)} tokens`,
  )
  console.log(
    `  attributableCut               ${t.attributableCut === null ? 'n/a (m did not fall)' : `${((Number(t.attributableCut) / 1e18) * 100).toFixed(1)}%`}`,
  )
  console.log(`  m drop d31..d45  treatment ${fmt(Number(t.mDropTreatment) / 1e18)}  noPayoutSell ${fmt(Number(t.mDropNoPayoutSell) / 1e18)}`)

  const stored = readCellResults(ROOT, 'baseline', cell.id).concat(
    readCellResults(ROOT, 'ofat', cell.id),
  )
  const match = stored.find((r) => r.seed === seed)
  if (match !== undefined) {
    const same = METRIC_PATHS.every(
      (p) => readMetric(match.metrics.delta, p) === readMetric(run.metrics.delta, p),
    )
    console.log('')
    console.log(same ? 'matches the stored result exactly' : 'DIFFERS FROM THE STORED RESULT')
  }
}

function armHeader(width: number, arms: readonly Arm[]): string {
  return 'metric'.padEnd(width) + arms.map((a) => a.padStart(16)).join('') + 'delta'.padStart(16)
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const abs = Math.abs(value)
  if (abs === 0) return '0'
  if (abs >= 1e6 || abs < 1e-4) return value.toExponential(3)
  return value.toFixed(abs >= 100 ? 1 : 4)
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function commandReport(args: Args): void {
  const name = args.positional[0]
  if (name === undefined) throw new Error('usage: study report <suite>')
  const which = (args.flags['which'] ?? 'delta') as Which
  const suite = buildNamedSuite(name, args.flags)
  const summaries = suite.cells.map((cell) =>
    summariseCell(cell, readCellResults(ROOT, suite.name, cell.id), which),
  )
  const withRuns = summaries.filter((s) => s.runs > 0)

  console.log(`# ${suite.name} — ${which}`)
  console.log(`${withRuns.length}/${summaries.length} cells have results`)
  console.log('')

  if (suite.name === 'baseline') {
    const cell = withRuns[0]
    if (cell === undefined) {
      console.log('no results yet')
      return
    }
    console.log(`baseline cell ${cell.cellId}, ${cell.runs} seeds`)
    console.log('')
    console.log(
      `${'metric'.padEnd(34)}${'mean'.padStart(14)}${'ci95 lo'.padStart(14)}${'ci95 hi'.padStart(14)}${'sd'.padStart(14)}${'noise band'.padStart(14)}`,
    )
    for (const path of METRIC_PATHS) {
      const s = cell.metrics[path]
      if (s === undefined) continue
      const t = thresholdFor(path, s)
      console.log(
        path.padEnd(34) +
          fmt(s.mean).padStart(14) +
          fmt(s.ci95[0]).padStart(14) +
          fmt(s.ci95[1]).padStart(14) +
          fmt(s.sd).padStart(14) +
          fmt(t.threshold).padStart(14),
      )
    }
    console.log('')
    console.log('treatment-only')
    for (const [key, s] of Object.entries(cell.treatmentOnly)) {
      console.log(
        `  ${key.padEnd(32)}${fmt(s.mean).padStart(14)}${fmt(s.ci95[0]).padStart(14)}${fmt(s.ci95[1]).padStart(14)}  (n=${s.n})`,
      )
    }
    console.log('')
    console.log(`replay: pnpm study replay ${cell.cellId} ${suite.cells[0]?.seeds[0] ?? ''}`)
    return
  }

  // OFAT and everything else: rank the axes.
  const baselineCell = buildBaseline({ horizonDays: suite.cells[0]?.horizonDays ?? 90 }).cells[0]
  const baselineResults =
    baselineCell === undefined ? [] : readCellResults(ROOT, 'baseline', baselineCell.id)
  const baselineSummary =
    baselineCell === undefined ? null : summariseCell(baselineCell, baselineResults, which)
  const bands = baselineSummary === null ? {} : noiseBands(baselineSummary.metrics)

  const headline = ['yieldPerBranchPerDayD45', 'yieldPerBranchPerDayD90', 'mintedToWalletsD90', 'multiplierIntegralD31to90']
  const detailAxes = args.flags['detail'] !== undefined ? Number(args.flags['detail']) : 4
  for (const metric of headline) {
    const band = bands[metric]?.threshold ?? 0
    console.log(`## sensitivity: ${metric}   (noise band ${fmt(band)} ${METRIC_DISPLAY[metric]?.unit ?? ''})`)
    const ranking = rankAxes(withRuns, suite.levels, metric, band)
    console.log(
      `${'axis'.padEnd(26)}${'range'.padStart(14)}${'in bands'.padStart(12)}  low -> high`,
    )
    for (const row of ranking) {
      console.log(
        row.axis.padEnd(26) +
          fmt(row.range).padStart(14) +
          row.rangeInNoiseBands.toFixed(1).padStart(12) +
          `  ${row.worstLevel} -> ${row.bestLevel}`,
      )
    }
    console.log('')
    for (const row of ranking.slice(0, detailAxes)) {
      console.log(`   ${row.axis}:`)
      for (const level of row.levels) {
        console.log(`     ${level.level.padEnd(22)}${fmt(level.mean).padStart(14)}   (n=${level.n})`)
      }
    }
    console.log('')
  }

  // Treatment-only series that the difference tables cannot show.
  const byCell = new Map(withRuns.map((s) => [s.cellId, s]))
  for (const name of ['ghostsNeverCollected.count', 'ghostsNeverCollected.branches', 'waveClearedOnDay', 'attributableCut', 'hunterGasSpentEth', 'revocations']) {
    console.log(`## treatment-only: ${name}`)
    const seenAxes = new Set<string>()
    for (const ref of suite.levels) {
      const summary = byCell.get(ref.cellId)
      if (summary === undefined || summary.runs === 0) continue
      if (!seenAxes.has(ref.axis)) {
        seenAxes.add(ref.axis)
        console.log(`   ${ref.axis}:`)
      }
      const stat = summary.treatmentOnly[name]
      console.log(
        `     ${ref.level.padEnd(22)}${fmt(stat?.mean ?? 0).padStart(14)}   (n=${stat?.n ?? 0})`,
      )
    }
    console.log('')
  }

  console.log('## cells')
  console.log(`${'cell'.padEnd(18)}${'label'.padEnd(34)}${'n'.padStart(5)}${'yieldD90'.padStart(14)}${'mintedD90'.padStart(14)}${'mIntegral'.padStart(14)}`)
  for (const summary of withRuns) {
    console.log(
      summary.cellId.padEnd(18) +
        summary.label.slice(0, 33).padEnd(34) +
        String(summary.runs).padStart(5) +
        fmt(summary.metrics['yieldPerBranchPerDayD90']?.mean ?? 0).padStart(14) +
        fmt(summary.metrics['mintedToWalletsD90']?.mean ?? 0).padStart(14) +
        fmt(summary.metrics['multiplierIntegralD31to90']?.mean ?? 0).padStart(14),
    )
  }
}

// ---------------------------------------------------------------------------
// cells / calibrate
// ---------------------------------------------------------------------------

/**
 * Re-point stored results at their current cell ids.
 *
 * Cell ids are content-derived, so a change to how that content is defined
 * moves every id at once and orphans results that are otherwise perfectly
 * good. That happened exactly once, when the id moved from a hash of the whole
 * resolved configuration to a hash of its difference from the defaults —
 * precisely so that it could not happen again when a configuration field is
 * added.
 *
 * The join is on the cell label, which the manifest records alongside the old
 * id. Nothing is deleted and nothing is merged: a rename that would collide
 * with an existing file is refused and reported.
 */
function commandMigrate(args: Args): void {
  const apply = args.flags['apply'] === 'true'
  const manifest = readManifest(ROOT)
  let moved = 0
  let already = 0
  let missing = 0

  for (const [suiteName, entry] of Object.entries(manifest.suites)) {
    const suite = buildNamedSuite(suiteName, { ...args.flags, horizon: String(entry.horizonDays) })
    const byLabel = new Map(suite.cells.map((c) => [c.label, c.id]))
    console.log(`${suiteName}: ${entry.cells.length} cells recorded`)
    for (const recorded of entry.cells) {
      const current = byLabel.get(recorded.label)
      const from = cellPath(ROOT, suiteName, recorded.id)
      if (!existsSync(from)) continue
      if (current === undefined) {
        console.log(`  ! ${recorded.label}: no cell with this label any more (${recorded.id})`)
        missing += 1
        continue
      }
      if (current === recorded.id) {
        already += 1
        continue
      }
      const to = cellPath(ROOT, suiteName, current)
      if (existsSync(to)) {
        console.log(`  ! ${recorded.label}: ${current}.jsonl already exists, refusing to overwrite`)
        continue
      }
      console.log(`  ${apply ? 'mv' : 'would mv'} ${recorded.id} -> ${current}   ${recorded.label}`)
      if (apply) {
        renameSync(from, to)
        recorded.id = current
      }
      moved += 1
    }
  }

  if (apply) {
    writeManifest(ROOT, manifest)
    console.log(`\nmoved ${moved}, already current ${already}, unmatched ${missing}`)
  } else {
    console.log(`\n${moved} to move, ${already} already current, ${missing} unmatched`)
    console.log('re-run with --apply=true to perform the rename')
  }
}

function commandCells(args: Args): void {
  const name = args.positional[0]
  if (name === undefined) throw new Error('usage: study cells <suite>')
  const suite = buildNamedSuite(name, args.flags)
  console.log(`${suite.name}: ${suite.cells.length} cells, ${totalRuns(suite)} runs`)
  for (const cell of suite.cells) {
    console.log(`  ${cell.id}  ${String(cell.seeds.length).padStart(4)} seeds  ${cell.label}`)
  }
}

function commandCalibrate(args: Args): void {
  const seed = args.flags['seed'] !== undefined ? Number(args.flags['seed']) : 1_000_000
  const boundary = calibrateGasBoundary(baselineOverrides(), seed)
  console.log('profitability boundary for the baseline cell')
  console.log(`  measured at tick        ${boundary.tick}`)
  console.log(`  reportable charters     ${boundary.reportableCharters}`)
  console.log(`  median dormant balance  ${fmt(Number(boundary.medianDormantBalance) / 1e18)} tokens`)
  console.log(`  pool price              ${fmt(Number(boundary.poolPriceWad) / 1e18)} ETH/token`)
  console.log(`  break-even gas          ${fmt(Number(boundary.boundaryWei) / 1e18)} ETH`)
  console.log(`  default gas             ${fmt(Number(1e18 / 500) / 1e18)} ETH`)
}

// ---------------------------------------------------------------------------

const HELP = `study — the Monte Carlo runner for The Thirty-First Day

  study run <suite> [--cells=id,id] [--seeds=N] [--workers=N] [--horizon=N]
  study replay <cellId> <seed> [--horizon=N]
  study report <suite> [--which=delta|deltaNoPayout|treatment|control|noPayoutSell]
  study cells <suite>
  study calibrate [--seed=N]
  study migrate [--apply=true]      re-point stored results at their current cell ids

  --root=<dir>  where runs/ lives (default: the working directory)

suites: baseline, ofat, factorial (--axes=a,b,c), sample [--cells=N]
`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags['root'] !== undefined) ROOT = resolve(args.flags['root'])
  switch (args.command) {
    case 'run':
      await commandRun(args)
      return
    case 'replay':
      commandReplay(args)
      return
    case 'report':
      commandReport(args)
      return
    case 'cells':
      commandCells(args)
      return
    case 'calibrate':
      commandCalibrate(args)
      return
    case 'migrate':
      commandMigrate(args)
      return
    default:
      console.log(HELP)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
