/**
 * Where does the time go?
 *
 * Runs one 90-day world at the whitepaper defaults with the full study
 * population and reports a breakdown by phase. Not part of the runner; it
 * exists so that the optimisation work in `docs/performance.md` has numbers
 * behind it rather than guesses.
 *
 *   pnpm tsx packages/study/scripts/profile.ts [days] [charters]
 */

import { createWorld, populateGenesisCohort } from '@thirty-first-day/protocol'

const days = Number(process.argv[2] ?? 90)
const charters = Number(process.argv[3] ?? 1000)
const ticks = days * 24

function bench(label: string, fn: () => void): number {
  const start = process.hrtime.bigint()
  fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  console.log(`${label.padEnd(34)} ${ms.toFixed(0).padStart(8)} ms`)
  return ms
}

console.log(`profile: ${days} days (${ticks} ticks), ${charters} charters\n`)

// -- Whole run -------------------------------------------------------------
let total = 0
total = bench('full run (population + ticks)', () => {
  const world = createWorld({ genesisCharters: charters }, 20260910)
  populateGenesisCohort(world)
  for (let t = 0; t < ticks; t++) world.tick()
})

// -- With no agents at all: the engine floor -------------------------------
const engineOnly = bench('engine only (no agents)', () => {
  const world = createWorld({ genesisCharters: charters }, 20260910)
  for (let t = 0; t < ticks; t++) world.tick()
})

// -- Agents but no hunters -------------------------------------------------
const noHunters = bench('cohort, no hunters', () => {
  const world = createWorld({ genesisCharters: charters }, 20260910)
  populateGenesisCohort(world, { withHunters: false })
  for (let t = 0; t < ticks; t++) world.tick()
})

// -- Agents, no outside demand (so almost no swaps) ------------------------
const noDemand = bench('cohort, no outside demand', () => {
  const world = createWorld({ genesisCharters: charters }, 20260910)
  populateGenesisCohort(world, { withExternalDemand: false })
  for (let t = 0; t < ticks; t++) world.tick()
})

// -- Just the agent loop, actions discarded --------------------------------
const agentLoop = bench('agent decisions only', () => {
  const world = createWorld({ genesisCharters: charters }, 20260910)
  const { bankers } = populateGenesisCohort(world, {
    withHunters: false,
    withExternalDemand: false,
  })
  const views = bankers.map((b) => world.viewFor(b.id))
  const rngs = bankers.map((b) => world.rngFor(b.id, 'profile'))
  for (let t = 0; t < ticks; t++) {
    for (let i = 0; i < bankers.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      bankers[i]!.onTick(views[i]!, rngs[i]!)
    }
  }
})

// -- Snapshot cost in isolation -------------------------------------------
console.log('')
const world = createWorld({ genesisCharters: charters }, 20260910)
populateGenesisCohort(world)
for (let t = 0; t < ticks; t++) world.tick()
const state = world.state

let withdrawals = 0
let revocations = 0
let licenses = 0
let swaps = 0
{
  const w2 = createWorld({ genesisCharters: charters }, 20260910)
  populateGenesisCohort(w2)
  for (let t = 0; t < ticks; t++) {
    for (const e of w2.tick().events) {
      if (e.type === 'withdrawal') withdrawals++
      else if (e.type === 'revocation') revocations++
      else if (e.type === 'licenseSold') licenses++
      else if (e.type === 'swap') swaps++
    }
  }
}

console.log(`events: withdrawals=${withdrawals} revocations=${revocations} licenses=${licenses} swaps=${swaps}`)
console.log(`final branches=${state.totalBranches} liveCharters=${state.liveCharters}`)
console.log('')
console.log('redistribution work (branch-touches):')
console.log(`  ~${((withdrawals + revocations) * state.totalBranches).toLocaleString()} settle+share ops`)
console.log('')
console.log(`derived: agent loop ${((agentLoop / total) * 100).toFixed(0)}% of full run`)
console.log(`derived: engine floor ${((engineOnly / total) * 100).toFixed(0)}% of full run`)
console.log(`derived: hunters cost ${(total - noHunters).toFixed(0)} ms`)
console.log(`derived: outside demand costs ${(total - noDemand).toFixed(0)} ms`)
console.log(`\nfull paired run (3 arms) would be ~${((total * 3) / 1000).toFixed(1)} s`)
