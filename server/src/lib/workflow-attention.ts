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

/**
 * How long a cartridge must be quiet before a dispatched step counts as abandoned.
 *
 * Generous on purpose. These cartridges legitimately pause between tool calls, and accusing a
 * working agent of stalling would re-dispatch work that is already in progress. Ten minutes is
 * far longer than any gap in normal operation and far shorter than a night.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export const ATTENTION_REASONS = [
  'failed',         // the run cannot continue at all
  'interrupted',    // a step's executor died mid-work; needs recovery
  'decision',       // a decision gate is waiting for a choice
  'agent-waiting',  // the executing cartridge stopped to ask a question
  'manual-advance', // a step finished but is held for a human to advance
  'agent-idle',     // dispatched, the cartridge went quiet, and nothing was ever reported
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
  dispatched_prompt: string;
  result: string;
}

/**
 * Is a person actually owed an answer by this cartridge?
 *
 * Either a permission request is still pending, or the hook recorded a question banner. A
 * `waiting` status with neither is a stale flag, not a block.
 */
function hasRealQuestion(agentId: string, pendingQuestion: string): boolean {
  if (pendingQuestion.trim()) return true;
  const pending = db.prepare(
    "SELECT 1 AS x FROM permissions WHERE agent_id = ? AND status = 'pending' LIMIT 1",
  ).get(agentId) as { x?: number } | undefined;
  return !!pending;
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
    `SELECT id, name, status, executor_type, executor_id, executor_config, auto_advance,
            recovery_status, dispatched_prompt, result
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

  // 4. The cartridge stopped to ASK something — and there must really be a question.
  //
  // `waiting` alone is not enough, and treating it as enough is what let a run sit all night.
  // Claude Code fires a `notification` hook when a turn ends with nothing more to do, and that
  // sets `waiting` with no question attached: the agent simply stopped. Reported as
  // `agent-waiting`, such a run says "the cartridge is waiting for your input" while there is
  // nothing to input, and `full` correctly refuses to invent an answer — so it sits forever.
  //
  // lib/queue-runner.ts already reached this conclusion for the queue and wrote it down:
  // "`waiting` counts ONLY when there is a real question outstanding. A cartridge that ends a
  // session in `waiting` with no pending question is not blocked on anything — it is idle with
  // a stale flag." The same rule, applied here. Anything else falls through to the stall check
  // below, which is what it actually is.
  const asking = steps.find((s) => {
    if (s.status !== 'running' || !s.executor_id) return false;
    const a = db.prepare('SELECT status, pending_question FROM agents WHERE id = ?').get(s.executor_id) as
      { status?: string; pending_question?: string } | undefined;
    if (a?.status !== 'waiting') return false;
    return hasRealQuestion(s.executor_id, a.pending_question || '');
  });
  if (asking) {
    return found('agent-waiting', asking, `The cartridge running "${asking.name}" is waiting for your input.`);
  }

  // 5. DISPATCHED AND ABANDONED — the failure that looks most like health.
  //
  // A step sits `running`, its cartridge went idle, and no result was ever reported. It is not
  // failed, not interrupted, not waiting on a person, not a gate. Every surface says "1 running"
  // and nothing is happening; a run stalled this way is invisible until someone notices hours
  // later that the number never moved. Seen live on the first real epic run.
  //
  // redispatchOrphanedSteps does NOT cover this: it fires only when the cartridge's session
  // CHANGED, which is the restart case. Here the session is identical — the agent simply
  // stopped without calling the completion webhook.
  //
  // Guarded three ways so a working cartridge is never accused of stalling:
  //   · executor_id must be set — a decision gate is `running` with no executor by design
  //   · dispatched_prompt must be non-empty — nothing was sent, nothing can be owed
  //   · the agent must have been quiet for STALE_AFTER_MS, not merely idle this instant
  const stalled = steps.find((s) => {
    if (s.status !== 'running' || !s.executor_id) return false;
    if (!(s.dispatched_prompt || '').trim()) return false;
    if ((s.result || '').trim()) return false;
    const a = db.prepare('SELECT status, last_seen FROM agents WHERE id = ?').get(s.executor_id) as
      { status?: string; last_seen?: string } | undefined;
    if (!a || a.status === 'working') return false;
    // `waiting` is only a genuine block when something is actually outstanding — see reason 4.
    // Otherwise it is the same abandonment as `idle`, wearing a different label.
    if (a.status === 'waiting' && hasRealQuestion(s.executor_id, '')) return false;
    const quietFor = a.last_seen ? Date.now() - Date.parse(a.last_seen) : Infinity;
    return Number.isFinite(quietFor) ? quietFor > STALE_AFTER_MS : true;
  });
  if (stalled) {
    return found('agent-idle', stalled,
      `"${stalled.name}" was dispatched but the cartridge went quiet without reporting.`);
  }

  // 6. Finished, but held. Only meaningful while there is still something left to advance to.
  const anyPending = steps.some((s) => s.status === 'pending');
  const held = steps.find((s) => s.status === 'completed' && s.auto_advance === 0);
  if (held && anyPending) {
    return found('manual-advance', held, `"${held.name}" finished and is waiting for you to advance.`);
  }

  return null;
}
