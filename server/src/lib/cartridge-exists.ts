/**
 * Does this cartridge id name something that actually exists?
 *
 * WHY THIS IS ITS OWN MODULE. Two guards decide whether a workflow launch may proceed —
 * `unassignedStepNames` (lib/workflow-launch.ts, "may this run start") and
 * `resolveWorkflowTargets` (lib/queue-if-busy.ts, "which cartridges will it drive"). They are
 * documented as needing to agree: a launch that satisfies one and fails the other is a run that
 * exists, looks started, and is already dead. Both used to ask "is executor_id non-empty",
 * which is not the same question as "is that a real cartridge" — so a step pinned to the id of
 * a cartridge that has since restarted sailed through both and died at dispatch with
 * "Command not delivered: agent <uuid> not found".
 *
 * Cartridge ids are ephemeral: a cartridge that restarts registers under a NEW id, and every
 * step still pinned to the old one is permanently unlaunchable. That is not an edge case — it
 * is what happens every time a machine reboots.
 *
 * Keeping the predicate in one place is the structural guarantee that the two guards give the
 * same answer, rather than a comment asking future edits to keep them in sync.
 */
import db from '../db.js';

/** The sentinel a template stores for "ask me at launch". Never a real cartridge. */
export const DEFERRED = '__deferred__';

/** True only for an id with a matching row in `agents`. '' and `__deferred__` are never real. */
export function cartridgeExists(id: string | null | undefined): boolean {
  const trimmed = (id ?? '').trim();
  if (!trimmed || trimmed === DEFERRED) return false;
  return db.prepare('SELECT 1 FROM agents WHERE id = ?').get(trimmed) !== undefined;
}

/** True when a step's own executor_id is the "fill me at launch" kind, not a stale pin. */
export function awaitsLaunchFill(executorId: string | null | undefined): boolean {
  const trimmed = (executorId ?? '').trim();
  return !trimmed || trimmed === DEFERRED;
}
