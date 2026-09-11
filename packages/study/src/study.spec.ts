/**
 * The runner's own guarantees.
 *
 * The protocol package asserts that the model is right. This file asserts that
 * the machinery around it does not quietly corrupt what the model produced:
 * that a cell id means one thing everywhere, that a stored number can be
 * reproduced exactly from its id and seed, that thirteen threads agree with
 * one, and that an interrupted suite resumes into the same state as one that
 * ran straight through.
 *
 * These are not incidental. The study's credibility rests on someone being
 * able to take a figure out of the report and reproduce it in one command.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, WAD, resolveConfig, type ConfigOverrides } from '@thirty-first-day/protocol'

import { summarise, summariseCell, toDisplay } from './aggregate.js'
import {
  cellId,
  canonicalJson,
  configDiff,
  contentHash,
  dedupeCells,
  makeCell,
  seedRange,
} from './cells.js'
import { baselineOverrides, mixForDormancyRate, STATIC_AXES } from './config/axes.js'
import { DEMAND, DEMAND_REGIMES } from './config/demand.js'
import { executeSuite, pendingTasks } from './execute.js'
import { isMaterial, thresholdFor } from './materiality.js'
import { METRIC_PATHS, readMetric } from './metrics.js'
import { runTasksPooled, runTasksSerial, type Task } from './pool.js'
import { runOne, toRunResult } from './runCell.js'
import {
  appendResult,
  cellPath,
  completedSeeds,
  manifestFingerprint,
  manifestPath,
  parse,
  readCellResults,
  readManifest,
  stringify,
  writeManifest,
} from './storage.js'
import { buildBaseline, buildOfat, buildSample, totalRuns, type Suite } from './suites.js'
import { auditSuite, levelLabelFor } from '../scripts/axis-audit.js'

// A deliberately small world: these tests are about the machinery, not the
// economics, and a full 1000-charter 90-day cell takes seventeen seconds.
const SMALL: ConfigOverrides = { ...baselineOverrides(), genesisCharters: 40 }
const SMALL_HORIZON = 5

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tfd-study-'))
}

function smallSuite(name: 'baseline', seeds: number[]): Suite {
  return {
    name,
    description: 'small suite for tests',
    cells: [
      makeCell({
        label: 'small',
        axis: null,
        level: 'small',
        overrides: SMALL,
        seeds,
        horizonDays: SMALL_HORIZON,
      }),
    ],
    levels: [],
  }
}

// ---------------------------------------------------------------------------
// Cell identity
// ---------------------------------------------------------------------------

describe('cell identity', () => {
  it('is stable across processes', () => {
    const repoRoot = resolve(process.cwd(), '..', '..')
    const script = join(repoRoot, 'packages', 'study', 'scripts', 'cell-id.ts')
    const cases: ConfigOverrides[] = [{}, { licensesPerDay: 50 }, { genesisCharters: 40 }]
    for (const overrides of cases) {
      const inProcess = cellId(overrides, 90)
      const other = execFileSync(
        process.execPath,
        ['--import', 'tsx', script, JSON.stringify(overrides), '90'],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim()
      expect(other, `id for ${JSON.stringify(overrides)}`).toBe(inProcess)
    }
  })

  it('changes if and only if the effective configuration changes', () => {
    const base = cellId({}, 90)
    // Restating a default is not a change.
    expect(cellId({ licensesPerDay: DEFAULT_CONFIG.licensesPerDay }, 90)).toBe(base)
    expect(cellId({ hunter: { ...DEFAULT_CONFIG.hunter } }, 90)).toBe(base)
    // Anything that would produce a different run is.
    expect(cellId({ licensesPerDay: 99 }, 90)).not.toBe(base)
    expect(cellId({ genesisCharters: 999 }, 90)).not.toBe(base)
    expect(cellId({ hunter: { ...DEFAULT_CONFIG.hunter, count: 6 } }, 90)).not.toBe(base)
    // So is the horizon, because the stored result depends on it.
    expect(cellId({}, 45)).not.toBe(base)
    // Key order does not matter.
    expect(cellId({ licensesPerDay: 99, genesisCharters: 999 }, 90)).toBe(
      cellId({ genesisCharters: 999, licensesPerDay: 99 }, 90),
    )
  })

  it('does not move when the configuration schema gains a defaulted field', () => {
    // The property that keeps stored results reachable. Hashing the whole
    // resolved config meant that adding the seat market to the protocol
    // orphaned every result the study had already computed; hashing only the
    // difference from the defaults means a new knob nobody touched is
    // invisible.
    expect(configDiff(resolveConfig({}))).toBeUndefined()
    const resolved = resolveConfig({}) as unknown as Record<string, unknown>
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>
    expect(configDiff({ ...resolved, brandNewKnob: 42 }, { ...defaults, brandNewKnob: 42 })).toBeUndefined()
    // A nested default is just as invisible.
    expect(
      configDiff(
        { ...resolved, seat: { ...(resolved['seat'] as object), brandNewKnob: 7 } },
        { ...defaults, seat: { ...(defaults['seat'] as object), brandNewKnob: 7 } },
      ),
    ).toBeUndefined()
    // But a knob that actually moved is not.
    expect(configDiff({ ...resolved, licensesPerDay: 7 })).toEqual({ licensesPerDay: 7 })
  })

  it('serialises bigints and sorts keys canonically', () => {
    expect(canonicalJson({ b: 1n, a: 2 })).toBe('{"a":2,"b":"1n"}')
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(contentHash('x')).toHaveLength(32)
    expect(contentHash('x')).toBe(contentHash('x'))
    expect(contentHash('x')).not.toBe(contentHash('y'))
  })

  it('merges cells that resolve to the same configuration', () => {
    const a = makeCell({ label: 'a', overrides: {}, seeds: [1, 2] })
    const b = makeCell({ label: 'b', overrides: { licensesPerDay: DEFAULT_CONFIG.licensesPerDay }, seeds: [2, 3] })
    const merged = dedupeCells([a, b])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.seeds).toEqual([1, 2, 3])
  })
})

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe('replay', () => {
  it('reproduces a stored result exactly, metric for metric', () => {
    const root = tempRoot()
    try {
      const suite = smallSuite('baseline', [7])
      const cell = suite.cells[0]!
      // Store it the way the runner would, then read it back and re-run.
      const stored = toRunResult(runOne(cell.overrides, 7, cell.horizonDays))
      appendResult(root, 'baseline', stored)

      const readBack = readCellResults(root, 'baseline', cell.id)
      expect(readBack).toHaveLength(1)

      const replayed = runOne(cell.overrides, 7, cell.horizonDays, { keepHourly: true })
      expect(replayed.cellId).toBe(readBack[0]!.cellId)
      for (const path of METRIC_PATHS) {
        expect(readMetric(replayed.metrics.delta, path), `${path} delta`).toBe(
          readMetric(readBack[0]!.metrics.delta, path),
        )
        expect(readMetric(replayed.metrics.levels.treatment, path), `${path} treatment`).toBe(
          readMetric(readBack[0]!.metrics.levels.treatment, path),
        )
      }
      expect(stringify(replayed.metrics.treatment)).toBe(stringify(readBack[0]!.metrics.treatment))
      // Keeping the hourly history changes nothing but what is retained.
      expect(replayed.hourly?.treatment?.length).toBe(SMALL_HORIZON * 24)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('round-trips bigints through storage without loss', () => {
    // Including the strings that would otherwise be mistaken for bigints on
    // the way back in.
    const value = { a: 2n ** 200n, b: [-1n, 0n], c: 'plain', d: '12n', e: '~12n', f: '~~-3n', g: '~x' }
    expect(parse<typeof value>(stringify(value))).toEqual(value)
  })
})

// ---------------------------------------------------------------------------
// The fourth arm — whitepaper 12
// ---------------------------------------------------------------------------

describe('the transferable arm', () => {
  it('is not built at all when the transfer switch is null', () => {
    const run = runOne({ ...SMALL }, 3, SMALL_HORIZON)
    expect(run.arms).toEqual(['control', 'treatment', 'noPayoutSell'])
    expect(run.metrics.levels.transferable).toBeNull()
    expect(run.metrics.deltaTransfer).toBeNull()
    expect(run.metrics.transfer).toBeNull()
    expect(Object.keys(run.worlds).sort()).toEqual(['control', 'noPayoutSell', 'treatment'])
  })

  it('is built, and reported, when the switch is set', () => {
    const run = runOne(
      { ...SMALL, charterTransfersEnabledAtDay: 2 },
      3,
      SMALL_HORIZON,
    )
    expect(run.arms).toEqual(['control', 'treatment', 'noPayoutSell', 'transferable'])
    expect(run.metrics.levels.transferable).not.toBeNull()
    expect(run.metrics.deltaTransfer).not.toBeNull()
    expect(run.metrics.transfer?.transfersEnabledOnDay).toBe(2n)
    // The other three arms stay soulbound, so the switch is the only difference.
    expect(run.worlds.control?.config.charterTransfersEnabledAtDay).toBeNull()
    expect(run.worlds.treatment?.config.charterTransfersEnabledAtDay).toBeNull()
    expect(run.worlds.transferable?.config.charterTransfersEnabledAtDay).toBe(2)
  })

  it('costs a soulbound cell nothing: same arms, same metrics, same id', () => {
    // "Cells that do not set it must cost exactly what they cost today."
    const withoutMention = runOne({ ...SMALL }, 9, SMALL_HORIZON)
    const explicitNull = runOne(
      { ...SMALL, charterTransfersEnabledAtDay: null },
      9,
      SMALL_HORIZON,
    )
    expect(explicitNull.cellId).toBe(withoutMention.cellId)
    expect(explicitNull.arms).toEqual(withoutMention.arms)
    expect(stringify(explicitNull.metrics)).toBe(stringify(withoutMention.metrics))
  })
})

// ---------------------------------------------------------------------------
// The worker pool
// ---------------------------------------------------------------------------

describe('the worker pool', () => {
  it('produces byte-identical results to single-threaded execution', async () => {
    const cell = smallSuite('baseline', seedRange(4, 500)).cells[0]!
    const tasks: Task[] = cell.seeds.map((seed) => ({
      cellId: cell.id,
      overrides: cell.overrides,
      seed,
      horizonDays: cell.horizonDays,
    }))

    const serial = runTasksSerial(tasks)
    const pooled = await runTasksPooled(tasks, { workers: 3 })
    expect(pooled).toHaveLength(serial.length)

    // Completion order is not task order, so key on the seed.
    const bySeed = new Map(pooled.map((r) => [r.seed, r]))
    for (const expected of serial) {
      const actual = bySeed.get(expected.seed)
      expect(actual, `seed ${expected.seed} missing`).toBeDefined()
      expect(stringify(actual)).toBe(stringify(expected))
    }
  }, 180_000)
})

// ---------------------------------------------------------------------------
// Resumability
// ---------------------------------------------------------------------------

describe('resumability', () => {
  it('resuming an interrupted suite yields the same manifest and results', async () => {
    const straight = tempRoot()
    const interrupted = tempRoot()
    try {
      const seeds = seedRange(4, 900)
      const suite = smallSuite('baseline', seeds)

      const whole = await executeSuite({ root: straight, suite, workers: 1 })
      expect(whole.ran).toBe(4)
      expect(whole.skipped).toBe(0)

      // Interrupt after two seeds, then resume.
      const first = await executeSuite({
        root: interrupted,
        suite,
        workers: 1,
        seeds: seeds.slice(0, 2),
      })
      expect(first.ran).toBe(2)
      expect(completedSeeds(interrupted, 'baseline', suite.cells[0]!.id).size).toBe(2)

      const resumed = await executeSuite({ root: interrupted, suite, workers: 1 })
      expect(resumed.ran).toBe(2)
      expect(resumed.skipped).toBe(2)

      expect(manifestFingerprint(resumed.manifest)).toBe(manifestFingerprint(whole.manifest))
      expect(Object.keys(readManifest(interrupted).suites)).toEqual(
        Object.keys(readManifest(straight).suites),
      )

      const a = readCellResults(straight, 'baseline', suite.cells[0]!.id)
      const b = readCellResults(interrupted, 'baseline', suite.cells[0]!.id)
      expect(b.map((r) => r.seed)).toEqual(a.map((r) => r.seed))
      expect(stringify(b)).toBe(stringify(a))
    } finally {
      rmSync(straight, { recursive: true, force: true })
      rmSync(interrupted, { recursive: true, force: true })
    }
  }, 180_000)

  it('ignores a torn final line rather than losing the file', () => {
    const root = tempRoot()
    try {
      const suite = smallSuite('baseline', [1, 2])
      const cell = suite.cells[0]!
      appendResult(root, 'baseline', toRunResult(runOne(cell.overrides, 1, cell.horizonDays)))
      // A process killed mid-write leaves a partial line behind.
      writeFileSync(cellPath(root, 'baseline', cell.id), '{"cellId":"tru', { flag: 'a' })

      expect(completedSeeds(root, 'baseline', cell.id)).toEqual(new Set([1]))
      expect(readCellResults(root, 'baseline', cell.id)).toHaveLength(1)
      const { tasks, skipped } = pendingTasks(root, suite, undefined, undefined)
      expect(skipped).toBe(1)
      expect(tasks.map((t) => t.seed)).toEqual([2])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

describe('the experimental design', () => {
  it('builds every suite without a full factorial', () => {
    const options = { gasBoundaryWei: WAD / 300n }
    const baseline = buildBaseline(options)
    const ofat = buildOfat(options)
    const sample = buildSample({ ...options, cells: 60 })

    expect(baseline.cells).toHaveLength(1)
    expect(totalRuns(baseline)).toBe(200)
    // One factor at a time, with the baseline level shared across axes.
    expect(ofat.cells.length).toBeGreaterThan(30)
    expect(ofat.cells.length).toBeLessThan(80)
    // Dedup folds each axis's baseline level into one shared cell, but the
    // level join keeps every axis complete for reporting.
    expect(ofat.levels.length).toBeGreaterThan(ofat.cells.length)
    for (const axis of STATIC_AXES) {
      const forAxis = ofat.levels.filter((l) => l.axis === axis.name)
      expect(forAxis.length, `${axis.name} levels`).toBe(axis.levels.length)
    }
    expect(sample.cells.length).toBeLessThanOrEqual(60)
    // Every sample cell is one seed.
    for (const cell of sample.cells) expect(cell.seeds).toHaveLength(1)
  })

  it('covers every level of every axis evenly in the hypercube', () => {
    const sample = buildSample({ cells: 132, gasBoundaryWei: WAD / 300n })
    // Each axis appears in every cell's label exactly once.
    for (const axis of STATIC_AXES) {
      const seen = new Map<string, number>()
      for (const cell of sample.cells) {
        const match = cell.label.match(new RegExp(`${axis.name}=([^ ]+)`))
        if (match === null) continue
        seen.set(match[1] as string, (seen.get(match[1] as string) ?? 0) + 1)
      }
      expect(seen.size, `${axis.name} levels covered`).toBe(axis.levels.length)
      const counts = [...seen.values()]
      // Balanced to within one, which is all a Latin hypercube promises when
      // the cell count is not a multiple of the level count.
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
    }
  })

  it('keeps the cohort mix a partition at every dormancy rate', () => {
    for (const rate of [0, 0.05, 0.15, 0.3, 0.45, 0.6, 1]) {
      const mix = mixForDormancyRate(rate)
      const total = mix.committed + mix.trader + mix.casual + mix.tourist + mix.lost
      expect(total, `rate ${rate}`).toBe(10_000n)
      expect(mix.tourist + mix.lost).toBe(BigInt(Math.round(rate * 10_000)))
      for (const share of Object.values(mix)) expect(share >= 0n).toBe(true)
    }
  })

  it('gives every demand regime an explicit, distinct generator', () => {
    for (const regime of DEMAND_REGIMES) {
      const demand = DEMAND[regime]
      expect(demand.buyBiasWad >= 0n && demand.buyBiasWad <= WAD).toBe(true)
      expect(demand.traders >= 0).toBe(true)
    }
    expect(DEMAND.none.traders).toBe(0)
    // chop is the mean-zero, high-variance case.
    expect(DEMAND.chop.buyBiasWad).toBe(WAD / 2n)
    expect(DEMAND.chop.maxTradeFractionWad > DEMAND.mild.maxTradeFractionWad).toBe(true)
    expect(DEMAND.chop.activityWad > DEMAND.mild.activityWad).toBe(true)
    expect(DEMAND.bear.buyBiasWad < DEMAND.mild.buyBiasWad).toBe(true)
    expect(DEMAND.bull.buyBiasWad > DEMAND.mild.buyBiasWad).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Statistics and materiality
// ---------------------------------------------------------------------------

describe('statistics', () => {
  it('bootstraps a confidence interval that brackets the mean and is seeded', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const a = summarise(values)
    const b = summarise(values)
    expect(a).toEqual(b)
    expect(a.mean).toBeCloseTo(5.5, 10)
    expect(a.median).toBeCloseTo(5.5, 10)
    expect(a.ci95[0]).toBeLessThan(a.mean)
    expect(a.ci95[1]).toBeGreaterThan(a.mean)
    expect(summarise([]).n).toBe(0)
    // A constant series has no interval to speak of.
    const flat = summarise([3, 3, 3, 3])
    expect(flat.sd).toBe(0)
    expect(flat.ci95).toEqual([3, 3])
  })

  it('requires a delta to clear both the noise band and an absolute floor', () => {
    const noisy = summarise([-5, 5, -5, 5, -5, 5])
    const threshold = thresholdFor('yieldPerBranchPerDayD45', noisy)
    expect(threshold.noiseBand).toBeGreaterThan(threshold.absoluteFloor)
    expect(threshold.threshold).toBe(threshold.noiseBand)
    expect(isMaterial(2, threshold)).toBe(false)
    expect(isMaterial(50, threshold)).toBe(true)

    // With a quiet baseline the absolute floor is what binds.
    const quiet = summarise([0, 0, 0, 0])
    const floored = thresholdFor('yieldPerBranchPerDayD45', quiet)
    expect(floored.threshold).toBe(floored.absoluteFloor)
    expect(isMaterial(0.5, floored)).toBe(false)
    expect(isMaterial(1.5, floored)).toBe(true)
  })

  it('scales metrics for display without losing their sign', () => {
    expect(toDisplay(10n ** 18n, 'circulatingD90')).toBe(1)
    expect(toDisplay(-(10n ** 18n), 'circulatingD90')).toBe(-1)
    expect(toDisplay(42n, 'totalBranchesD90')).toBe(42)
  })

  it('summarises a cell over its stored seeds', () => {
    const root = tempRoot()
    try {
      const suite = smallSuite('baseline', [11, 12])
      const cell = suite.cells[0]!
      for (const seed of cell.seeds) {
        appendResult(root, 'baseline', toRunResult(runOne(cell.overrides, seed, cell.horizonDays)))
      }
      const summary = summariseCell(cell, readCellResults(root, 'baseline', cell.id))
      expect(summary.runs).toBe(2)
      expect(summary.metrics['totalBranchesD90']?.n).toBe(2)
      expect(summary.treatmentOnly['revocations']?.n).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Storage hygiene
// ---------------------------------------------------------------------------

describe('storage', () => {
  it('writes the manifest atomically', () => {
    const root = tempRoot()
    try {
      writeManifest(root, { suites: {} })
      expect(JSON.parse(readFileSync(manifestPath(root), 'utf8'))).toEqual({ suites: {} })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Axis composition
// ---------------------------------------------------------------------------

/*
 * A multi-axis suite composes a cell with a shallow merge, so two axes that
 * write the same key silently resolve by order rather than erroring. The
 * failure mode is a flat result that is indistinguishable from a null, and a
 * null is publishable — see docs/experimental-design.md.
 *
 * Suite B is what the published study rests on, so its immunity is asserted
 * here rather than left to a script.
 */
