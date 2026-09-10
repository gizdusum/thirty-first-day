/**
 * Fixed-point helpers.
 *
 * Every quantity in the model is a `bigint`. Token amounts and ETH amounts are
 * held in wei (18 decimals). Fractions, rates and multipliers are held as WAD
 * fixed-point: 1.0 === 1e18.
 *
 * There are no floating point numbers anywhere in protocol state. `number` is
 * used only for counts (ticks, branch counts, ids), never for value.
 */

/** 1.0 in fixed point. Also 1 whole token, since $STANDARD has 18 decimals. */
export const WAD = 1_000_000_000_000_000_000n

/** Basis-point denominator. 10_000 bps === 100%. */
export const BPS = 10_000n

/** `a * b`, both WAD, result WAD. Truncates toward zero (both operands >= 0). */
export function mulWad(a: bigint, b: bigint): bigint {
  return (a * b) / WAD
}

/** `a / b`, both WAD, result WAD. Truncates. */
export function divWad(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('divWad: division by zero')
  return (a * WAD) / b
}

/** `a * bps / 10_000`. Truncates. */
export function mulBps(a: bigint, bps: bigint): bigint {
  return (a * bps) / BPS
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

export function clampBig(x: bigint, lo: bigint, hi: bigint): bigint {
  if (lo > hi) throw new RangeError('clampBig: lo > hi')
  return x < lo ? lo : x > hi ? hi : x
}

export function absBig(a: bigint): bigint {
  return a < 0n ? -a : a
}

/** `x^n` in WAD fixed point, by repeated multiplication. `n` is a small integer. */
export function powWadN(x: bigint, n: number): bigint {
  if (n < 0) throw new RangeError('powWadN: negative exponent')
  let acc = WAD
  for (let i = 0; i < n; i++) acc = mulWad(acc, x)
  return acc
}

/**
 * The `n`-th root of a WAD value in `[0, WAD]`, by bisection on `powWadN`.
 *
 * Used once per auction day to turn the Dutch decay ratio `P_floor / P_start`
 * into an hourly step, so that stepping 24 times reproduces the continuous
 * curve `P_start * (P_floor / P_start)^(t / 24h)` exactly at each hourly tick.
 *
 * 96 bisection steps resolve the full 1e18 range to the last wei.
 */
export function nthRootWad(x: bigint, n: number): bigint {
  if (n <= 0) throw new RangeError('nthRootWad: n must be positive')
  if (x < 0n) throw new RangeError('nthRootWad: negative input')
  if (x === 0n) return 0n
  if (x > WAD) throw new RangeError('nthRootWad: only defined on [0, WAD] here')
  let lo = 0n
  let hi = WAD
  for (let i = 0; i < 96; i++) {
    const mid = (lo + hi) / 2n
    if (mid === lo) break
    if (powWadN(mid, n) <= x) lo = mid
    else hi = mid
  }
  return lo
}

/** Whole tokens (or whole ETH) as wei. `tokens(100_000_000)` === 100e6 * 1e18. */
export function tokens(whole: bigint | number): bigint {
  return BigInt(whole) * WAD
}

/**
 * Exact division by a fixed divisor, via Barrett reduction.
 *
 * `floor(n / d)` for many different `n` against one `d`. BigInt division is
 * markedly more expensive than BigInt multiplication in V8, and the
 * pro-rata redistribution in `redistributePro` performs one division per live
 * branch per fee — tens of millions of them over a single 90-day run, which
 * profiling showed to be roughly three quarters of the model's total runtime.
 *
 * `prepareDivisor` precomputes `floor(2^SHIFT / d)` once; `divExact` then
 * replaces the division with two multiplications, a shift and at most one
 * correction step. The result is bit-identical to `n / d` — this is a
 * cheaper route to the same integer, not an approximation.
 *
 * Correctness: with `inv = floor(2^k / d) = 2^k/d - e` for `0 <= e < 1`, the
 * estimate `floor(n * inv / 2^k)` equals `floor(n/d)` or one less, provided
 * `n < 2^k`. `prepareDivisor` returns null when that bound cannot be
 * guaranteed, and callers fall back to plain division.
 */
const BARRETT_SHIFT = 256n
const BARRETT_LIMIT = 1n << BARRETT_SHIFT

export interface Divisor {
  readonly d: bigint
  readonly inv: bigint
}

/**
 * Prepare `d` for repeated exact division of numerators bounded by
 * `maxNumerator`. Returns null when Barrett cannot be applied safely.
 */
export function prepareDivisor(d: bigint, maxNumerator: bigint): Divisor | null {
  if (d <= 0n || maxNumerator >= BARRETT_LIMIT) return null
  return { d, inv: BARRETT_LIMIT / d }
}

/** `floor(n / divisor.d)`, exactly. `n` must be within the prepared bound. */
export function divExact(n: bigint, divisor: Divisor): bigint {
  const q = (n * divisor.inv) >> BARRETT_SHIFT
  return n - q * divisor.d >= divisor.d ? q + 1n : q
}
