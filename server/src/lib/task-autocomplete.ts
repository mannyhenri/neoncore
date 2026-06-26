import db from '../db.js';
import { getIO } from '../ws.js';
import { normalizeRepoPath } from './resolve-agent.js';
import type { Task, TaskStatus } from '../types.js';

function normalizeTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    title: row.title as string,
    prompt: (row.prompt as string) ?? '',
    projectId: (row.project_id as string) ?? null,
    status: (row.status as TaskStatus) ?? 'queued',
    assignedAgentId: (row.assigned_agent_id as string) ?? null,
    priority: (row.priority as number) ?? 0,
    result: (row.result as string) ?? '',
    error: (row.error as string) ?? '',
    createdAt: row.created_at as string,
    claimedAt: (row.claimed_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
  };
}

/**
 * Stop-hook auto-complete (path B): when an agent finishes a turn (its Stop hook
 * fires → POST /api/activity), mark its dispatched in-progress task done.
 *
 * Matches by repo, not by agent id: a relay registers one agent row while the
 * CLI running inside it reports Stop under its own session — both share the same
 * machine+repo, so we complete the in-progress task whose *assigned* agent serves
 * the same repo as the reporting agent. No-op when the agent already reported via
 * neoncore_report_task_done (path C) since the task is no longer 'in_progress'.
 */
export function autoCompleteDispatchedTask(reportingAgentId: string): void {
  const agent = db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(reportingAgentId) as
    | { repo_path?: string }
    | undefined;
  const repo = normalizeRepoPath(agent?.repo_path || '');
  if (!repo) return;

  // In-progress tasks with their assigned agent's repo, newest claim first.
  const rows = db.prepare(`
    SELECT t.id AS id, a.repo_path AS repo_path
      FROM tasks t JOIN agents a ON a.id = t.assigned_agent_id
     WHERE t.status = 'in_progress'
     ORDER BY t.claimed_at DESC
  `).all() as { id: string; repo_path: string }[];

  const match = rows.find((r) => normalizeRepoPath(r.repo_path) === repo);
  if (!match) return;

  const now = new Date().toISOString();
  const info = db.prepare(
    "UPDATE tasks SET status = 'done', result = ?, completed_at = ? WHERE id = ? AND status = 'in_progress'",
  ).run('Auto-completed when the agent finished its turn (Stop hook).', now, match.id);
  if (info.changes === 0) return; // raced with a report_task_done — leave it

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(match.id) as Record<string, unknown>;
  getIO().emit('task_updated', normalizeTask(updated));
}
