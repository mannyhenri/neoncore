import db from '../db.js';
import { getIO, hasActiveSocket } from '../ws.js';
import { sendCommandToAgent } from './send-command.js';
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
 * Backstop reconciler — call from the periodic sweep and once on startup.
 * Marks running steps whose agent died as interrupted. Returns the count.
 */
export function reconcileInterruptedSteps(): number {
  const marked = detectInterruptedSteps(db, {
    now: Date.now(),
    graceMs: DEFAULT_GRACE_MS,
    isAlive: hasActiveSocket,
  });
  if (marked.length > 0) {
    console.log(`[recovery] Reconciler marked ${marked.length} interrupted step(s): ${marked.join(', ')}`);
    for (const id of marked) emitRecovery(id);
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
  });
  emitRecovery(stepId);
  return result;
}
