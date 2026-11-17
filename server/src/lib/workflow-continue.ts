/**
 * CONTINUE INTO ANOTHER WORKFLOW — the `launch-workflow` connector.
 *
 * A run that is one phase of a longer delivery can start the next phase itself instead of
 * ending on a notification that asks a person to go and press Run. CE: Phase 3 — Implement is
 * the case that needed it: its description always said "Auto-continues to Phase 4", and nothing
 * in the engine could do that, so Phase 3 ended on a notification and Phase 4 waited for
 * someone to notice.
 *
 * The next run is created through cloneTemplateAsRun — the same path scheduled runs, goal
 * decompositions and Goal Pilot stages use — so it gets the same Work Standard Check, layout and
 * run-id resolution as a run started by hand. It inherits this run's project, cartridge,
 * autonomy and launch context (the feature slug, for the CE phases).
 *
 * Config on the connector step:
 *   templateName        the template to start (required)
 *   continueIfStep      optional: the name of a step in THIS run whose result decides…
 *   continueIfContains  …whether to continue: it must contain this text (case-insensitive).
 *                       A run whose tests failed must not start its review.
 *
 * Starting the next run does not race the rest of this one: the executor sends a step to a
 * cartridge only when no other step is running on it, in any run, so the next phase's first
 * step waits for this run's completion report.
 *
 * NOT INSIDE A GOAL PILOT. When this run is a stage of a Goal Pilot pipeline, the pilot decides
 * what runs next — it may have planned Phase 3 → QA Testing Guide. Continuing anyway would start
 * a Phase 4 the pilot never planned, tracks nothing of, and that opens a PR. The step stands down
 * and says so.
 */
import db from '../db.js';
import { cloneTemplateAsRun, LEARNINGS_HEADING } from './workflow-from-template.js';
import { templateNeedsParticipants } from './workflow-launch.js';

/** How many runs one chain may start in a row before it is treated as a loop. */
export const MAX_CONTINUATIONS = 10;

const CONTINUED_FROM = 'Continued from';

export type ContinueOutcome =
  | { kind: 'launched'; runId: string; templateName: string; alreadyLaunched: boolean }
  | { kind: 'skipped'; reason: string };

interface StepLike {
  id: string;
  workflowId: string;
  executorConfig: Record<string, unknown>;
}

/**
 * The run's context without the learnings cloneTemplateAsRun appended to it. Those are learnings
 * of THIS template; the next phase gets its own from its own template when it is cloned.
 */
function ownContext(initialContext: string): string {
  const at = initialContext.indexOf(LEARNINGS_HEADING);
  return (at === -1 ? initialContext : initialContext.slice(0, at)).trim();
}

/**
 * The cartridge this run has been working on: the agent of the most recently finished agent
 * step that still exists. A launch-time cartridge fills every deferred step, so this is the one
 * the person chose.
 */
function runCartridge(workflowId: string): string | undefined {
  const rows = db.prepare(
    `SELECT ws.executor_id AS id
       FROM workflow_steps ws JOIN agents a ON a.id = ws.executor_id
      WHERE ws.workflow_id = ? AND ws.executor_type IN ('claude-code', 'quality-gate', 'review-gate', 'command')
      ORDER BY (ws.completed_at IS NULL), ws.completed_at DESC`,
  ).all(workflowId) as { id: string }[];
  return rows[0]?.id;
}

/** The cartridges this run conferred with, from any confer step that has a roster of two or more. */
function runConferTeam(workflowId: string): { agentIds: string[]; mode: string; isolation: string } | undefined {
  const rows = db.prepare("SELECT executor_config FROM workflow_steps WHERE workflow_id = ? AND executor_type = 'confer'")
    .all(workflowId) as { executor_config: string }[];
  for (const r of rows) {
    try {
      const cfg = JSON.parse(r.executor_config || '{}') as Record<string, unknown>;
      const ids = Array.isArray(cfg.conferAgentIds) ? (cfg.conferAgentIds as unknown[]).filter((x): x is string => typeof x === 'string' && !!x) : [];
      if (ids.length >= 2) {
        return { agentIds: ids, mode: String(cfg.conferMode || 'divide'), isolation: String(cfg.conferIsolation || 'shared') };
      }
    } catch { /* a malformed step is not a team */ }
  }
  return undefined;
}

