/**
 * CAN THIS LAUNCH START, AND IF NOT, WHY NOT — the single answer.
 *
 * This rule used to exist twice inside WorkflowPanel: once in the Run Workflow button's
 * `disabled=` expression and once in `handleDeferredRun`'s own guard. They drifted, in the way
 * two copies of a predicate always eventually do — the button's copy learned about confer mode
 * and the handler's copy did not.
 *
 * The result was reported three times: pick "Run on", select two cartridges, the button turns
 * green, clicking it does nothing at all. Both halves were behaving exactly as written. In
 * confer mode the single-cartridge <select> is never rendered, so `runAgentId` stays '';
 * the button's copy said "confer supplies the cartridges, that's fine" and enabled, and the
 * handler's copy said "no runAgentId" and hit a bare `return` on its first line. No error, no
 * state change, nothing logged.
 *
 * Two decisions, both load-bearing:
 *
 *  1. ONE FUNCTION, both callers. The button disables when this returns anything; the handler
 *     refuses when this returns anything. They cannot disagree about whether a launch is ready
 *     because they are no longer two opinions.
 *
 *  2. BLOCKERS ARE SENTENCES, not a boolean. The old guard returned silently even when it was
 *     right to refuse, which is why this took three reports to pin down — there was nothing to
 *     see. A refusal that cannot explain itself is indistinguishable from a broken button.
 */

export interface LaunchPromptSlot {
  stepId: string;
  stepName: string;
  field: string;
  label: string;
}

export interface LaunchState {
  /** Runs are attributed to a project; the launch modal requires one. */
  projectId: string;
  /** How many steps arrived `__deferred__` and therefore need a cartridge from somewhere. */
  agentStepCount: number;
  /** The user chose to assign a cartridge per step rather than one for the run. */
  perStepAgents: boolean;
  assignments: Record<string, string>;
  /** The one-cartridge-for-everything pick. Empty in confer mode — that select is not rendered. */
  runAgentId: string;
  /** Cartridges picked under "Run on". Two or more IS the confer, and supplies every step. */
  conferAgents: string[];
  promptSteps: LaunchPromptSlot[];
  prompts: Record<string, Record<string, string>>;
  /** Some templates are useless without launch context and say so. */
  requiresContext: boolean;
  initialContext: string;
}

/** Two or more cartridges under "Run on" is a confer, and a confer supplies every agent step. */
export function isConfer(conferAgents: readonly string[]): boolean {
  return conferAgents.filter(Boolean).length >= 2;
}

/**
 * Everything standing between this launch and starting. Empty means go.
 *
 * Order matters only for which message a user sees first, so the cheapest and most common
 * omissions come first.
 */
export function launchBlockers(s: LaunchState): string[] {
  const out: string[] = [];

  if (!s.projectId) {
    out.push('Pick a project — a run has to be attributable to one.');
  }

  // Where the cartridges come from. THREE legitimate sources, and the third is the one the
  // duplicated copy never learned about.
  if (s.agentStepCount > 0) {
    if (isConfer(s.conferAgents)) {
      // Satisfied. The conversion gives every step the confer roster server-side
      // (CONFER_FILL, server/src/lib/workflow-launch.ts), so nothing else is needed here.
    } else if (s.conferAgents.filter(Boolean).length === 1) {
      // Naming this explicitly rather than falling through to "pick a cartridge": having
      // selected exactly one under "Run on" looks like a completed choice, and the generic
      // message would read as though the selection had not registered.
      out.push('A confer needs at least 2 cartridges — one on its own is an ordinary run, so pick another or clear the selection and choose a single cartridge below.');
    } else if (s.perStepAgents) {
      const missing = Math.max(0, s.agentStepCount - Object.values(s.assignments).filter(Boolean).length);
      if (missing > 0) {
        out.push(`${missing} step${missing === 1 ? '' : 's'} still need${missing === 1 ? 's' : ''} a cartridge.`);
      }
    } else if (!s.runAgentId) {
      out.push('Pick a cartridge for this run.');
    }
  }

  for (const slot of s.promptSteps) {
    if (!s.prompts[slot.stepId]?.[slot.field]?.trim()) {
      out.push(`"${slot.stepName}" needs its ${slot.label.toLowerCase()}.`);
    }
  }

  if (s.requiresContext && !s.initialContext.trim()) {
    out.push('This template needs launch context — describe what it should work on.');
  }

  return out;
}
