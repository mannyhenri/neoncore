// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { startWorkflowApp, stepsOf, stepNamed, verified, type WorkflowApp } from './helpers/workflow-app.ts';

/**
 * ROUTING RULES FIRE — AND WHEN THEY FIRE, THE WORKFLOW LOOPS.
 *
 * A routing rule names its target by STEP ID (`routingRules[].nextStepId`). Step ids are
 * regenerated in four places — the editor's create and save (/v2/create, PUT /v2/:id), a launch
 * (template → run in /v2/:id/start) and a scheduled launch (cloneTemplateAsRun) — and all four
 * remapped `dependsOn` and nothing else. Every rule in every run therefore pointed at a step that
 * was not in it, and the executor skipped it without a word: no rule had ever fired in a run.
 *
 * Remapping alone would have made rules fire BADLY, so the semantics are fixed with it:
 *  - a rule that fires re-runs the PATH from its target back to the step that fired (inclusive),
 *    with that step's result as feedback. Resetting only the target left the firing step
 *    `completed`: the target re-ran while everything downstream went ahead, and the condition was
 *    never re-checked — not a loop at all;
 *  - on a GATE, a rule is evaluated against a FAIL verdict and chooses where the retry goes back
 *    to. A PASS never loops back — before, a passing gate whose text mentioned "STATUS: FAIL"
 *    would have, once rules could fire at all;
 *  - a rule whose target is not in the run is logged, not silently skipped.
 */

let app: WorkflowApp;
before(async () => { app = await startWorkflowApp('routing-agent'); });
after(() => app.close());

type Ref = { from: string; to: string; kind: 'routing' | 'decision' };

/** Every step-id reference inside step configs, as step NAMES, for a workflow. */
function refsByName(workflowId: string): { refs: Ref[]; dangling: string[] } {
  const steps = stepsOf(workflowId);
  const nameOf = new Map(steps.map((s) => [s.id, s.name]));
  const refs: Ref[] = [];
  const dangling: string[] = [];
  for (const s of steps) {
    const cfg = JSON.parse(s.executor_config || '{}');
    const targets: Array<[string, 'routing' | 'decision']> = [
      ...((cfg.routingRules ?? []) as Array<{ nextStepId?: string }>).map((r) => [r.nextStepId ?? '', 'routing'] as [string, 'routing']),
      ...((cfg.options ?? []) as Array<{ nextStepId?: string }>).filter((o) => o.nextStepId).map((o) => [o.nextStepId!, 'decision'] as [string, 'decision']),
    ];
    for (const [id, kind] of targets) {
      const to = nameOf.get(id);
      if (to) refs.push({ from: s.name, to, kind });
      else dangling.push(`${s.name} → ${id.slice(0, 8)} (${kind})`);
    }
  }
  return { refs, dangling };
}

const templates = () => db.prepare(`SELECT id, name FROM workflows WHERE template_id IS NULL`).all() as Array<{ id: string; name: string }>;

// ── 1. Targets survive every place step ids are regenerated ─────────────────────

test('the seeded templates hold routing rules to check (the set is not empty)', () => {
  const withRules = templates().filter((t) => refsByName(t.id).refs.some((r) => r.kind === 'routing'));
  assert.ok(withRules.length >= 4, `only ${withRules.length} templates carry routing rules`);
});

test('launching a template (/v2/:id/start) keeps every routing target — every seeded template', async () => {
  const wrong: string[] = [];
  for (const t of templates()) {
    const before = refsByName(t.id);
    if (before.refs.length === 0) continue;
    const res = await app.post(`/api/workflows/v2/${t.id}/start`, { agentId: app.agent });
    assert.equal(res.status, 200, `${t.name}: ${JSON.stringify(res.json)}`);
    const after = refsByName(res.json.workflow.id);
    db.prepare(`UPDATE workflows SET status = 'cancelled' WHERE id = ?`).run(res.json.workflow.id);
    if (after.dangling.length) wrong.push(`${t.name}: dangling ${after.dangling.join(', ')}`);
    else if (JSON.stringify(after.refs) !== JSON.stringify(before.refs)) wrong.push(`${t.name}: ${JSON.stringify(after.refs)} ≠ ${JSON.stringify(before.refs)}`);
  }
  assert.deepEqual(wrong, []);
});

