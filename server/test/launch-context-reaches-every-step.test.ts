/**
 * THE LAUNCH CONTEXT MUST REACH EVERY KIND OF FIRST STEP.
 *
 * Reported as "confers sending empty directions" — two cartridges received:
 *
 *     "The task is in the workflow description above."
 *
 * and nothing above it. The prompt was not lying; the executor was. `executeStandardStep`
 * prepends the run's initial_context for a step with no dependencies, and `executeConfer`
 * builds its task as `dependencyContext + prompt` and never looks at initial_context at all.
 * A confer as the FIRST step of a run therefore cannot see what the run is about — ever.
 *
 * SET-BASED OVER THE EXECUTORS, because six of them dispatch a prompt to an agent and exactly
 * one of them carried the context. Fixing confer alone would leave deliberation, the gates and
 * command steps with the same hole, and each would be reported separately later.
 *
 * FIRST STEPS ONLY: a later step gets the run's subject through its dependencies' results,
 * which is why the standard executor gates this on `dependsOn.length === 0`. A first step has
 * no such inheritance — the launch form is its only source.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { buildLaunchContext } from '../src/lib/workflow-context.ts';
import { installStubIO } from './helpers/stub-io.ts';

installStubIO();
const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const iso = () => new Date().toISOString();
let n = 0;

const CONTEXT = 'GRD-3449 — port the installer bootstrap to the new signing flow';

function runWithFirstStep(executorType: string): { workflowId: string; stepId: string } {
  const i = ++n;
  const workflowId = `lc-wf-${i}`, stepId = `lc-step-${i}`;
  db.prepare(
    `INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number,initial_context)
     VALUES (?,'Run','A workflow','running','[]',?,?, 'tpl', 1, ?)`,
  ).run(workflowId, iso(), iso(), CONTEXT);
  db.prepare(
    `INSERT INTO workflow_steps (id,workflow_id,name,description,position_x,position_y,
       executor_type,executor_id,executor_config,auto_advance,depends_on,created_at,status)
     VALUES (?,?,'First step','',300,50,?,'a','{}',1,'[]',?,'running')`,
  ).run(stepId, workflowId, executorType, iso());
  return { workflowId, stepId };
}

/** Every executor that dispatches a prompt to a model. */
const PROMPT_EXECUTORS = ['claude-code', 'confer', 'deliberation', 'review-gate', 'quality-gate', 'command'] as const;

test('the shared builder gives a FIRST step the launch context', () => {
  const missing: string[] = [];
  for (const type of PROMPT_EXECUTORS) {
    const { workflowId, stepId } = runWithFirstStep(type);
    const step = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as Record<string, unknown>;
    const prefix = buildLaunchContext(db, {
      workflowId,
      dependsOn: JSON.parse((step.depends_on as string) || '[]'),
    });
    if (!prefix.includes(CONTEXT)) missing.push(`${type}: launch context absent`);
  }
  assert.deepEqual(missing, [],
    `a first step would be dispatched with no idea what the run is about:\n  ${missing.join('\n  ')}`);
  console.log(`[set] ${PROMPT_EXECUTORS.length}/${PROMPT_EXECUTORS.length} executors can carry the launch context`);
});

test('a LATER step is not given it twice — it inherits through its dependencies', () => {
  const { workflowId } = runWithFirstStep('claude-code');
  const prefix = buildLaunchContext(db, { workflowId, dependsOn: ['some-earlier-step'] });
  assert.equal(prefix, '',
    'a dependent step got the launch context as well as its predecessor’s result — the same ' +
    'text twice in one prompt is noise, and the standard executor has always gated on this');
});

test('the workflow DESCRIPTION is carried too when there is no typed context', () => {
  // A template launched with nothing typed still has a description saying what it is for.
  // Sending neither is how "the task is in the workflow description above" became a lie.
  const i = ++n;
  const workflowId = `lc-desc-${i}`;
  db.prepare(
    `INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number,initial_context)
     VALUES (?,'Confer','Two cartridges work one task together','running','[]',?,?, 'tpl', 1, '')`,
  ).run(workflowId, iso(), iso());
  const prefix = buildLaunchContext(db, { workflowId, dependsOn: [] });
  assert.match(prefix, /Two cartridges work one task together/,
    'no context and no description — the agent is told nothing at all about the run');
});

test('a run with neither produces no empty heading', () => {
  const i = ++n;
  const workflowId = `lc-empty-${i}`;
  db.prepare(
    `INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number,initial_context)
     VALUES (?,'Bare','','running','[]',?,?, 'tpl', 1, '')`,
  ).run(workflowId, iso(), iso());
  assert.equal(buildLaunchContext(db, { workflowId, dependsOn: [] }), '',
    'emitted a "## Context" heading with nothing under it');
});

// ── every executor actually USES it ────────────────────────────────────────────────────

test('EVERY prompt-dispatching executor calls the shared builder', () => {
  // The bug was one executor having it and five not. Source-scanned because these dispatch to
  // live cartridges and cannot be driven in a unit test — but scanned by NAME, so an executor
  // that stops calling it fails here.
  const src = read('server/src/lib/workflow-executor-v2.ts');
  const FUNCS = [
    'executeStandardStep', 'executeConfer', 'executeDeliberation',
    'executeReviewGate', 'executeQualityGate', 'executeCommandStep',
  ];
  const missing: string[] = [];
  for (const fn of FUNCS) {
    const at = src.indexOf(`function ${fn}(`);
    assert.ok(at > 0, `${fn} not found — the scan is stale`);
    // The body, up to the next top-level function.
    const next = src.indexOf('\nasync function ', at + 10);
    const body = src.slice(at, next > 0 ? next : at + 4000);
    if (!/buildLaunchContext\(/.test(body)) missing.push(fn);
  }
  assert.deepEqual(missing, [],
    `these dispatch a prompt without the run's launch context:\n  ${missing.join('\n  ')}`);
  console.log(`[set] ${FUNCS.length}/${FUNCS.length} executors call buildLaunchContext`);
});

test('the Confer template no longer promises context it cannot receive', () => {
  // Its prompt opened "The task is in the workflow description above." That sentence is only
  // true if the executor puts it there — it now does, and this pins the pair together.
  const row = db.prepare(
    `SELECT s.executor_config FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
      WHERE w.template_id IS NULL AND w.name = 'Confer' AND s.executor_type = 'confer'`,
  ).get() as { executor_config: string } | undefined;
  assert.ok(row, 'the Confer template has no confer step');
  const prompt = String(JSON.parse(row!.executor_config).prompt ?? '');
  assert.ok(prompt.length > 40, 'the confer step has no prompt at all');
  assert.match(prompt, /task/i);
});
