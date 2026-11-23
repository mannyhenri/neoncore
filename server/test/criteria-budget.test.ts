/**
 * A FEATURE'S SIZE CAPS ITS ACCEPTANCE CRITERIA — and setup work is checked by one command.
 *
 * REQUESTED: "the acceptance criteria get too verbose and way too complex sometimes for simple tasks
 * like just setting up a project with its dependencies … Some features are simple tasks, others more
 * complex." The planner was given one ceiling (12) and no notion of size, so a "set up the workspace"
 * feature came back with a dozen criteria, each with its own locked test to write first.
 *
 * SET-BASED, over the registries:
 *   FEATURE_SIZES — for EVERY size, its budget is accepted and budget+1 is REJECTED (never trimmed),
 *     on BOTH roads criteria arrive by: a scoping submission and a document plan; and every size and
 *     budget is in BOTH prompts.
 *   VERIFY_METHODS — every method survives normalization, and "command" runs end to end in the
 *     contract: no test to write, locked from the start, checked after a stage, shown to agents, kept
 *     when the written tests are waived.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  FEATURE_SIZES, VERIFY_METHODS, CRITERION_RULES, normalizeCriteria, acceptedCriteria, createContract, getContract, updateContract,
  criteriaToWrite, criterionStates, contractBlock, contractVerdict, type Criterion,
} from '../src/lib/acceptance-contract.ts';
import { waiveTests } from '../src/lib/acceptance-runner.ts';
import { normalizeScopeResult, createPilotRow, INTAKE_QUESTIONS } from '../src/lib/goal-pilot.ts';
import { buildScopePrompt } from '../src/lib/goal-pilot-prompts.ts';
import { createImportRow, buildImportPrompt, submitImport, applyImport } from '../src/lib/project-import.ts';
import { featureScope } from '../src/lib/plan-scope.ts';
import { createFeature } from '../src/routes/goals.ts';

installStubIO();
const ISO = new Date().toISOString();
const BRIEF = { slug: 's', summary: 'Set up the workspace.' };
const crit = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `When check ${i + 1} runs, the system shall pass.`, expect: `check ${i + 1} → ok`, verify: 'test' }));
let n = 0;
function project(): string {
  const id = `budget-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,NULL,?,'','/tmp/budget-repo','#fff',?,?)`).run(id, `proj ${id}`, ISO, ISO);
  return id;
}

test('sizes are ordered and the largest is the overall ceiling', () => {
  assert.deepEqual(FEATURE_SIZES.map((s) => s.value), ['small', 'medium', 'large']);
  const max = FEATURE_SIZES.map((s) => s.maxCriteria);
  assert.deepEqual(max, [...max].sort((a, b) => a - b));
  assert.ok(max[0] <= 3, 'a small feature takes a handful of criteria at most');
  assert.ok(INTAKE_QUESTIONS.some((q) => q.key === 'size' && !q.required), 'the person can size a feature on the start form (optional)');
});

test('every size, scoping: its budget is accepted, one more is rejected — nothing trimmed', () => {
  for (const s of FEATURE_SIZES) {
    const ok = normalizeScopeResult({ status: 'complete', size: s.value, brief: BRIEF, criteria: crit(s.maxCriteria) });
    assert.equal(ok.error, '', `${s.value}: ${ok.error}`);
    assert.equal(ok.value?.status === 'complete' && ok.value.criteria.length, s.maxCriteria);
    assert.equal(ok.value?.status === 'complete' && ok.value.brief.size, s.value);

    if (s.maxCriteria >= 12) continue;   // the ceiling itself is MAX_CRITERIA
    const over = normalizeScopeResult({ status: 'complete', size: s.value, brief: BRIEF, criteria: crit(s.maxCriteria + 1) });
    assert.equal(over.value, null, `${s.value} with ${s.maxCriteria + 1} criteria was accepted`);
    assert.match(over.error, new RegExp(`${s.value} feature takes at most ${s.maxCriteria}`));
    assert.match(over.error, /command/, 'the rejection says how to shrink (one command check)');
  }
});

test('a size the person set holds: the planner cannot re-size past it', () => {
  const out = normalizeScopeResult({ status: 'complete', size: 'large', brief: BRIEF, criteria: crit(5) }, new Set(), 'feature', 'small');
  assert.equal(out.value, null);
  assert.match(out.error, /small feature takes at most 3/);
  assert.match(out.error, /person set the size/);
  const fits = normalizeScopeResult({ status: 'complete', size: 'large', brief: BRIEF, criteria: crit(2) }, new Set(), 'feature', 'small');
  assert.equal(fits.value?.status === 'complete' && fits.value.brief.size, 'small');
});

test('no size sent: sized medium, said in the notes', () => {
  const out = normalizeScopeResult({ status: 'complete', brief: BRIEF, criteria: crit(2) });
  assert.equal(out.value?.status === 'complete' && out.value.brief.size, 'medium');
  assert.ok(out.notes.some((x) => /no size was sent/.test(x)));
});

test('every size and budget, and the criterion rules, are in the scoping prompt', () => {
  const goalId = createFeature({ projectId: project(), name: 'Workspace setup' });
  const prompt = buildScopePrompt(createPilotRow({ goalId, plannerAgentId: 'a', intake: { goal: 'x', involvement: 'balanced', size: 'small' } }), 'r1');
  for (const s of FEATURE_SIZES) assert.match(prompt, new RegExp(`- ${s.value}: at most ${s.maxCriteria}`), s.value);
  for (const l of CRITERION_RULES) assert.ok(prompt.includes(l.trim()), `missing rule: ${l}`);
  assert.match(prompt, /The person sized this feature small: at most 3 criteria/);
  assert.match(prompt, /"verify": "test\|command\|checklist"/);
});

test('every size, document plan: within budget is kept with its size; over it the submission is rejected', () => {
  const pid = project();
  const prompt = buildImportPrompt(createImportRow(pid, 'a', ['plan'], { name: 'spec.md', text: '# spec' }));
  for (const s of FEATURE_SIZES) assert.match(prompt, new RegExp(`"${s.value}" \\(at most ${s.maxCriteria}`), s.value);
  for (const l of CRITERION_RULES) assert.ok(prompt.includes(l.trim()), `plan prompt misses rule: ${l}`);

  for (const s of FEATURE_SIZES) {
    const budget = Math.min(s.maxCriteria, 8);
    const over = createImportRow(pid, 'a', ['plan'], { name: 'spec.md', text: '# spec' });
    assert.throws(() => submitImport(over.id, { plan: { features: [{ name: `F ${s.value}`, size: s.value, criteria: crit(budget + 1) }] } }),
      new RegExp(`"F ${s.value}" \\(${s.value}\\) has ${budget + 1} criteria — at most ${budget}`));
  }
  const imp = createImportRow(pid, 'a', ['plan'], { name: 'spec.md', text: '# spec' });
  submitImport(imp.id, { plan: { features: FEATURE_SIZES.map((s) => ({ name: `Feature ${s.value}`, size: s.value, criteria: crit(Math.min(s.maxCriteria, 8)) })) } });
  applyImport(imp.id, { plan: FEATURE_SIZES.map((s) => `Feature ${s.value}`) });
  for (const s of FEATURE_SIZES) {
    const gid = (db.prepare('SELECT id FROM goals WHERE project_id = ? AND name = ?').get(pid, `Feature ${s.value}`) as { id: string }).id;
    assert.equal(featureScope(gid).size, s.value, `${s.value} was not stored on the feature`);
  }
});

test('every verify method survives normalization; a command needs its command', () => {
  for (const m of VERIFY_METHODS) {
    const [c] = normalizeCriteria([{ text: `When ${m.value}`, expect: 'x', verify: m.value, command: 'npm ci && npm test' }]);
    assert.equal(c.verify, m.value);
  }
  const notes: string[] = [];
  const [c] = normalizeCriteria([{ text: 'It builds', verify: 'command' }], { workType: 'feature' }, notes);
  assert.equal(c.verify, 'test', 'a command criterion with no command falls back, with a note');
  assert.ok(notes.some((x) => /no command/.test(x)));
  const accepted = acceptedCriteria([{ text: 'It builds', expect: '', verify: 'command', command: 'cargo build && cargo test' }]);
  assert.equal(accepted.error, '', 'a command criterion needs no "expected" — exit 0 is the expectation');
});

function contractFor(criteria: Criterion[]) {
  const goalId = createFeature({ projectId: project(), name: `C ${++n}` });
  const pilot = createPilotRow({ goalId, plannerAgentId: 'a', intake: { goal: 'x' } });
  return { pilot, c: createContract({ pilotId: pilot.id, goalId, criteria, repoPath: '/tmp/r', agentType: 'claude' }) };
}

test('a contract of only commands is locked from the start: nothing to write, the command is the check', () => {
  const { c } = contractFor([{ id: 'AC-1', text: 'The workspace builds and its tests run.', expect: '', verify: 'command', command: 'cargo build && cargo test' }]);
  assert.equal(c.status, 'locked');
  assert.deepEqual(criteriaToWrite(c), []);
  assert.deepEqual(c.tests, [{ criterionId: 'AC-1', command: 'cargo build && cargo test', files: [] }]);
  assert.match(contractBlock(c), /AC-1 \(command\).*`cargo build && cargo test` must exit 0/);
  assert.equal(criterionStates(c)[0].outcome, 'not-run');
  updateContract(c.id, { verifications: [{ id: 'v', stageId: 's', stagePosition: 1, stageTitle: 'Build', at: ISO, version: 1, status: 'passed', passing: 1, total: 1, filesChecked: 0,
    results: [{ criterionId: 'AC-1', command: 'cargo build && cargo test', exitCode: 0, passed: true, timedOut: false, output: '', durationMs: 5, at: ISO }], tampered: [], error: '' }] });
  const after = getContract(c.pilotId)!;
  assert.equal(criterionStates(after)[0].outcome, 'pass');
  assert.equal(contractVerdict(criterionStates(after)), 'SUCCESS');
});

test('tests + a command: only the test is written; waiving the tests keeps the command in force', () => {
  const { pilot, c } = contractFor([
    { id: 'AC-1', text: 'When x, y.', expect: 'x → y', verify: 'test' },
    { id: 'AC-2', text: 'It builds.', expect: '', verify: 'command', command: 'npm run build' },
  ]);
  assert.equal(c.status, 'drafting');
  assert.deepEqual(criteriaToWrite(c).map((x) => x.id), ['AC-1']);
  waiveTests(pilot.id);
  const w = getContract(pilot.id)!;
  assert.equal(w.status, 'locked');
  assert.deepEqual(w.tests.map((t) => t.criterionId), ['AC-2']);
  const states = criterionStates(w);
  assert.equal(states.find((s) => s.id === 'AC-1')!.outcome, 'waived');
  assert.equal(states.find((s) => s.id === 'AC-2')!.outcome, 'not-run');
});
