// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import { loopCountRequirements, type LoopConfig } from '../src/lib/workflow-loop.ts';
import { isReportStep } from '../src/lib/workflow-report.ts';
import { startWorkflowApp, stepsOf, verified, type WorkflowApp, type StepRow } from './helpers/workflow-app.ts';

/**
 * LOOP-003 MUST HOLD FOR A REPORT THAT CAME THROUGH THE WEBHOOK.
 *
 * A cartridge stuck on one task re-reports `BLOCKED T-1 · 2 remaining`. LOOP-003 ends the loop at
 * the second identical report. It did — for completions handed straight to the executor, which is
 * how its tests drove it. An agent reports through `neoncore_report_step_done`, and the webhook
 * DECORATES the result first: the `next` hand-off (which the completion instruction asks every
 * agent to fill) becomes line 1, and a captured plan is prefixed as `[Plan]…`. The loop read
 * "what the last dispatch reported" from line 1, so it compared two `NEXT:` lines, found no claim
 * in either, and never saw the repeat. Measured with the workflow-test harness: 103 dispatches
 * (3 budgeted + the 100-extension ceiling, ~124k prompt tokens) for an agent that never moved,
 * against 2 when the same agent omitted `next`.
 *
 * SET-BASED twice over: every looped step in every seeded template (the loop is the engine's,
 * not one template's), × every decoration the webhook applies. And both directions: a stuck
 * agent must stop, and an advancing one must not be stopped — a fix that ended every decorated
 * loop at dispatch 2 would pass the first half alone.
 */

const TASKS = 3;
let app: WorkflowApp;
before(async () => { app = await startWorkflowApp('loop003-webhook-agent'); });
after(() => app.close());

interface Looped { template: string; templateId: string; step: string }

/** THE SET: every step the engine re-dispatches, in every seeded template. */
function loopedSteps(): Looped[] {
  const rows = db.prepare(`
    SELECT w.id AS templateId, w.name AS template, s.name AS step, s.executor_config AS config
      FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
     WHERE w.template_id IS NULL`).all() as Array<{ templateId: string; template: string; step: string; config: string }>;
  return rows.filter((r) => {
    const c = JSON.parse(r.config || '{}') as LoopConfig;
    return !!c.loopCountFrom?.step || (c.loopCount ?? 1) > 1;
  }).map(({ templateId, template, step }) => ({ templateId, template, step }));
}

type Decoration = { name: string; next?: string; plan?: string };
const DECORATIONS: Decoration[] = [
  { name: 'a `next` hand-off', next: 'Take the next task from the state doc.' },
  { name: 'a captured plan', plan: 'Plan: 1. read the state doc 2. pick the next task' },
  { name: 'a hand-off and a plan', next: 'Carry on.', plan: 'Plan: work the state doc top to bottom' },
];

/** A line satisfying a simple count pattern like `TASKS_A:\s*(\d+)`. */
function countLine(pattern: string, n: number): string {
  const line = pattern.replace(/\(\\d\+\)/, String(n)).replace(/\\s[*+]/g, ' ').replace(/(.)\?/g, '$1').replace(/\\(.)/g, '$1');
  assert.equal(new RegExp(pattern).exec(line)?.[1], String(n), `could not build a line for /${pattern}/`);
  return line;
}

/**
 * Drive a run of `templateId`, answering every step through the webhook, until `target` has been
 * dispatched `maxDispatches` times or the run ends. Returns how often `target` was dispatched and
 * the prompts it received.
 */
