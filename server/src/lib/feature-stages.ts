/**
 * WHAT BELONGS IN ONE FEATURE'S PIPELINE: write the tests → build → deliver.
 *
 * NeonCore already does the rest around the workflows: it writes and locks the acceptance tests
 * before the first stage, checks them after every stage, reviews the checklist criteria, writes the
 * report, and opens / merges / cleans up the PR when the person marks the feature done. A stage that
 * does one of those again is time and tokens spent twice (Gridlight's features queued a Super QA, a
 * Compound write-up and a review each; FacetDB's review stage had its own "Open PR").
 *
 * The planner's prompt said "one job per stage"; that was advice. This is the check: its submission
 * is refused with the reason (goal-pilot.ts normalizePipelineResult), and these templates are not
 * offered to it. The PERSON may still add any of them when they edit the plan — the rule binds the
 * planner, not them.
 */
import type { FeatureSize } from './acceptance-contract.js';

/** Never a stage of a single feature — with why, said to the planner when it tries. */
export const NOT_PER_FEATURE: Record<string, string> = {
  'Super QA': 'QA runs on the EPIC once most of its features are built, not per feature',
  'CE: Phase 5 — QA': 'QA runs on the EPIC once most of its features are built, not per feature',
  'QA Testing Guide': 'QA runs on the EPIC once most of its features are built, not per feature',
  'CE: Phase 7 — Compound': 'writing up learnings is not part of delivering the feature',
  'CE: Phase 6 — Ship': 'NeonCore opens the PR, merges it and cleans up when the feature is marked done',
};

/** A separate review stage only for a LARGE feature: NeonCore's own checks cover the rest. */
export const LARGE_ONLY: readonly string[] = ['CE: Phase 4 — Review', 'Engineering Architecture Review'];

/** Steps every feature stage leaves out, whatever its template: NeonCore does them itself. */
export const FEATURE_AUTO_SKIPS: readonly string[] = ['Open PR'];

/** Why this template may not be a stage of a feature this size — '' when it may. */
export function featureStageProblem(template: string, size: FeatureSize | string | undefined): string {
  if (NOT_PER_FEATURE[template]) return NOT_PER_FEATURE[template];
  if (LARGE_ONLY.includes(template) && size !== 'large') {
    return `a separate review stage is for a large feature — NeonCore checks the locked tests after every stage and reviews the checklist itself (this one is ${size || 'medium'})`;
  }
  return '';
}
