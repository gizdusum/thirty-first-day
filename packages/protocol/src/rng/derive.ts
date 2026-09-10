/**
 * Deriving one RNG stream per (seed, agent, purpose).
 *
 * The paired counterfactual in `runPaired` runs the same world twice with one
 * rule changed. That only tells us anything if the two runs stay aligned
 * wherever the rule is irrelevant. A single shared generator cannot promise
 * that: the moment the treatment world takes one extra draw — a hunter
 * resolving a contest that the control world never has — every subsequent draw
 * in that world is shifted, and the two histories diverge for reasons that
 * have nothing to do with revocation.
 *
 * So every agent gets its own stream, and each distinct kind of decision gets
 * its own stream within that. An extra draw is then local to the purpose that
 * took it.
 */

/** FNV-1a, 32-bit. Deterministic across platforms; no ambient state. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    hash ^= code & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
    hash ^= (code >>> 8) & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * The key identifying one stream. The separator is a character that cannot
 * appear in an agent id or a purpose, so distinct triples always produce
 * distinct keys.
 */
export function streamKey(agentId: string, purpose: string): string {
  return `${agentId}|${purpose}`
}

/** A stable 32-bit seed for one stream. */
export function deriveSeed(seed: number, agentId: string, purpose: string): number {
  return fnv1a32(`${seed >>> 0}|${streamKey(agentId, purpose)}`)
}
