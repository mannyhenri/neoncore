import db from '../db.js';

export type AgentRecoveryReason = 'disconnect' | 'session-end' | 'zombie';

function latestSessionId(agentId: string): string {
  const row = db.prepare(
    'SELECT session_id FROM messages WHERE agent_id = ? ORDER BY ts DESC LIMIT 1',
  ).get(agentId) as { session_id?: string } | undefined;
  return row?.session_id || '';
}

function hasRecoverableTranscript(agentId: string): boolean {
  const row = db.prepare(
    'SELECT id FROM messages WHERE agent_id = ? LIMIT 1',
  ).get(agentId) as { id?: string } | undefined;
  return !!row;
}

/**
 * Mark ordinary, non-workflow cartridge work as recoverable. This is deliberately
 * lightweight: workflow steps keep their richer recovery state on workflow_steps.
 * For direct terminal work we only need to remember that the last session ended
 * unexpectedly enough to offer transcript replay after the cartridge reconnects.
 */
export function markAgentSessionInterrupted(agentId: string, reason: AgentRecoveryReason): boolean {
  const agent = db.prepare(
    `SELECT id, recovery_status, active_objective
     FROM agents WHERE id = ?`,
  ).get(agentId) as { id: string; recovery_status: string; active_objective: string } | undefined;
  if (!agent) return false;
  if (agent.recovery_status === 'interrupted') return false;

  // Avoid cluttering every never-used cartridge with a Resume button. A transcript
  // or an explicit dashboard objective is enough evidence that there is work to resume.
  if (!agent.active_objective && !hasRecoverableTranscript(agentId)) return false;

  const now = new Date().toISOString();
  const sessionId = latestSessionId(agentId);
  const changes = db.prepare(
    `UPDATE agents
     SET recovery_status = 'interrupted',
         interrupted_at = ?,
         recovery_session_id = ?
     WHERE id = ?`,
  ).run(now, sessionId, agentId).changes;

  if (changes > 0) {
    console.log(`[agent-recovery] Agent ${agentId} marked interrupted (${reason})`);
  }
  return changes > 0;
}
