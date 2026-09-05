/**
 * A workflow step where several cartridges work TOGETHER — confer, inside a workflow.
 *
 * REPORTED: "It shouldn't be per step it should [be] them working together like the confer
 * process but in a workflow."
 *
 * The first attempt at this shipped `Epic: Two Repos`, a diamond where each branch has ONE
 * owner. That is per-step assignment in a nicer shape, and it is not what was asked for: the
 * two cartridges never talk, they only converge at a join. What was asked for is the confer
 * relationship — participants on one shared objective, splitting the work between themselves
 * and seeing each other's output — expressed as a step.
 *
 * ── WHY THIS REUSES CONFER RATHER THAN GROWING A SECOND COLLABORATION MODEL ─────────────
 * confer-conductor.ts already does exactly this, including the part that is hard: its align
 * milestone tells participants to "Converge on ONE plan and split the work by area/files so
 * you will not collide (state who owns what)". Participants each carry their OWN repoPath
 * (validated per participant), so a cross-repo confer already works today — there was simply
 * no way to start one from a workflow. Connectors are capture-learnings, save-to-project and
 * system-notify; none of them starts a confer.
 *
 * Building a second multi-agent mechanism beside it would mean two things to keep correct,
 * and the existing one already has milestones, rounds, worktrees and ownership.
 *
 * SET-BASED over the INTEGRATION POINTS a new executor type must be wired into, derived by
 * enumerating every place `deliberation` — the existing multi-agent type — appears. A type
 * wired into four of them dispatches and then hangs forever, which is the failure mode that
 * looks like health.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * THE SET: where a multi-agent executor type must appear to be real, and what breaks if it
 * does not. Each `needs` is checked against the existing `deliberation` wiring too, so a
 * location that stops being an integration point fails loudly instead of rotting.
 */
const INTEGRATION_POINTS = [
  // Each point carries the SPECIFIC marker that proves it, not the word "confer". A bare
  // word-match passed two mutations: packages/client/src/types.ts and routes/workflows.ts
  // both mention confer for unrelated reasons (ConferSession, the /api/confer routes), so
  // deleting the wiring left the file still "containing confer" and the guard still green.
  { file: 'server/src/types.ts',                     marker: /StepExecutorType[^;]*'confer'/,
    why: 'the StepExecutorType union — an unknown type is not representable' },
  { file: 'packages/client/src/types.ts',            marker: /StepExecutorType[^;]*'confer'/,
    why: 'the SHARED union the dashboard and phone import — without it every comparison is dead code' },
  { file: 'server/src/lib/engine-capability.ts',     marker: /f\('confer'/,
    why: 'the capability registry decides which engines can run the step' },
  { file: 'server/src/db.ts',                        marker: /DEFERRED_TYPES[\s\S]{0,160}'confer'/,
    why: 'DEFERRED_TYPES, or the step has no cartridges and the run hangs at launch' },
  { file: 'server/src/lib/workflow-executor-v2.ts',  marker: /executorType === 'confer'/,
    why: 'dispatch, per-tick advance, and completion' },
  { file: 'server/src/routes/workflows.ts',          marker: /conferOverrides/,
    why: 'the launch path must accept its participants' },
  { file: 'mobile/src/types.ts',                     marker: /StepExecutorType[\s\S]{0,200}'confer'/,
    why: 'the phone cannot render a step type it does not know' },
  { file: 'mobile/src/screens/WorkflowRunDetailScreen.tsx', marker: /'confer':/,
    why: 'the run view labels each step by type' },
  { file: 'dashboard/src/components/WorkflowCanvasEditor.tsx', marker: /executorType === 'confer'/,
    why: 'the desk must show and configure it' },
] as const;

test('the integration-point set matches how deliberation is actually wired', () => {
  // Non-vacuous AND self-checking: every location listed must genuinely be one, proven by the
  // existing multi-agent type appearing there. If deliberation leaves a file, this set is stale.
  const notReally = INTEGRATION_POINTS
    .filter((p) => !/deliberation/.test(read(p.file)))
    .map((p) => p.file);
  assert.deepEqual(notReally, [],
    `these are listed as integration points but deliberation does not appear in them — ` +
    `the set is stale:\n  ${notReally.join('\n  ')}`);
  assert.equal(INTEGRATION_POINTS.length, 9, 'the set changed — update it deliberately');
});

test('the confer step type is wired into EVERY integration point', () => {
  const missing = INTEGRATION_POINTS
    .filter((p) => !p.marker.test(read(p.file)))
    .map((p) => `${p.file} — ${p.why}`);
  assert.deepEqual(missing, [],
    `a step type wired into only some of these dispatches and then hangs forever:\n  ${missing.join('\n  ')}`);
});

test('the executor can dispatch, advance and finish a confer step', () => {
  // Three distinct lifecycle moments. A type with dispatch but no advance starts a confer and
  // never notices it ended — the run sits at "1 running" with the work long since done.
  const ex = read('server/src/lib/workflow-executor-v2.ts');
  assert.match(ex, /executorType === 'confer'/, 'no dispatch branch for a confer step');
  assert.match(ex, /executeConfer\s*\(/, 'no dispatch function');
  assert.match(ex, /processConferStep\s*\(/, 'nothing advances the step when the confer ends');
});

test('a confer step carries participants, not a single executor', () => {
  // The whole point: several cartridges, which may live in different repos. One executor_id
  // would make this deliberation-with-extra-steps.
  const ex = read('server/src/lib/workflow-executor-v2.ts');
  assert.match(ex, /conferAgentIds/, 'no per-step participant list');
});
