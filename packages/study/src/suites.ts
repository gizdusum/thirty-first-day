/**
 * The four suites.
 *
 * A full factorial over these axes is millions of cells and most of it is
 * noise, so the design is staged: establish a central estimate, rank the axes,
 * open out the interactions between the ones that matter, and then sample the
 * whole space once to support an honest global claim.
 *
 *   A. baseline    the baseline cell at many seeds. The central estimate and
 *                  the noise band that every other suite is judged against.
 *   B. ofat        one factor at a time. Produces the sensitivity ranking.
 *   C. factorial   full factorial over the top three axes from B. Interactions.
 *   D. sample      a Latin hypercube over the whole space, one seed each.
 *                  Supports claims of the form "N cells showed a difference,
 *                  M did not".
 */

import { createRng } from '@thirty-first-day/protocol'
import type { ConfigOverrides } from '@thirty-first-day/protocol'

import {
  DEFAULT_HORIZON_DAYS,
  dedupeCells,
  makeCell,
  seedRange,
  type CellSpec,
} from './cells.js'
import { STATIC_AXES, baselineOverrides, gasAxis, type Axis, type Level } from './config/axes.js'

export type SuiteName = 'baseline' | 'ofat' | 'factorial' | 'sample'

/** One axis level, joined to the cell that realises it. */
export interface LevelRef {
  axis: string
  level: string
  cellId: string
}

export interface Suite {
  name: SuiteName
  description: string
  /** The cells to execute, deduplicated by effective configuration. */
  cells: CellSpec[]
  /**
   * Every axis level and the cell it resolves to.
   *
   * Several axes include the baseline as one of their levels, and dedup folds
   * all of those into a single cell — which is right for execution (run it
   * once) but wrong for reporting, because each axis needs its baseline point
   * to have a range at all. This is the join that puts it back: many levels
   * may share one cell id, and the stored results for that cell serve all of
   * them.
   */
  levels: LevelRef[]
}

export interface SuiteOptions {
  horizonDays?: number
  /** The numerically located gas boundary for the baseline cell. */
  gasBoundaryWei?: bigint
}

// ---------------------------------------------------------------------------
// A. baseline
// ---------------------------------------------------------------------------

export const BASELINE_SEEDS = 200

export function buildBaseline(options: SuiteOptions & { seeds?: number } = {}): Suite {
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS
  return {
    name: 'baseline',
    description:
      'The baseline cell at many seeds. Establishes the central estimate and the seed-variance noise band.',
    cells: [
      makeCell({
        label: 'baseline',
        axis: null,
        level: 'baseline',
        overrides: baselineOverrides(),
        seeds: seedRange(options.seeds ?? BASELINE_SEEDS),
        horizonDays,
      }),
    ],
    levels: [],
  }
}

// ---------------------------------------------------------------------------
// B. ofat
// ---------------------------------------------------------------------------

export const OFAT_SEEDS = 50

export function axesFor(options: SuiteOptions): Axis[] {
  const axes = [...STATIC_AXES]
  if (options.gasBoundaryWei !== undefined) axes.push(gasAxis(options.gasBoundaryWei))
  return axes
}

export function buildOfat(options: SuiteOptions & { seeds?: number } = {}): Suite {
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS
  const seeds = seedRange(options.seeds ?? OFAT_SEEDS)
  const cells: CellSpec[] = []
  const levels: LevelRef[] = []

  for (const axis of axesFor(options)) {
    for (const level of axis.levels) {
      const cell = makeCell({
        label: `${axis.name}=${level.label}`,
        axis: axis.name,
        level: level.label,
        overrides: level.overrides,
        seeds,
        horizonDays,
      })
      cells.push(cell)
      levels.push({ axis: axis.name, level: level.label, cellId: cell.id })
    }
  }

  // Several axes include the baseline as one of their levels. Deduping means
  // it is run once rather than a dozen times, and the ranking still has a
  // baseline point on every axis because they all resolve to the same id.
  return {
    name: 'ofat',
    description:
      'One factor at a time across its full range, everything else at baseline. Produces the sensitivity ranking.',
    cells: dedupeCells(cells),
    levels,
  }
}

// ---------------------------------------------------------------------------
// C. factorial
// ---------------------------------------------------------------------------

export const FACTORIAL_SEEDS = 30