export function continueIntoWorkflow(step: StepLike): ContinueOutcome {
  const cfg = step.executorConfig;
  const templateName = String(cfg.templateName ?? '').trim();
  if (!templateName) throw new Error('launch-workflow connector requires templateName');

  // Idempotent: a step re-run after a restart must not start the next phase twice.
  const previous = String(cfg._continuedRunId ?? '');
  if (previous && db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(previous)) {
    return { kind: 'launched', runId: previous, templateName, alreadyLaunched: true };
  }

  const run = db.prepare(
    'SELECT name, run_number, project_id, initial_context, autonomy FROM workflows WHERE id = ?',
  ).get(step.workflowId) as {
    name: string; run_number: number | null; project_id: string | null; initial_context: string | null; autonomy: string | null;
  } | undefined;
  if (!run) throw new Error(`run ${step.workflowId} not found`);

  const stage = db.prepare('SELECT 1 FROM goal_pilot_stages WHERE run_id = ? LIMIT 1').get(step.workflowId);
  if (stage) return { kind: 'skipped', reason: 'this run is a Goal Pilot stage, and the pilot decides what runs next' };

  const gateStep = String(cfg.continueIfStep ?? '').trim();
  const gateText = String(cfg.continueIfContains ?? '').trim();
  if (gateStep && gateText) {
    const row = db.prepare(
      'SELECT result FROM workflow_steps WHERE workflow_id = ? AND name = ? ORDER BY completed_at DESC LIMIT 1',
    ).get(step.workflowId, gateStep) as { result: string | null } | undefined;
    if (!row) return { kind: 'skipped', reason: `this run has no "${gateStep}" step to check` };
    if (!(row.result ?? '').toLowerCase().includes(gateText.toLowerCase())) {
      return { kind: 'skipped', reason: `"${gateStep}" did not report "${gateText}"` };
    }
  }

  if (templateName === run.name) {
    throw new Error(`"${run.name}" cannot continue into itself`);
  }
  const context = ownContext(run.initial_context ?? '');
  const depth = context.split(CONTINUED_FROM).length - 1;
  if (depth >= MAX_CONTINUATIONS) {
    throw new Error(`refusing to continue: this chain has already started ${depth} runs in a row`);
  }

  const template = db.prepare(
    'SELECT id FROM workflows WHERE name = ? AND template_id IS NULL ORDER BY created_at ASC LIMIT 1',
  ).get(templateName) as { id: string } | undefined;
  if (!template) throw new Error(`there is no "${templateName}" workflow template to continue into`);

  const agentId = runCartridge(step.workflowId);
  if (!agentId) throw new Error('this run has no cartridge for the next workflow to run on');

  // A confer needs its team: the one this run conferred with, or it cannot start.
  let confer: { agentIds: string[]; mode: string; isolation: string } | undefined;
  if (templateNeedsParticipants(template.id)) {
    const team = runConferTeam(step.workflowId);
    if (!team) throw new Error(`"${templateName}" is a confer and needs two or more cartridges, and this run was not a confer`);
    confer = team;
  }

  const label = `${CONTINUED_FROM} "${run.name}"${run.run_number ? ` #${run.run_number}` : ''} (run ${step.workflowId.slice(0, 8)}).`;
  const runId = cloneTemplateAsRun(template.id, run.project_id, [context, label].filter(Boolean).join('\n\n'), {
    agentId,
    autonomy: run.autonomy || undefined,
    confer,
  });
  if (!runId) throw new Error(`"${templateName}" could not be cloned into a run`);

  db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
    .run(JSON.stringify({ ...cfg, _continuedRunId: runId }), step.id);
  return { kind: 'launched', runId, templateName, alreadyLaunched: false };
}
