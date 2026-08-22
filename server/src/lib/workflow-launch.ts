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
import { cartridgeExists, awaitsLaunchFill } from './cartridge-exists.js';

/** Why a step cannot run: nobody was picked, or the one that was picked no longer exists. */
export type UnrunnableReason = 'no-cartridge' | 'cartridge-gone';

/**
 * The steps that could not run if this launch went ahead, and why. Empty means it can start.
 *
 * Mirrors what the start handler ACTUALLY does, which is the only way this can be correct:
 *  - a per-step override overwrites the step unconditionally (routes/workflows.ts applies it
 *    with `WHERE id = ?`), so a live override rescues even a stale pin;
 *  - the run-level `agentId` fills only steps that are '' or `__deferred__`
 *    (`needsExecutor = !s.executor_id || s.executor_id === '__deferred__'`), so it does NOT
 *    rescue a stale pin — the dead id survives the fill and dies at dispatch.
 */
export function unrunnableSteps(
  workflowId: string,
  body: Record<string, unknown> | undefined,
): { name: string; reason: UnrunnableReason }[] {
  const steps = db.prepare(
    'SELECT id, name, executor_id FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(workflowId) as { id: string; name: string; executor_id: string }[];

  const runAgentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
  const overrides = (body?.agentOverrides && typeof body.agentOverrides === 'object')
    ? (body.agentOverrides as Record<string, unknown>)
    : {};

  const out: { name: string; reason: UnrunnableReason }[] = [];
  for (const s of steps) {
    // Resolve the executor this step will ACTUALLY hold, replaying the order the start handler
    // writes them in (routes/workflows.ts): clone -> run-level fill -> per-step override.
    // Last writer wins, so the order is the whole answer — a live run-level fill followed by a
    // stale override leaves the step stale, and a live override rescues even a stale pin.
    let effective = (s.executor_id ?? '').trim();

    // The fill touches ONLY steps still awaiting one; it never replaces a pin, stale or not.
    if (awaitsLaunchFill(effective) && runAgentId) effective = runAgentId;

    // An override is applied with a bare `UPDATE ... WHERE id = ?` — no condition on the
    // current value — so a present entry is the final word whatever it holds.
    const o = overrides[s.id];
    if (typeof o === 'string') effective = o.trim();

    if (cartridgeExists(effective)) continue;
    out.push({
      name: s.name,
      reason: awaitsLaunchFill(effective) ? 'no-cartridge' : 'cartridge-gone',
    });
  }
  return out;
}

/**
 * Names of the steps that cannot run. Kept as the narrow API the start route and its original
 * test already use; `unrunnableSteps` is the same answer with the reason attached.
 */
export function unassignedStepNames(
  workflowId: string,
  body: Record<string, unknown> | undefined,
): string[] {
  return unrunnableSteps(workflowId, body).map((s) => s.name);
}
