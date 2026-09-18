// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { STANDARD_TEMPLATE_NAMES } from '../src/db.ts';
import { completeStepFromSignal, isPassingGateVerdict } from '../src/lib/workflow-executor-v2.ts';
import { REPORT_STEP_NAME } from '../src/lib/workflow-report.ts';
import { installStubIO } from './helpers/stub-io.ts';

installStubIO();

const TEMPLATE = 'CE Develop and Optimize';

type Step = {
  id: string;
  workflowId: string;
  name: string;
  executorType: string;
  autoAdvance: number;
  dependsOn: string;
  config: Record<string, unknown>;
};

function steps(): Step[] {
  return (db.prepare(`
    SELECT s.id, s.workflow_id AS workflowId, s.name, s.executor_type AS executorType,
           s.auto_advance AS autoAdvance, s.depends_on AS dependsOn,
           s.executor_config AS config
    FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
    WHERE w.name = ? AND w.template_id IS NULL
    ORDER BY s.position_y
  `).all(TEMPLATE) as Array<Omit<Step, 'config'> & { config: string }>).map((s) => ({
    ...s,
    config: JSON.parse(s.config) as Record<string, unknown>,
  }));
}

test('CE Develop and Optimize is a seeded standard template with the complete pipeline', () => {
  assert.ok((STANDARD_TEMPLATE_NAMES as readonly string[]).includes(TEMPLATE));
  // The completion report is appended to EVERY template after seeding (lib/workflow-report.ts);
  // it is asserted as a set over all templates in workflow-report-step.test.ts, so here it is
  // only the tail of this template's own pipeline.
  assert.deepEqual(steps().map((s) => s.name), [
    'Load Work and Goals',
    'Develop and Optimize Every Task',
    'Verify Coverage and Evidence',
    'Goal Achievement Gate',
    'Notify',
    REPORT_STEP_NAME,
  ]);
});

test('the task worker is a data-counted loop and the producer emits its contract', () => {
  const all = steps();
  const load = all[0];
  const work = all[1];
  const cfg = work.config;
  const from = cfg.loopCountFrom as { step?: string; pattern?: string };

  assert.equal(from.step, load.name);
  assert.equal(cfg.loopUntil, 'ALL TASKS COMPLETE');
  assert.ok(JSON.parse(work.dependsOn).includes(load.id));

  const producer = String(load.config.prompt);
  for (const field of ['WORK:', 'STATE:', 'RUNLOG:', 'TESTS:', 'TASKS:', 'METRIC:', 'OVERALL_TARGET:', 'MEASURE:']) {
    assert.match(producer, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing ${field}`);
  }
  assert.match(producer.replace(/\[[^\]]*\]/g, '7'), new RegExp(from.pattern!));
});

test('each task develops a vertical slice before measured optimization and stops on trouble', () => {
  const prompt = String(steps()[1].config.prompt);
  const required = [
    /exactly one task/i,
    /failing test/i,
    /runnable.*vertical slice/i,
    /baseline/i,
    /hypoth/i,
    /isolated.*worktree/i,
    /integrate.*winning.*ROOT/i,
    /rerun TESTS and MEASURE in ROOT/i,
    /TASK_TARGET/i,
    /OVERALL_TARGET/i,
    /keep.*revert/i,
    /correctness gate/i,
    /running document/i,
    /AskUserQuestion/i,
    /do not report.*complete/i,
    /remaining/i,
    /commit/i,
  ];
  const missing = required.filter((p) => !p.test(prompt)).map(String);
  assert.deepEqual(missing, [], `missing task-loop guarantees:\n${missing.join('\n')}`);
});

test('the running document is authoritative and the final gate cannot optimize the evidence', () => {
  const all = steps();
  const verify = all.find((s) => s.name === 'Verify Coverage and Evidence')!;
  const gate = all.find((s) => s.name === 'Goal Achievement Gate')!;
  const verifyPrompt = String(verify.config.prompt);
  const gatePrompt = String(gate.config.customPrompt);

  assert.match(verifyPrompt, /every task/i);
  assert.match(verifyPrompt, /running document/i);
  assert.match(verifyPrompt, /baseline/i);
  assert.match(verifyPrompt, /final/i);
  assert.match(verifyPrompt, /correctness/i);
  assert.deepEqual(new Set(JSON.parse(verify.dependsOn)), new Set([all[0].id, all[1].id]));
  assert.equal(gate.executorType, 'quality-gate');
  assert.equal(gate.config.maxRetries, 0);
  assert.equal(gate.config.terminalOnFail, true);
  assert.match(gatePrompt, /FIRST LINE.*PASS.*FAIL/is);
  assert.match(gatePrompt, /do not.*implement|must not.*implement/is);
  assert.match(gatePrompt, /target/i);
  assert.match(gatePrompt, /unresolved|blocked|bug/i);
});

test('zero-retry goal failure is terminal instead of regenerating unchanged evidence', () => {
  const all = steps();
  const gate = all.find((s) => s.name === 'Goal Achievement Gate')!;
  const notify = all.find((s) => s.name === 'Notify')!;
  db.prepare("UPDATE workflow_steps SET status = 'running' WHERE id = ?").run(gate.id);

  assert.equal(completeStepFromSignal(gate.id, 'FAIL — the result did not PASS the target.'), true);
  const after = db.prepare('SELECT status, error FROM workflow_steps WHERE id = ?')
    .get(gate.id) as { status: string; error: string };
  assert.equal(after.status, 'failed');
  assert.match(after.error, /after 0 retries/);
  assert.equal((db.prepare('SELECT status FROM workflow_steps WHERE id = ?').get(notify.id) as { status: string }).status, 'skipped');
  assert.equal((db.prepare('SELECT status FROM workflows WHERE id = ?').get(gate.workflowId) as { status: string }).status, 'failed');
});

test('gate verdict parsing accepts only an exact PASS first line', () => {
  assert.equal(isPassingGateVerdict('PASS\nAll evidence is complete.'), true);
  assert.equal(isPassingGateVerdict(' pass \r\nAll evidence is complete.'), true);
  assert.equal(isPassingGateVerdict('FAIL — correctness did not PASS'), false);
  assert.equal(isPassingGateVerdict('FAIL: target NOT PASSED'), false);
  assert.equal(isPassingGateVerdict('PASS: with caveats'), false);
  assert.equal(isPassingGateVerdict(''), false);
});
