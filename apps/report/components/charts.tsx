/**
 * Hand-rolled inline SVG. No chart library.
 *
 * Thin strokes, no fills except a single light band, direct labels on the
 * series rather than a legend, axis labels in monospace. Everything is drawn
 * in a fixed 720x300 viewBox and scaled by CSS, so a phone gets the same
 * drawing at a smaller size rather than a different one.
 */

import type { ReactNode } from 'react'

/**
 * Two layouts, not one drawing scaled down.
 *
 * A 720-unit chart shown at 327px on a phone renders 10-unit axis text at
 * 4.5 CSS pixels, which is not readable. Scaling the type inside the same
 * viewBox does not work either: the labels then no longer fit the padding they
 * were laid out against. So the compact layout is a smaller drawing with
 * proportionally larger type and its own padding, and CSS shows exactly one of
 * the two.
 */
interface Layout {
  W: number
  H: number
  pad: { top: number; right: number; bottom: number; left: number }
  tick: number
  axis: number
  series: number
}

const WIDE: Layout = {
  W: 720,
  H: 300,
  pad: { top: 16, right: 76, bottom: 34, left: 52 },
  tick: 10,
  axis: 9,
  series: 10,
}

const COMPACT: Layout = {
  W: 380,
  H: 290,
  pad: { top: 14, right: 62, bottom: 34, left: 40 },
  tick: 11,
  axis: 9.5,
  series: 10.5,
}

function plotOf(l: Layout) {
  return { x0: l.pad.left, x1: l.W - l.pad.right, y0: l.pad.top, y1: l.H - l.pad.bottom }
}

interface Scale {
  x: (v: number) => number
  y: (v: number) => number
}

function makeScale(l: Layout, xDomain: [number, number], yDomain: [number, number]): Scale {
  const p = plotOf(l)
  const [x0, x1] = xDomain
  const [y0, y1] = yDomain
  return {
    x: (v) => p.x0 + ((v - x0) / (x1 - x0 || 1)) * (p.x1 - p.x0),
    y: (v) => p.y1 - ((v - y0) / (y1 - y0 || 1)) * (p.y1 - p.y0),
  }
}

function path(xs: readonly number[], ys: readonly number[], s: Scale): string {
  let d = ''
  for (let i = 0; i < xs.length; i++) {
    const x = s.x(xs[i] as number).toFixed(2)
    const y = s.y(ys[i] as number).toFixed(2)
    d += `${i === 0 ? 'M' : 'L'}${x} ${y}`
  }
  return d
}

function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo
  if (span <= 0) return [lo]
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag
  const ticks: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) {
    ticks.push(Number(t.toFixed(10)))
  }
  return ticks
}

interface FrameProps {
  l: Layout
  xDomain: [number, number]
  yDomain: [number, number]
  yFormat: (v: number) => string
  xLabel: string
  children: (s: Scale) => ReactNode
  /** Days to shade as the policy blind window. */
  blindWindow?: [number, number]
  markerDay?: number
  markerLabel?: string
  xTicks?: number[]
}

