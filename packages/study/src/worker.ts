/**
 * Worker entry point.
 *
 * Receives one task at a time and returns the storable part of the run. The
 * hourly history never leaves the worker; only the derived metrics cross the
 * thread boundary, which is what keeps the pool's memory flat.
 *
 * Every task is fully determined by `(overrides, seed, horizonDays)`, so a
 * worker's results are byte-identical to running the same task in the main
 * thread. `pool.spec.ts` asserts that.
 */

import { parentPort } from 'node:worker_threads'

import type { ConfigOverrides } from '@thirty-first-day/protocol'

import { runOne, toRunResult, type RunResult } from './runCell.js'

export interface WorkerTask {
  taskId: number
  cellId: string
  overrides: ConfigOverrides
  seed: number
  horizonDays: number
}

export type WorkerReply =
  | { taskId: number; ok: true; result: RunResult; ms: number }
  | { taskId: number; ok: false; error: string }

if (parentPort !== null) {
  const port = parentPort
  port.on('message', (task: WorkerTask) => {
    const started = Date.now()
    try {
      const run = runOne(task.overrides, task.seed, task.horizonDays)
      const reply: WorkerReply = {
        taskId: task.taskId,
        ok: true,
        result: toRunResult(run),
        ms: Date.now() - started,
      }
      port.postMessage(reply)
    } catch (error: unknown) {
      const reply: WorkerReply = {
        taskId: task.taskId,
        ok: false,
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      }
      port.postMessage(reply)
    }
  })
}
