/**
 * A STEP CAN BE BLOCKED ON A PERSON — and that is not a failure.
 *
 * Reported as: "why is the CE phase 3 always fails once". Runs #14 and #17 each needed a person
 * (amend a locked test; run the phase gate with sudo). The agent could only report DONE, so it did,
 * with "NEXT: Person: …" in the text. Every step after it was dispatched and "completed" having done
 * nothing, the quality gate failed, retried twice with nothing changed, and the run was marked
 * failed. The rerun after the person acted passed: every human-only block cost a failed run.
 *
 * Now a report may carry `blocked: "<what the person must do>"`. The step holds (`_blockedHold`):
 * nothing after it starts, no gate runs, no retry is spent, the run stays running and asks you.
 * `continue` re-dispatches exactly that step with your note; `stop` cancels the run.
 *
 * SET-BASED over every executor type that reports through the webhook — the four that use
 * /complete and the deliberation panel that uses /panel/:agent/complete — and, for each, the
 * blocked step in the middle of a run and as its LAST step (where `allDone` would have ended it).
 */
import './helpers/isolated-db.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import { workflowNeedsAttention, ATTENTION_REASONS } from '../src/lib/workflow-attention.ts';
import { canAutoResolve, AUTONOMY_LEVELS } from '../src/lib/autonomy.ts';
import { startWorkflowApp, verified } from './helpers/workflow-app.ts';

const app = await startWorkflowApp('blk-agent');
after(() => app.close());

const iso = () => new Date().toISOString();
let n = 0;

/** Every executor type whose agent reports through a webhook. */
const REPORTERS = [
  { type: 'claude-code', panel: false, cfg: { prompt: 'Build it.' } },
  { type: 'command', panel: false, cfg: { command: '/do-it' } },
  { type: 'quality-gate', panel: false, cfg: { gateType: 'tests', maxRetries: 2, currentRetry: 0 } },
  { type: 'review-gate', panel: false, cfg: { maxRetries: 2, currentRetry: 0 } },
  { type: 'deliberation', panel: true, cfg: { deliberationPhase: 'collecting', panelAgentIds: ['blk-agent', 'blk-other'], panelResults: {} } },
] as const;

type Reporter = (typeof REPORTERS)[number];

/** Prev (done) → Target (running, the reporter) → [Next (pending)]. */
function run(r: Reporter, last: boolean) {
  const i = ++n;
  const runId = `blk-run-${i}`;
  const id = (s: string) => `blk-${i}-${s}`;
  db.prepare(`INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number)
              VALUES (?,'CE: Phase 3 — Implement','','running','[]',?,?,'tpl',${i})`).run(runId, iso(), iso());
  const ins = db.prepare(`INSERT INTO workflow_steps (id,workflow_id,name,description,position_x,position_y,executor_type,executor_id,
      executor_config,auto_advance,depends_on,created_at,status,started_at,completed_at,result,dispatch_agent_id)
      VALUES (?,?,?,'',?,?,?,?,?,1,?,?,?,?,?,?,?)`);
  ins.run(id('prev'), runId, 'Load Plan', 0, 0, 'claude-code', 'blk-agent', '{}', '[]', iso(), 'completed', iso(), iso(), 'plan loaded', 'blk-agent');
  ins.run(id('target'), runId, 'Target', 0, 100, r.type, r.panel ? '' : 'blk-agent', JSON.stringify(r.cfg),
    JSON.stringify([id('prev')]), iso(), 'running', iso(), null, '', r.panel ? '' : 'blk-agent');
  if (!last) {
    ins.run(id('next'), runId, 'Next', 0, 200, 'claude-code', 'blk-agent', JSON.stringify({ prompt: 'Then this.' }),
      JSON.stringify([id('target')]), iso(), 'pending', null, null, '', '');
  }
  return { runId, id };
}

const ASK = 'Run `bash scripts/run_gates.sh 0` in ~/code/beam with 127.0.0.2-.4 up (needs sudo).';

function reportBlocked(r: Reporter, stepId: string) {
  const body = { result: 'Stopped at the step 0 precondition: no "Gate: Phase 0 passed" commit.', blocked: ASK };
  return r.panel
    ? app.post(`/api/workflows/webhook/${stepId}/panel/blk-agent/complete`, body)
    : app.post(`/api/workflows/webhook/${stepId}/complete`, body);
}

const stepRow = (id: string) => db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(id) as Record<string, any>;
const cfgOf = (id: string) => JSON.parse(stepRow(id).executor_config || '{}');
const runStatus = (runId: string) => (db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status: string }).status;