describe('axis composition', () => {
  it('every OFAT axis reaches every cell it labels', () => {
    const suite = buildOfat({ seeds: 1 })
    const verdicts = auditSuite(suite, STATIC_AXES)
    const broken = verdicts.filter((v) => v.clobbered > 0)
    expect(broken.map((v) => v.axis)).toEqual([])
    // And the audit is looking at something: OFAT labels one axis per cell.
    expect(verdicts.reduce((n, v) => n + v.reached, 0)).toBe(suite.cells.length)
  })

  it('the audit catches an axis whose level is overwritten', () => {
    // Two axes that both write `payout`, composed in this order.
    const first = {
      name: 'writesPayoutFirst',
      rationale: 'test',
      levels: [
        {
          label: 'sell-none',
          overrides: { ...baselineOverrides(), payout: { ...DEFAULT_CONFIG.payout, sellFractionWad: 0n } },
        },
      ],
    }
    const second = {
      name: 'writesPayoutSecond',
      rationale: 'test',
      levels: [
        {
          label: 'slow',
          overrides: { ...baselineOverrides(), payout: { ...DEFAULT_CONFIG.payout, sellOverHours: 168 } },
        },
      ],
    }
    const cell = makeCell({
      label: 'writesPayoutFirst=sell-none writesPayoutSecond=slow',
      overrides: { ...baselineOverrides(), ...first.levels[0]!.overrides, ...second.levels[0]!.overrides },
      seeds: [1],
      horizonDays: 90,
    })
    const suite: Suite = { name: 'factorial', description: 'test', cells: [cell], levels: [] }

    const verdicts = auditSuite(suite, [first, second])
    expect(verdicts.find((v) => v.axis === 'writesPayoutFirst')?.clobbered).toBe(1)
    expect(verdicts.find((v) => v.axis === 'writesPayoutSecond')?.clobbered).toBe(0)
  })

  it('reads a level label that contains a space', () => {
    // The gas axis labels its levels "4x boundary". A split on spaces drops
    // the axis silently, which is the same class of bug.
    expect(levelLabelFor('epochDays=3 hunterGasCostEth=4x boundary', 'hunterGasCostEth')).toBe(
      '4x boundary',
    )
    expect(levelLabelFor('hunterGasCostEth=4x boundary epochDays=3', 'hunterGasCostEth')).toBe(
      '4x boundary',
    )
  })
})
