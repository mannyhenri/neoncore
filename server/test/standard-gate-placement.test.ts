// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { withStandardGate, withStandardGateOnTemplateRows } from '../src/lib/standard-gate.ts';
import { reportStepConfig, isReportStep } from '../src/lib/workflow-report.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { NO_STANDARD_GATE_TEMPLATES, STANDARD_TEMPLATE_NAMES } from '../src/lib/templates/index.ts';
import { startWorkflowApp, stepsOf, type WorkflowApp } from './helpers/workflow-app.ts';

/**
 * THE WORK STANDARD CHECK AUDITS THE WORK — BEFORE "DONE", ON EVERY LAUNCH PATH, AND ONLY WHERE
 * THERE IS WORK TO AUDIT.
 *
 * Three things were wrong with the check a launch adds to a gate-less workflow:
 *  1. it depended on the LAST steps, and most templates end in connectors (Capture Learnings →
 *     Save to Project → Notify) — so it ran after "Done" was announced, and its only input was
 *     Notify's one line;
 *  2. it was added to workflows that change no code (digests, research, strategy, QA runs), and to
 *     a workflow created with `skipStandardGate` — the launch added it back every run;
 *  3. scheduled runs (cloneTemplateAsRun) got no check at all.
 * Checked as sets: every seeded template, every launch path.
 */

let app: WorkflowApp;
before(async () => { app = await startWorkflowApp('gate-agent'); });
after(() => app.close());

const row = (id: string, type: string, deps: string[] = [], config: Record<string, unknown> = {}) => ({
  id, executor_type: type, executor_id: 'agent-1', executor_config: JSON.stringify(config), depends_on: JSON.stringify(deps),
});
const deps = (r: Record<string, unknown>) => JSON.parse(String(r.depends_on)) as string[];
const gateRow = (rows: Record<string, unknown>[]) => rows.find((r) => String(r.executor_config).includes('"gateType":"standard"'))!;

// ── 1. Placement ───────────────────────────────────────────────────────────────

test('the check runs after the work and BEFORE the trailing connector chain; the report stays last', () => {
  const rows = [
    row('plan', 'claude-code'),
    row('build', 'claude-code', ['plan']),
    row('learn', 'connector', ['build']),
    row('save', 'connector', ['learn']),
    row('notify', 'connector', ['save']),
    row('report', 'claude-code', ['notify'], reportStepConfig()),
  ];
  const out = withStandardGateOnTemplateRows(rows);
  const gate = gateRow(out);
  const by = new Map(out.map((r) => [String(r.id), r]));
  assert.deepEqual(deps(gate), ['build'], 'the check must audit the work itself');
  assert.deepEqual(deps(by.get('learn')!), [gate.id], 'the connector chain must wait for the check');
  assert.deepEqual(deps(by.get('save')!), ['learn'], 'the chain itself is untouched');
  assert.deepEqual(deps(by.get('notify')!), ['save']);
  assert.deepEqual(deps(by.get('report')!), ['notify'], 'the report must still come last');
  assert.ok(isReportStep(JSON.parse(String(out[out.length - 1].executor_config))));
});

test('a connector in the MIDDLE of the work is work, not a trailing connector', () => {
  const out = withStandardGateOnTemplateRows([
    row('fetch', 'claude-code'),
    row('post', 'connector', ['fetch']),
    row('use', 'claude-code', ['post']),
  ]);
  const by = new Map(out.map((r) => [String(r.id), r]));
  assert.deepEqual(deps(gateRow(out)), ['use']);
  assert.deepEqual(deps(by.get('post')!), ['fetch'], 'a mid-run connector was moved');
});

test('parallel branches: the check waits for every branch of the work; each trailing connector waits for the check', () => {
  const out = withStandardGateOnTemplateRows([
    row('a', 'claude-code'),
    row('b', 'claude-code', ['a']),
    row('c', 'claude-code', ['a']),
    row('nb', 'connector', ['b']),
    row('nc', 'connector', ['c']),
  ]);
  const gate = gateRow(out);
  const by = new Map(out.map((r) => [String(r.id), r]));
  assert.deepEqual(deps(gate).sort(), ['b', 'c']);
  assert.deepEqual(deps(by.get('nb')!), [gate.id]);
  assert.deepEqual(deps(by.get('nc')!), [gate.id]);
});

