/**
 * xoshiro128** — the single source of randomness in this model.
 *
 * The RNG is threaded explicitly: `World` owns one instance and hands it to
 * agents on every tick. Nothing in the package calls `Math.random` or
 * `Date.now`. Same seed + same config => byte-identical history.
 *
 * Reference: Blackman & Vigna, "Scrambled Linear Pseudorandom Number
 * Generators" (2018). State is 4 x uint32.
 */

import { WAD } from '../math/fixed.js'

export interface Rng {
  /** Uniform uint32. */
  nextU32(): number
  /** Uniform integer in `[0, maxExclusive)`. */
  nextInt(maxExclusive: number): number
  /** Uniform bigint in `[0, maxExclusive)`. */
  nextBigint(maxExclusive: bigint): bigint
  /** True with probability `probWad / 1e18`. */
  nextBool(probWad: bigint): boolean
  /** Uniform bigint in `[lo, hi]`, inclusive. */
  nextRange(lo: bigint, hi: bigint): bigint
  /** Uniformly pick one element; throws on an empty array. */
  pick<T>(items: readonly T[]): T
  /** Current state, for snapshotting. */
  getState(): readonly [number, number, number, number]
  setState(state: readonly [number, number, number, number]): void
  /** An independent copy positioned at the same point in the stream. */
  clone(): Rng
}

/** Bits per RNG draw. */
const WORD_BITS = 32n

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0
}

/** splitmix32, used only to expand a single seed into the 128-bit state. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x9e3779b9) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0
    return (t ^ (t >>> 15)) >>> 0
  }
}

class Xoshiro128 implements Rng {
  private s0: number
  private s1: number
  private s2: number
  private s3: number

  constructor(state: readonly [number, number, number, number]) {
    this.s0 = state[0] >>> 0
    this.s1 = state[1] >>> 0
    this.s2 = state[2] >>> 0
    this.s3 = state[3] >>> 0
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7) >>> 0, 9) >>> 0
    const t = (this.s1 << 9) >>> 0
    this.s2 = (this.s2 ^ this.s0) >>> 0
    this.s3 = (this.s3 ^ this.s1) >>> 0
    this.s1 = (this.s1 ^ this.s2) >>> 0
    this.s0 = (this.s0 ^ this.s3) >>> 0
    this.s2 = (this.s2 ^ t) >>> 0
    this.s3 = rotl(this.s3, 11)
    return result
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextInt: maxExclusive must be a positive integer, got ${maxExclusive}`)
    }
    return Number(this.nextBigint(BigInt(maxExclusive)))
  }

  /**
   * Draws 32 bits more than `maxExclusive` needs and reduces modulo the bound.
   * The residual modulo bias is below 2^-32 of the bound, which is far under
   * the resolution of anything this study measures, and it keeps the number of
   * RNG draws per call fixed — which matters more here, because a variable
   * draw count (rejection sampling) would make the stream position depend on
   * rejected values and complicate reasoning about determinism.
   */
  nextBigint(maxExclusive: bigint): bigint {
    if (maxExclusive <= 0n) throw new RangeError('nextBigint: maxExclusive must be positive')
    if (maxExclusive === 1n) return 0n
    let words = 1
    let span = 1n << WORD_BITS
    while (span < maxExclusive) {
      span <<= WORD_BITS
      words++
    }
    words++ // one extra word of headroom to suppress modulo bias
    let acc = 0n
    for (let i = 0; i < words; i++) acc = (acc << WORD_BITS) | BigInt(this.nextU32())
    return acc % maxExclusive
  }

  nextBool(probWad: bigint): boolean {
    if (probWad <= 0n) return false
    if (probWad >= WAD) return true
    return this.nextBigint(WAD) < probWad
  }

  nextRange(lo: bigint, hi: bigint): bigint {
    if (hi < lo) throw new RangeError('nextRange: hi < lo')
    return lo + this.nextBigint(hi - lo + 1n)
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick: empty array')
    return items[this.nextInt(items.length)] as T
  }

  getState(): readonly [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3]
  }

  setState(state: readonly [number, number, number, number]): void {
    this.s0 = state[0] >>> 0
    this.s1 = state[1] >>> 0
    this.s2 = state[2] >>> 0
    this.s3 = state[3] >>> 0
  }

  clone(): Rng {
    return new Xoshiro128(this.getState())
  }
}

/** Builds an RNG from a single 32-bit seed. */
export function createRng(seed: number): Rng {
  const mix = splitmix32(seed)
  let state: [number, number, number, number] = [mix(), mix(), mix(), mix()]
  // xoshiro is undefined for an all-zero state; splitmix32 makes this
  // practically impossible, but the guard is free.
  if (state.every((w) => w === 0)) state = [1, 2, 3, 4]
  return new Xoshiro128(state)
}

export function rngFromState(state: readonly [number, number, number, number]): Rng {
  return new Xoshiro128(state)
}
