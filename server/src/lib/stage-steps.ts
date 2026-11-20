/**
 * STEPS A FEATURE STAGE LEAVES OUT — so a pipeline does not do the same work twice.
 *
 * A workflow template is written to stand alone: it scopes, works, captures what it learned and
 * notifies. Run as one stage of a feature pipeline (lib/goal-pilot-runner.ts), parts of that are
 * already done by the pipeline or by another stage, and some steps do not fit the stage's job:
 *
 *   automatic   "Capture Learnings" when a later stage is a Compound workflow (it captures them for
 *               the whole feature), and the run's own "Notify" (the pipeline reports progress itself)
 *   planned     steps the planner marked as not this stage's job (e.g. Security Review in a live
 *               engine run), shown to the person on the plan before it is accepted
 *
 * Some steps are never left out, whatever is asked: the first steps (they receive the stage's
 * launch context and their output is what the next step works from — Confer's task IS its scope
 * step's output), confer steps, gates, the completion report (the pipeline's stage summary), and any
 * step another kept step routes to. A step that is left out is removed with its edges rewired: what
 * depended on it now depends on what it depended on, so the graph still runs end to end.
 */
import { isReportStep, REPORT_STEP_NAME } from './workflow-report.js';

type StepRow = Record<string, unknown>;

const NEVER_TYPES = new Set(['confer', 'deliberation', 'decision', 'quality-gate', 'review-gate']);
const norm = (name: string) => name.trim().toLowerCase();

function depsOf(s: StepRow): string[] {
  try { return (JSON.parse(String(s.depends_on ?? '[]')) as string[]).filter((d) => typeof d === 'string'); } catch { return []; }
}

function configOf(s: StepRow): Record<string, unknown> {
  try { return JSON.parse(String(s.executor_config ?? '{}')) as Record<string, unknown>; } catch { return {}; }
}

/** Why a step can never be left out, or '' when it can. */
export function lockedReason(s: StepRow, all: StepRow[]): string {
  if (depsOf(s).length === 0) return 'it opens the workflow';
  if (NEVER_TYPES.has(String(s.executor_type))) return 'it is a confer, a decision or a gate';
  if (isReportStep(configOf(s)) || norm(String(s.name)) === norm(REPORT_STEP_NAME)) return 'it writes the completion report';
  const id = String(s.id);
  if (all.some((o) => o !== s && routeTargets(configOf(o)).has(id))) return 'another step routes to it';
  return '';
}

/** Every step a config routes to (`nextStepId`, at any depth — routing rules, decision options). */
function routeTargets(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => routeTargets(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'nextStepId' && typeof x === 'string') out.add(x);
      else routeTargets(x, out);
    }
  }
  return out;
}

/** The steps of a template a stage may leave out (their names), in order. */
export function skippableStepNames(steps: StepRow[]): string[] {
  return steps.filter((s) => !lockedReason(s, steps)).map((s) => String(s.name));
}

/**
 * The steps a stage leaves out without being told: "Capture Learnings" when a later stage is a
 * Compound workflow, and the run's own "Notify".
 */
export function automaticSkips(laterTemplates: string[]): string[] {
  const out = ['Notify'];
  if (laterTemplates.some((t) => /compound/i.test(t))) out.push('Capture Learnings');
  return out;
}

/**
 * Does a later stage of the pipeline do the reviewing? Then the build stage does not: a confer's
 * cross-review milestone is left out when a QA / review / audit workflow follows it, so the same
 * diff is not read twice by two stages (lib/goal-pilot-runner.ts, confer-conductor conferPlan).
 */
export function laterStageReviews(laterTemplates: string[]): boolean {
  return laterTemplates.some((t) => /\bqa\b|\breview\b|\baudit\b/i.test(t));
}

/**
 * Remove the named steps (case-insensitive) that may be left out, rewiring their edges. Returns the
 * kept rows (copies, `depends_on` rewritten) and the names actually left out. A name that matches no
 * step, or a step that must stay, is ignored — the run is never broken by a skip list.
 */
export function withoutSteps(steps: StepRow[], names: string[]): { steps: StepRow[]; skipped: string[] } {
  const want = new Set(names.map(norm).filter(Boolean));
  if (want.size === 0) return { steps, skipped: [] };
  const drop = new Map<string, StepRow>();
  for (const s of steps) {
    if (want.has(norm(String(s.name))) && !lockedReason(s, steps)) drop.set(String(s.id), s);
  }
  if (drop.size === 0) return { steps, skipped: [] };

  const resolve = (id: string, seen = new Set<string>()): string[] => {
    const d = drop.get(id);
    if (!d) return [id];
    if (seen.has(id)) return [];
    seen.add(id);
    return depsOf(d).flatMap((x) => resolve(x, seen));
  };
  const kept = steps.filter((s) => !drop.has(String(s.id))).map((s) => {
    const deps = depsOf(s);
    if (!deps.some((d) => drop.has(d))) return s;
    return { ...s, depends_on: JSON.stringify([...new Set(deps.flatMap((d) => resolve(d)))]) };
  });
  return { steps: kept, skipped: [...drop.values()].map((s) => String(s.name)) };
}
