/**
 * Cells: one point in the experiment grid.
 *
 * A cell is a set of config overrides plus a horizon. Running it means running
 * every seed in its list as a three-arm study (control, treatment,
 * noPayoutSell) and reporting differences, never levels alone.
 */

import { resolveConfig, type ConfigOverrides } from '@thirty-first-day/protocol'

export interface CellSpec {
  /** Stable, content-derived. See `cellId`. */
  id: string
  /** A human-readable name. Not part of the id. */
  label: string
  /** Which axis this cell varies, for the sensitivity ranking. `null` = baseline. */
  axis: string | null
  /** The axis value, as a display string. */
  level: string
  overrides: ConfigOverrides
  seeds: number[]
  horizonDays: number
}

// ---------------------------------------------------------------------------
// Canonical serialisation
// ---------------------------------------------------------------------------

/**
 * A canonical JSON form: object keys sorted, bigints tagged, undefined dropped.
 *
 * Two configs that mean the same thing must serialise identically regardless
 * of the order their keys were written in, or cell ids would depend on the
 * order a suite builder happened to spread its overrides.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'bigint') return `"${value.toString()}n"`
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : `"${value}"`
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return 'null'
}

/**
 * A 128-bit FNV-1a-style hash, written out rather than taken from `node:crypto`
 * so that the id definition is fully visible here and cannot drift with a
 * platform's default digest. Stability across processes and machines is the
 * whole point: `replay <cellId> <seed>` has to find the same cell tomorrow.
 */
export function contentHash(input: string): string {
  // Four independent 32-bit FNV-1a lanes with different offset bases.
  const bases = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
  const lanes = bases.slice()
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    for (let l = 0; l < 4; l++) {
      lanes[l] = (lanes[l] as number) ^ ((code + l * 7) & 0xffff)
      lanes[l] = Math.imul(lanes[l] as number, 0x01000193) >>> 0
      lanes[l] = ((lanes[l] as number) ^ ((lanes[l] as number) >>> 15)) >>> 0
    }
  }
  return lanes.map((l) => (l >>> 0).toString(16).padStart(8, '0')).join('')
}

/**
 * A cell's id.
 *
 * Derived from the **resolved** config and the horizon, not from the literal
 * overrides object. Two deviations from the obvious definition, both
 * deliberate:
 *
 *  - The horizon is included, because `replay <cellId> <seed>` has to
 *    reproduce a stored result exactly and two cells with the same config but
 *    different horizons do not produce the same result.
 *  - The config is resolved first, so that `{ licensesPerDay: 100 }` — which
 *    is the default — gets the same id as `{}`. Otherwise every one-factor
 *    sweep would re-run the baseline under a different id purely because it
 *    spelled a default value out. The id therefore changes if and only if the
 *    *effective configuration* changes, which is the property that actually
 *    matters: two cells share an id exactly when they would produce identical
 *    runs.
 *
 * The label, the axis name and the seed list are all excluded, so renaming a
 * cell or adding seeds to it never invalidates work already done.
 */
export function cellId(overrides: ConfigOverrides, horizonDays: number): string {
  return contentHash(canonicalJson({ horizonDays, config: resolveConfig(overrides) })).slice(0, 16)
}

export interface MakeCellOptions {
  label: string
  axis?: string | null
  level?: string
  overrides: ConfigOverrides
  seeds: number[]
  horizonDays?: number
}

export const DEFAULT_HORIZON_DAYS = 90

export function makeCell(options: MakeCellOptions): CellSpec {
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS
  return {
    id: cellId(options.overrides, horizonDays),
    label: options.label,
    axis: options.axis ?? null,
    level: options.level ?? '',
    overrides: options.overrides,
    seeds: options.seeds,
    horizonDays,
  }
}

/**
 * Merge cells that resolve to the same id, unioning their seed lists.
 *
 * One-factor-at-a-time sweeps regenerate the baseline level on every axis;
 * without this, the baseline would be run a dozen times over.
 */
export function dedupeCells(cells: readonly CellSpec[]): CellSpec[] {
  const byId = new Map<string, CellSpec>()
  for (const cell of cells) {
    const existing = byId.get(cell.id)
    if (existing === undefined) {
      byId.set(cell.id, { ...cell, seeds: [...cell.seeds] })
      continue
    }
    const seeds = new Set(existing.seeds)
    for (const seed of cell.seeds) seeds.add(seed)
    existing.seeds = [...seeds].sort((a, b) => a - b)
  }
  return [...byId.values()]
}

/** A deterministic seed list: `count` seeds starting from `base`. */
export function seedRange(count: number, base = 1_000_000): number[] {
  const seeds: number[] = []
  for (let i = 0; i < count; i++) seeds.push(base + i)
  return seeds
}
