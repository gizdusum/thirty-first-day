'use client'

/**
 * The instrument.
 *
 * A thousand charters on a tilted disc, one point each, ninety-one days.
 * Everything it draws comes from `cohort.json`, which is a replay of the same
 * cell and seed the report's charts use — the aggregates in the readouts are
 * checked against those charts at export time.
 *
 * It degrades in one direction only. The server renders a static PNG of day 31
 * and the day-31 readouts; this component replaces the PNG with a canvas if
 * and only if WebGL initialises and the data loads. If either fails, or if
 * JavaScript never runs, the PNG is what stays on screen. There is no spinner
 * and no empty canvas.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { HALO, STATE, appearance, height, pointScale, position, type Cohort } from './field'
import {
  LINES,
  SETTLE_DAY,
  STANDFIRST,
  counter,
  frameAt,
  type EntranceLine,
} from './entrance'
import { ENTRANCE } from '../config'

const DAY_31 = 31

/** Diameter of an `aSize` 1 dot, in disc radii. Tuned by eye at 1280 and 390. */
const DOT_WORLD = 0.028
const FALLBACK_DAY = DAY_31

/** Read a CSS custom property as an `[r, g, b]` triple in 0..1. */
function cssColour(name: string, fallback: [number, number, number]): [number, number, number] {
  if (typeof window === 'undefined') return fallback
  const probe = document.createElement('span')
  probe.style.color = `var(${name})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  const m = /rgba?\(([^)]+)\)/.exec(resolved)
  if (m === null) return fallback
  const parts = (m[1] as string).split(/[ ,/]+/).filter(Boolean).map(Number)
  if (parts.length < 3) return fallback
  return [(parts[0] as number) / 255, (parts[1] as number) / 255, (parts[2] as number) / 255]
}

/*
 * `aIndex` is the charter's index over the cohort, 0..1, and `uArrive` sweeps
 * across it during the entrance so the field assembles in charter order rather
 * than all at once. It is held at 1 whenever the entrance is not running, so
 * the gate costs one clamp and changes nothing.
 */
const VERTEX = `
  attribute float aSize;
  attribute float aOpacity;
  attribute float aRing;
  attribute float aIndex;
  varying float vOpacity;
  varying float vRing;
  uniform float uScale;
  uniform float uArrive;
  void main() {
    float gate = clamp((uArrive * 1.08 - aIndex) / 0.08, 0.0, 1.0);
    vOpacity = aOpacity * gate;
    vRing = aRing;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale * (0.55 + 0.45 * gate) / max(0.0001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

/*
 * A ringed point is drawn into a sprite HALO times larger than its dot, with
 * the ring out at the sprite's edge — the same construction as the static PNG.
 * A ring drawn at the dot's own edge is invisible at the size these points
 * actually render, and the ring is the whole reason the wave is legible before
 * anything is revoked.
 */
const FRAGMENT = `
  precision mediump float;
  varying float vOpacity;
  varying float vRing;
  uniform vec3 uInk;
  const float HALO = ${HALO.toFixed(3)};
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    // Distance in units of the dot's own radius, whatever the sprite's size.
    float dotD = d * mix(1.0, HALO, vRing);
    float disc = 1.0 - smoothstep(0.72, 0.96, dotD);
    float ring = smoothstep(0.70, 0.86, d) * (1.0 - smoothstep(0.92, 1.0, d));
    float a = max(disc * 0.92, ring * vRing);
    gl_FragColor = vec4(uInk, a * vOpacity);
    if (gl_FragColor.a < 0.01) discard;
  }
`

interface Readouts {
  day: number
  liveCharters: number
  totalBranches: number
  reportable: number
  multiplier: number
  yieldPerBranchPerDay: number
  regime: string
}

/**
 * Day 31, written at build time by `scripts/field-png.ts` from the same
 * `cohort.json` the PNG is drawn from. The server renders these, so the rail is
 * correct with JavaScript disabled and does not change when the canvas starts.
 */
interface Initial extends Readouts {
  revokedCumulative: number
  charters: number
  cellId: string
  seed: number
  replay: string
}

function pad(value: number, width: number): string {
  return String(Math.round(value)).padStart(width, '0')
}

/**
 * Should the entrance run, and with what chrome.
 *
 * `?entrance=1` forces it from the top — including over a reduced-motion
 * preference, because asking for it in the URL is an explicit request and the
 * recording needs to be reproducible. `?chrome=0` drops the skip control so a
 * screen capture has no UI in it.
 */
function entranceIntent(): { play: boolean; chrome: boolean } {
  if (!ENTRANCE || typeof window === 'undefined') return { play: false, chrome: true }
  const params = new URLSearchParams(window.location.search)
  const forced = params.get('entrance') === '1'
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return { play: forced || !reduced, chrome: params.get('chrome') !== '0' }
}

export function Instrument({ initial }: { initial: Initial }) {
  const stage = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const counterRef = useRef<HTMLSpanElement | null>(null)
  const lineRef = useRef<HTMLParagraphElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [live, setLive] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [day, setDay] = useState(FALLBACK_DAY)
  const [cohort, setCohort] = useState<Cohort | null>(null)
  const [replay, setReplay] = useState<string | null>(null)

  const [entrance, setEntrance] = useState<'idle' | 'playing' | 'done'>('idle')
  const [chrome, setChrome] = useState(true)

  const dayRef = useRef(day)
  dayRef.current = day
  const playingRef = useRef(playing)
  playingRef.current = playing
  const applyRef = useRef<((d: number) => void) | null>(null)
  /** Non-null exactly while the entrance is running. */
  const clockRef = useRef<{ start: number } | null>(null)
  const skipRef = useRef<(() => void) | null>(null)
  const lineShownRef = useRef<EntranceLine | null>(null)

  // -- Load, initialise, animate --------------------------------------------
  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | undefined

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) setPlaying(false)

    const start = async (): Promise<void> => {
      const host = frameRef.current
      const canvas = canvasRef.current
      if (host === null || canvas === null) return

      let data: Cohort
      let THREE: typeof import('three')
      try {
        const [res, three] = await Promise.all([fetch('/cohort.json'), import('three')])
        if (!res.ok) throw new Error(`cohort.json: ${res.status}`)
        data = (await res.json()) as Cohort
        THREE = three
      } catch {
        return // the static field stays on screen
      }
      if (disposed) return

      let renderer: import('three').WebGLRenderer
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
      } catch {
        return
      }
      if (disposed) {
        renderer.dispose()
        return
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setClearAlpha(0)

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)

      /*
       * The camera sits on a fixed line and slides along it until the disc
       * fills the frame, so a wide desktop and a tall phone get the same
       * picture at the same size rather than the same camera and a disc that
       * shrinks to a coin on one of them.
       *
       * The extent is measured, not estimated. Under perspective a tilted disc
       * is not symmetric about its centre — the near rim projects further down
       * than the far rim projects up — so the fit both scales the distance and
       * recentres what the camera looks at. Six passes converge well inside a
       * pixel; the rim is a circle, so the disc's own rotation does not move
       * it and the framing never wobbles.
       */
      const DIRECTION = new THREE.Vector3(0, 1.72, 2.34).normalize()
      /*
       * A disc seen from 36 degrees is twice as wide as it is tall, which is
       * right in a landscape frame and a sliver in a portrait one — the
       * 1080x1920 recording and a phone held upright both leave most of the
       * screen empty. The entrance looks down more steeply there, so the disc
       * reads round and fills the crop, and tilts back to the house angle as
       * it settles into the page.
       */
      const DIRECTION_PORTRAIT = new THREE.Vector3(0, 2.75, 1.5).normalize()
      const viewDirection = DIRECTION.clone()
      /** Settle progress, so the fit can tilt back in step with the resize. */
      let settleNow = 0
      const MARGIN = 0.92
      /*
       * The entrance fills the viewport and puts two lines of type low on it.
       * A disc fitted to 0.92 of that frame runs straight through them, so the
       * entrance fits looser and biases the disc upward, leaving the lower
       * fifth of the screen clear for the type.
       */
      const ENTRANCE_MARGIN = 0.78
      const ENTRANCE_BIAS = 0.12
      /*
       * On a portrait crop — a phone, and the 1080x1920 recording — the disc
       * is bound by the width, not the height, and there is vertical room to
       * spare. Reserving a fifth of the screen there leaves the field floating
       * in an empty column, so portrait fills the width instead and relies on
       * the spare height to keep the type clear.
       */
      const PORTRAIT_MARGIN = 0.93
      const PORTRAIT_BIAS = 0.06
      const TILT = -0.16

      const rim: import('three').Vector3[] = []
      for (let k = 0; k < 96; k++) {
        const a = (k / 96) * Math.PI * 2
        for (const lift of [0, 0.16]) {
          const v = new THREE.Vector3(Math.cos(a), lift, Math.sin(a))
          v.applyAxisAngle(new THREE.Vector3(1, 0, 0), TILT)
          rim.push(v)
        }
      }

      let distance = 3
      let lookY = 0
      const probe = new THREE.Vector3()

      const frameDisc = (): void => {
        const inEntrance = clockRef.current !== null
        const portrait = camera.aspect < 1.1
        const lean = inEntrance && portrait ? 1 - settleNow : 0
        const margin = inEntrance ? (portrait ? PORTRAIT_MARGIN : ENTRANCE_MARGIN) : MARGIN
        const bias = inEntrance ? (portrait ? PORTRAIT_BIAS : ENTRANCE_BIAS) : 0
        viewDirection.copy(DIRECTION).lerp(DIRECTION_PORTRAIT, lean).normalize()
        const tanV = Math.tan(((camera.fov / 2) * Math.PI) / 180)
        for (let pass = 0; pass < 6; pass++) {
          camera.position.copy(viewDirection).multiplyScalar(distance)
          camera.position.y += lookY
          camera.lookAt(0, lookY, 0)
          camera.updateMatrixWorld()
          let minY = Infinity
          let maxY = -Infinity
          let maxX = 0
          for (const v of rim) {
            probe.copy(v).project(camera)
            if (probe.y < minY) minY = probe.y
            if (probe.y > maxY) maxY = probe.y
            maxX = Math.max(maxX, Math.abs(probe.x))
          }
          const halfY = (maxY - minY) / 2
          distance *= Math.max(maxX, halfY) / margin
          lookY += ((maxY + minY) / 2 - bias) * distance * tanV
        }
      }
      const n = data.charters
      const positions = new Float32Array(n * 3)
      const sizes = new Float32Array(n)
      const opacity = new Float32Array(n)
      const ring = new Float32Array(n)
      const index = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const [x, z] = position(i, n)
        positions[i * 3] = x
        positions[i * 3 + 1] = 0
        positions[i * 3 + 2] = z
        index[i] = i / n
      }

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
      geometry.setAttribute('aOpacity', new THREE.BufferAttribute(opacity, 1))
      geometry.setAttribute('aRing', new THREE.BufferAttribute(ring, 1))
      geometry.setAttribute('aIndex', new THREE.BufferAttribute(index, 1))

      const ink = cssColour('--ink', [0.14, 0.12, 0.09])
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uInk: { value: new THREE.Vector3(ink[0], ink[1], ink[2]) },
          uScale: { value: 16 },
          uArrive: { value: 1 },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
      })

      const points = new THREE.Points(geometry, material)
      const disc = new THREE.Group()
      disc.add(points)
      disc.rotation.x = TILT
      scene.add(disc)

      const apply = (d: number): void => {
        const clamped = Math.max(0, Math.min(data.days - 1, Math.round(d)))
        const states = data.state[clamped] as number[]
        const branches = data.branches[clamped] as number[]
        const balances = data.balance[clamped] as number[]
        for (let i = 0; i < n; i++) {
          const s = states[i] as number
          const look = appearance(s)
          sizes[i] =
            pointScale(branches[i] as number) *
            (s === STATE.revoked ? 0.8 : 1) *
            (look.ring > 0 ? HALO : 1)
          opacity[i] = look.opacity
          ring[i] = look.ring
          positions[i * 3 + 1] = s === STATE.revoked ? 0 : height(balances[i] as number)
        }
        geometry.attributes['position']!.needsUpdate = true
        geometry.attributes['aSize']!.needsUpdate = true
        geometry.attributes['aOpacity']!.needsUpdate = true
        geometry.attributes['aRing']!.needsUpdate = true
      }
      applyRef.current = apply
      apply(FALLBACK_DAY)

      const resize = (): void => {
        const w = host.clientWidth
        const h = host.clientHeight
        if (w === 0 || h === 0) return
        renderer.setSize(w, h, false)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        frameDisc()
        /*
         * `gl_PointSize = aSize * uScale / -mv.z`, in device pixels, so uScale
         * has to carry this canvas's device-pixels-per-world-unit for a dot to
         * keep the same apparent size as the camera moves or the ratio changes.
         * A dot of `aSize` 1 is DOT_WORLD across on the disc.
         */
        const tanV = Math.tan(((camera.fov / 2) * Math.PI) / 180)
        const devicePixels = h * renderer.getPixelRatio()
        material.uniforms['uScale']!.value = (DOT_WORLD * devicePixels) / (2 * tanV)
      }
      resize()
      const observer = new ResizeObserver(resize)
      observer.observe(host)

      // Pause when the instrument is not on screen. Nothing animates in a tab
      // the reader has scrolled past.
      let onScreen = true
      const visibility = new IntersectionObserver(
        (entries) => {
          onScreen = entries[0]?.isIntersecting ?? true
        },
        { threshold: 0.05 },
      )
      visibility.observe(host)

      const scheme = window.matchMedia('(prefers-color-scheme: dark)')
      const onScheme = (): void => {
        const c = cssColour('--ink', [0.14, 0.12, 0.09])
        ;(material.uniforms['uInk']!.value as import('three').Vector3).set(c[0], c[1], c[2])
      }
      scheme.addEventListener('change', onScheme)

      /*
       * The settle.
       *
       * The frame is `position: fixed` over the whole viewport while the
       * entrance runs, and resolves into the stage that has been holding its
       * height since the first paint — so the page underneath never moves.
       * It resolves by resizing rather than by scaling: a non-uniform scale
       * would squash the disc, whereas resizing lets the camera refit every
       * frame and the disc keeps its shape the whole way down.
       */
      const layoutFrame = (settle: number): void => {
        const target = stage.current
        if (target === null) return
        if (settle >= 1) {
          host.style.cssText = ''
          return
        }
        const r = target.getBoundingClientRect()
        const p = settle * settle * (3 - 2 * settle)
        const mix = (from: number, to: number): number => from + (to - from) * p
        host.style.top = `${mix(0, r.top)}px`
        host.style.left = `${mix(0, r.left)}px`
        host.style.width = `${mix(window.innerWidth, r.width)}px`
        host.style.height = `${mix(window.innerHeight, r.height)}px`
        host.style.right = 'auto'
        host.style.bottom = 'auto'
      }

      /** Land on the settled page. Used by both the end of the run and skip. */
      const finish = (): void => {
        if (clockRef.current === null) return
        clockRef.current = null
        settleNow = 1
        material.uniforms['uArrive']!.value = 1
        host.style.cssText = ''
        document.documentElement.removeAttribute('data-entrance')
        setEntrance('done')
        dayRef.current = SETTLE_DAY
        setDay(SETTLE_DAY)
        apply(SETTLE_DAY)
        if (!reduced) setPlaying(true)
        resize()
      }
      skipRef.current = finish

      let raf = 0
      let last = performance.now()
      let accumulated = 0
      const DAY_SECONDS = 0.42

      const frame = (now: number): void => {
        raf = requestAnimationFrame(frame)
        const dt = Math.min(0.1, (now - last) / 1000)
        last = now

        const clock = clockRef.current
        if (clock !== null) {
          const t = (now - clock.start) / 1000
          const f = frameAt(t)
          material.uniforms['uArrive']!.value = f.arrive
          disc.rotation.y = f.spin
          if (f.day !== dayRef.current) {
            dayRef.current = f.day
            setDay(f.day)
            apply(f.day)
          }
          // Written straight to the DOM: at sixty frames a second this is a
          // counter, not application state.
          if (counterRef.current !== null) counterRef.current.textContent = counter(f.day)
          if (lineRef.current !== null && lineShownRef.current !== f.line) {
            lineShownRef.current = f.line
            lineRef.current.textContent = LINES[f.line]
          }
          if (overlayRef.current !== null) {
            overlayRef.current.style.opacity = String(Math.max(0, 1 - f.settle * 2.4))
          }
          if (f.settle > 0) {
            settleNow = f.settle
            layoutFrame(f.settle)
            resize()
          }
          renderer.render(scene, camera)
          if (f.done) finish()
          return
        }

        if (!onScreen) return
        if (!reduced) disc.rotation.y += dt * 0.055
        if (playingRef.current) {
          accumulated += dt
          while (accumulated >= DAY_SECONDS) {
            accumulated -= DAY_SECONDS
            const next = dayRef.current >= data.days - 1 ? 0 : dayRef.current + 1
            dayRef.current = next
            setDay(next)
            apply(next)
          }
        }
        renderer.render(scene, camera)
      }
      raf = requestAnimationFrame(frame)

      // The entrance only ever runs over a field that is actually on screen.
      // If WebGL never came up there is nothing to assemble, and the page is
      // already sitting at its settled state.
      const intent = entranceIntent()
      if (intent.play) {
        setChrome(intent.chrome)
        document.documentElement.setAttribute('data-entrance', 'arming')
        dayRef.current = 0
        setDay(0)
        apply(0)
        material.uniforms['uArrive']!.value = 0
        setPlaying(false)
        setEntrance('playing')
        clockRef.current = { start: performance.now() }
        resize()
      }

      setCohort(data)
      setReplay(data.replay)
      setLive(true)

      cleanup = () => {
        cancelAnimationFrame(raf)
        clockRef.current = null
        skipRef.current = null
        document.documentElement.removeAttribute('data-entrance')
        observer.disconnect()
        visibility.disconnect()
        scheme.removeEventListener('change', onScheme)
        geometry.dispose()
        material.dispose()
        renderer.dispose()
      }
    }

    void start()
    return () => {
      disposed = true
      cleanup?.()
    }
  }, [])

  /*
   * Any interaction ends it, immediately and with no fade. Someone who has
   * seen the entrance once must never be made to sit through it again, and a
   * half-second dissolve on the way out is exactly that in miniature.
   */
  useEffect(() => {
    if (!ENTRANCE) return
    const skip = (): void => skipRef.current?.()
    const events: Array<[keyof WindowEventMap, EventListener]> = [
      ['wheel', skip],
      ['touchstart', skip],
      ['pointerdown', skip],
      ['keydown', skip],
      ['scroll', skip],
    ]
    for (const [name, handler] of events) {
      window.addEventListener(name, handler, { passive: true, capture: true })
    }
    return () => {
      for (const [name, handler] of events) {
        window.removeEventListener(name, handler, { capture: true })
      }
    }
  }, [])

  /*
   * The arming attribute is written before first paint by a script in the
   * layout, so the settled page never flashes. If the field never comes up —
   * no WebGL, no `cohort.json` — nothing will ever clear it, so this does.
   */
  useEffect(() => {
    if (!ENTRANCE) return
    const timer = window.setTimeout(() => {
      if (clockRef.current === null) {
        document.documentElement.removeAttribute('data-entrance')
        setEntrance('done')
      }
    }, 2500)
    return () => window.clearTimeout(timer)
  }, [])

  const onScrub = useCallback((next: number) => {
    setDay(next)
    dayRef.current = next
    applyRef.current?.(next)
  }, [])

  const row = cohort?.daily[day]
  const readouts: Readouts =
    row === undefined
      ? initial
      : {
          day: row.day,
          liveCharters: row.liveCharters,
          totalBranches: row.totalBranches,
          reportable: row.reportable,
          multiplier: row.multiplier,
          yieldPerBranchPerDay: row.yieldPerBranchPerDay,
          regime: row.regime,
        }

  return (
    <section
      className="instrument"
      data-entrance={entrance}
      aria-label="The genesis cohort over ninety days"
    >
      {/*
        The stage holds its height from the first paint and never gives it up.
        The frame inside it is what goes full-viewport for the entrance, so
        nothing below ever moves.
      */}
      <div className="instrument-stage" ref={stage}>
        <div className="instrument-frame" ref={frameRef}>
          <img
            src="/field-day31.png"
            alt={`The genesis cohort on day ${initial.day}: ${initial.charters} charters on a disc, one point each, sized by branch count. ${initial.liveCharters} are live, ${initial.reportable} of them carry a ring marking them reportable, and the faint ghosts are the ${initial.revokedCumulative ?? 0} already revoked.`}
            className="instrument-static"
            data-live={live ? 'true' : 'false'}
            width={1200}
            height={720}
          />
          <canvas
            ref={canvasRef}
            className="instrument-canvas"
            data-live={live ? 'true' : 'false'}
          />
        </div>
      </div>

      {entrance === 'playing' ? (
        <div className="entrance" ref={overlayRef} aria-hidden="true">
          <span className="entrance-day">
            DAY <span ref={counterRef}>000</span>
          </span>
          <div className="entrance-type">
            <p className="entrance-line" ref={lineRef}>
              {LINES.open}
            </p>
            <p className="entrance-standfirst">{STANDFIRST}</p>
          </div>
          {chrome ? (
            <button type="button" className="entrance-skip" onClick={() => skipRef.current?.()}>
              SKIP
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="instrument-rail">
        <div className="readouts">
          <span>
            DAY {pad(readouts.day, 3)} · EPOCH {pad(readouts.day, 3)} ·{' '}
            {readouts.regime.toUpperCase()}
          </span>
          <span>
            <i>LIVE CHARTERS</i>
            {pad(readouts.liveCharters, 4)} / {cohort?.charters ?? initial.charters}
          </span>
          <span>
            <i>BRANCHES</i>
            {pad(readouts.totalBranches, 4)}
          </span>
          <span>
            <i>REPORTABLE</i>
            {pad(readouts.reportable, 4)}
          </span>
          <span>
            <i>MULTIPLIER</i>
            {readouts.multiplier.toFixed(4)}
          </span>
          <span>
            <i>YIELD / BRANCH</i>
            {pad(readouts.yieldPerBranchPerDay, 3)}
          </span>
        </div>

        <div className="controls" data-live={live ? 'true' : 'false'}>
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? 'PAUSE' : 'PLAY'}
          </button>
          <div className="scrub">
            <input
              type="range"
              min={0}
              max={(cohort?.days ?? 91) - 1}
              step={1}
              value={day}
              onChange={(e) => onScrub(Number(e.currentTarget.value))}
              aria-label="Day"
            />
            <div className="tick" style={{ left: `${(DAY_31 / ((cohort?.days ?? 91) - 1)) * 100}%` }}>
              <span>DAY 31</span>
            </div>
          </div>
        </div>
      </div>

      <p className="instrument-note">
        One seed from the study — cell {cohort?.cellId ?? initial.cellId}, seed{' '}
        {cohort?.seed ?? initial.seed}. The spiral arms are the phyllotaxis, not the data. Every
        charter, every day, replayable: <code>{replay ?? initial.replay}</code>
      </p>
    </section>
  )
}
