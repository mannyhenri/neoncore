/**
 * THE FIXED TEXT NEONCORE WRAPS AROUND A STEP'S OWN PROMPT, BUDGETED PER KIND OF DISPATCH.
 *
 * Overhead is what an agent receives minus the content the run supplied (the step prompt, the
 * confer task): completion instructions, role prefixes, output formats, gate wording, the run
 * record scaffold, the confer milestone frame, and anything send-command adds (the work-standard
 * block, memory, the goal brief). It rides on every dispatch and stays in the session's context
 * for every turn after, so it is paid many times over.
 *
 * Measured end to end by test/prompt-overhead-budget.test.ts over every variant of every kind.
 * Raising a number here is allowed — it should be a decision, made in a diff, not a side effect
 * of adding one more sentence to a builder.
 */
export const DISPATCH_KINDS = [
  'work', 'command', 'report', 'review-gate', 'quality-gate', 'panel', 'synthesis', 'confer-milestone',
] as const;

export type DispatchKind = typeof DISPATCH_KINDS[number];

// Set at the measured maximum (2026-10-19, after Phases 0–1) plus ~5% headroom.
export const OVERHEAD_BUDGET: Record<DispatchKind, number> = {
  /** Completion instruction + role prefix + output format; worst case reviewer + test_results (1,265). */
  work: 1330,
  /** Completion instruction around a saved command template (598). */
  command: 650,
  /** The report spec (WORKFLOW_REPORT_PROMPT) + run-record scaffold + completion (2,691). */
  report: 2800,
  /** Critic frame + verdict rule + gate completion (968). */
  'review-gate': 1020,
  /** Preset prompt + retry hint + verdict rule; worst case the work-standard preset (2,208). */
  'quality-gate': 2300,
  /** Panel completion on its per-agent channel (533). */
  panel: 580,
  /** Synthesis frame + gate completion, excluding the members' answers (812). */
  synthesis: 860,
  /**
   * Milestone frame + done signal + the work-standard block send-command appends (2,862).
   * ~1,100 of this is that block, re-sent on every milestone beside the milestone's own done
   * signal — the double contract steps no longer carry. Kept until that is decided; trim, don't raise.
   */
  'confer-milestone': 2950,
};
