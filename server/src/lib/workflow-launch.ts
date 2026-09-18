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
import type { StepExecutorType } from '../types.js';
import { isReportStep } from './workflow-report.js';

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
 * WHAT RUN-LEVEL CONFER GIVES EACH STEP TYPE. The single registry — the door checks it and the
 * conversion applies it.
 *
 * This replaces a pair that had drifted: a Record over the union in routes/workflows.ts saying
 * what the conversion DOES, and a hand-written Set of four names here saying what the door
 * ACCEPTS. The door runs first, so the Set won every disagreement — and it had never heard of
 * `quality-gate`, `review-gate`, `confer` or `deliberation`. Measured against the live database,
 * 12 of 24 templates could not be launched in confer mode, `Epic: Confer Across Repos` among
 * them, refused because of its own confer step.
 *
 * Keyed by `StepExecutorType`, so a ninth type fails to compile until someone decides what
 * confer means for it. That is the property the Set could never have.
 *
 *   confer-all      the agent-work step — rewritten into a confer over every participant
 *   single          needs exactly ONE cartridge; takes the first participant
 *   multi-if-empty  carries its own agent list; filled from the participants only when unset
 *   none            dispatches to no cartridge in any mode
 *
 * `command` is 'single' and that is a fix, not a transcription: the old pair both called it a
 * no-agent step, while executeCommandStep opens with "Command step requires an agent ID". A
 * confer run containing one passed the door and died at that step.
 */
export type ConferFill = 'confer-all' | 'single' | 'multi-if-empty' | 'none';

export const CONFER_FILL: Record<StepExecutorType, ConferFill> = {
  'claude-code': 'confer-all',
  // A gate reads PASS/FAIL out of a result. Converting it to a confer breaks it AS a gate —
  // one that never passes, which reads as the agents being bad rather than as a wiring
  // mistake. So it keeps its single-judge shape and simply gets a judge.
  'quality-gate': 'single',
  'review-gate': 'single',
  // Not a no-agent step, whatever the old registries said. See the note above.
  'command': 'single',
  // Already multi-agent. Its own list wins when it has one; an unset list is what left the
  // confer-across-repos template unlaunchable.
  'confer': 'multi-if-empty',
  'deliberation': 'multi-if-empty',
  'connector': 'none',
  // Waits for YOUR judgement. Nothing may fill that.
  'decision': 'none',
};

/**
 * WHAT THIS STEP GETS FROM A RUN-LEVEL CONFER. The one answer, for the door and the conversion.
 *
 * CONFER_FILL above is keyed by executor TYPE, which is right for every question but one: the
 * Workflow Completion Report is an ordinary `claude-code` step and must NOT be conferred.
 *
 * A completion report is ONE account of ONE run. Conferred, it became N accounts: every
 * participant executed the report prompt, wrote `.neoncore/reports/<runId>/workflow-report.*`
 * into its own repo and opened it — which is exactly the reported symptom, "I got the same
 * report several times for baseback/interlag-backend". Run a6c37e54 has a complete report in
 * both repos. Worse, the conversion empties `executor_id` by design, and the ingest resolves
 * the repo from it, so a conferred report could never reach the journal: 7 of 14 report steps
 * were conferred, 1 of 14 delivered.
 *
 * It is 'single', not 'none': it still needs a cartridge to run on, and the judge is the same
 * first participant every other single-cartridge step gets. The report then covers the whole
 * run, all participants included — `buildRunReportContext` reads the run, not one agent.
 *
 * Callers pass the step's `executor_config` because the exemption is a property of the STEP,
 * not of its type — there is no executor type that means "report".
 */
export function conferFillFor(
  executorType: string,
  executorConfig: string | Record<string, unknown> | null | undefined,
): ConferFill | undefined {
  let config: Record<string, unknown> = {};
  if (typeof executorConfig === 'string') {
    try { config = JSON.parse(executorConfig || '{}') as Record<string, unknown>; } catch { config = {}; }
  } else if (executorConfig) {
    config = executorConfig;
  }
  if (isReportStep(config)) return 'single';
  return CONFER_FILL[executorType as StepExecutorType];
}

/** Types the confer conversion supplies agents for, so the door must not refuse them. */
const CONFER_SUPPLIES = new Set<ConferFill>(['confer-all', 'single', 'multi-if-empty', 'none']);

export function unrunnableSteps(
  workflowId: string,
  body: Record<string, unknown> | undefined,
): { name: string; reason: UnrunnableReason }[] {
  const steps = db.prepare(
    'SELECT id, name, executor_id, executor_type, executor_config FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(workflowId) as { id: string; name: string; executor_id: string; executor_type: string; executor_config: string }[];

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
    // In confer mode the conversion supplies agents for every type in the registry — so the
    // door must not refuse a step merely for arriving unassigned. It still refuses a STALE
    // pin below: the fill only touches steps awaiting one, so a dead id survives the mode and
    // would die at dispatch. Hiding that behind confer would be the original bug inverted.
    const fill = conferFillFor(s.executor_type, s.executor_config);
    if (confersEveryStep && fill && CONFER_SUPPLIES.has(fill)
        && awaitsLaunchFill((s.executor_id ?? '').trim())) continue;

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