/**
 * Full factorial over the named axes.
 *
 * Which three axes belong here is a result of suite B, not an assumption, so
 * the caller passes them in.
 */
export function buildFactorial(
  axisNames: readonly string[],
  options: SuiteOptions & { seeds?: number } = {},
): Suite {
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS
  const seeds = seedRange(options.seeds ?? FACTORIAL_SEEDS)
  const all = axesFor(options)
  const chosen = axisNames.map((name) => {
    const axis = all.find((a) => a.name === name)
    if (axis === undefined) throw new Error(`factorial: unknown axis ${name}`)
    return axis
  })

  let combos: Array<{ labels: string[]; overrides: ConfigOverrides }> = [
    { labels: [], overrides: baselineOverrides() },
  ]
  for (const axis of chosen) {
    const next: typeof combos = []
    for (const combo of combos) {
      for (const level of axis.levels) {
        next.push({
          labels: [...combo.labels, `${axis.name}=${level.label}`],
          overrides: { ...combo.overrides, ...level.overrides },
        })
      }
    }
    combos = next
  }

  return {
    name: 'factorial',
    description: `Full factorial over ${axisNames.join(', ')}. Where interactions show up.`,
    levels: combos.map((combo) => ({
      axis: axisNames.join('*'),
      level: combo.labels.join(' '),
      cellId: makeCell({
        label: combo.labels.join(' '),
        overrides: combo.overrides,
        seeds,
        horizonDays,
      }).id,
    })),
    cells: dedupeCells(
      combos.map((combo) =>
        makeCell({
          label: combo.labels.join(' '),
          axis: axisNames.join('*'),
          level: combo.labels.join(' '),
          overrides: combo.overrides,
          seeds,
          horizonDays,
        }),
      ),
    ),
  }
}

// ---------------------------------------------------------------------------
// D. sample
// ---------------------------------------------------------------------------

export const SAMPLE_CELLS = 1_500

/**
 * A Latin hypercube over every axis.
 *
 * Each axis is partitioned into as many strata as it has levels; every
 * stratum on every axis is visited the same number of times, and the
 * assignments are permuted independently per axis. That gives even marginal
 * coverage of each factor at a fraction of the cost of a factorial, which is
 * what an honest global claim needs — the point of this suite is to be able to
 * say how many cells in the whole space showed a difference and how many did
 * not, not to resolve any single interaction.
 */
export function buildSample(options: SuiteOptions & { cells?: number; seed?: number } = {}): Suite {
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS
  const count = options.cells ?? SAMPLE_CELLS
  const rng = createRng(options.seed ?? 20260911)
  const axes = axesFor(options)

  // One column of level indices per axis, balanced then shuffled.
  const columns = axes.map((axis) => {
    const column: number[] = []
    for (let i = 0; i < count; i++) column.push(i % axis.levels.length)
    for (let i = column.length - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1)
      const swap = column[i] as number
      column[i] = column[j] as number
      column[j] = swap
    }
    return column
  })

  const cells: CellSpec[] = []
  for (let row = 0; row < count; row++) {
    let overrides: ConfigOverrides = baselineOverrides()
    const labels: string[] = []
    for (let a = 0; a < axes.length; a++) {
      const axis = axes[a] as Axis
      const level = axis.levels[(columns[a] as number[])[row] as number] as Level
      overrides = { ...overrides, ...level.overrides }
      labels.push(`${axis.name}=${level.label}`)
    }
    cells.push(
      makeCell({
        label: labels.join(' '),
        axis: 'sample',
        level: labels.join(' '),
        overrides,
        seeds: [2_000_000 + row],
        horizonDays,
      }),
    )
  }

  return {
    name: 'sample',
    description:
      'Latin hypercube over the whole space, one seed each. Supports the global "N showed a difference, M did not" claim.',
    cells: dedupeCells(cells),
    levels: [],
  }
}

// ---------------------------------------------------------------------------

export function buildSuite(name: SuiteName, options: SuiteOptions = {}): Suite {
  switch (name) {
    case 'baseline':
      return buildBaseline(options)
    case 'ofat':
      return buildOfat(options)
    case 'factorial':
      throw new Error(
        'factorial: pass the top axes from suite B explicitly, via buildFactorial(axes)',
      )
    case 'sample':
      return buildSample(options)
  }
}

export function totalRuns(suite: Suite): number {
  return suite.cells.reduce((sum, cell) => sum + cell.seeds.length, 0)
}