function Frame({
  l,
  xDomain,
  yDomain,
  yFormat,
  xLabel,
  children,
  blindWindow,
  markerDay,
  markerLabel,
  xTicks,
}: FrameProps) {
  const s = makeScale(l, xDomain, yDomain)
  const PLOT = plotOf(l)
  const yTicks = niceTicks(yDomain[0], yDomain[1])
  const xt = xTicks ?? niceTicks(xDomain[0], xDomain[1], 5)

  return (
    <svg viewBox={`0 0 ${l.W} ${l.H}`} role="img" aria-label={xLabel}>
      {/* horizontal rules */}
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line
            x1={PLOT.x0}
            x2={PLOT.x1}
            y1={s.y(t)}
            y2={s.y(t)}
            stroke="var(--rule-faint)"
            strokeWidth="1"
          />
          <text
            x={PLOT.x0 - 8}
            y={s.y(t) + 3.5}
            textAnchor="end"
            fontFamily="var(--mono)"
            fontSize={l.tick}
            fill="var(--ink-faint)"
          >
            {yFormat(t)}
          </text>
        </g>
      ))}

      {/* the blind window, and the day-31 marker */}
      {blindWindow !== undefined ? (
        <rect
          x={s.x(blindWindow[0])}
          y={PLOT.y0}
          width={s.x(blindWindow[1]) - s.x(blindWindow[0])}
          height={PLOT.y1 - PLOT.y0}
          fill="var(--band)"
        />
      ) : null}
      {markerDay !== undefined ? (
        <g>
          <line
            x1={s.x(markerDay)}
            x2={s.x(markerDay)}
            y1={PLOT.y0}
            y2={PLOT.y1}
            stroke="var(--ink-faint)"
            strokeWidth="1"
          />
          {markerLabel !== undefined ? (
            <text
              x={s.x(markerDay) + 4}
              y={PLOT.y0 + 10}
              fontFamily="var(--mono)"
              fontSize={l.tick}
              fill="var(--ink-muted)"
            >
              {markerLabel}
            </text>
          ) : null}
        </g>
      ) : null}

      {/* axes */}
      <line
        x1={PLOT.x0}
        x2={PLOT.x1}
        y1={PLOT.y1}
        y2={PLOT.y1}
        stroke="var(--rule)"
        strokeWidth="1"
      />
      {xt.map((t) => (
        <text
          key={`x${t}`}
          x={s.x(t)}
          y={PLOT.y1 + 15}
          textAnchor="middle"
          fontFamily="var(--mono)"
          fontSize={l.tick}
          fill="var(--ink-faint)"
        >
          {t}
        </text>
      ))}
      <text
        x={(PLOT.x0 + PLOT.x1) / 2}
        y={l.H - 4}
        textAnchor="middle"
        fontFamily="var(--mono)"
        fontSize={l.axis}
        letterSpacing="0.06em"
        fill="var(--ink-faint)"
      >
        {xLabel}
      </text>

      {children(s)}
    </svg>
  )
}

/** A series label placed at the end of the line, not in a legend. */
function EndLabel({
  x,
  y,
  text,
  dy = 0,
  size = 10,
}: {
  x: number
  y: number
  text: string
  dy?: number
  size?: number
}) {
  return (
    <text
      x={x + 5}
      y={y + 3.5 + dy}
      fontFamily="var(--mono)"
      fontSize={size}
      fill="var(--ink-muted)"
    >
      {text}
    </text>
  )
}

/**
 * Two end labels, pushed apart if the series finish close together.
 *
 * The whole point of several of these charts is that two lines end up almost
 * on top of each other, so the labels have to survive that rather than
 * assuming it will not happen.
 */
function EndLabels({
  x,
  a,
  b,
  size = 10,
}: {
  x: number
  a: { y: number; text: string }
  b: { y: number; text: string }
  size?: number
}) {
  const MIN = size * 1.25
  const gap = b.y - a.y
  let aDy = 0
  let bDy = 0
  if (Math.abs(gap) < MIN) {
    const push = (MIN - Math.abs(gap)) / 2
    aDy = gap >= 0 ? -push : push
    bDy = gap >= 0 ? push : -push
  }
  return (
    <g>
      <EndLabel x={x} y={a.y} text={a.text} dy={aDy} size={size} />
      <EndLabel x={x} y={b.y} text={b.text} dy={bDy} size={size} />
    </g>
  )
}

/** Exactly one of the two is displayed; CSS decides which. */
function Responsive({ wide, compact }: { wide: ReactNode; compact: ReactNode }) {
  return (
    <>
      <div className="chart-wide">{wide}</div>
      <div className="chart-compact">{compact}</div>
    </>
  )
}

// ---------------------------------------------------------------------------

export interface Exemplar {
  days: number[]
  multiplier: { treatment: number[]; control: number[] }
  yieldPerBranchPerDay: { treatment: number[]; control: number[] }
  totalBranches: { treatment: number[]; control: number[] }
}

function window20to90(data: Exemplar) {
  const from = data.days.findIndex((d) => d >= 20)
  return {
    days: data.days.slice(from),
    slice: <T,>(xs: T[]) => xs.slice(from),
  }
}

function extent(series: readonly number[][], pad = 0.06): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const s of series) {
    for (const v of s) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  const span = hi - lo || Math.abs(hi) || 1
  return [lo - span * pad, hi + span * pad]
}

