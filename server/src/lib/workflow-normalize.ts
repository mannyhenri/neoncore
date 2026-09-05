/**
 * One serializer for a workflow step. The database row in, the API shape out.
 *
 * This existed twice — privately in routes/workflows.ts and in workflow-executor-v2.ts — and the
 * copies had drifted. Not in the way first reported: the difference was not a field surviving in
 * one and not the other, it was that the routes copy called bare JSON.parse on executor_config
 * and THREW on an unreadable row, while the executor logged and carried on. One malformed row
 * therefore 500'd every route that serialises a step while the run itself kept going — the two
 * halves of the product disagreeing about whether a workflow could be loaded at all.
 *
 * Guarded parsing is the correct behaviour and is now the only behaviour.
 */
import type { WorkflowStep } from '../types.js';

/**
 * executor_config is written by a dozen paths and read by all of them. A row that cannot be
 * parsed is a row to complain about, not to crash on: the step still has a name, a status and a
 * position, and every one of those is worth rendering while someone works out what happened to
 * its config.
 */
export function parseExecutorConfig(raw: string | null | undefined, stepId: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // Arrays and scalars are valid JSON and useless here — every caller indexes this by key.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    console.error(`[workflow] Step ${stepId}: executor_config is not valid JSON — treating as empty. Raw: ${String(raw).slice(0, 120)}`);
    return {};
  }
}

export function normalizeStep(row: Record<string, unknown>): WorkflowStep {
  return {
    id: row.id as string,
    workflowId: row.workflow_id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    positionX: row.position_x as number,
    positionY: row.position_y as number,
    executorType: row.executor_type as WorkflowStep['executorType'],
    executorId: (row.executor_id as string) || '',
    executorConfig: parseExecutorConfig(row.executor_config as string, row.id as string),
    autoAdvance: (row.auto_advance as number) === 1,
    status: (row.status as WorkflowStep['status']) || 'pending',
    result: (row.result as string) || '',
    error: (row.error as string) || '',
    dispatchedPrompt: (row.dispatched_prompt as string) || '',
    dependsOn: JSON.parse((row.depends_on as string) || '[]'),
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
    recoveryStatus: (row.recovery_status as string) || '',
    interruptedAt: (row.interrupted_at as string) || null,
    recoveryAttempts: (row.recovery_attempts as number) || 0,
    // This copy is the one that emits `workflow_step_updated` DURING execution, which is
    // exactly when a routing substitution is recorded. Surfacing it only in the routes'
    // serializer would have left the live path dropping the field.
    routingNote: (row.routing_note as string) || '',
  };
}
