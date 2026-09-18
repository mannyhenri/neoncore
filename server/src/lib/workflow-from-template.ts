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
import { awaitsLaunchFill } from './cartridge-exists.js';
import { DEFAULT_AUTONOMY } from './autonomy.js';
import { layoutSteps } from './workflow-layout.js';
import { resolveRunPlaceholders } from './workflow-report.js';

/**
 * What previous runs OF THIS WORKFLOW learned. THE ONE IMPLEMENTATION — both clone paths call
 * it, because it used to exist twice.
 *
 * ── WHY IT IS SCOPED TO THE TEMPLATE AND NOT THE PROJECT ─────────────────────────────
 * It used to take the last 3 learnings for the whole PROJECT. Project membership is not
 * relevance: "Gridlight" holds a Daily AI Research Digest and a CUDA inference engine, and a
 * run of one was handed the other's report as the first thing in its prompt. Reported as GPU
 * quantisation notes appearing inside the research digest; measured at 19 runs across 5
 * workflows, 16 step prompts.
 *
 * Two things made it worse than a stray paste. `project_learnings` stores WHOLE WORKFLOW
 * REPORTS rather than distilled lessons, and the 600-character cut lands mid-sentence — so
 * what arrived was a fragment reading "RECOMMENDATION CONTRADICTS THE RESEARCH, so the
 * requested elimination was NOT performed", with nothing marking it as another repo's history.
 * An agent has no way to tell that from its own brief.
 *
 * Scoping by `template_id` keeps the half that was actually useful — a digest run learning what
 * the last digest run found out — and drops the half that was never relevant. A learning whose
 * run has since been deleted is not carried: the join drops it, which errs toward less context
 * rather than more, and that is the right direction for this bug.
 */
export function learningsContext(projectId: string, templateId: string): string {
  if (!projectId || !templateId) return '';
  const learnings = db.prepare(
    `SELECT pl.content, pl.workflow_name
       FROM project_learnings pl
       JOIN workflows w ON w.id = pl.workflow_id
      WHERE pl.project_id = ? AND w.template_id = ?
      ORDER BY pl.created_at DESC LIMIT 3`,
  ).all(projectId, templateId) as { content: string; workflow_name: string }[];
  if (learnings.length === 0) return '';
  return [
    '## What previous runs of this workflow learned',
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
export interface CloneOptions {
  /**
   * The cartridge every deferred step should land on.
   *
   * WITHOUT THIS A SCHEDULED RUN IS BORN DEAD. Template steps carry `__deferred__` — "ask me at
   * launch" — and this function copied that verbatim. The manual launch path fills them from the
   * request; the heartbeat path had nowhere to get one, even though `heartbeats.agent_id` was
   * collected by the route and the dashboard and simply never passed on. Measured: 7 of 8 steps
   * landed with no cartridge while the run was marked `running`.
   */
  agentId?: string;
  /**
   * The posture the run starts in. A scheduled run that inherits the column default `manual`
   * auto-resolves NOTHING and halts at the first of ten attention reasons with nobody there.
   */
  autonomy?: string;
}

export function cloneTemplateAsRun(
  templateId: string,
  projectId: string | null,
  extraContext = '',
  opts: CloneOptions = {},
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

  // Set the posture BEFORE any step can be picked up by the executor poll. Explicit rather
  // than relying on the column default — see DEFAULT_AUTONOMY.
  db.prepare('UPDATE workflows SET autonomy = ? WHERE id = ?')
    .run(opts.autonomy || DEFAULT_AUTONOMY, runId);

  // Context the run should open with. `extraContext` goes FIRST: the answers a person just typed
  // are more specific than historical learnings, and the first thing in the field is the thing
  // most likely to survive a long prompt.
  const parts = [extraContext.trim(), projectId ? learningsContext(projectId, templateId) : ''].filter(Boolean);
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
      // Fill only what is AWAITING a cartridge. A template step deliberately pinned to a
      // specific cartridge keeps it — the fill is for '__deferred__', not a blanket overwrite.
      s.executor_type,
      awaitsLaunchFill(String(s.executor_id ?? '')) && opts.agentId
        ? opts.agentId
        : (s.executor_id ?? ''),
      // A run has an id; a template does not, which is why its stored prompt carries
      // `<workflowRunId>`. Resolve it HERE too — this is the second clone path (scheduled runs
      // and decompositions), and a fix applied only to the HTTP start handler would have left
      // every scheduled report telling the agent to invent an id. See resolveRunPlaceholders.
      resolveRunPlaceholders(String(s.executor_config ?? '{}'), runId),
      deps, s.auto_advance ?? 1, now,
    );
  }

  // Same layout authority as every other path — a scheduled run must open looking like a
  // hand-launched one.
  layoutSteps(db, runId);

  return runId;
}
