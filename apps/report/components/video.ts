/**
 * The video timeline.
 *
 * Deliberately not `entrance.ts`. The page has a reader who arrived on purpose
 * and will give it fifteen seconds; a video in a feed has about two to land or
 * it is scrolled past. So the beats are the same beats, compressed at the front
 * and given their time where the finding actually is — the ring hold, and the
 * cascade.
 *
 * Same contract as the entrance: a pure function of elapsed seconds. No clock,
 * no DOM, no randomness, and nothing read from `requestAnimationFrame`. The
 * same `t` produces the same pixels, which is what makes a frame-stepped render
 * possible at all.
 *
 *   0.0 -  1.5  arrival      the field assembles, DAY 000
 *   1.5 -  4.5  the clock    000 to 029, compressed
 *   4.5 -  6.0  the wave     030, rings up across a third of it, held
 *   6.0 - 11.0  the cascade  031 onward, holes opening at the data's own rate
 *  11.0 - 12.5  run on       to 045, field holed, ghosts in place
 *  12.5 - 15.0  end card     one cut, held still
 */

export const ARRIVE_END = 1.5
export const CLOCK_END = 4.5
export const HOLD_END = 6
export const CASCADE_END = 11
export const RUN_END = 12.5
export const CARD_START = 12.5
export const VIDEO_SECONDS = 15

export const FPS = 30
export const TOTAL_FRAMES = VIDEO_SECONDS * FPS

export const WAVE_DAY = 30
/** The wave clears over about a week; 031 to 038 is the cascade. */
export const CASCADE_END_DAY = 38
export const SETTLE_DAY = 45

/** Radians per second. Matches the page, so the two read as one object. */
export const SPIN_RATE = 0.055

export type VideoLine = 'open' | 'wave'

export interface VideoFrame {
  day: number
  arrive: number
  spin: number
  line: VideoLine
  /** True once the field is gone and only the end card is on screen. */
  card: boolean
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function easeOut(p: number): number {
  const t = clamp01(p)
  return 1 - (1 - t) ** 3
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * clamp01(p)
}

export function dayAt(t: number): number {
  if (t <= ARRIVE_END) return 0
  if (t <= CLOCK_END) {
    return (WAVE_DAY - 1) * easeOut((t - ARRIVE_END) / (CLOCK_END - ARRIVE_END))
  }
  if (t <= HOLD_END) return WAVE_DAY
  if (t <= CASCADE_END) {
    return lerp(WAVE_DAY + 1, CASCADE_END_DAY, (t - HOLD_END) / (CASCADE_END - HOLD_END))
  }
  if (t <= RUN_END) {
    return lerp(CASCADE_END_DAY, SETTLE_DAY, (t - CASCADE_END) / (RUN_END - CASCADE_END))
  }
  return SETTLE_DAY
}

export function frameAt(t: number): VideoFrame {
  return {
    day: Math.round(dayAt(t)),
    arrive: clamp01(t / (ARRIVE_END * 0.86)),
    spin: t * SPIN_RATE,
    line: t >= HOLD_END ? 'wave' : 'open',
    card: t >= CARD_START,
  }
}

export const LINES: Record<VideoLine, string> = {
  open: 'A thousand charters. One clock.',
  wave: 'On the thirty-first day, a third of them go dark.',
}

export const STANDFIRST = 'The Thirty-First Day · an independent study of The Standard Reserve'

/** The end card. One cut, then still for two and a half seconds. */
export const CARD = {
  headline: 'The bank does not see it for two epochs.',
  domain: 'day31.xyz',
  standfirst: 'An independent study of The Standard Reserve',
} as const

export function counter(day: number): string {
  return String(Math.max(0, Math.round(day))).padStart(3, '0')
}
