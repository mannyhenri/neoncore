/**
 * A COMPLETE DOCUMENT PREPS A COMPLETE PROJECT — scoping starts from what the document settled.
 *
 * REQUESTED: "we need to be able to completely prep a full project from a complete document". Before
 * this, a plan read from a document filled a feature's name, description and criteria; starting it
 * still meant typing "done when" and the constraints, and the planner — who never saw the document —
 * asked about things it already answered. Now every blank scoping would ask about travels the whole way.
 *
 * SET-BASED, over the registries (lib/plan-scope.ts), so a field added to the brief cannot be left
 * behind on any leg:
 *   FEATURE_SCOPE_FIELDS (every brief field but summary and criteria) and PROJECT_CONTEXT_FIELDS:
 *     asked for in the plan prompt → kept by validation → stored on apply → in the planner's prompt
 *   epic "done when" (the phase gate), roadmap-wide questions answered once, and filling the blanks
 *   of features already on the project — never overwriting what is there.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { createImportRow, buildImportPrompt, normalizePlan, submitImport, applyImport } from '../src/lib/project-import.ts';
import { FEATURE_SCOPE_FIELDS, PROJECT_CONTEXT_FIELDS, featureScope, projectPlanContext, INTAKE_SLOT } from '../src/lib/plan-scope.ts';
import { BRIEF_FIELDS, createPilotRow } from '../src/lib/goal-pilot.ts';
import { buildScopePrompt } from '../src/lib/goal-pilot-prompts.ts';
import { chartOf, createEpic } from '../src/lib/roadmap.ts';
import { createFeature } from '../src/routes/goals.ts';

installStubIO();
const ISO = new Date().toISOString();
let n = 0;
function project(): string {
  const id = `scope-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,NULL,?,'','/tmp/scope-repo','#fff',?,?)`).run(id, `proj ${id}`, ISO, ISO);
  return id;
}
const valueFor = (key: string) => `the document's ${key} for this`;
const scopeOf = () => Object.fromEntries(FEATURE_SCOPE_FIELDS.map((f) => [f.key, valueFor(f.key)]));
const contextOf = () => Object.fromEntries(PROJECT_CONTEXT_FIELDS.map((f) => [f.key, `project ${f.key} from the document`]));
const scopePromptFor = (goalId: string) => buildScopePrompt(createPilotRow({ goalId, plannerAgentId: 'a', intake: { goal: 'x', involvement: 'balanced' } }), 'req-1');

test('the registry is the brief: every field scoping writes, except the summary and the criteria (they already travel)', () => {
  assert.deepEqual(FEATURE_SCOPE_FIELDS.map((f) => f.key).sort(),
    BRIEF_FIELDS.map((f) => f.key).filter((k) => k !== 'summary' && k !== 'acceptanceCriteria').sort());
  assert.ok(FEATURE_SCOPE_FIELDS.length >= 6);
});

test('the plan prompt asks for every feature scope field, every project field, epic gates and open questions', () => {
  const prompt = buildImportPrompt(createImportRow(project(), 'a', ['plan'], { name: 'spec.md', text: '# spec' }));
  for (const f of FEATURE_SCOPE_FIELDS) assert.match(prompt, new RegExp(`"${f.key}"`), `feature field ${f.key}`);
  for (const f of PROJECT_CONTEXT_FIELDS) assert.match(prompt, new RegExp(`"${f.key}"`), `project field ${f.key}`);
  for (const k of ['doneWhen', 'questions', 'suggested', 'source', 'workType']) assert.match(prompt, new RegExp(`"${k}"`), k);
});

test('validation keeps every field of the set — on new features, on fill-ins, on the project and the epics', () => {
  const notes: string[] = [];
  const plan = normalizePlan({
    project: contextOf(),
    epics: [{ name: 'Phase 1', doneWhen: 'The crash test passes 50 runs.' }],
    features: [
      { name: 'Group commit', epic: 'Phase 1', scope: scopeOf(), workType: 'feature', source: 'Implement group commit…' },
      { name: 'Log recovery', epic: 'Phase 1', ...scopeOf() },
    ],
    questions: [{ text: 'Which hash for checksums?', why: 'affects the log', options: ['CRC32C', 'xxHash'], suggested: 'CRC32C', features: ['Group commit', 'Nope'] }],
  }, ['Log recovery'], [], notes);
  for (const f of PROJECT_CONTEXT_FIELDS) assert.equal(plan.project[f.key], `project ${f.key} from the document`, f.key);
  assert.equal(plan.epics[0].doneWhen, 'The crash test passes 50 runs.');
  const [fresh] = plan.features;
  const [update] = plan.updates;
  assert.equal(fresh.name, 'Group commit');
  assert.equal(update.name, 'Log recovery', 'a feature already on the project is kept as a fill-in, not dropped');
  for (const f of FEATURE_SCOPE_FIELDS) {
    assert.equal(fresh.scope[f.key], valueFor(f.key), `new feature: ${f.key}`);
    assert.equal(update.scope[f.key], valueFor(f.key), `fill-in (fields sent flat): ${f.key}`);
  }
  assert.equal(fresh.workType, 'feature');
  assert.match(fresh.source, /group commit/);
  assert.deepEqual(plan.questions.map((q) => [q.text, q.suggested, q.features]), [['Which hash for checksums?', 'CRC32C', ['Group commit']]]);
});

test('apply stores every field, and the planner sees every one of them when the feature is started', () => {
  const pid = project();
  const imp = createImportRow(pid, 'a', ['plan'], { name: 'spec.md', text: '# spec' });
  submitImport(imp.id, { plan: {
    vision: 'v', project: contextOf(),
    epics: [{ name: 'Phase 1', outcome: 'A durable log', doneWhen: 'The crash test passes 50 consecutive runs.' }],
    features: [{ name: 'Group commit', epic: 'Phase 1', scope: scopeOf(), workType: 'feature', source: 'Writers queue batches; one thread appends and syncs.',
      criteria: [{ text: 'When 64 writers append, the system shall sustain 200,000 changes per second.' }] }],
    questions: [{ text: 'Which checksum?', options: ['CRC32C', 'xxHash'], suggested: 'CRC32C' }],
  } });
  const q = (db.prepare('SELECT proposal FROM project_imports WHERE id = ?').get(imp.id) as { proposal: string });
  const qid = JSON.parse(q.proposal).plan.questions[0].id as string;
  applyImport(imp.id, { epics: ['Phase 1'], plan: ['Group commit'], project: PROJECT_CONTEXT_FIELDS.map((f) => f.key), answers: { [qid]: { value: '', delegated: true } } });

  const gid = (db.prepare("SELECT id FROM goals WHERE project_id = ? AND name = 'Group commit'").get(pid) as { id: string }).id;
  const stored = featureScope(gid);
  for (const f of FEATURE_SCOPE_FIELDS) assert.equal(stored[f.key], valueFor(f.key), `stored: ${f.key}`);
  const ctx = projectPlanContext(pid);
  for (const f of PROJECT_CONTEXT_FIELDS) assert.equal(ctx.fields[f.key], `project ${f.key} from the document`, `stored on the project: ${f.key}`);
  assert.deepEqual(ctx.decisions.map((d) => [d.question, d.answer, d.delegated]), [['Which checksum?', 'CRC32C', true]], 'delegated = the suggested answer');
  assert.equal(chartOf(pid)!.epics[0].doneWhen, 'The crash test passes 50 consecutive runs.');

  const prompt = scopePromptFor(gid);
  for (const f of FEATURE_SCOPE_FIELDS) assert.ok(prompt.includes(valueFor(f.key)), `the planner sees ${f.key}`);
  for (const f of PROJECT_CONTEXT_FIELDS) assert.ok(prompt.includes(`project ${f.key} from the document`), `the planner sees the project's ${f.key}`);
  for (const want of ['The crash test passes 50 consecutive runs.', 'sustain 200,000 changes per second', 'Writers queue batches', 'Which checksum? → CRC32C']) {
    assert.ok(prompt.includes(want), `the planner sees: ${want}`);
  }
  assert.match(prompt, /submit status "complete" NOW/, 'with nothing open, it goes straight to the brief');
});

test('every scope field with a slot on the start form fills it; the rest reach the planner (above)', () => {
  const slotted = FEATURE_SCOPE_FIELDS.filter((f) => INTAKE_SLOT[f.key]);
  assert.ok(slotted.length >= 2);
  for (const f of FEATURE_SCOPE_FIELDS) {
    if (!INTAKE_SLOT[f.key]) continue;
    assert.ok(['done', 'constraints', 'context', 'audience'].includes(INTAKE_SLOT[f.key]!), `${f.key} → ${INTAKE_SLOT[f.key]}`);
  }
});

test('a feature with nothing from a document keeps the planner prompt as it was', () => {
  const pid = project();
  const gid = createFeature({ projectId: pid, name: 'Plain feature' });
  const prompt = scopePromptFor(gid);
  assert.doesNotMatch(prompt, /PLANNING DOCUMENT/);
  assert.doesNotMatch(prompt, /"complete" NOW/);
});

test('filling in a project already planned: only blanks are filled — nothing a person wrote is overwritten', () => {
  const pid = project();
  const { id: epic } = createEpic(pid, { name: 'Phase 1' });
  const blank = createFeature({ projectId: pid, name: 'Log recovery' });
  const written = createFeature({ projectId: pid, name: 'Group commit', description: 'Written by a person.' });
  db.prepare("UPDATE goals SET success_metric = 'A person decided this.', epic_id = ? WHERE id = ?").run(epic, written);
  const dep = createFeature({ projectId: pid, name: 'Log records' });
  const imp = createImportRow(pid, 'a', ['plan'], { name: 'spec.md', text: '# spec' });
  submitImport(imp.id, { plan: { epics: [{ name: 'Phase 1' }], features: [
    { name: 'Log recovery', epic: 'Phase 1', description: 'Scan segments; truncate at the first bad checksum.', scope: scopeOf(), dependsOn: ['Log records'], criteria: ['When the tail is torn, the system shall truncate it.'] },
    { name: 'Group commit', epic: 'Phase 1', description: 'From the document.', scope: scopeOf() },
  ] } });
  applyImport(imp.id, { updates: ['Log recovery', 'Group commit'] });

  const r = (id: string) => db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, string>;
  assert.equal(r(blank).description, 'Scan segments; truncate at the first bad checksum.');
  assert.match(r(blank).acceptance_criteria, /AC-1: When the tail is torn/);
  assert.equal(r(blank).epic_id, epic);
  assert.deepEqual(JSON.parse(r(blank).depends_on), [dep]);
  for (const f of FEATURE_SCOPE_FIELDS) assert.equal(featureScope(blank)[f.key], valueFor(f.key), `blank filled: ${f.key}`);
  assert.equal(r(written).description, 'Written by a person.', 'never overwritten');
  assert.equal(r(written).success_metric, 'A person decided this.', 'never overwritten');
  assert.equal(featureScope(written).inScope, valueFor('inScope'), 'its blanks are still filled');
});

/**
 * FOUND ON FACET DB: the project already had its 10 phase epics, and the prompt said "do not propose
 * them again" — so the cartridge sent no epics and no phase gate arrived. An epic the project has is
 * invited back under its own name, and its blanks (outcome, gate) are filled — never overwritten.
 */
