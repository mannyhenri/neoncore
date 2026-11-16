/**
 * Has a cartridge's turn ended since NeonCore last typed into it?
 *
 * The end of a turn is reported by the Stop hooks (routes/agents.ts `turnEnded`), which also flips
 * the cartridge's status to idle. This narrower question — "is the turn that began with MY last
 * command over?" — is what the executor asks before typing the /clear that opens a fresh session.
 *
 * In memory on purpose: after a restart nothing is known, and "unknown" must mean "not over"
 * (fall back to the status), never "free to type into".
 */
import db from '../db.js';

const turnEndedAt = new Map<string, number>();

/** The Stop hook's completion check allowed `agentId` to stop. */
export function noteTurnEnded(agentId: string, at = Date.now()): void {
  turnEndedAt.set(agentId, at);
}

/** Has the cartridge's turn ended since the last thing NeonCore typed into it? */
export function turnIsOver(agentId: string): boolean {
  const ended = turnEndedAt.get(agentId);
  if (!ended) return false;
  const last = db.prepare('SELECT MAX(created_at) AS t FROM commands WHERE agent_id = ?').get(agentId) as { t?: string | null };
  return !last?.t || Date.parse(last.t) <= ended;
}
