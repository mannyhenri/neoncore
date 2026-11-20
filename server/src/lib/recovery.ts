import db from '../db.js';
import { getIO, hasActiveSocket } from '../ws.js';
import { sendCommandToAgent } from './send-command.js';
import { expandSessionReferences } from './workflow-executor-v2.js';
import { markStepPrompt } from './step-session-guard.js';
import { AUTH_CURL_HEADER, getServerBaseUrl } from './server-url.js';
import {
  detectInterruptedSteps,
  markAgentStepsInterrupted,
  recoverStep as recoverStepCore,
  DEFAULT_GRACE_MS,
  type RecoverResult,
} from './recovery-core.js';

/**
 * Crash-recovery wiring — binds the pure core to the real db, sockets, and
 * command dispatch. See `.neoncore/docs/recovery-subsystem-plan.md`.
 */

/** Emit a lightweight recovery event so the dashboard can badge / offer Resume. */
function emitRecovery(stepId: string): void {
  const row = db.prepare(
    `SELECT id, workflow_id, name, status, recovery_status, interrupted_at, recovery_attempts
     FROM workflow_steps WHERE id = ?`
  ).get(stepId) as Record<string, unknown> | undefined;
  if (!row) return;
  getIO().emit('workflow_step_recovery', {
    stepId: row.id as string,
    workflowId: row.workflow_id as string,
    name: row.name as string,
    status: row.status as string,
    recoveryStatus: row.recovery_status as string,
    interruptedAt: (row.interrupted_at as string | null) ?? null,
    recoveryAttempts: (row.recovery_attempts as number) ?? 0,
  });
}

/**
 * Proof of life REVERSES a death sentence.
 *
 * `detectInterruptedSteps` infers "the executor died" from the absence of tool events for
 * EXECUTOR_STALE_MS. That signal cannot tell a dead agent from one in the middle of a single
 * long tool call: PostToolUse only fires when a tool COMPLETES, so a `cargo test` or an
 * `npm install` produces a silence indistinguishable from a crash. A cartridge was marked dead
 * during a 6m38s cargo build and posted activity 58 seconds later; nothing un-marked it, so
 * two live workflow steps sat stranded behind a "Session interrupted" banner.
 *
 * Raising the threshold only moves the cliff and delays real detection. Instead, any traffic
 * FROM the agent clears the flag. That is safe because the detector is a periodic sweep: an
 * agent that is genuinely gone is re-marked on the next pass, so a wrongly-cleared interrupt
 * costs one sweep, while a wrongly-kept one strands live work until a human notices.
 *
 * Scoped deliberately: only this agent's steps, and only ones still `running` — recovery
 * state on a finished step is the historical record of an interruption that really happened.
 */
export function clearInterruptOnLife(agentId: string): number {
  if (!agentId) return 0;
  // A cartridge relaunched by "Resume session" has just shown its first sign of life: tell it
  // to finish what it owed, before the interrupt flags that would otherwise hide the step go.
  continueAfterResume(agentId);
  const stranded = db.prepare(
    `SELECT id FROM workflow_steps
      WHERE executor_id = ? AND status = 'running' AND recovery_status = 'interrupted'`
  ).all(agentId) as { id: string }[];
  if (stranded.length === 0) return 0;

  db.prepare(
    `UPDATE workflow_steps
        SET recovery_status = '', interrupted_at = NULL
      WHERE executor_id = ? AND status = 'running' AND recovery_status = 'interrupted'`
  ).run(agentId);

  console.log(`[recovery] ${agentId} is alive after all — released ${stranded.length} falsely interrupted step(s)`);
  for (const s of stranded) emitRecovery(s.id);
  return stranded.length;
}

/**
 * Backstop reconciler — call from the periodic sweep and once on startup.
 * Marks running steps whose agent died as interrupted. Returns the count.
 */
/**
 * THE RESUMED SESSION IS TOLD TO CARRY ON.
 *
 * "Resume session" relaunches a dead cartridge natively — same id, same session, conversation
 * restored (native-relaunch.ts). What it does not restore is the TURN that was running when the
 * machine went down. Found by cutting the power on the sandbox mid-step: the cartridge came back
 * and sat idle, the step stayed `running`, and nothing would have asked for it for 90 minutes.
 *
 * Fires once, on the first sign of life after the relaunch, and ONLY when the cartridge is
 * `recovering` — set by the Resume relaunch and nothing else. A cartridge that only looked dead
 * (a long tool call) is mid-turn, and telling it to start over would duplicate work.
 */
