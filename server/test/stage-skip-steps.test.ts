// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
/**
 * A feature stage leaves out the workflow steps that are not its job (lib/stage-steps.ts).
 *
 * REQUESTED: "are we going overkill with the scoping mechanisms and the steps … not adding more
 * duplicate work" → "yes please do". A feature run as a pipeline ran every step of every template:
 * a live engine run on Super QA was going to do a Security Review and a Performance & Accessibility
 * pass, and capture learnings that the Compound stage after it captures again.
 *
 * The set: the planner's skips (validated against the template), the automatic ones (Notify;
 * Capture Learnings when a Compound stage follows), the clone that removes them with the graph
 * rewired, the steps that are never removed, and the stage context that names what was left out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { withoutSteps, skippableStepNames, automaticSkips, lockedReason } from '../src/lib/stage-steps.ts';
import { plannedSkips } from '../src/lib/goal-pilot.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { templateIdForName } from '../src/lib/goal-decomposition.ts';
import { stageSkips, buildStageContext } from '../src/lib/goal-pilot-runner.ts';
import { templateCatalogue } from '../src/lib/goal-pilot-prompts.ts';
import type { PilotStage, GoalPilot } from '../src/lib/goal-pilot.ts';

const row = (id: string, name: string, deps: string[] = [], type = 'claude-code', config: Record<string, unknown> = {}) =>
  ({ id, name, depends_on: JSON.stringify(deps), executor_type: type, executor_config: JSON.stringify(config) });
const deps = (r: Record<string, unknown>) => JSON.parse(String(r.depends_on)) as string[];

test('a removed step hands its dependencies to the steps after it — the graph still runs end to end', () => {
  const steps = [row('a', 'Scope'), row('b', 'Security Review', ['a']), row('c', 'Perf', ['b']), row('d', 'Report', ['c'])];
  const out = withoutSteps(steps, ['security review', 'PERF']);
  assert.deepEqual(out.skipped.sort(), ['Perf', 'Security Review']);
  assert.deepEqual(out.steps.map((s) => s.name), ['Scope', 'Report']);
  assert.deepEqual(deps(out.steps[1]), ['a']);
});

test('the opening step, confers, decisions, gates, the report and routing targets are never removed', () => {
  const steps = [
    row('a', 'Scope'),
    row('b', 'Confer & Build', ['a'], 'confer'),
    row('c', 'Verify Coverage', ['b'], 'claude-code', { routingRules: [{ nextStepId: 'b' }] }),
    row('d', 'Fix', ['c']),
    row('e', 'Check', ['d'], 'claude-code', { routingRules: [{ nextStepId: 'd' }] }),
    row('f', 'Gate', ['e'], 'quality-gate'),
    row('g', 'Workflow Completion Report', ['f'], 'claude-code', { stepKind: 'workflow-report' }),
  ];
  const out = withoutSteps(steps, ['Scope', 'Confer & Build', 'Fix', 'Gate', 'Workflow Completion Report', 'Nonexistent']);
  assert.deepEqual(out.skipped, [], 'nothing that must stay was removed');
  assert.equal(out.steps.length, steps.length);
  for (const s of steps.filter((x) => x.id !== 'c' && x.id !== 'e')) assert.ok(lockedReason(s, steps), `${s.name} should be locked`);
  assert.deepEqual(skippableStepNames(steps), ['Verify Coverage', 'Check']);
});

test('automatic: Notify always, Capture Learnings only when a Compound stage follows', () => {
  assert.deepEqual(automaticSkips(['Super QA']), ['Notify', 'Open PR'], 'NeonCore opens the feature\'s PR itself (lib/feature-stages.ts)');
  assert.deepEqual(automaticSkips(['Super QA', 'CE: Phase 7 — Compound']), ['Notify', 'Open PR', 'Capture Learnings']);
});

test('the planner\'s skips are kept only when the workflow has that step and may leave it out', () => {
  assert.deepEqual(plannedSkips('Super QA', ['security review', 'Performance & Accessibility', 'Scope & Read the Code', 'Made Up']),
    ['Security Review', 'Performance & Accessibility']);
  assert.deepEqual(plannedSkips('No Such Workflow', ['Security Review']), []);
  assert.deepEqual(plannedSkips('Super QA', 'not a list'), []);
});

test('the planner is shown, per workflow, the steps it may leave out', () => {
  const qa = templateCatalogue().find((t) => t.name === 'Super QA');
  assert.ok(qa);
  assert.ok(qa!.skippable.includes('Security Review'));
  assert.ok(!qa!.skippable.includes('Scope & Read the Code'), 'the opening step is not offered');
  assert.ok(!qa!.skippable.includes('Notify'), 'automatic skips are not offered');
});

test('a stage run of Super QA leaves out what was asked plus the automatic steps, and still ends in its report', () => {
  const templateId = templateIdForName('Super QA')!;
  const runId = cloneTemplateAsRun(templateId, null, 'ctx', {
    skipSteps: ['Security Review', 'Performance & Accessibility', ...automaticSkips(['CE: Phase 7 — Compound'])],
  })!;
  const steps = db.prepare('SELECT id, name, executor_type, depends_on FROM workflow_steps WHERE workflow_id = ?').all(runId) as Record<string, unknown>[];
  const names = steps.map((s) => String(s.name));
  for (const gone of ['Security Review', 'Performance & Accessibility', 'Capture Learnings', 'Notify']) assert.ok(!names.includes(gone), `${gone} still in the run`);
  for (const kept of ['Scope & Read the Code', 'Functional Testing', 'QA Report', 'Workflow Completion Report']) assert.ok(names.includes(kept), `${kept} missing`);
  // Every dependency points at a step of this run — nothing dangles where a step was removed.
  const ids = new Set(steps.map((s) => String(s.id)));
  for (const s of steps) for (const d of deps(s)) assert.ok(ids.has(d), `${s.name} depends on a removed step`);
  // And it is still one chain from the opening step: every step but the first depends on something.
  assert.equal(steps.filter((s) => deps(s).length === 0).length, 1);
});

test('a pilot stage combines its planned skips with the automatic ones, and its context names what it leaves out', () => {
  const base = { kind: 'workflow', why: '', focus: 'Live run', repoPath: '/r', agentType: 'claude', participants: [], projectId: '', runId: '', agentId: '',
    status: 'pending', waitReason: '', resultSummary: '', attempts: 0, verifyState: '', requestId: '', startedAt: null, completedAt: null, templateId: '' };
  const stages = [
    { ...base, id: 's1', position: 0, key: 's1', template: 'Super QA', title: 'Live run', skipSteps: ['Security Review'] },
    { ...base, id: 's2', position: 1, key: 's2', template: 'CE: Phase 7 — Compound', title: 'Compound', skipSteps: [] },
  ] as unknown as PilotStage[];
  assert.deepEqual(stageSkips(stages[0], stages), ['Security Review', 'Notify', 'Open PR', 'Capture Learnings']);
  assert.deepEqual(stageSkips(stages[1], stages), ['Notify', 'Open PR']);
  const pilot = { id: 'p', goalId: 'none', plan: null, rounds: [], workspace: null } as unknown as GoalPilot;
  assert.match(buildStageContext(pilot, stages[0], stages), /Left out of this run\nSecurity Review/);
});
