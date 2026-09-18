/**
 * WHAT THIS RUN IS ABOUT — the prefix every first step needs.
 *
 * Reported as "confers sending empty directions": two cartridges were dispatched
 *
 *     "The task is in the workflow description above."
 *
 * with nothing above it. The prompt was not lying; the executor was. `executeStandardStep`
 * prepended the run's `initial_context` for a step with no dependencies, and `executeConfer`
 * built its task as `dependencyContext + prompt` and never read initial_context at all. A
 * confer as the FIRST step of a run could therefore never learn what the run was for.
 *
 * Six executors dispatch a prompt to a model and exactly ONE of them carried this. Fixing
 * confer alone would have left deliberation, both gates and command steps with the same hole,
 * each to be reported separately later — so the prefix moved here and they all call it.
 *
 * ── FIRST STEPS ONLY ──────────────────────────────────────────────────────────────────
 * A later step learns the subject from its dependencies' results, which is why the standard
 * executor has always gated on `dependsOn.length === 0`. Repeating it would put the same
 * paragraph in a prompt twice. A first step has no such inheritance: the launch form is its
 * only source, and without this it has none.
 *
 * ── DESCRIPTION AS WELL AS CONTEXT ────────────────────────────────────────────────────
 * A template launched with nothing typed still has a description saying what it is for.
 * Sending neither is exactly how a confer ended up with no instructions.
 */
import type { Database as DatabaseType } from 'better-sqlite3';

export interface LaunchContextTarget {
  workflowId: string;
  /** The step's dependencies. A step with any is not a first step. */
  dependsOn: readonly string[];
}

export function buildLaunchContext(db: DatabaseType, step: LaunchContextTarget): string {
  if (step.dependsOn.length > 0) return '';

  const wf = db.prepare('SELECT name, description, initial_context FROM workflows WHERE id = ?')
    .get(step.workflowId) as { name?: string; description?: string; initial_context?: string } | undefined;
  if (!wf) return '';

  const typed = (wf.initial_context ?? '').trim();
  const described = (wf.description ?? '').trim();

  const parts: string[] = [];
  // What the person typed at launch comes FIRST: it is specific to this run, where the
  // description is the same sentence for every run of the template.
  if (typed) parts.push(`## Context\n${typed}`);
  if (described && described !== typed) parts.push(`## About this workflow\n${described}`);

  // No empty heading. A "## Context" with nothing under it reads as a context that was lost.
  return parts.length > 0 ? `${parts.join('\n\n')}\n\n` : '';
}
