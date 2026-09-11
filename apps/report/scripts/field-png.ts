/**
 * The static field, for when WebGL is not available.
 *
 * Renders day 31 from the same `cohort.json` and the same layout functions the
 * live instrument uses, so the fallback is the same picture rather than an
 * approximation of it. Written straight to a PNG with `node:zlib` — a
 * rasteriser and a chunk writer are about eighty lines between them, which is
 * less to justify than an image dependency in a report that has none.
 *
 *   pnpm field
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { HALO, STATE, appearance, height, pointScale, position, type Cohort } from '../components/field'

const DAY = 31
const W = 1200
const H = 720
const SUPERSAMPLE = 2

// The warmed palette, resolved to sRGB. Kept in step with globals.css by hand;
// there is one colour here and one colour there.
const PAPER: [number, number, number] = [0xee, 0xeb, 0xe5] // oklch(0.94 0.008 85)
const INK: [number, number, number] = [0x24, 0x1e, 0x18] // oklch(0.24 0.015 70)

const cohort = JSON.parse(
  readFileSync(join(process.cwd(), 'public', 'cohort.json'), 'utf8'),
) as Cohort

const w = W * SUPERSAMPLE
const h = H * SUPERSAMPLE
const buf = new Float32Array(w * h * 3)
for (let i = 0; i < w * h; i++) {
  buf[i * 3] = PAPER[0]
  buf[i * 3 + 1] = PAPER[1]
  buf[i * 3 + 2] = PAPER[2]
}

/** Orthographic, tilted: the same read as the live disc, without a camera. */
const R = w * 0.44
const SQUASH = 0.44
const LIFT = 0.62
const cx = w / 2
const cy = h * 0.52

function blend(px: number, py: number, alpha: number): void {
  if (alpha <= 0 || px < 0 || py < 0 || px >= w || py >= h) return
  const i = (py * w + px) * 3
  const a = Math.min(1, alpha)
  buf[i] = (buf[i] as number) * (1 - a) + INK[0] * a
  buf[i + 1] = (buf[i + 1] as number) * (1 - a) + INK[1] * a
  buf[i + 2] = (buf[i + 2] as number) * (1 - a) + INK[2] * a
}

interface Drawn {
  x: number
  y: number
  r: number
  opacity: number
  ring: number
  depth: number
}

const n = cohort.charters
const states = cohort.state[DAY] as number[]
const branches = cohort.branches[DAY] as number[]
const balances = cohort.balance[DAY] as number[]

const drawn: Drawn[] = []
for (let i = 0; i < n; i++) {
  const [dx, dz] = position(i, n)
  const s = states[i] as number
  const look = appearance(s)
  const y = s === STATE.revoked ? 0 : height(balances[i] as number)
  drawn.push({
    x: cx + dx * R,
    y: cy + dz * R * SQUASH - y * R * LIFT,
    r: pointScale(branches[i] as number) * (s === STATE.revoked ? 0.8 : 1) * SUPERSAMPLE * 4.4,
    opacity: look.opacity,
    ring: look.ring,
    depth: dz,
  })
}
// Back to front, so overlaps read correctly.
drawn.sort((a, b) => a.depth - b.depth)

for (const p of drawn) {
  const outer = p.ring > 0 ? p.r * HALO : p.r
  const reach = Math.ceil(outer + 2)
  for (let py = Math.floor(p.y - reach); py <= p.y + reach; py++) {
    for (let px = Math.floor(p.x - reach); px <= p.x + reach; px++) {
      const dist = Math.hypot(px + 0.5 - p.x, py + 0.5 - p.y)
      const d = dist / p.r
      let a = (1 - smoothstep(0.72, 1.0, d)) * 0.94
      if (p.ring > 0) {
        const hd = dist / outer
        a = Math.max(a, (smoothstep(0.70, 0.86, hd) * (1 - smoothstep(0.92, 1.04, hd))) * 0.95)
      }
      blend(px, py, a * p.opacity)
    }
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// -- Downsample and encode ---------------------------------------------------

const rgb = Buffer.alloc(W * H * 3)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0
    let g = 0
    let b = 0
    for (let sy = 0; sy < SUPERSAMPLE; sy++) {
      for (let sx = 0; sx < SUPERSAMPLE; sx++) {
        const i = ((y * SUPERSAMPLE + sy) * w + (x * SUPERSAMPLE + sx)) * 3
        r += buf[i] as number
        g += buf[i + 1] as number
        b += buf[i + 2] as number
      }
    }
    const k = SUPERSAMPLE * SUPERSAMPLE
    const o = (y * W + x) * 3
    rgb[o] = Math.round(r / k)
    rgb[o + 1] = Math.round(g / k)
    rgb[o + 2] = Math.round(b / k)
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // truecolour
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

// One filter byte per scanline; filter 0 (none) compresses well enough on a
// picture this flat.
const raw = Buffer.alloc(H * (1 + W * 3))
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0
  rgb.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = join(process.cwd(), 'public', 'field-day31.png')
writeFileSync(out, png)
const day = cohort.daily[DAY]
if (day === undefined) throw new Error(`cohort.json has no day ${DAY}`)

// The readouts that sit beside the static field, and that the page renders on
// the server so they are correct before any JavaScript runs. Same source, same
// build step, so they cannot drift from the picture.
const reportable = (cohort.state[DAY] as number[]).filter((s) => s === STATE.reportable).length
mkdirSync(join(process.cwd(), 'data'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'data', 'field-day31.json'),
  `${JSON.stringify({ ...day, charters: cohort.charters, cellId: cohort.cellId, seed: cohort.seed, replay: cohort.replay }, null, 2)}\n`,
)
if (reportable !== day.reportable) {
  throw new Error(`day ${DAY}: ${reportable} ringed points, readout says ${day.reportable}`)
}

console.log(`field: wrote ${out}  ${W}x${H}  ${(png.length / 1024).toFixed(0)} KB`)
console.log(
  `  day ${DAY}: ${day.liveCharters} live, ${day.reportable} reportable, ${day.totalBranches} branches`,
)
