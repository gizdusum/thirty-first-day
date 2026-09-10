/**
 * Executing a suite.
 *
 * Split out of the CLI so that the resume path is testable without a shell:
 * an interrupted suite and an uninterrupted one must end up in the same state,
 * and that is a property worth asserting rather than hoping for.
 */

import { cpus } from 'node:os'

import type { CellSpec } from './cells.js'
import { runTasksPooled, runTasksSerial, defaultWorkerCount, type Task } from './pool.js'
import { PROTOCOL_VERSION, type RunResult } from './runCell.js'
import {
  appendResult,
  completedSeeds,
  suiteManifestFor,
  upsertSuiteManifest,
  type SuiteManifest,
} from './storage.js'
import type { Suite } from './suites.js'

export interface ExecuteOptions {
  root: string
  suite: Suite
  /** Restrict to these cell ids. */
  cellIds?: readonly string[]
  /** Restrict to these seeds, for a deliberately partial run. */
  seeds?: readonly number[]
  workers?: number
  gitSha?: string
  gasBoundaryWei?: bigint | null
  onResult?: (result: RunResult, info: { ms: number; done: number; total: number }) => void
}

export interface ExecuteReport {
  ran: number
  skipped: number
  seconds: number
  manifest: SuiteManifest
}

export function machineInfo(): SuiteManifest['machine'] {
  return {
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    node: process.version,
  }
}

/** The tasks a suite still owes, after removing everything already recorded. */
export function pendingTasks(
  root: string,
  suite: Suite,
  cellIds?: readonly string[],
  seeds?: readonly number[],
): { tasks: Task[]; skipped: number } {
  const cells: CellSpec[] =
    cellIds === undefined ? suite.cells : suite.cells.filter((c) => cellIds.includes(c.id))
  const tasks: Task[] = []
  let skipped = 0
  for (const cell of cells) {
    const done = completedSeeds(root, suite.name, cell.id)
    for (const seed of cell.seeds) {
      if (seeds !== undefined && !seeds.includes(seed)) continue
      if (done.has(seed)) {
        skipped += 1
        continue
      }
      tasks.push({ cellId: cell.id, overrides: cell.overrides, seed, horizonDays: cell.horizonDays })
    }
  }
  return { tasks, skipped }
}

export async function executeSuite(options: ExecuteOptions): Promise<ExecuteReport> {
  const { root, suite } = options
  const horizonDays = suite.cells[0]?.horizonDays ?? 90
  const { tasks, skipped } = pendingTasks(root, suite, options.cellIds, options.seeds)

  const manifest = suiteManifestFor(suite, {
    protocolVersion: PROTOCOL_VERSION,
    gitSha: options.gitSha ?? 'unknown',
    machine: machineInfo(),
    horizonDays,
    gasBoundaryWei: options.gasBoundaryWei ?? null,
    startedAt: new Date().toISOString(),
  })
  upsertSuiteManifest(root, manifest)

  const started = Date.now()
  if (tasks.length > 0) {
    const onResult = (result: RunResult, info: { ms: number; done: number; total: number }): void => {
      appendResult(root, suite.name, result)
      options.onResult?.(result, info)
    }
    const workers = options.workers ?? defaultWorkerCount()
    if (workers <= 1) runTasksSerial(tasks, { onResult })
    else await runTasksPooled(tasks, { workers, onResult })
  }

  const finished: SuiteManifest = { ...manifest, finishedAt: new Date().toISOString() }
  upsertSuiteManifest(root, finished)

  return {
    ran: tasks.length,
    skipped,
    seconds: (Date.now() - started) / 1000,
    manifest: finished,
  }
}
