/**
 * Does every axis actually reach the cell?
 *
 * A suite composes a cell by spreading one level from each axis over the
 * baseline, left to right. That is a shallow merge, and several axes own the
 * same key:
 *
 *   - `hunterCount`, `maxReportsPerHour` and `hunterGasCostEth` all write the
 *     whole `hunter` object, so the last one to be spread resets the fields
 *     the earlier ones set.
 *   - `payoutSellFraction` and `payoutSellOverHours` both write the whole
 *     `payout` object, the same way.
 *   - `postTransferCharterLimit` pins `charterTransfersEnabledAtDay` to 15 on
 *     purpose — the limit is inert while charters are soulbound — which also
 *     overwrites whatever the `charterTransfersEnabledAtDay` axis drew.
 *   - every level built through `withBase` re-injects the baseline's
 *     `externalDemand`, so any axis after `demandRegime` resets it to `mild`.
 *
 * One-factor-at-a-time suites are immune: they spread exactly one level, so
 * nothing can collide. It is the suites that vary several axes at once —
 * `factorial` and `sample` — where a level can be silently overwritten, and a
 * silently overwritten axis reports as a flat null rather than as an error.
 * That is the dangerous failure: a null is a publishable result.
 *
 * This checks, for every axis of a suite, whether the level a cell drew is
 * still present in that cell's composed overrides.
 *
 *   pnpm tsx packages/study/scripts/axis-audit.ts [suite]
 */

import { pathToFileURL } from 'node:url'

import type { Axis, Level } from '../src/config/axes.js'
import { baselineOverrides } from '../src/config/axes.js'
import { axesFor, buildFactorial, buildOfat, buildSample, type Suite } from '../src/suites.js'
import { readManifest } from '../src/storage.js'
import type { CellSpec } from '../src/cells.js'

const ROOT = process.cwd()
const HORIZON = 90

/** Stable stringify, bigints included, so nested config groups compare. */
function key(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
}

function gasBoundaryFromManifest(horizonDays: number): bigint {
  for (const entry of Object.values(readManifest(ROOT).suites)) {
    if (entry.gasBoundaryWei !== null && entry.horizonDays === horizonDays) {
      return BigInt(entry.gasBoundaryWei)
    }
  }
  throw new Error(`no manifest entry carries a gas boundary for a ${horizonDays}-day horizon`)
}

/**
 * The level a cell drew on an axis.
 *
 * Not a split on spaces: the gas axis labels its levels "4x boundary", and a
 * space-delimited parse drops that axis silently — which is the same class of
 * bug this script exists to catch.
 */
export function levelLabelFor(label: string, axisName: string): string | null {
  const match = new RegExp(`(?:^| )${axisName}=(.*?)(?= [A-Za-z][A-Za-z0-9]*=|$)`).exec(label)
  return match === null ? null : (match[1] as string)
}

/** The keys a level actually changes, ignoring the baseline every level carries. */
export function ownedKeys(level: Level): string[] {
  const base = baselineOverrides() as Record<string, unknown>
  const owned: string[] = []
  for (const [k, v] of Object.entries(level.overrides as Record<string, unknown>)) {
    if (key(v) !== key(base[k])) owned.push(k)
  }
  return owned
}

export interface AxisVerdict {
  axis: string
  levels: number
  reached: number
  clobbered: number
}

export function auditSuite(suite: Suite, axes: readonly Axis[]): AxisVerdict[] {
  const verdicts: AxisVerdict[] = []
  for (const axis of axes) {
    let reached = 0
    let clobbered = 0
    for (const cell of suite.cells as CellSpec[]) {
      const drawn = levelLabelFor(cell.label, axis.name)
      if (drawn === null) continue
      const level = axis.levels.find((l) => l.label === drawn)
      if (level === undefined) continue
      const owned = ownedKeys(level)
      // A level that is the baseline changes nothing and cannot be clobbered.
      if (owned.length === 0) {
        reached += 1
        continue
      }
      const actual = cell.overrides as Record<string, unknown>
      const want = level.overrides as Record<string, unknown>
      if (owned.every((k) => key(actual[k]) === key(want[k]))) reached += 1
      else clobbered += 1
    }
    verdicts.push({ axis: axis.name, levels: axis.levels.length, reached, clobbered })
  }
  return verdicts
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/*
 * Guarded so that importing `auditSuite` does not print a report. The suite D
 * reporter imports this to refuse to publish a dead axis as a null.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const options = { horizonDays: HORIZON, gasBoundaryWei: gasBoundaryFromManifest(HORIZON) }
  const axes = axesFor(options)

  const which = process.argv[2] ?? 'sample'
  const suite: Suite =
    which === 'ofat'
      ? buildOfat(options)
      : which === 'factorial'
        ? buildFactorial(
            (process.argv[3] ?? 'licensesPerDay,dormancyRate,epochDays').split(','),
            options,
          )
        : buildSample(options)

  console.log(`# axis audit — suite ${suite.name}, ${suite.cells.length} cells`)
  console.log('')
  console.log(
    `${'axis'.padEnd(30)}${'levels'.padStart(7)}${'reached'.padStart(9)}${'clobbered'.padStart(11)}  verdict`,
  )

  const verdicts = auditSuite(suite, axes)
  let dead = 0
  for (const v of verdicts) {
    const verdict =
      v.clobbered === 0
        ? 'ok'
        : v.reached === 0
          ? 'DEAD — no cell carries the drawn level'
          : `PARTIAL — ${v.clobbered} of ${v.reached + v.clobbered} cells lost it`
    if (v.clobbered > 0) dead += 1
    console.log(
      v.axis.padEnd(30) +
        String(v.levels).padStart(7) +
        String(v.reached).padStart(9) +
        String(v.clobbered).padStart(11) +
        '  ' +
        verdict,
    )
  }

  console.log('')
  if (dead === 0) {
    console.log(`every axis reaches every cell in suite ${suite.name}.`)
  } else {
    console.log(
      `${dead} of ${verdicts.length} axes are overwritten during composition in suite ${suite.name}.`,
    )
    console.log('Results on those axes are not nulls. They are the same configuration repeated.')
    process.exitCode = 1
  }
}
