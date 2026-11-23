import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { runStandardTemplateSeed } from '../src/lib/templates/index.ts';
import { availableTemplates } from '../src/lib/goal-decomposition.ts';
import { NOT_PER_FEATURE, LARGE_ONLY, featureStageProblem, FEATURE_AUTO_SKIPS } from '../src/lib/feature-stages.ts';
import { normalizePipelineResult, createPilotRow, type PilotStage } from '../src/lib/goal-pilot.ts';
import { buildPipelinePrompt } from '../src/lib/goal-pilot-prompts.ts';
import { stageSkips } from '../src/lib/goal-pilot-runner.ts';
import { createFeature } from '../src/routes/goals.ts';
import { FEATURE_SIZES } from '../src/lib/acceptance-contract.ts';

/**
 * A FEATURE'S PIPELINE IS: WRITE THE TESTS → BUILD → DELIVER.
 *
 * REQUESTED: "once it starts it should go through writing the test criteria, then workflows listed
 * with no waiting unless multiple parties are involved, and then deliver the feature. The automated
 * QA part … should only be used on an epic once most of the features are developed." And: "I have a
 * feeling they might be wasting a lot of tokens and time doing extra steps and duplicated flows."
 *
 * Found live: Gridlight's two features each queued a per-feature Super QA, a Compound write-up and
 * an independent review; FacetDB's "Core data types" ran a review workflow whose own "Open PR" step
 * does what NeonCore does when the feature is marked done. The planner's rules said "one job per
 * stage" — advice, not a check.
 *
 * THE SETS: every workflow template is classified (allowed / large features only / never per
 * feature, with the reason); every size × every template through the planner's submission; the
 * prompt offers only what may be used; every stage leaves out the PR step.
 */
installStubIO();
runStandardTemplateSeed(db);
const names = () => availableTemplates().map((t) => t.name);

test('the registry names real templates — a rename cannot silently let a stage back in', () => {
  for (const n of [...Object.keys(NOT_PER_FEATURE), ...LARGE_ONLY]) assert.ok(names().includes(n), `"${n}" is not a template`);
  for (const n of ['Super QA', 'CE: Phase 5 — QA', 'CE: Phase 7 — Compound', 'CE: Phase 6 — Ship']) assert.ok(NOT_PER_FEATURE[n], `${n} must not run per feature`);
  assert.ok(LARGE_ONLY.includes('CE: Phase 4 — Review'));
});

for (const size of FEATURE_SIZES.map((s) => s.value)) {
  test(`every template × a ${size} feature: the planner may use it, or the plan is refused with the reason`, () => {
    for (const template of names()) {
      const out = normalizePipelineResult({ stages: [{ template, title: 'x', focus: 'y' }] }, { size });
      const why = featureStageProblem(template, size);
      if (!why) { assert.equal(out.error, '', `${template}: ${out.error}`); continue; }
      assert.equal(out.value, null, `${template} was accepted for a ${size} feature`);
      assert.ok(out.error.includes(template) && out.error.includes(why), `${template}: "${out.error}"`);
    }
  });
}

test('the planner is offered only what it may use, and told the shape', () => {
  for (const size of FEATURE_SIZES.map((s) => s.value)) {
    const goalId = createFeature({ projectId: '', name: `Lean ${size}` });
    const pilot = createPilotRow({ goalId, plannerAgentId: 'a', intake: { goal: 'x', involvement: 'balanced' } });
    db.prepare('UPDATE goal_pilots SET brief = ? WHERE id = ?').run(JSON.stringify({ slug: 'lean', summary: 's', size }), pilot.id);
    const prompt = buildPipelinePrompt({ ...pilot, brief: { slug: 'lean', summary: 's', size } as never }, 'r1');
    const offered = prompt.slice(prompt.indexOf('AVAILABLE WORKFLOWS'), prompt.indexOf('HOW THE PIPELINE RUNS'));
    for (const t of names()) {
      const listed = offered.includes(`  · ${t}`);
      assert.equal(listed, !featureStageProblem(t, size), `${size}: "${t}" ${listed ? 'offered but refused' : 'allowed but not offered'}`);
    }
    assert.match(prompt, /write the tests → build → deliver/i);
    assert.match(prompt, /QA runs on the EPIC/);
    assert.match(prompt, /NeonCore opens the PR/);
  }
});

test('every stage of a feature leaves out the PR step: NeonCore opens, merges and cleans up the PR itself', () => {
  assert.ok(FEATURE_AUTO_SKIPS.includes('Open PR'));
  const s = (template: string, position: number) => ({ position, kind: 'workflow', template, status: 'pending', skipSteps: [] }) as unknown as PilotStage;
  for (const template of names()) assert.ok(stageSkips(s(template, 0), [s(template, 0)]).includes('Open PR'), template);
});
