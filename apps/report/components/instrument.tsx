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

const VERTEX = `
  attribute float aSize;
  attribute float aOpacity;
  attribute float aRing;
  varying float vOpacity;
  varying float vRing;
  uniform float uScale;
  void main() {
    vOpacity = aOpacity;
    vRing = aRing;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.0001, -mv.z);
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

export function Instrument({ initial }: { initial: Initial }) {
  const stage = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [live, setLive] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [day, setDay] = useState(FALLBACK_DAY)
  const [cohort, setCohort] = useState<Cohort | null>(null)
  const [replay, setReplay] = useState<string | null>(null)

  const dayRef = useRef(day)
  dayRef.current = day
  const playingRef = useRef(playing)
  playingRef.current = playing
  const applyRef = useRef<((d: number) => void) | null>(null)

  // -- Load, initialise, animate --------------------------------------------
  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | undefined

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) setPlaying(false)

    const start = async (): Promise<void> => {
      const host = stage.current
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
      const MARGIN = 0.92
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
        const tanV = Math.tan(((camera.fov / 2) * Math.PI) / 180)
        for (let pass = 0; pass < 6; pass++) {
          camera.position.copy(DIRECTION).multiplyScalar(distance)
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
          distance *= Math.max(maxX, halfY) / MARGIN
          lookY += ((maxY + minY) / 2) * distance * tanV
        }
      }
      const n = data.charters
      const positions = new Float32Array(n * 3)
      const sizes = new Float32Array(n)
      const opacity = new Float32Array(n)
      const ring = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const [x, z] = position(i, n)
        positions[i * 3] = x
        positions[i * 3 + 1] = 0
        positions[i * 3 + 2] = z
      }

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
      geometry.setAttribute('aOpacity', new THREE.BufferAttribute(opacity, 1))
      geometry.setAttribute('aRing', new THREE.BufferAttribute(ring, 1))

      const ink = cssColour('--ink', [0.14, 0.12, 0.09])
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uInk: { value: new THREE.Vector3(ink[0], ink[1], ink[2]) },
          uScale: { value: 16 },
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

      let raf = 0
      let last = performance.now()
      let accumulated = 0
      const DAY_SECONDS = 0.42

      const frame = (now: number): void => {
        raf = requestAnimationFrame(frame)
        const dt = Math.min(0.1, (now - last) / 1000)
        last = now
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

      setCohort(data)
      setReplay(data.replay)
      setLive(true)

      cleanup = () => {
        cancelAnimationFrame(raf)
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
    <section className="instrument" aria-label="The genesis cohort over ninety days">
      <div className="instrument-stage" ref={stage}>
        <img
          src="/field-day31.png"
          alt={`The genesis cohort on day ${initial.day}: ${initial.charters} charters on a disc, one point each, sized by branch count. ${initial.liveCharters} are live, ${initial.reportable} of them carry a ring marking them reportable, and the faint ghosts are the ${initial.revokedCumulative ?? 0} already revoked.`}
          className="instrument-static"
          data-live={live ? 'true' : 'false'}
          width={1200}
          height={720}
        />
        <canvas ref={canvasRef} className="instrument-canvas" data-live={live ? 'true' : 'false'} />
      </div>

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
