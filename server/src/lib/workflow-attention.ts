/**
 * Is this run waiting on a PERSON right now?
 *
 * `[P1] Pick Approach` is a `decision` step: it sat `running` with an empty
 * `dispatched_prompt` because decision steps are never sent to an agent — they wait for
 * someone to choose. From every surface it was indistinguishable from work in progress. The
 * run said "1 running"; the bell said nothing. The executing agent investigated, correctly
 * found its queue empty, and reported a phantom stall.
 *
 * ── WHY THIS IS DERIVED, NOT REMEMBERED ────────────────────────────────────────────────
 * `workflow_notification` fires in exactly two places in the executor — manual-advance and the
 * `system-notify` connector. A decision gate sends a phone push and nothing to the dashboard;
 * failed and interrupted steps send neither. Adding the missing emissions is necessary but not
 * sufficient: a notification is a one-shot event that can be missed, dismissed, or fired while
 * nobody was looking. "Is this waiting on me right now?" has to be answerable from state at
 * any moment, so it is computed from the rows rather than stored when something happened.
 *
 * ── ORDER IS THE POINT ─────────────────────────────────────────────────────────────────
 * A run can be in several of these at once — a parallel branch fails while another waits on a
 * decision. Reporting the decision would send someone to answer a question on a run that is
 * already broken, so the list is ordered most-urgent first and the first match wins.
 */
import db from '../db.js';

export const ATTENTION_REASONS = [
  'failed',         // the run cannot continue at all
  'interrupted',    // a step's executor died mid-work; needs recovery
  'decision',       // a decision gate is waiting for a choice
  'agent-waiting',  // the executing cartridge stopped to ask a question
  'manual-advance', // a step finished but is held for a human to advance
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface Attention {
  reason: AttentionReason;
  stepId: string;
  stepName: string;
  /** One line a person can act on without opening the run. */
  detail: string;
}

interface StepRow {
  id: string;
  name: string;
  status: string;
  executor_type: string;
  executor_id: string;
  executor_config: string;
  auto_advance: number;
  recovery_status: string;
}

function question(cfg: string): string {
  try {
    const q = (JSON.parse(cfg || '{}') as { question?: string }).question;
    return typeof q === 'string' ? q : '';
  } catch {
    return '';
  }
}

/**
 * The reason this run is blocked on a human, or null when it is genuinely working.
 *
 * Only a `running` workflow can need attention: recovery state on a finished or cancelled run
 * is history, and flagging it would make the badge permanent noise.
 */
export function workflowNeedsAttention(workflowId: string): Attention | null {
  const wf = db.prepare('SELECT status FROM workflows WHERE id = ?').get(workflowId) as
    { status?: string } | undefined;
  if (!wf || wf.status !== 'running') return null;

  const steps = db.prepare(
    `SELECT id, name, status, executor_type, executor_id, executor_config, auto_advance, recovery_status
       FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y`,
  ).all(workflowId) as StepRow[];
  if (steps.length === 0) return null;

  const found = (reason: AttentionReason, s: StepRow, detail: string): Attention =>
    ({ reason, stepId: s.id, stepName: s.name, detail });

  // 1. Broken outright.
  const failed = steps.find((s) => s.status === 'failed');
  if (failed) return found('failed', failed, `"${failed.name}" failed — the run cannot continue.`);

  // 2. Executor died mid-step.
  const interrupted = steps.find((s) => s.status === 'running' && s.recovery_status === 'interrupted');
  if (interrupted) {
    return found('interrupted', interrupted, `"${interrupted.name}" was interrupted and needs recovery.`);
  }

  // 3. A decision gate. Nothing was dispatched and nothing ever will be until someone chooses.
  const decision = steps.find((s) => s.status === 'running' && s.executor_type === 'decision');
  if (decision) {
    const q = question(decision.executor_config);
    return found('decision', decision, q || `"${decision.name}" is waiting for your choice.`);
  }

  // 4. The cartridge stopped to ask something. `waiting` is the status a pending question sets.
  const asking = steps.find((s) => {
    if (s.status !== 'running' || !s.executor_id) return false;
    const a = db.prepare('SELECT status FROM agents WHERE id = ?').get(s.executor_id) as
      { status?: string } | undefined;
    return a?.status === 'waiting';
  });
  if (asking) {
    return found('agent-waiting', asking, `The cartridge running "${asking.name}" is waiting for your input.`);
  }

  // 5. Finished, but held. Only meaningful while there is still something left to advance to.
  const anyPending = steps.some((s) => s.status === 'pending');
  const held = steps.find((s) => s.status === 'completed' && s.auto_advance === 0);
  if (held && anyPending) {
    return found('manual-advance', held, `"${held.name}" finished and is waiting for you to advance.`);
  }

  return null;
}
