/**
 * A TASK-LIST RUN IS NOT FINISHED UNTIL EVERY TASK IS — and it never loops forever trying.
 *
 * Asked for as: "if I ever use a confer or a similar workflow to complete a full set of tasks,
 * the workflow won't finish until it completes."
 *
 * Before this, the engine guaranteed ATTEMPTS, not completions. A work loop could end with tasks
 * open — blocked after three attempts, a cartridge repeating itself, a confer out of rounds — and
 * the only things standing between that and a run marked `completed` were two agents: the
 * coverage step that wrote `COVERAGE: 18/23`, and the Work Standard Check reading it. Nothing in
 * the engine read the number. A lenient check could pass it, and its retry re-ran only the
 * report, never the work.
 *
 * Now a step that carries `coverage: { retryFrom: [...] }` (the coverage step of every task-list
 * template) is READ BY THE ENGINE when it completes:
 *
 *   every task done                      → the run goes on.
 *   tasks open, and the last pass got    → the run goes BACK to the work step(s) named in
 *   further than the one before it         retryFrom, handed the list of what is open, with a
 *                                          budget sized to what is left. Then the check again.
 *   tasks open, and no progress          → the run HOLDS and asks you: keep working, or accept
 *   (or no COVERAGE line, or the pass      it as it is. No autonomy level may answer for you —
 *   limit reached)                         `tasks-outstanding` is never auto-resolved.
 *
 * "Progress" is what bounds it: a pass that finished nothing more than the last one cannot be
 * helped by another identical pass (the same reasoning as LOOP-003 for a single dispatch), and
 * MAX_COVERAGE_PASSES caps a run that creeps forward one task per full pass.
 */
import type { Coverage } from './run-progress.js';

export const MAX_COVERAGE_PASSES = 10;

/**
 * The machine-read line every coverage step of every task-list template reports:
 * `COVERAGE: <done>/<total>`. THE SAME PATTERN the completion webhook requires of that step (see
 * countsOwed), so what the gate accepts is exactly what the engine can read — a stricter reader
 * would hold a run the gate had let through.
 */
export const COVERAGE_PATTERN = 'COVERAGE:\\s*(\\d+)\\s*\\/\\s*(\\d+)';

export interface CoverageConfig {
  /** The work step(s) a pass with tasks left goes back to, by NAME (ids are regenerated per run). */
  retryFrom: string[];
  /** Passes back to the work before the run holds regardless of progress. */
  maxPasses?: number;
}

export function coverageConfigOf(cfg: Record<string, unknown>): CoverageConfig | null {
  const c = cfg.coverage as { retryFrom?: unknown; maxPasses?: unknown } | undefined;
  if (!c || typeof c !== 'object') return null;
  const retryFrom = (Array.isArray(c.retryFrom) ? c.retryFrom : [c.retryFrom])
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  if (retryFrom.length === 0) return null;
  const maxPasses = typeof c.maxPasses === 'number' && c.maxPasses > 0 ? Math.floor(c.maxPasses) : undefined;
  return { retryFrom, maxPasses };
}

export type CoverageDecision =
  | { action: 'complete' }
  | { action: 'loop-back'; remaining: number }
  | { action: 'hold'; why: string };

/**
 * What to do with one coverage check.
 *
 * `previousDone` — tasks done at the previous check of this run (undefined on the first).
 * `passes` — how many times this run has already been sent back to the work.
 */
export function decideCoverage(
  coverage: Coverage | null,
  previousDone: number | undefined,
  passes: number,
  cfg: CoverageConfig,
): CoverageDecision {
  if (!coverage) {
    return { action: 'hold', why: 'it did not report a COVERAGE line, so the engine cannot confirm every task is done' };
  }
  const { done, total } = coverage;
  if (total === 0 || done >= total) return { action: 'complete' };

  const remaining = total - done;
  if (previousDone !== undefined && done <= previousDone) {
    return {
      action: 'hold',
      why: `the last pass finished nothing more (${previousDone} → ${done} of ${total}), so another identical pass would not help`,
    };
  }
  const max = cfg.maxPasses ?? MAX_COVERAGE_PASSES;
  if (passes >= max) {
    return { action: 'hold', why: `the run has already gone back to the work ${passes} times, the limit` };
  }
  return { action: 'loop-back', remaining };
}

/** The line a person reads — on the run, in the bell, on the phone. */
export function holdDetail(stepName: string, coverage: Coverage | null, why: string): string {
  if (!coverage) return `"${stepName}" could not be checked: ${why}. Keep working, or accept the run as it is.`;
  const open = coverage.total - coverage.done;
  return `${open} of ${coverage.total} task(s) are still open after "${stepName}" — ${why}. `
    + 'Keep working, or accept the run as it is.';
}

/** What the work step is told when the run comes back to it. */
export function loopBackFeedback(coverage: Coverage, pass: number, max: number, forced: boolean): string {
  const open = coverage.total - coverage.done;
  const lines = [
    `[TASKS STILL OPEN — ${forced ? 'you chose to keep working' : `coverage pass ${pass} of at most ${max}`}: `
      + `${coverage.done} of ${coverage.total} done, ${open} open. The run is not finished until every task is. `
      + 'Work ONLY what is still open; re-read the progress document for the full list and each task\'s notes.]',
  ];
  if (coverage.outstanding.length) lines.push(...coverage.outstanding.map((l) => `- ${l}`));
  return lines.join('\n');
}

/** A count a step's result must carry, and who reads it. */
export interface CountOwed { readerStep: string; pattern: string }

/**
 * EVERY count a step's result must carry before it may complete: the loop counts and confer
 * sizes other steps read from it (lib/workflow-loop.ts loopCountRequirements), and — for a
 * coverage step — its own COVERAGE line, which the engine reads. The completion webhook refuses a
 * result that lacks one and says which, so the agent adds it while it is still there.
 */
export function countsOwed(
  step: { name: string; config: Record<string, unknown> },
  siblingRequirements: CountOwed[],
): CountOwed[] {
  const own = coverageConfigOf(step.config)
    ? [{ readerStep: `${step.name} (the engine's coverage check)`, pattern: COVERAGE_PATTERN }]
    : [];
  return [...siblingRequirements, ...own];
}
