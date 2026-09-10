import { createWorld, populateGenesisCohort } from '@thirty-first-day/protocol'
const world = createWorld({ genesisCharters: 1000 }, 20260910)
populateGenesisCohort(world)
for (let t = 0; t < 2160; t++) world.tick()
console.log('done', world.state.totalBranches)
