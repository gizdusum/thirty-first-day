/**
 * Storage: results stream out as they finish, nothing accumulates in memory.
 *
 * One JSONL file per cell, one line per seed. A run that is interrupted is
 * resumed by reading back which seeds already have a line and skipping them,
 * so the unit of lost work is one seed rather than one suite.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { CellSpec } from './cells.js'
import type { RunResult } from './runCell.js'
import type { Suite } from './suites.js'

export const RUNS_DIR = 'runs'

// ---------------------------------------------------------------------------
// bigint-safe JSON
// ---------------------------------------------------------------------------

/**
 * bigints become `"<digits>n"`.
 *
 * A plain string could of course already look like that, so strings that would
 * be ambiguous are escaped with a leading `~` on the way out and unescaped on
 * the way back. Without that, storing the literal string `"12n"` would read
 * back as the number 12 — which is the kind of quiet corruption that would not
 * surface until someone tried to reproduce a figure.
 */
const BIGINT_LITERAL = /^-?\d+n$/
const ESCAPED_LITERAL = /^~+-?\d+n$/

export function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return `${v}n`
    if (typeof v === 'string' && (BIGINT_LITERAL.test(v) || ESCAPED_LITERAL.test(v))) return `~${v}`
    return v
  })
}

export function parse<T>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (typeof v !== 'string') return v
    if (BIGINT_LITERAL.test(v)) return BigInt(v.slice(0, -1))
    if (ESCAPED_LITERAL.test(v)) return v.slice(1)
    return v
  }) as T
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function suiteDir(root: string, suite: string): string {
  return join(root, RUNS_DIR, suite)
}

export function cellPath(root: string, suite: string, cellId: string): string {
  return join(suiteDir(root, suite), `${cellId}.jsonl`)
}

export function manifestPath(root: string): string {
  return join(root, RUNS_DIR, 'manifest.json')
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function appendResult(root: string, suite: string, result: RunResult): void {
  const dir = suiteDir(root, suite)
  mkdirSync(dir, { recursive: true })
  appendFileSync(cellPath(root, suite, result.cellId), `${stringify(result)}\n`)
}

/**
 * Seeds already recorded for a cell.
 *
 * A trailing partial line — the signature of a process killed mid-write — is
 * ignored rather than treated as an error, and will simply be re-run.
 */
export function completedSeeds(root: string, suite: string, cellId: string): Set<number> {
  const path = cellPath(root, suite, cellId)
  const done = new Set<number>()
  if (!existsSync(path)) return done
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      done.add(parse<RunResult>(line).seed)
    } catch {
      // A torn final line. Leave it out; the seed gets re-run.
    }
  }
  return done
}

export function readCellResults(root: string, suite: string, cellId: string): RunResult[] {
  const path = cellPath(root, suite, cellId)
  if (!existsSync(path)) return []
  const results: RunResult[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      results.push(parse<RunResult>(line))
    } catch {
      /* torn line */
    }
  }
  // Deduplicate by seed, keeping the first: a crash between the append and the
  // manifest update can leave a seed recorded twice.
  const bySeed = new Map<number, RunResult>()
  for (const result of results) if (!bySeed.has(result.seed)) bySeed.set(result.seed, result)
  return [...bySeed.values()].sort((a, b) => a.seed - b.seed)
}

export function listCellFiles(root: string, suite: string): string[] {
  const dir = suiteDir(root, suite)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface SuiteManifest {
  suite: string
  description: string
  protocolVersion: string
  gitSha: string
  machine: { platform: string; arch: string; cpus: number; node: string }
  horizonDays: number
  gasBoundaryWei: string | null
  cells: Array<{ id: string; label: string; axis: string | null; level: string; seeds: number }>
  totalRuns: number
  startedAt: string
  finishedAt: string | null
}

export interface Manifest {
  suites: Record<string, SuiteManifest>
}

export function readManifest(root: string): Manifest {
  const path = manifestPath(root)
  if (!existsSync(path)) return { suites: {} }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest
  } catch {
    return { suites: {} }
  }
}

/** Written via a temp file and a rename, so an interrupt cannot truncate it. */
export function writeManifest(root: string, manifest: Manifest): void {
  const path = manifestPath(root)
  mkdirSync(join(root, RUNS_DIR), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(temp, path)
}

export function upsertSuiteManifest(root: string, entry: SuiteManifest): void {
  const manifest = readManifest(root)
  manifest.suites[entry.suite] = entry
  writeManifest(root, manifest)
}

/**
 * Everything about a suite manifest that must not depend on when it was run.
 *
 * An interrupted-and-resumed suite must produce the same fingerprint as one
 * that ran straight through; only the timestamps may differ.
 */
export function manifestFingerprint(entry: SuiteManifest): string {
  return stringify({
    suite: entry.suite,
    description: entry.description,
    protocolVersion: entry.protocolVersion,
    horizonDays: entry.horizonDays,
    gasBoundaryWei: entry.gasBoundaryWei,
    cells: entry.cells,
    totalRuns: entry.totalRuns,
  })
}

export function suiteManifestFor(
  suite: Suite,
  extras: {
    protocolVersion: string
    gitSha: string
    machine: SuiteManifest['machine']
    horizonDays: number
    gasBoundaryWei: bigint | null
    startedAt: string
  },
): SuiteManifest {
  return {
    suite: suite.name,
    description: suite.description,
    protocolVersion: extras.protocolVersion,
    gitSha: extras.gitSha,
    machine: extras.machine,
    horizonDays: extras.horizonDays,
    gasBoundaryWei: extras.gasBoundaryWei === null ? null : extras.gasBoundaryWei.toString(),
    cells: suite.cells.map((cell: CellSpec) => ({
      id: cell.id,
      label: cell.label,
      axis: cell.axis,
      level: cell.level,
      seeds: cell.seeds.length,
    })),
    totalRuns: suite.cells.reduce((sum, cell) => sum + cell.seeds.length, 0),
    startedAt: extras.startedAt,
    finishedAt: null,
  }
}
