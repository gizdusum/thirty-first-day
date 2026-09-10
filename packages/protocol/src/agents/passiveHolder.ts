import type { Action, Agent, AgentView } from '../types.js'

/**
 * Does nothing, ever.
 *
 * A genesis banker who never interacts is exactly the dormancy case
 * (whitepaper 10): 30 days after genesis this agent's charter becomes
 * reportable and stays that way. Trivial, and the whole point of the study.
 */
export class PassiveHolder implements Agent {
  constructor(readonly id: string) {}

  onTick(_view: AgentView): Action[] {
    return []
  }
}
