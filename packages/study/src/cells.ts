/**
 * Cells: one point in the experiment grid.
 *
 * A cell is a set of config overrides plus a horizon. Running it means running
 * every seed in its list as a three-arm study (control, treatment,
 * noPayoutSell) and reporting differences, never levels alone.
 */

import { DEFAULT_CONFIG, resolveConfig, type ConfigOverrides } from '@thirty-first-day/protocol'

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
 * The part of a resolved configuration that differs from the defaults.
 *
 * Recursive, so a nested object contributes only the leaves that actually
 * moved. `{}` means "the defaults", however many fields the defaults happen to
 * have.
 */
export function configDiff(value: unknown, base: unknown = DEFAULT_CONFIG): unknown {
  if (value === base) return undefined
  if (
    value !== null &&
    base !== null &&
    typeof value === 'object' &&
    typeof base === 'object' &&
    !Array.isArray(value) &&
    !Array.isArray(base) &&
    !(value instanceof Map)
  ) {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const delta = configDiff(inner, (base as Record<string, unknown>)[key])
      if (delta !== undefined) out[key] = delta
    }
    return Object.keys(out).length === 0 ? undefined : out
  }
  return canonicalJson(value) === canonicalJson(base) ? undefined : value
}

/**
 * A cell's id.
 *
 * Derived from the horizon and from **how the resolved configuration differs
 * from the defaults** — not from the literal overrides object, and not from
 * the whole resolved configuration. Three properties, each of which was
 * learned by getting it wrong first:
 *
 *  - The horizon is included, because `replay <cellId> <seed>` has to
 *    reproduce a stored result exactly and two cells with the same config but
 *    different horizons do not produce the same result.
 *  - The config is **resolved** before the diff is taken, so
 *    `{ licensesPerDay: 100 }` — which is the default — gets the same id as
 *    `{}`. Otherwise every one-factor sweep would re-run the baseline under a
 *    different id purely because it spelled a default value out.
 *  - Only the **diff** is hashed, so adding a new configuration field with a
 *    default cannot move the id of any cell that leaves it alone. Hashing the
 *    whole resolved config meant that adding the seat market to the protocol
 *    silently orphaned every result the study had already computed. It is
 *    stored data; it should not be hostage to a schema addition.
 *
 * The trade this makes: if a *default value* changes, ids do not change even
 * though results would. That is what `provenance.protocolVersion` and the
 * manifest's git SHA are for — a default is a change to the model, and a
 * change to the model is a change to the code.
 *
 * The label, the axis name and the seed list are all excluded, so renaming a
 * cell or adding seeds to it never invalidates work already done.
 */
export function cellId(overrides: ConfigOverrides, horizonDays: number): string {
  const diff = configDiff(resolveConfig(overrides)) ?? {}
  return contentHash(canonicalJson({ horizonDays, diff })).slice(0, 16)
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
