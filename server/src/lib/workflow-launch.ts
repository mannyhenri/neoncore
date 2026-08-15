/**
 * Can this launch actually run? Answered BEFORE anything is created.
 *
 * A template's steps are `__deferred__` — "ask me at launch". The cartridge arrives in the
 * request, and the start handler fills every unassigned step with it. When it doesn't arrive,
 * nothing filled anything: the run was still created, all 47 rows cloned, status set to
 * `running`, and step 1 then threw "has no cartridge assigned" on dispatch. A run that exists,
 * looks started, and is already dead.
 *
 * ── WHY THE CHECK IS HERE AND NOT IN THE CALLER ────────────────────────────────────────
 * `startWorkflowV2` takes the cartridge in TWO positions: `agentOverrides` (arg 2, a
 * stepId→agentId map) and `agentId` (arg 6, the run-level fill). GoalsPage passed the chosen
 * cartridge as `{ [templateId]: agentId }` into arg 2 — a map keyed by a TEMPLATE id, matching
 * no step — while arg 6 stayed undefined. That is a footgun, not a typo, and there are four
 * launch sites. Fixing the caller fixes one; enforcing the invariant where every caller passes
 * fixes the class.
 *
 * Deliberately mirrors resolveWorkflowTargets (lib/queue-if-busy.ts): both answer "which
 * cartridges will this run drive", from the same three sources. Two different answers would
 * mean a launch that satisfies the busy guard and fails the assignment guard, or worse, the
 * reverse.
 */
import db from '../db.js';

/** The `__deferred__` sentinel means "ask me at launch"; '' means the step never had one. */
function needsCartridge(executorId: string): boolean {
  return !executorId || executorId === '__deferred__';
}

/**
 * Names of the steps that would still have no cartridge if this launch went ahead.
 * Empty means the run can start.
 */
export function unassignedStepNames(
  workflowId: string,
  body: Record<string, unknown> | undefined,
): string[] {
  const steps = db.prepare(
    'SELECT id, name, executor_id FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(workflowId) as { id: string; name: string; executor_id: string }[];

  const runAgentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
  const overrides = (body?.agentOverrides && typeof body.agentOverrides === 'object')
    ? (body.agentOverrides as Record<string, unknown>)
    : {};

  return steps
    .filter((s) => {
      if (!needsCartridge(s.executor_id)) return false;      // already pinned
      if (runAgentId) return false;                          // the run-level fill covers it
      const o = overrides[s.id];                             // keyed by STEP id, not template id
      return !(typeof o === 'string' && o.trim() && o !== '__deferred__');
    })
    .map((s) => s.name);
}
