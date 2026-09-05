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
/**
 * Step types that need no cartridge pinned when the run confers on every step: the one the
 * conversion rewrites, plus the three that dispatch to no agent in any mode.
 *
 * Gates and deliberation are deliberately ABSENT — they still need their own agents, and a
 * confer run that silently launched with an unassigned gate would stall at it.
 */
const CONFER_SATISFIED = new Set(['claude-code', 'connector', 'decision', 'command']);

export function unrunnableSteps(
  workflowId: string,
  body: Record<string, unknown> | undefined,
): { name: string; reason: UnrunnableReason }[] {
  const steps = db.prepare(
    'SELECT id, name, executor_id, executor_type FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(workflowId) as { id: string; name: string; executor_id: string; executor_type: string }[];

  const runAgentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';

  /**
   * Run-level confer supplies cartridges too, and this check must know it.
   *
   * Found by launching for real: every static guard passed while the launch returned
   * "Pick a cartridge for this run — 4 step(s) cannot run ... they have none". This function
   * replays how the start handler assigns executors, and the confer conversion is a source of
   * assignment it had never heard of — so a fully-specified confer run was refused at the door
   * before the conversion could happen.
   *
   * A converted step holds NO executor_id by design (no single cartridge owns it), which is
   * exactly what this function otherwise reads as "unassigned".
   */
  const conferAll = Array.isArray(body?.conferAllSteps)
    ? (body.conferAllSteps as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim())
    : [];
  const confersEveryStep = conferAll.length >= 2;
  const overrides = (body?.agentOverrides && typeof body.agentOverrides === 'object')
    ? (body.agentOverrides as Record<string, unknown>)
    : {};

  const out: { name: string; reason: UnrunnableReason }[] = [];
  for (const s of steps) {
    // Resolve the executor this step will ACTUALLY hold, replaying the order the start handler
    // writes them in (routes/workflows.ts): clone -> run-level fill -> per-step override.
    // Last writer wins, so the order is the whole answer — a live run-level fill followed by a
    // stale override leaves the step stale, and a live override rescues even a stale pin.
    // In confer mode, a step is satisfied if the conversion covers it or it never needed a
    // cartridge at all. `claude-code` is rewritten to a confer and holds no executor_id by
    // design; connector/decision/command dispatch to no cartridge ever — they are only
    // "unassigned" here because an ordinary run's run-level fill happens to stamp them too.
    // Scoped to confer mode deliberately: relaxing this for every run would change a check
    // that has been correct for every other path.
    if (confersEveryStep && CONFER_SATISFIED.has(s.executor_type)) continue;

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
