import db from '../db.js';
import { sendCommandToAgent } from './send-command.js';
import {
  SESSION_SUMMARY_MAX_CHARS,
  SESSION_COUNT,
  KNOWLEDGE_FILE_MAX_CHARS,
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

  // Gotchas
  const gotchas = db.prepare(
    "SELECT content FROM project_knowledge WHERE project = ? AND filename = 'gotchas.md'"
  ).get(project) as { content: string } | undefined;

  if (gotchas?.content && gotchas.content.trim().length > 30) {
    parts.push('## Known Gotchas');
    parts.push(gotchas.content.slice(0, KNOWLEDGE_FILE_MAX_CHARS));
  }

  // Recent progress (last 8 lines)
  const progress = db.prepare(
    "SELECT content FROM project_knowledge WHERE project = ? AND filename = 'progress.md'"
  ).get(project) as { content: string } | undefined;

  if (progress?.content) {
    const lines = progress.content.trim().split('\n').filter((l) => l.startsWith('- '));
    if (lines.length > 0) {
      parts.push('## Recent Progress');
      const progressText = lines.slice(-8).join('\n');
      parts.push(progressText.slice(0, KNOWLEDGE_FILE_MAX_CHARS));
    }
  }

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
    includeProgress?: boolean;
    includeGotchas?: boolean;
    includeDecisions?: boolean;
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

  // Knowledge files (full content)
  const fileMap: [boolean | undefined, string, string][] = [
    [options.includeProgress, 'progress.md', '## Recent Progress'],
    [options.includeGotchas, 'gotchas.md', '## Known Gotchas'],
    [options.includeDecisions, 'decisions.md', '## Decisions'],
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
 * Called from session-manager.ts startSession().
 */
export function injectProjectContext(agentId: string, project: string): void {
  const context = buildProjectContext(project);
  if (!context) return;

  console.log(`[context] Injecting project context for "${project}" into agent ${agentId.slice(0, 8)} (${context.length} chars)`);
  sendCommandToAgent(agentId, context, false);
}
