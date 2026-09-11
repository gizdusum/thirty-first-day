/**
 * The entrance timeline.
 *
 * A pure function of elapsed seconds. Nothing here reads the clock, the DOM or
 * a random number, so the same second always produces the same frame — which
 * is what makes the sequence recordable: run it twice and you get the same
 * fifteen seconds, frame for frame, on any machine.
 *
 * Four beats:
 *
 *   0.0 - 2.0   arrival    the thousand points assemble in charter-index order
 *   2.0 - 8.0   the clock  day 000 to 029, quick at first and slowing
 *   8.0 - 13.0  the wave   030 holds, then 031 onward at the rate the data
 *                          actually revokes — a cascade over about a week
 *  13.0 - 15.0  settle     on to 045, and the stage resolves into the page
 *
 * The clock beat eases out rather than running flat because nothing happens in
 * it. It is there so the wave lands, and it should get out of its own way.
 */

export const ARRIVE_END = 2
export const CLOCK_END = 8
export const HOLD_END = 9.6
export const CASCADE_END = 13
export const RUN_END = 14.2
export const ENTRANCE_SECONDS = 15

/** The day the wave becomes visible, and the day the holes start. */
export const WAVE_DAY = 30
export const SETTLE_DAY = 45

/** Radians per second. Slow: this is an instrument, not a screensaver. */
export const SPIN_RATE = 0.055

export type EntranceLine = 'open' | 'wave'

export interface EntranceFrame {
  /** Day to show, already rounded. */
  day: number
  /** Point assembly, 0 to 1. */
  arrive: number
  /** Resolve into the page, 0 to 1. */
  settle: number
  /** Which of the two sentences is on screen. */
  line: EntranceLine
  /** Disc rotation in radians, as a function of elapsed time rather than of
   *  accumulated frame deltas, so a dropped frame cannot change the angle. */
  spin: number
  /** True once the sequence has finished and the page should take over. */
  done: boolean
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Fast, then easing off. Used for the beat where nothing happens. */
function easeOut(p: number): number {
  const t = clamp01(p)
  return 1 - (1 - t) ** 3
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * clamp01(p)
}

/** The day shown at `t`, as a float, before rounding. */
export function dayAt(t: number): number {
  if (t <= ARRIVE_END) return 0
  if (t <= CLOCK_END) {
    return (WAVE_DAY - 1) * easeOut((t - ARRIVE_END) / (CLOCK_END - ARRIVE_END))
  }
  // The hold. The rings are up across a third of the field and nothing has
  // been destroyed yet, which is the entire point of finding one.
  if (t <= HOLD_END) return WAVE_DAY
  if (t <= CASCADE_END) {
    return lerp(WAVE_DAY + 1, 38, (t - HOLD_END) / (CASCADE_END - HOLD_END))
  }
  if (t <= RUN_END) return lerp(38, SETTLE_DAY, (t - CASCADE_END) / (RUN_END - CASCADE_END))
  return SETTLE_DAY
}

export function frameAt(t: number): EntranceFrame {
  return {
    day: Math.round(dayAt(t)),
    // A touch past 1 so the last charters are fully up before the clock starts.
    arrive: clamp01(t / (ARRIVE_END * 0.86)),
    settle: clamp01((t - CASCADE_END) / (ENTRANCE_SECONDS - CASCADE_END)),
    line: t >= HOLD_END ? 'wave' : 'open',
    spin: t * SPIN_RATE,
    done: t >= ENTRANCE_SECONDS,
  }
}

export const LINES: Record<EntranceLine, string> = {
  open: 'A thousand charters. One clock.',
  wave: 'On the thirty-first day, a third of them go dark.',
}

export const STANDFIRST = 'The Thirty-First Day · an independent study of The Standard Reserve'

/** Three digits, zero padded, so the counter never reflows. */
export function counter(day: number): string {
  return String(Math.max(0, Math.round(day))).padStart(3, '0')
}
