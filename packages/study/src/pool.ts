/**
 * A worker pool.
 *
 * The grid is embarrassingly parallel — every task is a self-contained
 * deterministic function of `(overrides, seed, horizonDays)` — so the pool is
 * a queue and a handful of threads, with no shared state to get wrong.
 *
 * Default size is `os.cpus().length - 1`, leaving one core for the main thread
 * that is writing results to disk.
 */

import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import type { ConfigOverrides } from '@thirty-first-day/protocol'

import { runOne, toRunResult, type RunResult } from './runCell.js'
import type { WorkerReply, WorkerTask } from './worker.js'

export interface Task {
  cellId: string
  overrides: ConfigOverrides
  seed: number
  horizonDays: number
}

export interface PoolOptions {
  workers?: number
  /** Called on the main thread as each result lands, in completion order. */
  onResult?: (result: RunResult, info: { ms: number; done: number; total: number }) => void
}

export function defaultWorkerCount(): number {
  return Math.max(1, cpus().length - 1)
}

/** Run every task in the calling thread. The reference implementation. */
export function runTasksSerial(tasks: readonly Task[], options: PoolOptions = {}): RunResult[] {
  const results: RunResult[] = []
  for (const task of tasks) {
    const started = Date.now()
    const result = toRunResult(runOne(task.overrides, task.seed, task.horizonDays))
    results.push(result)
    options.onResult?.(result, { ms: Date.now() - started, done: results.length, total: tasks.length })
  }
  return results
}

/**
 * Run every task across a pool of workers.
 *
 * Results are delivered to `onResult` in completion order, which is not task
 * order — but each result carries its own cell id and seed, and the storage
 * layer keys on those, so nothing downstream depends on ordering.
 */
export async function runTasksPooled(
  tasks: readonly Task[],
  options: PoolOptions = {},
): Promise<RunResult[]> {
  if (tasks.length === 0) return []
  const size = Math.max(1, Math.min(options.workers ?? defaultWorkerCount(), tasks.length))
  if (size === 1) return runTasksSerial(tasks, options)

  const workerUrl = new URL('./worker.ts', import.meta.url)
  const workerPath = fileURLToPath(workerUrl)
  const isTypeScript = workerPath.endsWith('.ts')

  const results: RunResult[] = []
  let next = 0
  let done = 0

  return new Promise<RunResult[]>((resolve, reject) => {
    const workers: Worker[] = []
    let failed = false

    const shutdown = (): void => {
      for (const worker of workers) void worker.terminate()
    }

    const dispatch = (worker: Worker): void => {
      if (failed) return
      if (next >= tasks.length) {
        void worker.terminate()
        return
      }
      const task = tasks[next] as Task
      const message: WorkerTask = {
        taskId: next,
        cellId: task.cellId,
        overrides: task.overrides,
        seed: task.seed,
        horizonDays: task.horizonDays,
      }
      next += 1
      worker.postMessage(message)
    }

    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerPath, {
        // tsx compiles the worker on the fly when the package is run from
        // source; a compiled deployment needs no loader.
        execArgv: isTypeScript ? ['--import', 'tsx'] : [],
      })
      workers.push(worker)

      worker.on('message', (reply: WorkerReply) => {
        if (failed) return
        if (!reply.ok) {
          failed = true
          shutdown()
          reject(new Error(`worker task ${reply.taskId} failed: ${reply.error}`))
          return
        }
        results.push(reply.result)
        done += 1
        options.onResult?.(reply.result, { ms: reply.ms, done, total: tasks.length })
        if (done === tasks.length) {
          shutdown()
          resolve(results)
          return
        }
        dispatch(worker)
      })

      worker.on('error', (error: Error) => {
        if (failed) return
        failed = true
        shutdown()
        reject(error)
      })

      dispatch(worker)
    }
  })
}