test('a scheduled launch (cloneTemplateAsRun) keeps every routing target — every seeded template', () => {
  const wrong: string[] = [];
  for (const t of templates()) {
    const before = refsByName(t.id);
    if (before.refs.length === 0) continue;
    const runId = cloneTemplateAsRun(t.id, null, '', { agentId: app.agent })!;
    db.prepare(`UPDATE workflows SET status = 'cancelled' WHERE id = ?`).run(runId);
    const after = refsByName(runId);
    if (after.dangling.length || JSON.stringify(after.refs) !== JSON.stringify(before.refs)) {
      wrong.push(`${t.name}: ${after.dangling.join(', ') || JSON.stringify(after.refs)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

/** A workflow as the canvas editor sends it: client-side ids, references by those ids. */
function editorPayload(name: string) {
  return {
    name, description: 'routing test',
    skipStandardGate: true, skipReportStep: true,
    steps: [
      { id: 'c-a', name: 'A', executorType: 'claude-code', executorConfig: { prompt: 'Do A.', includeDepOutput: true } },
      { id: 'c-b', name: 'B', executorType: 'claude-code', dependsOn: ['c-a'],
        executorConfig: { prompt: 'Do B.', includeDepOutput: true, maxCycles: 1,
          routingRules: [{ id: 'r1', condition: 'contains', value: 'RETRY-A', nextStepId: 'c-a' }] } },
      { id: 'c-d', name: 'Choose', executorType: 'decision', dependsOn: ['c-b'],
        executorConfig: { question: 'Ship?', options: [{ id: 'yes', label: 'Yes', nextStepId: 'c-c' }, { id: 'no', label: 'No', nextStepId: 'c-a' }] } },
      { id: 'c-c', name: 'C', executorType: 'claude-code', dependsOn: ['c-d'], executorConfig: { prompt: 'Do C.', includeDepOutput: true } },
    ],
  };
}
const EXPECTED_REFS: Ref[] = [
  { from: 'B', to: 'A', kind: 'routing' },
  { from: 'Choose', to: 'C', kind: 'decision' },
  { from: 'Choose', to: 'A', kind: 'decision' },
];

test('saving from the editor — create, then save again — keeps routing and decision targets', async () => {
  const created = await app.post('/api/workflows/v2/create', editorPayload('editor-save'));
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.workflow.id as string;
  assert.deepEqual(refsByName(id), { refs: EXPECTED_REFS, dangling: [] }, 'create');

  // The editor re-saves what it loaded: the SERVER's ids as its client ids. PUT regenerates them.
  const loaded = stepsOf(id).map((s) => ({
    id: s.id, name: s.name, executorType: s.executor_type,
    executorConfig: JSON.parse(s.executor_config), dependsOn: JSON.parse(s.depends_on), autoAdvance: !!s.auto_advance,
  }));
  const saved = await app.put(`/api/workflows/v2/${id}`, { name: 'editor-save', description: 'again', steps: loaded });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.ok(!stepsOf(id).some((s) => loaded.some((l) => l.id === s.id)), 'precondition: PUT gave the steps new ids');
  assert.deepEqual(refsByName(id), { refs: EXPECTED_REFS, dangling: [] }, 'save');
});

// ── 2. A rule that fires on a work step is a real loop ─────────────────────────

async function launchEditorWorkflow(name: string): Promise<string> {
  // A cartridge runs one step at a time (workflow-executor-v2 cartridgeHold): a run left mid-flight
  // by an earlier test on this same fake cartridge would hold this one. End them first.
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  const created = await app.post('/api/workflows/v2/create', editorPayload(name));
  const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  return start.json.workflow.id as string;
}

async function complete(runId: string, name: string, result: string) {
  const s = stepNamed(runId, name);
  assert.equal(s.status, 'running', `"${name}" is ${s.status}, not running`);
  const res = await app.post(`/api/workflows/webhook/${s.id}/complete`, verified(result));
  assert.equal(res.status, 200, JSON.stringify(res.json));
}

const tick = async () => { tickWorkflowsOnce(); await new Promise((r) => setImmediate(r)); };
// The launch route adds a Work Standard Check to gate-less workflows; these tests are about the
// steps they authored, so that one is left out of the comparison.
const status = (runId: string) => Object.fromEntries(stepsOf(runId).filter((s) => s.name !== 'Work Standard Check').map((s) => [s.name, s.status]));

test('a work-step rule re-runs the path back to its target with feedback, and downstream waits', async () => {
  const runId = await launchEditorWorkflow('cycle');
  await tick();
  await complete(runId, 'A', 'A v1 done');
  await tick();
  await complete(runId, 'B', 'B found a problem: RETRY-A because the schema is wrong');
  await tick();

  assert.deepEqual(status(runId), { A: 'running', B: 'pending', Choose: 'pending', C: 'pending' },
    'the rule must send the run back to A, hold B for re-evaluation and start nothing downstream');
  const promptA = stepNamed(runId, 'A').dispatched_prompt;
  assert.match(promptA, /RETRY-A because the schema is wrong/, 'A was re-run without being told why');

  await complete(runId, 'A', 'A v2 done');
  await tick();
  assert.equal(stepNamed(runId, 'B').status, 'running', 'B was not re-evaluated after A re-ran');
  // The budget (maxCycles: 1) is spent: the same trigger now lets the run move on.
  await complete(runId, 'B', 'still RETRY-A');
  await tick();
  assert.equal(stepNamed(runId, 'Choose').status, 'running', 'an exhausted rule must let the run proceed');
  assert.equal(stepNamed(runId, 'A').status, 'completed');
});

test('a rule that does not match lets the run proceed untouched', async () => {
  const runId = await launchEditorWorkflow('no-match');
  await tick();
  await complete(runId, 'A', 'A done');
  await tick();
  await complete(runId, 'B', 'B done, all good');
  await tick();
  assert.deepEqual(status(runId), { A: 'completed', B: 'completed', Choose: 'running', C: 'pending' });
});

// ── 3. Gates: a rule chooses where a FAIL goes back to; a PASS never loops ──────

async function launchGateWorkflow(name: string, gateType: 'quality-gate' | 'review-gate'): Promise<string> {
  // A cartridge runs one step at a time (workflow-executor-v2 cartridgeHold): a run left mid-flight
  // by an earlier test on this same fake cartridge would hold this one. End them first.
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  const created = await app.post('/api/workflows/v2/create', {
    name, skipStandardGate: true, skipReportStep: true,
    steps: [
      { id: 'g-a', name: 'Design', executorConfig: { prompt: 'Design it.', includeDepOutput: true } },
      { id: 'g-b', name: 'Build', dependsOn: ['g-a'], executorConfig: { prompt: 'Build it.', includeDepOutput: true } },
      { id: 'g-g', name: 'Tests', dependsOn: ['g-b'], executorType: gateType,
        executorConfig: { gateType: 'test', criteria: 'the tests pass', includeDepOutput: true, maxCycles: 2,
          routingRules: [{ id: 'r', condition: 'contains', value: 'DESIGN-FLAW', nextStepId: 'g-a' }] } },
      { id: 'g-n', name: 'After', dependsOn: ['g-g'], executorConfig: { prompt: 'Wrap up.', includeDepOutput: true } },
    ],
  });
  const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent });
  return start.json.workflow.id as string;
}

async function judge(runId: string, verdict: string) {
  const s = stepNamed(runId, 'Tests');
  assert.equal(s.status, 'running');
  const res = await app.post(`/api/workflows/webhook/${s.id}/complete`, { result: verdict });
  assert.equal(res.status, 200, JSON.stringify(res.json));
}

for (const gateType of ['quality-gate', 'review-gate'] as const) {
test(`${gateType}: a FAIL matching a rule retries from the rule's target, not just the step before it`, async () => {
  const runId = await launchGateWorkflow(`gate-route-${gateType}`, gateType);
  await tick(); await complete(runId, 'Design', 'design v1');
  await tick(); await complete(runId, 'Build', 'build v1');
  await tick(); await judge(runId, 'FAIL\nDESIGN-FLAW: the data model cannot express refunds');
  await tick();
  assert.deepEqual(status(runId), { Design: 'running', Build: 'pending', Tests: 'pending', After: 'pending' });
  assert.match(stepNamed(runId, 'Design').dispatched_prompt, /cannot express refunds/, 'the target got no feedback');
});

test(`${gateType}: a FAIL that matches no rule retries the step it judged, as before`, async () => {
  const runId = await launchGateWorkflow(`gate-plain-fail-${gateType}`, gateType);
  await tick(); await complete(runId, 'Design', 'design v1');
  await tick(); await complete(runId, 'Build', 'build v1');
  await tick(); await judge(runId, 'FAIL\n3 tests red');
  await tick();
  assert.deepEqual(status(runId), { Design: 'completed', Build: 'running', Tests: 'pending', After: 'pending' });
});

test(`${gateType}: a PASS never loops back, even when its text contains the rule's trigger`, async () => {
  const runId = await launchGateWorkflow(`gate-pass-${gateType}`, gateType);
  await tick(); await complete(runId, 'Design', 'design v1');
  await tick(); await complete(runId, 'Build', 'build v1');
  await tick(); await judge(runId, 'PASS\nan earlier run reported DESIGN-FLAW; it is fixed now');
  await tick();
  assert.deepEqual(status(runId), { Design: 'completed', Build: 'completed', Tests: 'completed', After: 'running' });
});
}

// ── 4. A rule that cannot fire says so ───────────────────────────────────────

test('a rule whose target is not in the run is reported in the run log, not silently skipped', async () => {
  const runId = await launchEditorWorkflow('dangling');
  const b = stepNamed(runId, 'B');
  const cfg = JSON.parse(b.executor_config);
  cfg.routingRules[0].nextStepId = 'no-such-step';
  db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?').run(JSON.stringify(cfg), b.id);
  await tick(); await complete(runId, 'A', 'A done');
  await tick(); await complete(runId, 'B', 'RETRY-A please');
  await tick();
  const log = db.prepare(`SELECT message FROM workflow_journal WHERE workflow_id = ? AND step_id = ?`).all(runId, b.id) as { message: string }[];
  assert.ok(log.some((l) => /routing rule .*not a step in this run/i.test(l.message)), log.map((l) => l.message).join('\n'));
  assert.equal(stepNamed(runId, 'Choose').status, 'running', 'a dead rule must not hold up the run');
});