/** 1. The multiplier path, with the two-epoch blind window shaded. */
function MultiplierPlot({ data, l }: { data: Exemplar; l: Layout }) {
  const w = window20to90(data)
  const t = w.slice(data.multiplier.treatment)
  const c = w.slice(data.multiplier.control)
  const y = extent([t, c])
  return (
    <Frame
      l={l}
      xDomain={[20, 90]}
      yDomain={y}
      yFormat={(v) => v.toFixed(2)}
      xLabel="DAY"
      blindWindow={[30, 32]}
      markerDay={31}
      markerLabel="day 31"
      xTicks={[20, 31, 45, 60, 75, 90]}
    >
      {(s) => (
        <g>
          <path d={path(w.days, c, s)} fill="none" stroke="var(--ink-faint)" strokeWidth="1" />
          <path d={path(w.days, t, s)} fill="none" stroke="var(--ink)" strokeWidth="1.6" />
          <EndLabels
            x={s.x(90)}
            a={{ y: s.y(t[t.length - 1] as number), text: 'treatment' }}
            b={{ y: s.y(c[c.length - 1] as number), text: 'control' }}
            size={l.series}
          />
        </g>
      )}
    </Frame>
  )
}

export function MultiplierChart({ data }: { data: Exemplar }) {
  return (
    <Responsive
      wide={<MultiplierPlot data={data} l={WIDE} />}
      compact={<MultiplierPlot data={data} l={COMPACT} />}
    />
  )
}

/** 2. Yield per branch: the day-45 gap, closed by day 90. */
function YieldPlot({ data, l }: { data: Exemplar; l: Layout }) {
  const w = window20to90(data)
  const t = w.slice(data.yieldPerBranchPerDay.treatment)
  const c = w.slice(data.yieldPerBranchPerDay.control)
  const y = extent([t, c])
  const PLOT = plotOf(l)
  return (
    <Frame
      l={l}
      xDomain={[20, 90]}
      yDomain={y}
      yFormat={(v) => v.toFixed(0)}
      xLabel="DAY — TOKENS PER BRANCH PER DAY"
      markerDay={31}
      markerLabel="day 31"
      xTicks={[20, 31, 45, 60, 75, 90]}
    >
      {(s) => (
        <g>
          <line
            x1={s.x(45)}
            x2={s.x(45)}
            y1={PLOT.y0}
            y2={PLOT.y1}
            stroke="var(--rule)"
            strokeWidth="1"
          />
          <path d={path(w.days, c, s)} fill="none" stroke="var(--ink-faint)" strokeWidth="1" />
          <path d={path(w.days, t, s)} fill="none" stroke="var(--ink)" strokeWidth="1.6" />
          <EndLabels
            x={s.x(90)}
            a={{ y: s.y(t[t.length - 1] as number), text: 'treatment' }}
            b={{ y: s.y(c[c.length - 1] as number), text: 'control' }}
            size={l.series}
          />
          <text
            x={s.x(45) + 4}
            y={PLOT.y0 + l.tick}
            fontFamily="var(--mono)"
            fontSize={l.tick}
            fill="var(--ink-muted)"
          >
            day 45
          </text>
        </g>
      )}
    </Frame>
  )
}

export function YieldChart({ data }: { data: Exemplar }) {
  return (
    <Responsive
      wide={<YieldPlot data={data} l={WIDE} />}
      compact={<YieldPlot data={data} l={COMPACT} />}
    />
  )
}

/** 3. Total branches: destruction, then refill. */
function BranchesPlot({ data, l }: { data: Exemplar; l: Layout }) {
  const w = window20to90(data)
  const t = w.slice(data.totalBranches.treatment)
  const c = w.slice(data.totalBranches.control)
  const y = extent([t, c])
  return (
    <Frame
      l={l}
      xDomain={[20, 90]}
      yDomain={y}
      yFormat={(v) => String(Math.round(v))}
      xLabel="DAY — LIVE BRANCHES"
      markerDay={31}
      markerLabel="day 31"
      xTicks={[20, 31, 45, 60, 75, 90]}
    >
      {(s) => (
        <g>
          <path d={path(w.days, c, s)} fill="none" stroke="var(--ink-faint)" strokeWidth="1" />
          <path d={path(w.days, t, s)} fill="none" stroke="var(--ink)" strokeWidth="1.6" />
          <EndLabels
            x={s.x(90)}
            a={{ y: s.y(t[t.length - 1] as number), text: 'treatment' }}
            b={{ y: s.y(c[c.length - 1] as number), text: 'control' }}
            size={l.series}
          />
        </g>
      )}
    </Frame>
  )
}

