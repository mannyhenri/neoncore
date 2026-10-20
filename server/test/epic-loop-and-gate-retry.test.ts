/**
 * AN EPIC RUN WORKS EVERY TASK, AND A FAILED CHECK SENDS IT BACK TO THE WORK.
 *
 * Reported as: "run 86 is stalled again" → then "yes" to fixing why it only did one task and why
 * its check could not recover. Run 86 (Epic: Task by Task, GRD-4453, 14 tasks) did ONE task:
 *
 *  1. Its steps ran as confers, and a confer step's RESULT was the task prompt it was given,
 *     not what the participants reported. Load Epic's result therefore held the template's own
 *     placeholder "TASKS: [count of tasks not yet done]" — the participants' "TASKS 14" lived
 *     only in the confer's milestones — so Work Every Task's loop count fell back to 1. The
 *     prompt text is also actively harmful downstream: it contains the loop's stop phrase.
 *  2. The Work Standard Check sits after Notify, and a gate's retry resets only its direct
 *     dependencies. So its one retry re-sent a notification and re-audited 18 s later —
 *     the gate itself wrote "the gap is work the loop has to do, not something an audit can
 *     close" — and the run ended having worked 1 of 15.
 *
 * SET-BASED over the ways a gate can send work back: a named RETRY FROM target, no target
 * (walk up past connector steps), and a target that is not upstream of the gate (ignored).
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { tickWorkflowsOnce, completeStepFromSignal } from '../src/lib/workflow-executor-v2.ts';
import { explainLoopCount } from '../src/lib/workflow-loop.ts';

installStubIO();
const iso = () => new Date().toISOString();
let n = 0;

// ── 1. What a confer step hands downstream ─────────────────────────────────────────────

function finishedConfer(task: string, milestones: Array<[string, Record<string, string>]>): string {
  const id = `ec-confer-${++n}`;
  db.prepare(
    `INSERT INTO confer_sessions (id,repo_name,repo_path,task,participant_ids,status,current_milestone,error,created_at,completed_at,attachments,mode,isolation,worktrees,build_rounds)
     VALUES (?,'film-engine','/tmp/fe',?,?,'completed',?, '',?,?,'{}','collaborate','shared','{}',1)`,
  ).run(id, task, JSON.stringify(['a1', 'a2']), milestones.length - 1, iso(), iso());
  milestones.forEach(([key, results], idx) => db.prepare(
    `INSERT INTO confer_milestones (id,session_id,idx,key,name,status,done_ids,results,nudged,round)
     VALUES (?,?,?,?,?,'done','[]',?,0,0)`,
  ).run(`${id}-m${idx}`, id, idx, key, key[0].toUpperCase() + key.slice(1), JSON.stringify(results)));
  return id;
}

function confersStep(sessionId: string): { stepId: string } {
  const i = ++n;
  const runId = `ec-run-${i}`, stepId = `ec-step-${i}`;
  db.prepare(`INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number)
              VALUES (?,'Epic: Task by Task','','running','[]',?,?,'tpl',86)`).run(runId, iso(), iso());
  db.prepare(`INSERT INTO workflow_steps (id,workflow_id,name,description,position_x,position_y,executor_type,executor_id,
                executor_config,auto_advance,depends_on,created_at,status,started_at)
              VALUES (?,?,'Load Epic','',300,50,'confer','__deferred__',?,1,'[]',?,'running',?)`)
    .run(stepId, runId, JSON.stringify({ conferAgentIds: ['a1', 'a2'], conferSessionId: sessionId }), iso(), iso());
  return { stepId };
}

const PROMPT = 'OUTPUT these lines:\nTASKS: [count of tasks not yet done]\nFinish with ALL TASKS COMPLETE when nothing is left.';

test('a finished confer hands downstream what the participants REPORTED, not the prompt', () => {
  const session = finishedConfer(PROMPT, [
    ['frame', { a1: 'framing notes' }],
    ['finalize', { a1: 'EPIC GRD-4453 | STATE tracker | TASKS 14', a2: 'confirmed plan on main' }],
  ]);
  const { stepId } = confersStep(session);
  tickWorkflowsOnce();
  const row = db.prepare('SELECT status, result FROM workflow_steps WHERE id = ?').get(stepId) as { status: string; result: string };
  assert.equal(row.status, 'completed');
  assert.match(row.result, /TASKS 14/, 'the participants\' final report is not in the step result');
  assert.match(row.result, /confirmed plan on main/, 'only one participant\'s report was kept');
  assert.doesNotMatch(row.result, /\[count of tasks not yet done\]/, 'the prompt placeholder is still handed downstream');
  assert.doesNotMatch(row.result, /ALL TASKS COMPLETE/, 'the prompt\'s stop phrase would end the next step\'s loop at once');
});

test('the epic\'s loop count is read from a confer-run Load Epic', () => {
  const tpl = db.prepare("SELECT executor_config FROM workflow_steps WHERE workflow_id = (SELECT id FROM workflows WHERE template_id IS NULL AND name = 'Epic: Task by Task') AND name = 'Work Every Task'").get() as { executor_config: string };
  const cfg = JSON.parse(tpl.executor_config);
  const got = explainLoopCount(cfg, { 'Load Epic': 'Participant film-engine:\nEPIC GRD-4453 | STATE tracker | TASKS 14' });
  assert.equal(got.count, 14, `the template pattern missed "TASKS 14" (${got.note})`);
  assert.equal(explainLoopCount(cfg, { 'Load Epic': 'TASKS: 9' }).count, 9, 'the documented "TASKS: n" form stopped matching');
});

// ── 2. Where a failed gate sends the work ──────────────────────────────────────────────

type Row = { name: string; type: string; status: string; deps?: string[]; cfg?: Record<string, unknown> };

function epicRun(): { runId: string; id: (s: string) => string } {
  const i = ++n;
  const runId = `ec-gate-run-${i}`;
  const id = (s: string) => `ec-${i}-${s.replace(/\W+/g, '-')}`;
  db.prepare(`INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number)
              VALUES (?,'Epic: Task by Task','','running','[]',?,?,'tpl',86)`).run(runId, iso(), iso());
  const rows: Row[] = [
    { name: 'Load Epic', type: 'confer', status: 'completed' },
    { name: 'Work Every Task', type: 'confer', status: 'completed', deps: ['Load Epic'],
      cfg: { prompt: 'Do one task.', loopCountFrom: { step: 'Load Epic', pattern: 'TASKS:?\\s*(\\d+)' }, _resolvedLoopCount: 1, _currentLoop: 1, conferSessionId: 'old-session' } },
    { name: 'Verify Coverage', type: 'confer', status: 'completed', deps: ['Work Every Task'] },
    { name: 'Notify', type: 'connector', status: 'completed', deps: ['Verify Coverage'] },
    { name: 'Work Standard Check', type: 'quality-gate', status: 'running', deps: ['Notify'], cfg: { gateType: 'standard', maxRetries: 1 } },
  ];
  rows.forEach((r, k) => db.prepare(`INSERT INTO workflow_steps (id,workflow_id,name,description,position_x,position_y,executor_type,executor_id,
      executor_config,auto_advance,depends_on,created_at,status,result,completed_at)
    VALUES (?,?,?,'',300,?,?,'a',?,1,?,?,?,'done',?)`)
    .run(id(r.name), runId, r.name, 50 + k * 175, r.type, JSON.stringify(r.cfg ?? {}), JSON.stringify((r.deps ?? []).map(id)), iso(), r.status,
      r.status === 'completed' ? iso() : null));
  return { runId, id };
}

const status = (stepId: string) => (db.prepare('SELECT status FROM workflow_steps WHERE id = ?').get(stepId) as { status: string }).status;
const config = (stepId: string) => JSON.parse((db.prepare('SELECT executor_config FROM workflow_steps WHERE id = ?').get(stepId) as { executor_config: string }).executor_config);

test('RETRY FROM: a failed gate restarts the named step and everything after it', () => {
  const { id } = epicRun();
  completeStepFromSignal(id('Work Standard Check'),
    'FAIL\nOnly 1 of 15 tasks done; FEM-002..014 never attempted.\nRETRY FROM: Work Every Task');

  assert.equal(status(id('Load Epic')), 'completed', 'reset a step BEFORE the named one');
  for (const s of ['Work Every Task', 'Verify Coverage', 'Notify', 'Work Standard Check']) {
    assert.equal(status(id(s)), 'pending', `"${s}" was not reset, so the work cannot be redone`);
  }
  const work = config(id('Work Every Task'));
  assert.match(String(work.prompt), /FEM-002\.\.014 never attempted/, 'the gate\'s feedback did not reach the step that redoes the work');
  for (const k of ['_resolvedLoopCount', '_currentLoop', 'conferSessionId']) {
    assert.equal(work[k], undefined, `"${k}" survived the reset — the step would re-run with stale state`);
  }
});

test('no RETRY FROM: the retry climbs past notify-type steps to real work', () => {
  const { id } = epicRun();
  completeStepFromSignal(id('Work Standard Check'), 'FAIL\nThe coverage report is incomplete.');
  assert.equal(status(id('Notify')), 'pending');
  assert.equal(status(id('Verify Coverage')), 'pending', 'the retry stopped at a notification and re-ran no work');
  assert.equal(status(id('Work Every Task')), 'completed', 'climbed further than the nearest work step');
});

test('a RETRY FROM that is not upstream of the gate is ignored, not obeyed', () => {
  const { id } = epicRun();
  completeStepFromSignal(id('Work Standard Check'), 'FAIL\nsomething\nRETRY FROM: Deploy To Production');
  assert.equal(status(id('Work Every Task')), 'completed');
  assert.equal(status(id('Verify Coverage')), 'pending', 'fell back to nothing instead of the nearest work step');
});
