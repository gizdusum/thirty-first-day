/**
 * The instrument is additive and reversible.
 *
 * Set this to `false` and the report ships exactly as it stood before it was
 * built: no canvas, no three.js chunk, no `cohort.json` fetch, no reserved
 * height. Nothing else in the report knows the instrument exists.
 */
export const INSTRUMENT = true

/**
 * The entrance is the same, one level up.
 *
 * `false` and the page opens at the settled state it opens at today — the
 * instrument as a hero, the report beneath it. The entrance only ever adds an
 * overlay on top of that page; it never gates it, and nothing below it knows
 * it exists.
 */
export const ENTRANCE = true