test('epics the project already has are asked for again, and their gates fill in without overwriting', () => {
  const pid = project();
  const { id: blank } = createEpic(pid, { name: 'Phase 1: The log' });
  const { id: written } = createEpic(pid, { name: 'Phase 2: Snapshots', outcome: 'A person wrote this.' });
  db.prepare("UPDATE epics SET done_when = 'A person decided this gate.' WHERE id = ?").run(written);
  const imp = createImportRow(pid, 'a', ['plan'], { name: 'spec.md', text: '# spec' });
  const prompt = buildImportPrompt(imp);
  assert.doesNotMatch(prompt, /do not propose them again/);
  assert.match(prompt, /EPICS THE PROJECT ALREADY HAS[\s\S]*include each one the\s+document describes in `epics` under EXACTLY this name/);
  submitImport(imp.id, { plan: { epics: [
    { name: 'Phase 1: The log', outcome: 'A durable log.', doneWhen: 'The crash test passes 50 consecutive runs.' },
    { name: 'Phase 2: Snapshots', outcome: 'From the document.', doneWhen: 'From the document.' },
  ] } });
  applyImport(imp.id, { vision: '', epics: [] , plan: [], updates: [], project: [], answers: {}, features: ['__nothing__'] } as never);
  const e = (id: string) => db.prepare('SELECT outcome, done_when FROM epics WHERE id = ?').get(id) as { outcome: string; done_when: string };
  assert.deepEqual(e(blank), { outcome: 'A durable log.', done_when: 'The crash test passes 50 consecutive runs.' });
  assert.deepEqual(e(written), { outcome: 'A person wrote this.', done_when: 'A person decided this gate.' });
});