test('the create path (canvas → /v2/create) places it the same way, and the report it appends comes after the connectors', async () => {
  const out = withStandardGate([
    { id: 'w', executorType: 'claude-code', dependsOn: [] },
    { id: 'n', executorType: 'connector', dependsOn: ['w'] },
  ]);
  const gate = out.find((s) => (s.executorConfig as Record<string, unknown> | undefined)?.gateType === 'standard')!;
  assert.deepEqual(gate.dependsOn, ['w']);
  assert.deepEqual(out.find((s) => s.id === 'n')!.dependsOn, [gate.id]);

  const created = await app.post('/api/workflows/v2/create', {
    name: 'placed', steps: [
      { id: 'w', name: 'Work', executorConfig: { prompt: 'do it' } },
      { id: 'n', name: 'Notify', executorType: 'connector', dependsOn: ['w'], executorConfig: { connectorType: 'system-notify', title: 'Done' } },
    ],
  });
  assert.equal(created.status, 201);
  const steps = stepsOf(created.json.workflow.id);
  const name = new Map(steps.map((s) => [s.id, s.name]));
  const depNames = (n: string) => JSON.parse(steps.find((s) => s.name === n)!.depends_on).map((d: string) => name.get(d));
  assert.deepEqual(depNames('Work Standard Check'), ['Work']);
  assert.deepEqual(depNames('Notify'), ['Work Standard Check']);
  assert.deepEqual(depNames('Workflow Completion Report'), ['Notify']);
});

test('every seeded template that gets the check: it audits work steps, never a connector, and precedes every trailing connector', async () => {
  const wrong: string[] = [];
  let gated = 0;
  for (const name of STANDARD_TEMPLATE_NAMES) {
    const tpl = db.prepare('SELECT id, standard_gate FROM workflows WHERE name = ? AND template_id IS NULL').get(name) as { id: string; standard_gate: string };
    const rows = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(tpl.id) as Record<string, unknown>[];
    const out = withStandardGateOnTemplateRows(rows, { skip: tpl.standard_gate === 'off' });
    const gate = out.find((r) => String(r.executor_config).includes('"gateType":"standard"'));
    if (!gate) continue;
    gated++;
    const by = new Map(out.map((r) => [String(r.id), r]));
    for (const d of deps(gate)) if (by.get(d)?.executor_type === 'connector') wrong.push(`${name}: the check audits a connector`);
    // Nothing downstream of the check is a work step (the report excepted): it really is after the work.
    const downstream = new Set<string>([String(gate.id)]);
    for (let grew = true; grew;) {
      grew = false;
      for (const r of out) if (!downstream.has(String(r.id)) && deps(r).some((d) => downstream.has(d))) { downstream.add(String(r.id)); grew = true; }
    }
    for (const id of downstream) {
      const r = by.get(id)!;
      if (id === gate.id || isReportStep(JSON.parse(String(r.executor_config)))) continue;
      if (r.executor_type !== 'connector') wrong.push(`${name}: work step after the check`);
    }
    // …and no connector that ends the run comes before it.
    for (const r of out) {
      if (r.executor_type === 'connector' && !downstream.has(String(r.id)) && !out.some((x) => deps(x).includes(String(r.id)))) {
        wrong.push(`${name}: trailing connector ${String(r.id).slice(0, 8)} runs before the check`);
      }
    }
  }
  assert.ok(gated >= 8, `only ${gated} templates got the check — the set is too small to mean anything`);
  assert.deepEqual(wrong, []);
});

// ── 2. Only where there is work to audit ───────────────────────────────────────

