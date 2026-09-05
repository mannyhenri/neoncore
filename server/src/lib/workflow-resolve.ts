/**
 * Resolving a step — the operations behind both the dashboard's buttons and a remote one.
 *
 * N3 of docs/plans/build-order.md says actions "resolve through the endpoints that already
 * exist". Taken literally that would mean the server making HTTP calls to itself; taken as
 * intended it means ONE implementation, not a second copy that drifts. So the bodies moved out
 * of routes/workflows.ts and both callers land here.
 *
 * That matters more for remote than for the dashboard. A divergence between "Advance" on the
 * grid and "Advance" on your phone is a bug nobody finds until the two disagree about a run
 * that is already blocked.
 */
import db from '../db.js';
import { getIO } from '../ws.js';
import { normalizeStep } from './workflow-executor-v2.js';

export interface ResolveResult {
  ok: boolean;
  error?: string;
  step?: ReturnType<typeof normalizeStep>;
}

interface StepRow { id: string; workflow_id: string; name: string; status: string; executor_config: string }

function stepById(stepId: string): StepRow | undefined {
  return db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as StepRow | undefined;
}

/**
 * Broadcast the change, but never let the broadcast undo it.
 *
 * The database write has already happened by the time this runs. `getIO()` THROWS when the
 * socket server is not up, so an unguarded emit turns a successful advance into a half-done
 * one: the step is released, and the audit row and the notification that were supposed to
 * follow never happen — the single worst outcome, because the run moves and nobody is told.
 * Caught live by an autonomy test, where the socket is stubbed and momentarily was not.
 */
function emit(stepId: string): ReturnType<typeof normalizeStep> {
  const updated = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as Record<string, unknown>;
  const step = normalizeStep(updated);
  try {
    getIO().emit('workflow_step_updated', step);
  } catch (err) {
    console.warn(`[workflow-resolve] step ${stepId} updated but not broadcast: ${err instanceof Error ? err.message : String(err)}`);
  }
  return step;
}

export interface DecisionOption { id: string; label: string; description?: string; nextStepId?: string }

/** The choices a decision gate is offering. Empty for any other kind of step. */
export function decisionOptions(stepId: string): DecisionOption[] {
  const row = stepById(stepId);
  if (!row) return [];
  try {
    return (JSON.parse(row.executor_config || '{}').options as DecisionOption[]) || [];
  } catch {
    return [];
  }
}

/** Answer a decision gate. */
export function decideStep(stepId: string, optionId: string): ResolveResult {
  const row = stepById(stepId);
  if (!row) return { ok: false, error: 'Step not found' };

  const chosen = decisionOptions(stepId).find((o) => o.id === optionId);
  if (!chosen) return { ok: false, error: 'Unknown optionId' };

  const resultText = JSON.stringify({
    choice: chosen.label, optionId: chosen.id, description: chosen.description || '',
  });
  db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
    .run('completed', resultText, new Date().toISOString(), stepId);

  return { ok: true, step: emit(stepId) };
}

/** Release a completed step that was held for a human. */
export function advanceStep(stepId: string): ResolveResult {
  const row = stepById(stepId);
  if (!row) return { ok: false, error: 'Step not found' };

  db.prepare('UPDATE workflow_steps SET auto_advance = 1 WHERE id = ?').run(stepId);
  return { ok: true, step: emit(stepId) };
}

/** The run a step belongs to — action ids carry only the step, so this recovers the rest. */
export function workflowIdOfStep(stepId: string): string | null {
  return stepById(stepId)?.workflow_id ?? null;
}
