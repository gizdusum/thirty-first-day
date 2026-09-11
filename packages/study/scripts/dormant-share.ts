/**
 * The dormant cohort's share of charters and of branches, on day 31.
 *
 * This is the number the report leans on hardest in finding three, and it was
 * originally read off a single seed. A single seed is an anecdote. This runs
 * the baseline cell's treatment arm to the wave and reports the distribution.
 *
 * Only one arm, and only to day 31, so it is cheap.
 *
 *   pnpm tsx packages/study/scripts/dormant-share.ts [seeds]
 */

import { createWorld, dormancyTicks, populateGenesisCohort, resolveConfig } from '@thirty-first-day/protocol'

import { summarise } from '../src/aggregate.js'
import { baselineOverrides } from '../src/config/axes.js'

const count = Number(process.argv[2] ?? 30)
const cfg = resolveConfig(baselineOverrides())
const target = dormancyTicks(cfg)

const charterShare: number[] = []
const branchShare: number[] = []
const reportable: number[] = []

for (let i = 0; i < count; i++) {
  const world = createWorld(baselineOverrides(), 1_000_000 + i)
  populateGenesisCohort(world)
  for (let t = 0; t < target; t++) world.tick()
  const s = world.history[world.history.length - 1]
  if (s === undefined) throw new Error('no snapshot')
  if (s.tick !== target) throw new Error(`expected tick ${target}, got ${s.tick}`)
  charterShare.push((Number(s.dormantCohort.charterShare) / 1e18) * 100)
  branchShare.push((Number(s.dormantCohort.branchShare) / 1e18) * 100)
  reportable.push(s.reportableCharters)
}

const show = (name: string, xs: number[], dp: number) => {
  const s = summarise(xs)
  console.log(
    `${name.padEnd(26)}${s.mean.toFixed(dp).padStart(9)}   CI [${s.ci95[0].toFixed(dp)}, ${s.ci95[1].toFixed(dp)}]   min ${s.min.toFixed(dp)}  max ${s.max.toFixed(dp)}`,
  )
}

console.log(`day 31 (tick ${target}), baseline cell, ${count} seeds, treatment arm\n`)
show('reportable charters', reportable, 1)
show('share of live charters %', charterShare, 2)
show('share of live branches %', branchShare, 2)