export function continueAfterResume(agentId: string): number {
  const agent = db.prepare('SELECT recovery_status FROM agents WHERE id = ?').get(agentId) as { recovery_status?: string } | undefined;
  if (agent?.recovery_status !== 'recovering') return 0;
  db.prepare("UPDATE agents SET recovery_status = 'recovered' WHERE id = ? AND recovery_status = 'recovering'").run(agentId);

  const owed = db.prepare(
    `SELECT s.id, s.name, w.name AS workflow, w.run_number FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
      WHERE w.status IN ('running', 'paused') AND s.status = 'running'
        AND s.executor_type IN ('claude-code', 'command', 'quality-gate', 'review-gate', '')
        AND (s.dispatch_agent_id = ? OR (COALESCE(s.dispatch_agent_id, '') = '' AND s.executor_id = ?))`,
  ).all(agentId, agentId) as Array<{ id: string; name: string; workflow: string; run_number: number }>;

  const base = `\${NEONCORE_URL:-${getServerBaseUrl()}}`;
  for (const s of owed) {
    db.prepare("UPDATE workflow_steps SET recovery_status = '', interrupted_at = NULL WHERE id = ?").run(s.id);
    const text = [
      `[NeonCore — resumed after an interruption] Your session stopped (the machine or the cartridge went down) while you were `
        + `working on step "${s.name}" of "${s.workflow}"${s.run_number ? ` (run #${s.run_number})` : ''}. Your conversation has been `
        + 'restored, but the turn that was running was lost.',
      '1. Check where the work actually stands — `git status`, the files you were changing, any test you had started — rather '
        + 'than assuming it is finished or that nothing was done.',
      '2. Finish the step.',
      `3. Report it: \`neoncore_report_step_done\` with stepId: "${s.id}" and every field (result, next, scope, verify, deferred). `
        + `No MCP? POST the same JSON to /api/workflows/webhook/${s.id}/complete.`,
      `If the step's instructions are no longer in your conversation: curl -s "${base}/api/workflows/steps/${s.id}/instructions" ${AUTH_CURL_HEADER}`,
    ].join('\n');
    sendCommandToAgent(agentId, markStepPrompt(s.id, text), false, undefined, { standard: 'silent' });
    emitRecovery(s.id);
  }
  if (owed.length) console.log(`[recovery] ${agentId} resumed — asked it to finish ${owed.length} step(s) it owed`);
  return owed.length;
}

export function reconcileInterruptedSteps(): number {
  const marked = detectInterruptedSteps(db, {
    now: Date.now(),
    graceMs: DEFAULT_GRACE_MS,
    isAlive: hasActiveSocket,
  });
  if (marked.length > 0) {
    console.log(`[recovery] Reconciler marked ${marked.length} interrupted step(s): ${marked.join(', ')}`);
    for (const id of marked) {
      emitRecovery(id);
      // `workflow_step_recovery` badges the step in the canvas; the BELL never heard about it,
      // so a run stranded overnight showed nothing until someone opened the run.
      const row = db.prepare('SELECT id, name, workflow_id FROM workflow_steps WHERE id = ?')
        .get(id) as { id: string; name: string; workflow_id: string } | undefined;
      if (row) {
        void import('./workflow-executor-v2.js').then(({ notifyNeedsAttention }) => {
          notifyNeedsAttention(
            { id: row.id, name: row.name, workflowId: row.workflow_id },
            'Step interrupted',
            `"${row.name}" lost its cartridge and needs recovery.`,
            'workflow_step_interrupted',
          );
        }).catch(() => {});
      }
    }
  }
  return marked.length;
}

/** Fast path — the relay reported its agent is dying (SIGTERM). */
export function handleAgentInterrupted(agentId: string): number {
  const marked = markAgentStepsInterrupted(db, agentId, { now: Date.now() });
  if (marked.length > 0) {
    console.log(`[recovery] Agent ${agentId} reported interrupt — marked ${marked.length} step(s)`);
    for (const id of marked) emitRecovery(id);
  }
  return marked.length;
}

/** Human-gated (P1) / auto (P2) recovery of one interrupted step. */
export function recoverStep(stepId: string): RecoverResult {
  const result = recoverStepCore(db, stepId, {
    now: Date.now(),
    dispatch: (agentId, text) => sendCommandToAgent(agentId, text, true),
    // The stored prompt may refer to a session that is gone: replay it with the text.
    expandPrompt: expandSessionReferences,
  });
  emitRecovery(stepId);
  return result;
}
