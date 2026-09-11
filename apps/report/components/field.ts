/**
 * The layout, shared by the live instrument and the static fallback.
 *
 * No positions are exported in `cohort.json`; they are computed from the
 * charter index, so the layout is deterministic, identical in both renderers,
 * and costs nothing to transfer.
 *
 * Phyllotaxis: charter `i` sits at angle `i x 137.508°` and radius
 * `sqrt(i)`. It is the arrangement a sunflower head uses: a thousand points on
 * a disc at even density, with no clumping and no gaps.
 *
 * It does show the spiral arms a sunflower shows. That is a property of the
 * arrangement, not of the data, and the caption says so — a reader should not
 * be left wondering whether the curves mean something.
 */

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

export const STATE = { active: 0, dormant: 1, reportable: 2, revoked: 3 } as const

export interface Cohort {
  cellId: string
  seed: number
  days: number
  charters: number
  replay: string
  maxBalanceTokens: number
  state: number[][]
  branches: number[][]
  balance: number[][]
  daily: Array<{
    day: number
    liveCharters: number
    totalBranches: number
    reportable: number
    revokedCumulative: number
    multiplier: number
    yieldPerBranchPerDay: number
    regime: string
  }>
}

/** `[x, z]` on the unit disc for charter `i` of `n`. */
export function position(i: number, n: number): [number, number] {
  const angle = i * GOLDEN_ANGLE
  const radius = Math.sqrt((i + 0.5) / n)
  return [Math.cos(angle) * radius, Math.sin(angle) * radius]
}

/** Point radius, in the same units as the disc, from a branch count of 1..10. */
export function pointScale(branchCount: number): number {
  // sqrt so that ten branches reads as bigger than one without a ten-branch
  // charter swamping its neighbours.
  return 0.55 + 0.45 * Math.sqrt(Math.max(0, branchCount) / 10)
}

/** Vertical offset from the accrued balance byte, giving the field relief. */
export function height(balanceByte: number): number {
  return (balanceByte / 255) * 0.16
}

export interface Appearance {
  /** 0..1 multiplier on the ink colour's alpha. */
  opacity: number
  /** 1 when the point should carry a halo, drawn well outside the dot. */
  ring: number
}

/**
 * How far out the reportable halo sits, as a multiple of the dot radius.
 *
 * Generously outside it. A ring drawn at the dot's own edge is invisible at
 * the size these points are actually rendered — checked, at 390px and in the
 * static fallback — and the whole purpose of the ring is that the wave should
 * be legible while it builds.
 */
export const HALO = 2.1

/**
 * How a charter looks, by state.
 *
 * A revoked charter stays exactly where it was at 10% opacity. The hole it
 * leaves is the finding; a shrinking cloud would hide it.
 */
export function appearance(state: number): Appearance {
  switch (state) {
    case STATE.active:
      return { opacity: 1, ring: 0 }
    case STATE.dormant:
      return { opacity: 0.42, ring: 0 }
    case STATE.reportable:
      return { opacity: 1, ring: 1 }
    default:
      return { opacity: 0.1, ring: 0 }
  }
}
