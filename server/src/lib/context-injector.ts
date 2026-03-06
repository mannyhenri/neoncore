import db from '../db.js';
import { sendCommandToAgent } from './send-command.js';

/**
 * Build a project context block from recent sessions and knowledge files.
 * Injected when a new session starts so the agent has continuity.
 */
export function buildProjectContext(project: string): string {
  if (!project) return '';

  const parts: string[] = [];

  // Last 2 session summaries
  const sessions = db.prepare(
    "SELECT summary FROM sessions WHERE project = ? AND status = 'summarized' AND summary != '' ORDER BY started_at DESC LIMIT 2"
  ).all(project) as { summary: string }[];

  if (sessions.length > 0) {
    parts.push('## Recent Sessions');
    for (const s of sessions) {
      // Truncate each summary to ~600 chars to stay within budget
      parts.push(s.summary.slice(0, 600));
      parts.push('---');
    }
  }

  // Gotchas
  const gotchas = db.prepare(
    "SELECT content FROM project_knowledge WHERE project = ? AND filename = 'gotchas.md'"
  ).get(project) as { content: string } | undefined;

  if (gotchas?.content && gotchas.content.trim().length > 30) {
    parts.push('## Known Gotchas');
    parts.push(gotchas.content.slice(0, 500));
  }

  // Recent progress (last 10 lines)
  const progress = db.prepare(
    "SELECT content FROM project_knowledge WHERE project = ? AND filename = 'progress.md'"
  ).get(project) as { content: string } | undefined;

  if (progress?.content) {
    const lines = progress.content.trim().split('\n').filter((l) => l.startsWith('- '));
    if (lines.length > 0) {
      parts.push('## Recent Progress');
      parts.push(lines.slice(-10).join('\n'));
    }
  }

  if (parts.length === 0) return '';

  return `[Project Context for ${project}]\n\n${parts.join('\n\n')}`;
}

/**
 * Inject project context into a new agent session.
 * Called from session-manager.ts startSession().
 */
export function injectProjectContext(agentId: string, project: string): void {
  const context = buildProjectContext(project);
  if (!context) return;

  console.log(`[context] Injecting project context for "${project}" into agent ${agentId.slice(0, 8)} (${context.length} chars)`);
  sendCommandToAgent(agentId, context, false);
}
