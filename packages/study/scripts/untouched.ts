/**
 * Proof that the seat market did not disturb the suites already run.
 *
 * Adding configuration to a protocol changes the resolved configuration of
 * every cell, which is exactly why cell ids are derived from the *difference*
 * from the defaults rather than from the whole thing. This checks the claim
 * rather than asserting it: it takes a result stored before whitepaper 12 was
 * modelled, strips the fields this prompt added from the configuration as it
 * stands now, and compares the two hashes directly.
 *
 *   pnpm tsx packages/study/scripts/untouched.ts
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveConfig } from '@thirty-first-day/protocol'

import { canonicalJson, cellId, configDiff, contentHash } from '../src/cells.js'
import { baselineOverrides } from '../src/config/axes.js'
import { armsFor } from '@thirty-first-day/protocol'
import { parse, readCellResults, readManifest } from '../src/storage.js'
import type { RunResult } from '../src/runCell.js'

const ROOT = resolve(process.cwd())
const ADDED_BY_THIS_PROMPT = ['charterTransfersEnabledAtDay', 'postTransferCharterLimit', 'seat']

const manifest = readManifest(ROOT)
const baselineEntry = manifest.suites['baseline']
if (baselineEntry === undefined) throw new Error('no baseline suite in the manifest')
const storedCellId = baselineEntry.cells[0]?.id
if (storedCellId === undefined) throw new Error('no baseline cell recorded')

const stored: RunResult[] = readCellResults(ROOT, 'baseline', storedCellId)
if (stored.length === 0) throw new Error(`no stored results for ${storedCellId}`)
const storedConfigHash = stored[0]!.provenance.configHash

// The configuration as it stands now, with this prompt's additions removed.
const now = resolveConfig(baselineOverrides()) as unknown as Record<string, unknown>
const restricted: Record<string, unknown> = {}
for (const [key, value] of Object.entries(now)) {
  if (!ADDED_BY_THIS_PROMPT.includes(key)) restricted[key] = value
}
const restrictedHash = contentHash(canonicalJson(restricted))

console.log('THE BASELINE CELL, BEFORE AND AFTER THE SEAT MARKET')
console.log('='.repeat(74))
console.log(`stored results                     ${stored.length} seeds in runs/baseline/${storedCellId}.jsonl`)
console.log('')
console.log('config hash of the resolved configuration')
console.log(`  recorded in a stored result      ${storedConfigHash}`)
console.log(`  now, minus this prompt's fields  ${restrictedHash}`)
console.log(`  identical                        ${storedConfigHash === restrictedHash ? 'YES' : 'NO'}`)
console.log('')
console.log('the fields this prompt added, and their values in the baseline')
for (const key of ADDED_BY_THIS_PROMPT) {
  const value = now[key]
  const shown =
    value === null ? 'null' : typeof value === 'object' ? '{ ...defaults }' : String(value)
  console.log(`  ${key.padEnd(30)} ${shown}`)
}
console.log('')
console.log('difference from the defaults (what the cell id is derived from)')
console.log(`  baseline diff                    ${JSON.stringify(configDiff(resolveConfig(baselineOverrides()))) ?? '{} (none)'}`)
console.log(`  cell id under diff hashing       ${cellId(baselineOverrides(), 90)}`)
console.log(`  cell id recorded before          ${storedCellId}   (whole-config hashing)`)
console.log('')
console.log('arms built for a cell that does not name the transfer switch')
const soulboundArms = armsFor(resolveConfig(baselineOverrides()))
console.log(`  ${soulboundArms.join(', ')}   -> ${soulboundArms.length} arms`)
const transferArms = armsFor(resolveConfig({ ...baselineOverrides(), charterTransfersEnabledAtDay: 15 }))
console.log(`  with the switch at day 15: ${transferArms.join(', ')}   -> ${transferArms.length} arms`)
console.log('')
const ok = storedConfigHash === restrictedHash && soulboundArms.length === 3
console.log(ok ? 'UNTOUCHED.' : 'SOMETHING MOVED — investigate before trusting suite A or B.')
process.exitCode = ok ? 0 : 1
void parse