test('content templates are launched without the check; every template that changes code keeps it', async () => {
  for (const name of NO_STANDARD_GATE_TEMPLATES) {
    assert.ok((STANDARD_TEMPLATE_NAMES as readonly string[]).includes(name), `"${name}" is not a seeded template`);
    const tpl = db.prepare('SELECT id FROM workflows WHERE name = ? AND template_id IS NULL').get(name) as { id: string };
    const res = await app.post(`/api/workflows/v2/${tpl.id}/start`, { agentId: app.agent, initialContext: 'x' });
    assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.json)}`);
    db.prepare("UPDATE workflows SET status = 'cancelled' WHERE id = ?").run(res.json.workflow.id);
    assert.ok(!stepsOf(res.json.workflow.id).some((s) => s.name === 'Work Standard Check'), `${name} was launched with the check`);
  }
  for (const name of ['Epic: Task by Task', 'CE: Phase 4 — Review', 'CE: Phase 5 — QA', 'Confer']) {
    const tpl = db.prepare('SELECT standard_gate FROM workflows WHERE name = ? AND template_id IS NULL').get(name) as { standard_gate: string };
    assert.equal(tpl.standard_gate, 'auto', `${name} lost its check`);
  }
});

test('a workflow created with skipStandardGate is launched without it — the opt-out is kept, not re-added at launch', async () => {
  const created = await app.post('/api/workflows/v2/create', {
    name: 'no gate please', skipStandardGate: true, steps: [{ id: 'w', name: 'Work', executorConfig: { prompt: 'do it' } }],
  });
  assert.equal(created.status, 201);
  const res = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE id = ?").run(res.json.workflow.id);
  assert.ok(!stepsOf(res.json.workflow.id).some((s) => s.name === 'Work Standard Check'), 'the launch re-added the check');

  // Saving from an editor that says nothing about it keeps the opt-out; saying so changes it.
  const id = created.json.workflow.id as string;
  await app.put(`/api/workflows/v2/${id}`, { name: 'no gate please', steps: [{ id: 'w', name: 'Work', executorConfig: { prompt: 'do it' } }] });
  assert.equal((db.prepare('SELECT standard_gate FROM workflows WHERE id = ?').get(id) as { standard_gate: string }).standard_gate, 'off');
  await app.put(`/api/workflows/v2/${id}`, { name: 'no gate please', skipStandardGate: false, steps: [{ id: 'w', name: 'Work', executorConfig: { prompt: 'do it' } }] });
  assert.equal((db.prepare('SELECT standard_gate FROM workflows WHERE id = ?').get(id) as { standard_gate: string }).standard_gate, 'auto');
});

// ── 3. Every launch path ───────────────────────────────────────────────────────

test('a scheduled run gets exactly the steps a run from the Run button gets — the check included, in the same place', async () => {
  const differs: string[] = [];
  for (const name of STANDARD_TEMPLATE_NAMES) {
    const tpl = db.prepare('SELECT id FROM workflows WHERE name = ? AND template_id IS NULL').get(name) as { id: string };
    const hasConfer = stepsOf(tpl.id).some((s) => s.executor_type === 'confer');
    if (hasConfer) continue; // a confer launch converts steps; the schedule path does not (by design)
    const manual = await app.post(`/api/workflows/v2/${tpl.id}/start`, { agentId: app.agent, initialContext: 'x' });
    assert.equal(manual.status, 200, `${name}: ${JSON.stringify(manual.json)}`);
    db.prepare("UPDATE workflows SET status = 'cancelled' WHERE id = ?").run(manual.json.workflow.id);
    const scheduled = cloneTemplateAsRun(tpl.id, null, 'x', { agentId: app.agent })!;
    db.prepare("UPDATE workflows SET status = 'cancelled' WHERE id = ?").run(scheduled);
    const shape = (runId: string) => {
      const steps = stepsOf(runId);
      const n = new Map(steps.map((s) => [s.id, s.name]));
      return steps.map((s) => `${s.name} <- ${JSON.parse(s.depends_on).map((d: string) => n.get(d)).sort().join(',')}`).sort();
    };
    if (JSON.stringify(shape(manual.json.workflow.id)) !== JSON.stringify(shape(scheduled))) differs.push(name);
  }
  assert.deepEqual(differs, []);
});
