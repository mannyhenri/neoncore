/**
 * Shared agent deletion — removes an agent row together with every row that
 * references it, in a single transaction. Used by the manual DELETE route and
 * the periodic offline-agent reaper so both clean up identically.
 *
 * `foreign_keys` IS enforced on this connection (better-sqlite3's default) and the child
 * tables' constraints do not cascade, so the child rows are deleted here first, explicitly —
 * a table with a constraint on agents missing from this list makes the delete throw.
 */
import db from '../db.js';

/**
 * The tables whose rows belong to the cartridge and go with it. Rows that are HISTORY of shared
 * work stay: workflow steps, goal pilot stages/requests/drafts, queue completions, limit events
 * and finished tasks still say who did what after the cartridge is gone.
 */
const AGENT_CHILD_TABLES = [
  'activity',
  'agent_memory',
  'commands',
  'messages',
  'permissions',
  'heartbeats',
  'session_usage',
  'sessions',
] as const;

const deleteAgentTx = db.transaction((id: string) => {
  // Unfinished tasks it held go back to the queue. A task is claimable only while unassigned,
  // and a deleted cartridge never returns under this id (a new session registers a new row), so
  // left as they were these tasks could never be picked up by anyone.
  db.prepare(`UPDATE tasks SET status = 'queued', assigned_agent_id = NULL, claimed_at = NULL
               WHERE assigned_agent_id = ? AND status IN ('queued', 'claimed', 'in_progress')`).run(id);
  // Notes are project notes; they outlive the cartridge (older rows still carry its id).
  for (const table of AGENT_CHILD_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(id);
  }
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
});

/** Delete an agent and all rows that reference it. */
export function deleteAgentCascade(agentId: string): void {
  deleteAgentTx(agentId);
}
