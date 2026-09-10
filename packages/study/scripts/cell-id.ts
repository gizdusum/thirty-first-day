/**
 * Print a cell id for a JSON-encoded set of overrides.
 *
 *   node --import tsx packages/study/scripts/cell-id.ts '{"licensesPerDay":50}' 90
 *
 * Exists so that the cross-process stability of `cellId` can be asserted by
 * actually using another process, rather than by assuming it.
 */
import { cellId } from '../src/cells.js'

const raw = process.argv[2] ?? '{}'
const horizon = Number(process.argv[3] ?? 90)
const revive = (_k: string, v: unknown): unknown =>
  typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v
console.log(cellId(JSON.parse(raw, revive) as Record<string, never>, horizon))
