import db from '../db.js';
import { sendCommandToAgent } from './send-command.js';
import {
  SESSION_SUMMARY_MAX_CHARS,
  SESSION_COUNT,
  PROJECT_CONTEXT_MAX_CHARS,
} from './context-budget.js';

/**
 * Build a project context block from recent sessions and knowledge files.
 * All components are capped by context-budget constants.
 */
export function buildProjectContext(project: string): string {
  if (!project) return '';

  const parts: string[] = [];

  // Last N session summaries
  const sessions = db.prepare(
    `SELECT summary FROM sessions WHERE project = ? AND status = 'summarized' AND summary != '' ORDER BY started_at DESC LIMIT ${SESSION_COUNT}`
  ).all(project) as { summary: string }[];

  if (sessions.length > 0) {
    parts.push('## Recent Sessions');
    for (const s of sessions) {
      parts.push(s.summary.slice(0, SESSION_SUMMARY_MAX_CHARS));
      parts.push('---');
    }
  }

  // progress.md and gotchas.md used to be read here. Both were auto-appended by the session
  // summarizer and read by nobody — the live progress.md was prompt fragments with "— {}" on
  // the end of each — so injecting them spent the context budget on noise. Recent sessions
  // above carry the same ground truth, written once per session instead of once per hook.

  if (parts.length === 0) return '';

  let result = `[Project Context for ${project}]\n\n${parts.join('\n\n')}`;
  if (result.length > PROJECT_CONTEXT_MAX_CHARS) {
    result = result.slice(0, PROJECT_CONTEXT_MAX_CHARS) + '\n...truncated';
  }
  return result;
}

/**
 * Build selective context based on user-chosen options from the Send Context popup.
 * No caps here — user explicitly chose what to send, so send it in full.
 */
export function buildSelectiveContext(
  project: string,
  options: {
    sessionIds?: string[];
    includeDetails?: boolean;
  },
): string {
  if (!project) return '';
  const parts: string[] = [];

  // Selected sessions (full summaries)
  if (options.sessionIds?.length) {
    const placeholders = options.sessionIds.map(() => '?').join(',');
    const sessions = db.prepare(
      `SELECT summary FROM sessions WHERE id IN (${placeholders}) ORDER BY started_at DESC`
    ).all(...options.sessionIds) as { summary: string }[];

    if (sessions.length > 0) {
      parts.push('## Recent Sessions');
      for (const s of sessions) {
        parts.push(s.summary);
        parts.push('---');
      }
    }
  }

  // Knowledge files (full content). One file now: details.md is the only one a PERSON writes,
  // and the only one worth spending a cartridge's context on. Derived from the registry so a
  // file added there is offered here without a second edit.
  const fileMap: [boolean | undefined, string, string][] = [
    [options.includeDetails, 'details.md', '## Project Details'],
  ];

  for (const [include, filename, heading] of fileMap) {
    if (!include) continue;
    const row = db.prepare(
      'SELECT content FROM project_knowledge WHERE project = ? AND filename = ?'
    ).get(project, filename) as { content: string } | undefined;
    if (row?.content?.trim()) {
      parts.push(heading);
      parts.push(row.content);
    }
  }

  if (parts.length === 0) return '';
  return `[Project Context for ${project}]\n\n${parts.join('\n\n')}`;
}

/**
 * Inject project context into a new agent session.
 * NOT called at session start, despite what this comment said for a long time.
 * session-manager.ts:74 records the actual rule: "Context injection is now manual — triggered
 * via dashboard 'Send Context' button". The only caller is POST /api/agents/:id/send-context.
 */
export function injectProjectContext(agentId: string, project: string): void {
  const context = buildProjectContext(project);
  if (!context) return;

  console.log(`[context] Injecting project context for "${project}" into agent ${agentId.slice(0, 8)} (${context.length} chars)`);
  sendCommandToAgent(agentId, context, false);
}
