/**
 * Turn a workflow TEMPLATE into a running RUN.
 *
 * Extracted from `heartbeat-scheduler.ts`, which was its only caller until decomposition needed
 * the same thing. Two copies of "clone a template, remap the step graph, attach it to a project"
 * would be two chances to diverge on the part that is easy to get wrong — the dependency remap —
 * and the scheduler had already solved it correctly.
 *
 * `extraContext` is why this moved rather than being exported in place: a decomposition carries
 * the answers the person typed while setting the work up, and that context has to land in the
 * run's `initial_context` alongside the project learnings the scheduler already injects. Both
 * are "things the agent should know before step one", so they belong in the same field.
 */
import db from '../db.js';
import { libelleContexte } from './context-label.js';
import { randomUUID } from 'crypto';

/** Recent learnings for a project, as the scheduler has always injected them. */
function learningsContext(projectId: string): string {
  const learnings = db.prepare(
    `SELECT content, workflow_name FROM project_learnings WHERE project_id = ? ORDER BY created_at DESC LIMIT 3`,
  ).all(projectId) as { content: string; workflow_name: string }[];
  if (learnings.length === 0) return '';
  return [
    '## Recent Project Learnings',
    ...learnings.map((l, i) =>
      `### ${i + 1}. From "${l.workflow_name}"\n${l.content.slice(0, 600)}${l.content.length > 600 ? '...' : ''}`),
    '---',
  ].join('\n\n');
}

/**
 * Clone a template into a run, optionally attached to a project.
 *
 * Returns the new run id, or null when the template does not exist — a caller must be able to
 * tell "no such template" from "created", because silently creating nothing is how a plan item
 * disappears between acceptance and execution.
 */
export function cloneTemplateAsRun(
  templateId: string,
  projectId: string | null,
  extraContext = '',
): string | null {
  const template = db.prepare('SELECT * FROM workflows WHERE id = ? AND template_id IS NULL')
    .get(templateId) as Record<string, unknown> | undefined;
  if (!template) return null;

  const runNum = (db.prepare(
    'SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM workflows WHERE template_id = ?',
  ).get(templateId) as { next: number }).next;

  const runId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO workflows (id, name, jira_task_id, description, players, phases, status,
      current_phase, iteration, max_iterations, shared_context, initial_context,
      created_at, started_at, completed_at, error, target_repos, template_id, run_number)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, '', ?, ?, NULL, '', ?, ?, ?)
  `).run(
    runId,
    template.name, template.jira_task_id, template.description,
    template.players, template.phases,
    template.current_phase, template.iteration, template.max_iterations, template.shared_context,
    now, now,
    template.target_repos, templateId, runNum,
  );

  if (projectId) db.prepare('UPDATE workflows SET project_id = ? WHERE id = ?').run(projectId, runId);

  // Context the run should open with. `extraContext` goes FIRST: the answers a person just typed
  // are more specific than historical learnings, and the first thing in the field is the thing
  // most likely to survive a long prompt.
  const parts = [extraContext.trim(), projectId ? learningsContext(projectId) : ''].filter(Boolean);
  if (parts.length) {
    // The label is derived from what the PERSON typed, not from the assembled context: the
    // learnings appended after it are the same for every run in a project, so a label taken from
    // the whole string would make every run in a project read alike.
    db.prepare('UPDATE workflows SET initial_context = ?, context_label = ? WHERE id = ?')
      .run(parts.join('\n\n'), libelleContexte(extraContext), runId);
  }

  // Clone the steps, remapping depends_on to the NEW ids. Getting this wrong produces a run
  // whose steps point at the template's step graph, which then never advances.
  const templateSteps = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?')
    .all(templateId) as Record<string, unknown>[];
  const oldToNew = new Map<string, string>();
  for (const s of templateSteps) oldToNew.set(s.id as string, randomUUID());

  for (const s of templateSteps) {
    const deps = (() => {
      try {
        const parsed = JSON.parse((s.depends_on as string) || '[]') as string[];
        return JSON.stringify(parsed.map((d) => oldToNew.get(d) ?? d));
      } catch {
        return '[]';
      }
    })();
    db.prepare(`
      INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y,
        executor_type, executor_id, executor_config, depends_on, status, auto_advance,
        result, error, dispatched_prompt, recovery_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '', '', '', '', ?)
    `).run(
      oldToNew.get(s.id as string), runId, s.name, s.description ?? '',
      s.position_x ?? 0, s.position_y ?? 0,
      s.executor_type, s.executor_id ?? '', s.executor_config ?? '{}',
      deps, s.auto_advance ?? 1, now,
    );
  }

  return runId;
}