async function drive(templateId: string, target: string, claimFor: (k: number) => string, deco: Decoration, maxDispatches = 12) {
  const start = await app.post(`/api/workflows/v2/${templateId}/start`, { agentId: app.agent, initialContext: 'docs/plans/EPIC-x.md' });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const runId = start.json.workflow.id as string;
  const prompts: string[] = [];
  const seen = new Map<string, string>(); // stepId → the dispatched prompt we last answered

  for (let guard = 0; guard < 80; guard++) {
    tickWorkflowsOnce();
    await new Promise((r) => setImmediate(r));
    const all = stepsOf(runId);
    const running = all.filter((s) => s.status === 'running' && seen.get(s.id) !== s.dispatched_prompt);
    if (running.length === 0) {
      const wf = db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status: string };
      if (wf.status !== 'running') break;
      const pendingAdvance = all.filter((s) => s.status === 'completed' && !s.auto_advance);
      for (const s of pendingAdvance) await app.post(`/api/workflows/v2/${runId}/steps/${s.id}/advance`, {});
      if (pendingAdvance.length === 0 && all.every((s) => s.status !== 'running')) continue;
      continue;
    }
    for (const s of running) {
      seen.set(s.id, s.dispatched_prompt);
      if (s.name === target) {
        prompts.push(s.dispatched_prompt);
        if (prompts.length > maxDispatches) return { runId, prompts, stepStatus: 'runaway' };
        if (deco.plan) db.prepare('UPDATE workflow_steps SET plan_content = ? WHERE id = ?').run(deco.plan, s.id);
        const res = await app.post(`/api/workflows/webhook/${s.id}/complete`, verified(claimFor(prompts.length), deco.next ? { next: deco.next } : {}));
        assert.equal(res.status, 200, JSON.stringify(res.json));
      } else {
        await answerOther(s, all);
      }
    }
  }
  const step = stepsOf(runId).find((s) => s.name === target)!;
  return { runId, prompts, stepStatus: step.status };
}

async function answerOther(s: StepRow, all: StepRow[]): Promise<void> {
  const cfg = JSON.parse(s.executor_config || '{}');
  if (s.executor_type === 'quality-gate' || s.executor_type === 'review-gate') {
    await app.post(`/api/workflows/webhook/${s.id}/complete`, { result: 'PASS\nok' });
    return;
  }
  if (s.executor_type === 'decision') {
    await app.post(`/api/workflows/v2/${s.id}/steps/${s.id}/decide`, { optionId: cfg.options?.[0]?.id });
    return;
  }
  const owed = loopCountRequirements(s.name, all.map((x) => ({ name: x.name, config: JSON.parse(x.executor_config || '{}') })));
  const lines = owed.map((r) => countLine(r.pattern, TASKS));
  const sibling = isReportStep(cfg) ? 'report' : 'work';
  // A sibling loop (Epic: Two Repos has two) progresses normally so the run can reach the target.
  const loopy = !!cfg.loopCountFrom?.step;
  const k = Number(cfg._currentLoop) || 1;
  const claim = loopy ? `DONE S-${k} · commit c${k} · ${Math.max(0, TASKS - k)} remaining` : `${s.name}: ${sibling} done`;
  const res = await app.post(`/api/workflows/webhook/${s.id}/complete`, verified([claim, ...lines].join('\n')));
  assert.equal(res.status, 200, `${s.name}: ${JSON.stringify(res.json)}`);
}

test('the set of looped steps is not empty', () => {
  assert.ok(loopedSteps().length >= 4, `found only ${loopedSteps().length}`);
});

for (const deco of DECORATIONS) {
  test(`a stuck agent ends the loop at its 2nd identical report — every looped step, with ${deco.name}`, async () => {
    const wrong: string[] = [];
    for (const l of loopedSteps()) {
      const r = await drive(l.templateId, l.step, () => `BLOCKED T-1 · ${TASKS - 1} remaining\nthe fixture is missing`, deco);
      if (r.prompts.length !== 2 || r.stepStatus !== 'completed') {
        wrong.push(`${l.template} › ${l.step}: ${r.prompts.length} dispatches, step ${r.stepStatus}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  test(`an advancing agent is NOT stopped — every looped step covers all ${TASKS} tasks, with ${deco.name}`, async () => {
    const wrong: string[] = [];
    for (const l of loopedSteps()) {
      const r = await drive(l.templateId, l.step, (k) => `DONE T-${k} · commit abc${k} · ${TASKS - k} remaining`, deco);
      if (r.prompts.length !== TASKS || r.stepStatus !== 'completed') {
        wrong.push(`${l.template} › ${l.step}: ${r.prompts.length} dispatches, step ${r.stepStatus}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
}

test('the loop header quotes the previous CLAIM, not the hand-off line above it', async () => {
  const l = loopedSteps().find((x) => x.step === 'Work Every Task')!;
  const r = await drive(l.templateId, l.step, (k) => `DONE T-${k} · commit abc${k} · ${TASKS - k} remaining`, DECORATIONS[2]);
  assert.ok(r.prompts.length >= 2);
  const header = r.prompts[1].split('\n').slice(0, 8).join('\n');
  assert.match(header, /it reported:\n\s+DONE T-1 · commit abc1 · 2 remaining/, header);
  assert.doesNotMatch(header, /it reported:\n\s+NEXT:/);
});