export function BranchesChart({ data }: { data: Exemplar }) {
  return (
    <Responsive
      wide={<BranchesPlot data={data} l={WIDE} />}
      compact={<BranchesPlot data={data} l={COMPACT} />}
    />
  )
}

// ---------------------------------------------------------------------------

export interface LicenseLevel {
  level: string
  mean: number
  lo: number
  hi: number
  n: number
}

/**
 * 4. Day-45 yield delta against `licensesPerDay`.
 *
 * Categorical, so it is drawn as points with their confidence intervals rather
 * than as a line: the levels are not evenly spaced and "unlimited" is not a
 * number. The grey band is the 95% interval.
 */
function LicensesPlot({ levels, l }: { levels: LicenseLevel[]; l: Layout }) {
  const PLOT = plotOf(l)
  const n = levels.length
  const lo = Math.min(0, ...levels.map((l) => l.lo))
  const hi = Math.max(...levels.map((l) => l.hi))
  const span = hi - lo || 1
  const y = (v: number) => PLOT.y1 - ((v - (lo - span * 0.12)) / (span * 1.24)) * (PLOT.y1 - PLOT.y0)
  const x = (i: number) => PLOT.x0 + ((i + 0.5) / n) * (PLOT.x1 - PLOT.x0)
  const yTicks = niceTicks(lo, hi, 4)
  const half = ((PLOT.x1 - PLOT.x0) / n) * 0.3

  return (
    <svg viewBox={`0 0 ${l.W} ${l.H}`} role="img" aria-label="day-45 yield delta by licensesPerDay">
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={PLOT.x0}
            x2={PLOT.x1}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--rule-faint)"
            strokeWidth="1"
          />
          <text
            x={PLOT.x0 - 8}
            y={y(t) + 3.5}
            textAnchor="end"
            fontFamily="var(--mono)"
            fontSize={l.tick}
            fill="var(--ink-faint)"
          >
            {t.toFixed(0)}
          </text>
        </g>
      ))}
      <line x1={PLOT.x0} x2={PLOT.x1} y1={y(0)} y2={y(0)} stroke="var(--rule)" strokeWidth="1" />

      {levels.map((level, i) => (
        <g key={level.level}>
          {/* 95% interval */}
          <rect
            x={x(i) - half * 0.55}
            y={y(level.hi)}
            width={half * 1.1}
            height={Math.max(1, y(level.lo) - y(level.hi))}
            fill="var(--band)"
          />
          <line
            x1={x(i) - half}
            x2={x(i) + half}
            y1={y(level.mean)}
            y2={y(level.mean)}
            stroke="var(--ink)"
            strokeWidth="1.8"
          />
          <text
            x={x(i)}
            y={y(level.hi) - 6}
            textAnchor="middle"
            fontFamily="var(--mono)"
            fontSize={l.tick}
            fill="var(--ink)"
          >
            {level.mean.toFixed(1)}
          </text>
          <text
            x={x(i)}
            y={PLOT.y1 + l.tick + 5}
            textAnchor="middle"
            fontFamily="var(--mono)"
            fontSize={l.tick}
            fill="var(--ink-faint)"
          >
            {level.level === 'unlimited' ? '∞' : level.level}
          </text>
        </g>
      ))}
      <text
        x={(PLOT.x0 + PLOT.x1) / 2}
        y={l.H - 4}
        textAnchor="middle"
        fontFamily="var(--mono)"
        fontSize={l.axis}
        letterSpacing="0.06em"
        fill="var(--ink-faint)"
      >
        LICENSES/DAY — DAY-45 YIELD DELTA
      </text>
    </svg>
  )
}

export function LicensesChart({ levels }: { levels: LicenseLevel[] }) {
  return (
    <Responsive
      wide={<LicensesPlot levels={levels} l={WIDE} />}
      compact={<LicensesPlot levels={levels} l={COMPACT} />}
    />
  )
}
