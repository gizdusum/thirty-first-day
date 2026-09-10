/**
 * A first look at the transfer switch: one seed, no grid.
 *
 * The comparison is properly paired — a single run builds both the soulbound
 * `treatment` arm and the `transferable` arm from the same seed, with the same
 * agents making the same decisions everywhere the switch is irrelevant. This
 * is one point, not a result; the shape of the curve across switch days is
 * what suite B is for.
 *
 *   pnpm tsx packages/study/scripts/first-look.ts [switchDay] [seed] [days]
 */

import { runOne } from '../src/runCell.js'
import { baselineOverrides } from '../src/config/axes.js'

const switchDay = Number(process.argv[2] ?? 15)
const seed = Number(process.argv[3] ?? 1_000_000)
const days = Number(process.argv[4] ?? 32)

const started = Date.now()
const run = runOne(
  { ...baselineOverrides(), charterTransfersEnabledAtDay: switchDay },
  seed,
  days,
)
const treatment = run.daily.treatment ?? []
const transferable = run.daily.transferable ?? []
const at = (series: typeof treatment, day: number) => series[day - 1]

const tok = (v: bigint) => (Number(v) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 })
const eth = (v: bigint) => (Number(v) / 1e18).toFixed(3)

console.log(`FIRST LOOK — charterTransfersEnabledAtDay: null vs ${switchDay}`)
console.log('='.repeat(78))
console.log(`seed ${seed}, ${days} days, 1000 genesis charters, mild demand`)
console.log(`arms built: ${run.arms.join(', ')}     (${((Date.now() - started) / 1000).toFixed(1)}s)`)
console.log(`cell ${run.cellId}   replay: pnpm study replay ${run.cellId} ${seed} --horizon=${days}`)
console.log('')

const day31 = Math.min(31, days)
const t31 = at(treatment, day31)
const x31 = at(transferable, day31)
const tEnd = at(treatment, days)
const xEnd = at(transferable, days)
if (t31 === undefined || x31 === undefined || tEnd === undefined || xEnd === undefined) {
  throw new Error('horizon too short')
}

const row = (label: string, a: string, b: string, delta: string) =>
  console.log(`${label.padEnd(34)}${a.padStart(14)}${b.padStart(14)}${delta.padStart(14)}`)

console.log(`${'at day ' + day31}`)
console.log('-'.repeat(78))
row('metric', 'soulbound', `switch d${switchDay}`, 'difference')
row('revocations to date', String(t31.cumulativeRevoked), String(x31.cumulativeRevoked), String(x31.cumulativeRevoked - t31.cumulativeRevoked))
row('reportable charters', String(t31.reportableCharters), String(x31.reportableCharters), String(x31.reportableCharters - t31.reportableCharters))
row('total branches', String(t31.totalBranches), String(x31.totalBranches), String(x31.totalBranches - t31.totalBranches))
row('live charters', String(t31.liveCharters), String(x31.liveCharters), String(x31.liveCharters - t31.liveCharters))
row('minted to wallets', tok(t31.mintedToWallets), tok(x31.mintedToWallets), tok(x31.mintedToWallets - t31.mintedToWallets))
row('revocation-fee burn', tok(t31.burnsBySource.revocationFee), tok(x31.burnsBySource.revocationFee), tok(x31.burnsBySource.revocationFee - t31.burnsBySource.revocationFee))
row('payout sold into pool (ETH)', eth(t31.ethVolumeByOrigin.revocationPayout), eth(x31.ethVolumeByOrigin.revocationPayout), eth(x31.ethVolumeByOrigin.revocationPayout - t31.ethVolumeByOrigin.revocationPayout))
row('seat market volume (ETH)', eth(t31.seatMarketEthVolume), eth(x31.seatMarketEthVolume), eth(x31.seatMarketEthVolume - t31.seatMarketEthVolume))
row('seat sales', String(t31.cumulativeSeatSales), String(x31.cumulativeSeatSales), String(x31.cumulativeSeatSales - t31.cumulativeSeatSales))
console.log('')

console.log(`at day ${days}`)
console.log('-'.repeat(78))
row('metric', 'soulbound', `switch d${switchDay}`, 'difference')
row('revocations to date', String(tEnd.cumulativeRevoked), String(xEnd.cumulativeRevoked), String(xEnd.cumulativeRevoked - tEnd.cumulativeRevoked))

row('total branches', String(tEnd.totalBranches), String(xEnd.totalBranches), String(xEnd.totalBranches - tEnd.totalBranches))
row('minted to wallets', tok(tEnd.mintedToWallets), tok(xEnd.mintedToWallets), tok(xEnd.mintedToWallets - tEnd.mintedToWallets))
row('yield per branch per day', tok(tEnd.yieldPerBranchPerDay), tok(xEnd.yieldPerBranchPerDay), tok(xEnd.yieldPerBranchPerDay - tEnd.yieldPerBranchPerDay))
row('multiplier', (Number(tEnd.multiplier) / 1e18).toFixed(4), (Number(xEnd.multiplier) / 1e18).toFixed(4), (Number(xEnd.multiplier - tEnd.multiplier) / 1e18).toFixed(4))
row('seat market volume (ETH)', eth(tEnd.seatMarketEthVolume), eth(xEnd.seatMarketEthVolume), eth(xEnd.seatMarketEthVolume - tEnd.seatMarketEthVolume))
row('trader volume, cum. (ETH)', eth(tEnd.ethVolumeByOrigin.trader), eth(xEnd.ethVolumeByOrigin.trader), eth(xEnd.ethVolumeByOrigin.trader - tEnd.ethVolumeByOrigin.trader))
row('pool ETH reserve', eth(tEnd.poolEthReserve), eth(xEnd.poolEthReserve), eth(xEnd.poolEthReserve - tEnd.poolEthReserve))
console.log('')
console.log(`  the blind spot, as a share of all sell-side pool volume the signal did see:`)
console.log(`    ${((Number(xEnd.seatMarketEthVolume) / Number(xEnd.ethVolumeByOrigin.trader + xEnd.ethVolumeByOrigin.retirement + xEnd.ethVolumeByOrigin.revocationPayout)) * 100).toFixed(1)}%`)
console.log(`  and as a share of the pool's own ETH reserve: ${((Number(xEnd.seatMarketEthVolume) / Number(xEnd.poolEthReserve)) * 100).toFixed(1)}%`)
console.log('')

const transfer = run.metrics.transfer
if (transfer !== null) {
  console.log('transfer metrics (transferable vs treatment)')
  console.log('-'.repeat(78))
  console.log(`  revocationsAvoided          ${transfer.revocationsAvoided}`)
  console.log(`  valueRescuedBySale          ${tok(transfer.valueRescuedBySale)} $STANDARD not burned`)
  console.log(`  sellerProceedsEth           ${eth(transfer.sellerProceedsEth)} ETH to sellers`)
  console.log(`  seatMarketEthVolume         ${eth(transfer.seatMarketEthVolume)} ETH  <- the blind spot`)
  console.log(`  branchesKeptAlive           ${transfer.branchesKeptAlive}`)
  console.log(`  seatSales                   ${transfer.seatSales}`)
  console.log(`  concentrationHHI            ${(Number(transfer.concentrationHHI) / 1e18).toExponential(3)}`)
  console.log(`  largestHolderBranchShare    ${((Number(transfer.largestHolderBranchShare) / 1e18) * 100).toFixed(3)}%`)
}
