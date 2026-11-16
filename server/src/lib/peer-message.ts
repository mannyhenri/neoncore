/**
 * ONE AGENT MESSAGING ANOTHER — delivered as what it is.
 *
 * `neoncore_message_agent` used the same route as a person's prompt, so a peer's comment arrived
 * in the other cartridge with no sender, wrapped in the goal brief and the work-standard block (a
 * 274-char comment became 1,365 chars at a Codex peer), and became that cartridge's ACTIVE
 * OBJECTIVE — resetting its Stop-gate arming in the middle of a milestone.
 *
 * Now it carries a one-line header (who sent it, that it is not the user, how to reply) and
 * nothing else; the recipient's objective and gate state are left alone.
 *
 * ── A LATE COMMENT RE-OPENS THE MILESTONE FOR ITS RECIPIENT ──────────────────────────
 * A confer advances a milestone when every participant has signalled done. A participant that had
 * already signalled stayed "done" when its peer's comments arrived afterwards, so the confer moved
 * to the next stage with them unread. When the sender and the recipient share a running confer and
 * the recipient has signalled the ACTIVE milestone done, its signal is withdrawn and it is told to
 * deal with the comment and signal again. The milestone then waits for it.
 */
import db from '../db.js';
import { AUTH_CURL_HEADER, getServerBaseUrl } from './server-url.js';

export interface Sender { id: string; name: string; repoName: string; agentType: string }

const normalizePath = (p: string) => p.trim().replace(/\/+$/, '');

/**
 * Who sent it: the id the relay exports into the agent's environment (NEONCORE_AGENT_ID, read by
 * the MCP tool), or — for agents not launched by a relay — the cartridge in that repo on that
 * engine seen most recently.
 */
export function resolveSender(body: { from?: unknown; fromRepoPath?: unknown; fromAgentType?: unknown }): Sender | null {
  const id = typeof body.from === 'string' ? body.from.trim() : '';
  let row = id
    ? db.prepare('SELECT id, name, repo_name, agent_type FROM agents WHERE id = ?').get(id) as Record<string, string> | undefined
    : undefined;
  const repo = typeof body.fromRepoPath === 'string' ? normalizePath(body.fromRepoPath) : '';
  if (!row && repo) {
    const type = typeof body.fromAgentType === 'string' ? body.fromAgentType : '';
    const candidates = db.prepare('SELECT id, name, repo_name, agent_type, repo_path FROM agents ORDER BY last_seen DESC')
      .all() as Array<Record<string, string>>;
    row = candidates.find((a) => normalizePath(a.repo_path || '') === repo && (!type || a.agent_type === type))
      ?? candidates.find((a) => normalizePath(a.repo_path || '') === repo);
  }
  return row ? { id: row.id, name: row.name || row.id, repoName: row.repo_name || '', agentType: row.agent_type || '' } : null;
}

/**
 * The text to deliver: header + message, plus — when the message re-opens the recipient's confer
 * milestone — what that means and how to signal done again. Re-opening happens HERE, in the same
 * step as delivery, so a message can never be delivered without its effect or vice versa.
 */
export function composePeerMessage(sender: Sender, recipientId: string, text: string): string {
  const where = [sender.repoName, sender.agentType].filter(Boolean).join(', ');
  const header = `[Message from ${sender.name}${where ? ` (${where})` : ''} — a peer agent, not the user. `
    + `Reply with neoncore_message_agent targetAgentId: "${sender.id}".]`;
  const reopened = reopenForLateComment(sender.id, recipientId);
  return `${header}\n${text}${reopened ? `\n\n${reopened}` : ''}`;
}

function reopenForLateComment(senderId: string, recipientId: string): string {
  const sessions = db.prepare(
    "SELECT id, current_milestone, participant_ids FROM confer_sessions WHERE status = 'running'",
  ).all() as Array<{ id: string; current_milestone: number; participant_ids: string }>;
  for (const s of sessions) {
    const participants = JSON.parse(s.participant_ids || '[]') as string[];
    if (!participants.includes(senderId) || !participants.includes(recipientId)) continue;
    const ms = db.prepare('SELECT id, idx, name, done_ids FROM confer_milestones WHERE session_id = ? AND idx = ?')
      .get(s.id, s.current_milestone) as { id: string; idx: number; name: string; done_ids: string } | undefined;
    if (!ms) continue;
    const done = JSON.parse(ms.done_ids || '[]') as string[];
    if (!done.includes(recipientId)) continue;
    db.prepare('UPDATE confer_milestones SET done_ids = ? WHERE id = ?')
      .run(JSON.stringify(done.filter((d) => d !== recipientId)), ms.id);
    const url = `\${NEONCORE_URL:-${getServerBaseUrl()}}/api/confer/${s.id}/milestone/${recipientId}/done`;
    return `[NeonCore Confer] You had signalled milestone ${ms.idx + 1} (${ms.name}) done; this message re-opens it for you. `
      + `Address it — reply if it needs an answer — then signal done again:\n`
      + `curl -s -X POST "${url}" ${AUTH_CURL_HEADER} -H "Content-Type: application/json" -d '{"result":"<1 line>"}'`;
  }
  return '';
}