for (const r of REPORTERS) {
  for (const last of [false, true]) {
    const where = last ? 'as the last step' : 'mid-run';

    test(`${r.type} ${where}: a blocked report holds the run — nothing after it, no retry, not failed`, async () => {
      const { runId, id } = run(r, last);
      const res = await reportBlocked(r, id('target'));
      assert.equal(res.status, 200, `blocked report refused: ${JSON.stringify(res.json)}`);

      const hold = cfgOf(id('target'))._blockedHold;
      assert.ok(hold, 'no _blockedHold on the step');
      assert.equal(hold.ask, ASK);
      assert.ok(hold.at, 'the hold has no time');
      assert.match(stepRow(id('target')).result, /^BLOCKED: /, 'the stored result does not lead with BLOCKED');
      assert.equal(cfgOf(id('target')).currentRetry ?? 0, 0, 'a retry was spent');

      for (let k = 0; k < 3; k++) tickWorkflowsOnce();
      assert.equal(runStatus(runId), 'running', 'the run ended (or failed) while held');
      if (!last) assert.equal(stepRow(id('next')).status, 'pending', 'the step after a blocked step started');
      assert.equal(stepRow(id('prev')).status, 'completed', 'an upstream step was reset');

      const att = workflowNeedsAttention(runId);
      assert.equal(att?.reason, 'blocked-on-person', `attention is ${att?.reason}`);
      assert.match(att!.detail, /run_gates\.sh 0/, 'the attention does not say what to do');
    });

    test(`${r.type} ${where}: "continue" re-dispatches exactly that step, with your note`, async () => {
      const { runId, id } = run(r, last);
      await reportBlocked(r, id('target'));
      const res = await app.post(`/api/workflows/v2/${runId}/steps/${id('target')}/blocked`, { action: 'continue', note: 'Done: gate passed, 6b8c0fa.' });
      assert.equal(res.status, 200, JSON.stringify(res.json));

      const cfg = cfgOf(id('target'));
      assert.equal(cfg._blockedHold, undefined, 'the hold was not cleared');
      assert.match(String(cfg._routingFeedback), /6b8c0fa/, 'the person\'s note is not carried to the re-dispatch');
      assert.match(String(cfg._routingFeedback), /run_gates\.sh 0/, 'the re-dispatch is not told what it was blocked on');
      assert.equal(cfg.currentRetry ?? 0, 0, 'continue spent a retry');
      if (r.panel) assert.deepEqual(cfg.panelResults ?? {}, {}, 'the panel kept the blocked round\'s answers');
      assert.equal(stepRow(id('target')).status, 'pending');
      assert.equal(stepRow(id('prev')).status, 'completed', 'continue reset more than the blocked step');
      if (!last) assert.equal(stepRow(id('next')).status, 'pending');
      assert.equal(runStatus(runId), 'running');
    });

    test(`${r.type} ${where}: "stop" cancels the run`, async () => {
      const { runId, id } = run(r, last);
      await reportBlocked(r, id('target'));
      const res = await app.post(`/api/workflows/v2/${runId}/steps/${id('target')}/blocked`, { action: 'stop' });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(runStatus(runId), 'cancelled');
    });
  }
}

test('a blocked work report needs no verify — but it needs to say what the person must do', async () => {
  const { id } = run(REPORTERS[0], false);
  const empty = await app.post(`/api/workflows/webhook/${id('target')}/complete`, { result: 'stuck', blocked: '   ' });
  assert.equal(empty.status, 400, 'an empty `blocked` was accepted');
  assert.equal(stepRow(id('target')).status, 'running');
  const plain = await app.post(`/api/workflows/webhook/${id('target')}/complete`, { result: 'stuck' });
  assert.equal(plain.status, 400, 'a done report without verify is still refused');
  const ok = await app.post(`/api/workflows/webhook/${id('target')}/complete`, { result: 'stuck', blocked: ASK });
  assert.equal(ok.status, 200);
});

test('a normal (verified) report still completes and lets the next step start', async () => {
  const { runId, id } = run(REPORTERS[0], false);
  // Only this run is live: an earlier test's run still holding the cartridge would (rightly) keep
  // "Next" waiting for it — the one-step-per-cartridge rule, not what this test is about.
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE id LIKE 'blk-run-%' AND id != ?").run(runId);
  const res = await app.post(`/api/workflows/webhook/${id('target')}/complete`, verified('built'));
  assert.equal(res.status, 200);
  assert.equal(cfgOf(id('target'))._blockedHold, undefined);
  tickWorkflowsOnce();
  assert.notEqual(stepRow(id('next')).status, 'pending', 'the step after a normal completion did not start');
  assert.equal(runStatus(runId), 'running');
});

test('the resolve route refuses a step that is not blocked, and an unknown action', async () => {
  const { runId, id } = run(REPORTERS[0], false);
  const notHeld = await app.post(`/api/workflows/v2/${runId}/steps/${id('prev')}/blocked`, { action: 'continue' });
  assert.equal(notHeld.status, 409);
  await reportBlocked(REPORTERS[0], id('target'));
  const bad = await app.post(`/api/workflows/v2/${runId}/steps/${id('target')}/blocked`, { action: 'skip' });
  assert.equal(bad.status, 400);
});

test('blocked-on-person is an attention reason no autonomy level may settle', () => {
  assert.ok((ATTENTION_REASONS as readonly string[]).includes('blocked-on-person'));
  for (const level of AUTONOMY_LEVELS) assert.equal(canAutoResolve(level, 'blocked-on-person' as never), false, level);
});
