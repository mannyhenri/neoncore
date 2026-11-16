// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { isPassingGateVerdict } from '../src/lib/workflow-executor-v2.ts';
import { startWorkflowApp, type WorkflowApp } from './helpers/workflow-app.ts';

/**
 * A GATE THAT SAYS "STATUS: PASS" PASSED.
 *
 * WORKFLOWS.md tells agents to "signal gate status with a prefix in their webhook result:
 * `STATUS: PASS …` / `STATUS: FAIL …`", while the executor accepted ONLY a first line that was
 * exactly `PASS`. An agent that followed the documentation failed every gate it judged — and
 * since every run has at least one gate (the Work Standard Check is added to gate-less templates
 * at launch), it failed every workflow in the catalogue.
 *
 * The fix is deliberately narrow. A LABEL around the verdict is fine — `STATUS:`, `Verdict:`,
 * `Result:`, markdown emphasis, a full stop. A QUALIFIED pass is not: "PASS: with caveats" is
 * the exact thing the zero-retry evidence gate must not wave through
 * (test/ce-develop-optimize-template.test.ts), so anything after the verdict on its line still
 * makes it a FAIL. Explanations go on the following lines, as every gate prompt says.
 *
 * SET-BASED: every label × every decoration, rather than the one spelling that was reported.
 */

const LABELS = ['', 'STATUS: ', 'Status: ', 'status:', 'VERDICT: ', 'Verdict - ', 'RESULT: ', 'Gate verdict: '];
const DECORATIONS: Array<(v: string) => string> = [
  (v) => v, (v) => v.toLowerCase(), (v) => `**${v}**`, (v) => `\`${v}\``, (v) => `${v}.`, (v) => `**${v}.**`, (v) => `  ${v}  `,
];

test('every labelled / decorated form of a bare PASS is a pass', () => {
  const misses: string[] = [];
  for (const label of LABELS) {
    for (const deco of DECORATIONS) {
      for (const shape of [(l: string, v: string) => `${l}${v}`, (l: string, v: string) => (l ? `**${l.trim()}** ${v}` : v)]) {
        const line = shape(label, deco('PASS'));
        if (!isPassingGateVerdict(`${line}\nall 128 tests passed`)) misses.push(JSON.stringify(line));
      }
    }
  }
  assert.deepEqual(misses, [], `rejected as FAIL: ${misses.join(', ')}`);
});

test('a qualified, failing or ambiguous first line is never a pass — whatever its label', () => {
  const body = [
    'PASS: with caveats', 'PASS — but two tests are skipped', 'PASS with caveats', 'PASSED', 'PASS/FAIL',
    'PASS or FAIL', 'FAIL', 'FAIL — correctness did not PASS', 'FAIL: target NOT PASSED', 'NOT PASS', 'no PASS yet',
    'PASSING', 'PASS (partially)', '',
  ];
  const wrong: string[] = [];
  for (const label of LABELS) {
    for (const b of body) {
      const line = `${label}${b}`;
      if (isPassingGateVerdict(`${line}\ndetails`)) wrong.push(JSON.stringify(line));
    }
  }
  assert.deepEqual(wrong, [], `accepted as PASS: ${wrong.join(', ')}`);
  assert.equal(isPassingGateVerdict('\n\nnotes\nPASS'), false, 'the verdict is the FIRST non-empty line only');
});

// ── Through the webhook, as an agent reports it ────────────────────────────────

let app: WorkflowApp;
before(async () => { app = await startWorkflowApp(); });
after(() => app.close());

let n = 0;
function runningGate(type: 'quality-gate' | 'review-gate'): { gateId: string; workflowId: string } {
  const wf = `gv-wf-${++n}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, status, template_id, created_at) VALUES (?, 'gate run', 'running', 'tpl', ?)`).run(wf, now);
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, depends_on, position_x, position_y, created_at, result, completed_at)
              VALUES (?, ?, 'Work', 'completed', 'claude-code', ?, '{}', '[]', 0, 0, ?, 'did it', ?)`).run(`${wf}-work`, wf, app.agent, now, now);
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, depends_on, position_x, position_y, created_at, started_at)
              VALUES (?, ?, 'Gate', 'running', ?, ?, ?, ?, 0, 1, ?, ?)`).run(`${wf}-gate`, wf, type, app.agent, JSON.stringify({ gateType: 'test' }), JSON.stringify([`${wf}-work`]), now, now);
  return { gateId: `${wf}-gate`, workflowId: wf };
}

const statusOf = (id: string) => (db.prepare('SELECT status, result FROM workflow_steps WHERE id = ?').get(id) as { status: string; result: string });

for (const type of ['quality-gate', 'review-gate'] as const) {
  for (const withNext of [false, true]) {
    test(`${type}: "STATUS: PASS" reported through the webhook passes${withNext ? ' — with a `next` hand-off' : ''}`, async () => {
      const { gateId } = runningGate(type);
      const res = await app.post(`/api/workflows/webhook/${gateId}/complete`, {
        result: 'STATUS: PASS\n128 tests, 0 failures',
        ...(withNext ? { next: 'Ship it.' } : {}),
      });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const after = statusOf(gateId);
      assert.equal(after.status, 'completed', `the gate did not pass: ${after.status}`);
      // The verdict must stay on line 1 of what is STORED — a hand-off placed above it would make
      // the next reader of this result see "NEXT: …" where the verdict belongs.
      assert.match(after.result.split('\n')[0], /^STATUS: PASS$/);
    });

    test(`${type}: "STATUS: FAIL" stays a FAIL${withNext ? ' — with a `next` hand-off' : ''}`, async () => {
      const { gateId } = runningGate(type);
      const res = await app.post(`/api/workflows/webhook/${gateId}/complete`, {
        result: 'STATUS: FAIL\n3 tests red', ...(withNext ? { next: 'Fix the tests.' } : {}),
      });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.notEqual(statusOf(gateId).status, 'completed');
    });
  }
}
