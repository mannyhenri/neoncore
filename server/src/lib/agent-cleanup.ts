/**
 * Shared agent deletion — removes an agent row together with every row that
 * references it, in a single transaction. Used by the manual DELETE route and
 * the periodic offline-agent reaper so both clean up identically.
 *
 * NOTE: `foreign_keys` is not enabled on this connection (see db.ts), so child
 * rows are not auto-cascaded by SQLite — we delete them explicitly here.
 */
import db from '../db.js';

/** Every table carrying an `agent_id` that points back at `agents.id`. */
const AGENT_CHILD_TABLES = [
  'activity',
  'agent_memory',
  'commands',
  'messages',
  'epic_runs',
  'notes',
  'permissions',
  'heartbeats',
  'session_usage',
  'sessions',
] as const;

const deleteAgentTx = db.transaction((id: string) => {
  for (const table of AGENT_CHILD_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(id);
  }
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
});

/** Delete an agent and all rows that reference it. */
export function deleteAgentCascade(agentId: string): void {
  deleteAgentTx(agentId);
}
