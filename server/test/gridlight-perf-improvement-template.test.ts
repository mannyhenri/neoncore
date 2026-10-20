/**
 * GRIDLIGHT PERFORMANCE IMPROVEMENT — the whole contract, as sets, driven through the real engine.
 *
 * The flow a person asked for: Jira task → a numeric target written BEFORE coding → develop →
 * the local QA script on the 7B model → targets met? report + Done : gap + suggestions → a human
 * approves the next round → develop again. Every piece of that is asserted here, and the loop is
 * exercised through completeStepFromSignal rather than read off the config, because a loop that
 * is wired on paper but resets the wrong steps is the failure this file exists to catch.
 *
 * WHY THE LOOP IS A QUALITY GATE, NOT A ROUTING RULE: applyRoutingRules resets ONE target step
 * and leaves everything downstream of it `completed`, so "back to Develop" would re-run Develop
 * and never re-run the QA script. The quality gate's FAIL path resets the gate AND every direct
 * dependency, so the gate depends on the whole loop body — decision, develop, QA, compare.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import db, { STANDARD_TEMPLATE_NAMES } from '../src/db.ts';
import { completeStepFromSignal } from '../src/lib/workflow-executor-v2.ts';
import { REPORT_STEP_NAME, isReportStep } from '../src/lib/workflow-report.ts';
import {
  parseWorkflowLaunchConfig, defaultLaunchOptionValues, renderLaunchCommand,
} from '../../dashboard/src/lib/workflowLaunchOptions.ts';
import { installStubIO } from './helpers/stub-io.ts';

installStubIO();

const TEMPLATE = 'Gridlight Performance Improvement';
const QA_7B_COMMAND = 'scripts/qa/guided-local-run.sh --non-interactive --model-profile qwen2.5-7b-q4 '
  + '--engines gridlight --metrics yes --manager no --build yes --media-agents none --backend metal';

const STEP_ORDER = [
  ['Load Jira Task', 'claude-code'],
  ['Write Performance Target', 'claude-code'],
  ['Approve Development Round', 'decision'],
  ['Develop Improvement', 'claude-code'],
  ['Run Local QA (7B)', 'claude-code'],
  ['Compare Against Target', 'claude-code'],
  ['Targets Met?', 'quality-gate'],
  ['Write Performance Report', 'claude-code'],
  ['Mark Jira Task Done', 'claude-code'],
  [REPORT_STEP_NAME, 'claude-code'],
] as const;

type Step = {
  id: string; workflowId: string; name: string; executorType: string;
  status: string; dependsOn: string[]; config: Record<string, unknown>;
};

function steps(): Step[] {
  return (db.prepare(`
    SELECT s.id, s.workflow_id AS workflowId, s.name, s.executor_type AS executorType, s.status,
           s.depends_on AS dependsOn, s.executor_config AS config
      FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
     WHERE w.name = ? AND w.template_id IS NULL
     ORDER BY s.position_y
  `).all(TEMPLATE) as Array<Record<string, string>>).map((s) => ({
    ...(s as unknown as Step),
    dependsOn: JSON.parse(s.dependsOn || '[]') as string[],
    config: JSON.parse(s.config || '{}') as Record<string, unknown>,
  }));
}
const byName = (name: string) => {
  const s = steps().find((x) => x.name === name);
  assert.ok(s, `missing step "${name}"`);
  return s;
};
const text = (s: Step) => String(s.config.prompt ?? s.config.customPrompt ?? '');

test('it is registered, seeded and categorised, with every step in order', () => {
  assert.ok((STANDARD_TEMPLATE_NAMES as readonly string[]).includes(TEMPLATE), 'not in STANDARD_TEMPLATE_NAMES');
  const all = steps();
  assert.deepEqual(all.map((s) => [s.name, s.executorType]), STEP_ORDER.map(([n, t]) => [n, t]));

  // Order is the dependency order, not just the canvas order: each step waits on its predecessor.
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].dependsOn.includes(all[i - 1].id),
      `"${all[i].name}" does not wait for "${all[i - 1].name}"`);
  }

  const panel = readFileSync(fileURLToPath(
    new URL('../../dashboard/src/components/WorkflowPanel.tsx', import.meta.url)), 'utf8');
  assert.match(panel, /'Gridlight Performance Improvement':\s*'quality'/);
  // The Jira key arrives only through the launch context, so launching without it is refused.
  assert.match(panel, /REQUIRES_CONTEXT[^;]*'Gridlight Performance Improvement'/s);
  console.log(`[set] ${all.length}/${STEP_ORDER.length} steps in order`);
});

test('the target is numeric, written to the Gridlight repo BEFORE any development', () => {
  const load = byName('Load Jira Task');
  const target = byName('Write Performance Target');
  assert.deepEqual(load.dependsOn, [], 'the Jira step must be first so it receives the launch context');
  for (const re of [/Jira/, /comments/i, /TICKET:/, /QA COMMAND:/, /RESOLVED COMMAND/]) {
    assert.match(text(load), re, `Load Jira Task prompt lacks ${re}`);
  }
  for (const re of [/docs\/benchmarks\/<TICKET>\/target\.md/, /baseline/i, /target/i, /tok\/s/, /TTFT/,
    /c=8/, /per-step ms/i, /numeric/i, /do not (write|change) (any )?(production )?code/i]) {
    assert.match(text(target), re, `Write Performance Target prompt lacks ${re}`);
  }
});

test('the approval decision offers exactly continue / revise / stop / accept-as-done', () => {
  const decision = byName('Approve Development Round');
  const opts = decision.config.options as Array<{ id: string; label: string }>;
  assert.ok(String(decision.config.question).length > 20);
  assert.deepEqual(opts.map((o) => o.id).sort(), ['accept-done', 'continue', 'revise', 'stop']);
  const labels = opts.map((o) => o.label);
  for (const l of ['Continue with these improvements', 'Revise the plan', 'Stop here']) {
    assert.ok(labels.includes(l), `missing option "${l}"`);
  }
  assert.equal(decision.config.recommendation, 'continue');
  // Develop can only start once the human has chosen.
  assert.ok(byName('Develop Improvement').dependsOn.includes(decision.id));
});

test('the QA step runs the local script on the 7B model through the launch-options machinery', () => {
  const qa = byName('Run Local QA (7B)');
  const cfg = qa.config;
  assert.equal(cfg.launchScript, 'scripts/qa/guided-local-run.sh');
  assert.deepEqual(cfg.launchFixedArgs, ['--non-interactive']);
  assert.equal(cfg.launchDefaultCommand, QA_7B_COMMAND);
  assert.ok(text(qa).includes(QA_7B_COMMAND), 'the fallback command is not in the prompt');
  assert.match(text(qa), /RESOLVED COMMAND|QA COMMAND:/);

  const launch = parseWorkflowLaunchConfig(cfg);
  assert.ok(launch, 'the dashboard rejects this launch configuration');
  const model = launch.options.find((o) => o.key === 'modelProfile');
  assert.equal(model?.defaultValue, 'qwen2.5-7b-q4');
  // The form's defaults must render to exactly the declared 7B command.
  assert.equal(renderLaunchCommand(launch, defaultLaunchOptionValues(launch.options)), QA_7B_COMMAND);

  // Only one launch form per workflow — the dashboard reads the first one it finds.
  const forms = steps().filter((s) => 'launchScript' in s.config);
  assert.deepEqual(forms.map((s) => s.name), ['Run Local QA (7B)']);
});

test('the loop body is exactly decision → develop → QA → compare, gated and bounded', () => {
  const gate = byName('Targets Met?');
  const body = ['Approve Development Round', 'Develop Improvement', 'Run Local QA (7B)', 'Compare Against Target'];
  assert.deepEqual(new Set(gate.dependsOn), new Set(body.map((n) => byName(n).id)),
    'the gate resets exactly its direct deps on FAIL — they must be the whole loop body');
  assert.equal(gate.config.gateType, 'custom');
  assert.equal(gate.config.maxRetries, 2, 'at most 3 development rounds');
  assert.equal(gate.config.terminalOnFail, true, 'an exhausted loop must end the run, not hang it');
  // The decision re-enters from OUTSIDE the loop: its only dependency is the written target.
  assert.deepEqual(byName('Approve Development Round').dependsOn, [byName('Write Performance Target').id]);

  const g = text(gate);
  assert.match(g, /first line/i);
  for (const v of ['VERDICT: MET', 'VERDICT: NOT MET', 'VERDICT: STOPPED', 'VERDICT: ACCEPTED']) {
    assert.ok(g.includes(v), `gate does not handle ${v}`);
  }
  assert.match(g, /round 3|third round|3 rounds/i);
  const compare = text(byName('Compare Against Target'));
  for (const re of [/target\.md/, /measured/i, /gap/i, /suggest/i, /accept-done/, /VERDICT: ACCEPTED/, /VERDICT: STOPPED/]) {
    assert.match(compare, re, `Compare prompt lacks ${re}`);
  }
});

test('Jira is marked Done only on the MET path or an approved accept-as-done', () => {
  const gate = byName('Targets Met?');
  const report = byName('Write Performance Report');
  const done = byName('Mark Jira Task Done');

  // Structural: every route to "Done" passes the gate (report depends on gate, Done on report).
  assert.ok(report.dependsOn.includes(gate.id));
  assert.ok(done.dependsOn.includes(report.id));
  // Done must see the verdict it is conditioned on.
  assert.ok(done.dependsOn.includes(byName('Compare Against Target').id));
  const p = text(done);
  assert.match(p, /VERDICT: MET/);
  assert.match(p, /VERDICT: ACCEPTED/);
  assert.match(p, /(do not|never) transition/i);
  assert.match(p, /transitionJiraIssue|transition/i);

  for (const re of [/report\.html/, /baseline/i, /target/i, /measured/i, /what changed/i, /QA summary/i]) {
    assert.match(text(report), re, `Write Performance Report lacks ${re}`);
  }

  const final = byName(REPORT_STEP_NAME);
  assert.ok(isReportStep(final.config));
  assert.deepEqual(final.dependsOn, [done.id]);
});

test('driven through the engine: NOT MET loops the whole body, MET proceeds, exhaustion never reaches Done', () => {
  const all = steps();
  const id = (n: string) => all.find((s) => s.name === n)!.id;
  const status = (n: string) => (db.prepare('SELECT status FROM workflow_steps WHERE id = ?')
    .get(id(n)) as { status: string }).status;
  const setAll = (s: string) => db.prepare('UPDATE workflow_steps SET status = ? WHERE workflow_id = ?')
    .run(s, all[0].workflowId);

  // Round 1 done, gate running, targets missed.
  setAll('completed');
  db.prepare("UPDATE workflow_steps SET status = 'pending' WHERE id IN (?, ?, ?)")
    .run(id('Write Performance Report'), id('Mark Jira Task Done'), id(REPORT_STEP_NAME));
  db.prepare("UPDATE workflow_steps SET status = 'running' WHERE id = ?").run(id('Targets Met?'));
  assert.equal(completeStepFromSignal(id('Targets Met?'), 'FAIL\nVERDICT: NOT MET — tok/s c=16 at 41, target 48'), true);

  const loop = ['Approve Development Round', 'Develop Improvement', 'Run Local QA (7B)', 'Compare Against Target', 'Targets Met?'];
  for (const n of loop) assert.equal(status(n), 'pending', `"${n}" was not reset for the next round`);
  for (const n of ['Load Jira Task', 'Write Performance Target']) assert.equal(status(n), 'completed', `"${n}" was re-run`);
  assert.equal(status('Mark Jira Task Done'), 'pending');
  const dev = JSON.parse((db.prepare('SELECT executor_config FROM workflow_steps WHERE id = ?')
    .get(id('Develop Improvement')) as { executor_config: string }).executor_config);
  assert.match(String(dev.prompt), /tok\/s c=16 at 41/, 'the gap did not reach the next Develop round');

  // Round 2: targets met — the gate passes and the loop exits.
  for (const n of loop) db.prepare("UPDATE workflow_steps SET status = 'completed' WHERE id = ?").run(id(n));
  db.prepare("UPDATE workflow_steps SET status = 'running' WHERE id = ?").run(id('Targets Met?'));
  assert.equal(completeStepFromSignal(id('Targets Met?'), 'PASS\nVERDICT: MET'), true);
  assert.equal(status('Targets Met?'), 'completed');

  // Exhaustion: a FAIL with no retries left ends the run and skips Done.
  db.prepare("UPDATE workflow_steps SET status = 'running', executor_config = json_set(executor_config, '$.currentRetry', 2) WHERE id = ?")
    .run(id('Targets Met?'));
  assert.equal(completeStepFromSignal(id('Targets Met?'), 'FAIL\nVERDICT: NOT MET'), true);
  assert.equal(status('Targets Met?'), 'failed');
  assert.equal(status('Mark Jira Task Done'), 'skipped');
});
