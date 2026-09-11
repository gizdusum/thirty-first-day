/**
 * Render the entrance to frames, one at a time.
 *
 * Not a screen recording. Every frame is its own page load at an exact `t`, so
 * the output is a function of the timeline and nothing else — no dropped
 * frames, no compositor jitter, no dependence on how fast this machine happens
 * to be. Fifteen seconds at thirty frames is 450 loads, which is slow and is
 * the point.
 *
 * The script never waits on a timeout. It waits on `window.__captureReady`,
 * which the page sets only after the GL commands for that frame have completed
 * and the compositor has presented them.
 *
 *   node scripts/render-video.mjs [--base http://localhost:4312] [--out frames]
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from 'playwright'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
}

const BASE = args.get('base') ?? 'http://localhost:4312'
const OUT = args.get('out') ?? join(process.cwd(), 'frames')
const FPS = 30
const SECONDS = 15
const TOTAL = FPS * SECONDS
const WIDTH = 1920
const HEIGHT = 1080

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: [
    // Software WebGL, so the render does not depend on this machine's GPU and
    // two runs on two machines produce the same pixels.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--disable-lcd-text',
  ],
})

const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  reducedMotion: 'no-preference',
})

page.on('pageerror', (e) => {
  console.error('  page error:', e.message)
})

const started = Date.now()
let lastDay = null
const days = []

for (let f = 0; f < TOTAL; f++) {
  const t = f / FPS
  await page.goto(`${BASE}/?capture=1&t=${t}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__captureReady === true, null, { timeout: 60_000 })

  // Read back what the page actually rendered, so the check on dropped or
  // repeated days is made against the DOM rather than against the model of it.
  const shown = await page.evaluate(() => {
    const card = document.documentElement.getAttribute('data-capture') === 'card'
    const el = document.querySelector('.entrance-day')
    return { card, day: el ? el.textContent.replace(/\D/g, '') : null }
  })
  days.push(shown.card ? 'CARD' : shown.day)

  await page.screenshot({
    path: join(OUT, String(f).padStart(4, '0') + '.png'),
    animations: 'disabled',
  })

  if (f % 30 === 0 || f === TOTAL - 1) {
    const pct = (((f + 1) / TOTAL) * 100).toFixed(0)
    const secs = ((Date.now() - started) / 1000).toFixed(0)
    process.stdout.write(
      `  ${String(f + 1).padStart(3)}/${TOTAL}  t=${t.toFixed(2)}s  ${shown.card ? 'card' : 'day ' + shown.day}  ${pct}%  ${secs}s elapsed\n`,
    )
  }
  lastDay = shown.day
}

await browser.close()

// -- Verify the day sequence -------------------------------------------------

const fieldDays = days.filter((d) => d !== 'CARD').map(Number)
let regressions = 0
let jumps = 0
for (let i = 1; i < fieldDays.length; i++) {
  const delta = fieldDays[i] - fieldDays[i - 1]
  if (delta < 0) regressions++
  if (delta > 2) jumps++
}
console.log('')
console.log(`frames written : ${TOTAL}`)
console.log(`field frames   : ${fieldDays.length}   end card frames: ${days.length - fieldDays.length}`)
console.log(`day range      : ${Math.min(...fieldDays)} -> ${Math.max(...fieldDays)}`)
console.log(`counter goes backwards: ${regressions}   jumps of >2 days: ${jumps}`)
if (regressions > 0) {
  console.error('FAIL: the day counter regresses')
  process.exitCode = 1
}
