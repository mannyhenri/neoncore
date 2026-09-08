/**
 * A RUN THAT IS ABOUT TO FALL SHORT SHOULD SAY SO WHILE IT STILL HAS A DISPATCH LEFT.
 *
 * The loop budget guarantees a number of ATTEMPTS, not a number of completions. When the budget
 * runs out with work remaining, the step completes, the run advances to `Verify Coverage`, and
 * the report says "9 of 12 done" — which is a useful result, but only discovered at the end.
 *
 * The engine already defends this well: `shouldExtendLoop` grows the budget one dispatch at a
 * time, up to 100 extensions, on any positive `k remaining`. So under-delivery survives in only
 * four shapes, and this reason is exactly those four:
 *
 *   1. STATIC COUNT — the template wrote `loopCount: 5` with no `loopCountFrom`. Extension
 *      refuses immediately: a static count is an author's decision, not an estimate to revise.
 *   2. EXTENSIONS EXHAUSTED — 100 of them, or the 250-dispatch ceiling.
 *   3. NO COUNT REPORTED — the agent did not say `k remaining`. `remainingFrom` returns null,
 *      extension refuses (silence is not a claim that work remains), and the run ends quietly.
 *      The dispatch prompt demands the count "on EVERY exit path" precisely because of this,
 *      which means it depends on an agent remembering.
 *
 * ── WHY IT ASKS `shouldExtendLoop` RATHER THAN RESTATING ITS RULES ────────────────────
 * The condition "will the budget rescue itself?" is already implemented, with six clauses and a
 * comment explaining a live incident behind one of them. Reimplementing it here would be a
 * second definition that drifts — the same mistake the reason registry was built to end. This
 * detector asks the real function and reports when the answer is no.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { workflowNeedsAttention } from '../src/lib/workflow-attention.ts';
import { MAX_LOOP_EXTENSIONS, MAX_LOOP_CEILING } from '../src/lib/workflow-loop.ts';

installStubIO();

let n = 0;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function wf(): string {
  const id = `wf-bud-${++n}`;
  db.prepare("INSERT INTO workflows (id,name,status,created_at,template_id,run_number) VALUES (?,?,'running',?, 'tpl',1)")
    .run(id, `run ${id}`, iso());
  return id;
}

function agent(): string {
  const id = `ag-bud-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
     VALUES (?,?,?,?,?,?,'working',?,?,'')`,
  ).run(id, `m/${id}`, 'm', `/r/${id}`, 'r', 'claude', iso(1_000), `s-${id}`);
  return id;
}

/** A looped step mid-run: `cfg` is its executor_config, `result` what the last dispatch said. */
function loopStep(w: string, cfg: Record<string, unknown>, result: string): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (id,workflow_id,name,description,position_x,position_y,status,executor_type,executor_id,
        executor_config,auto_advance,created_at,recovery_status,dispatched_prompt,result,started_at)
     VALUES (?,?,'Work Every Task','',0,1,'running','claude-code',?,?,1,?,'','do it',?,?)`,
  ).run(`st-bud-${++n}`, w, agent(), JSON.stringify(cfg), iso(), result, iso(60_000));
}

/** A dynamic count, the ordinary shape: the budget came from step 1's output. */
const DYNAMIC = { loopUntil: 'ALL TASKS COMPLETE', loopCountFrom: { step: 'Load Epic', pattern: 'TASKS:\\s*(\\d+)' } };
/** A static count: an author wrote the number down. Extension refuses these by design. */
const STATIC = { loopUntil: 'ALL TASKS COMPLETE', loopCount: 5 };

interface Case { label: string; cfg: Record<string, unknown>; result: string; fires: boolean }

const CASES: Case[] = [
  {
    label: 'budget unspent — the loop will simply run again',
    cfg: { ...DYNAMIC, _currentLoop: 3, _resolvedLoopCount: 19 },
    result: 'DONE BC-003 · commit abc · 16 remaining',
    fires: false,
  },
  {
    label: 'budget spent but the agent declared completion',
    cfg: { ...DYNAMIC, _currentLoop: 19, _resolvedLoopCount: 19 },
    result: 'ALL TASKS COMPLETE — 19 of 19 done',
    fires: false,
  },
  {
    label: 'budget spent, work remains, and the engine WILL extend — not our problem',
    cfg: { ...DYNAMIC, _currentLoop: 19, _resolvedLoopCount: 19, _loopExtensions: 2 },
    result: 'DONE BC-019 · commit abc · 4 remaining',
    fires: false,
  },
  {
    label: 'STATIC count with work remaining — extension refuses by design',
    cfg: { ...STATIC, _currentLoop: 5, _resolvedLoopCount: 5 },
    result: 'DONE T-005 · commit abc · 7 remaining',
    fires: true,
  },
  {
    label: 'extensions exhausted',
    cfg: { ...DYNAMIC, _currentLoop: 40, _resolvedLoopCount: 40, _loopExtensions: MAX_LOOP_EXTENSIONS },
    result: 'DONE BC-040 · commit abc · 6 remaining',
    fires: true,
  },
  {
    label: 'the dispatch ceiling reached',
    cfg: { ...DYNAMIC, _currentLoop: MAX_LOOP_CEILING, _resolvedLoopCount: MAX_LOOP_CEILING },
    result: 'DONE BC-250 · commit abc · 3 remaining',
    fires: true,
  },
  {
    label: 'NO remaining count reported — silence ends the run quietly',
    cfg: { ...DYNAMIC, _currentLoop: 19, _resolvedLoopCount: 19 },
    result: 'DONE BC-019 · commit abc',
    fires: true,
  },
  {
    label: 'not a looped step at all',
    cfg: {},
    result: 'finished',
    fires: false,
  },
];

test('EVERY budget shape resolves correctly', () => {
  const wrong: string[] = [];
  for (const c of CASES) {
    const w = wf();
    loopStep(w, c.cfg, c.result);
    const got = workflowNeedsAttention(w);
    const fired = got?.reason === 'budget-exhaustion';
    if (fired !== c.fires) wrong.push(`${c.label}: fired=${fired}, expected ${c.fires}`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('the detail says WHY the budget cannot grow, because the fixes differ', () => {
  // "Raise loopCount in the template" and "the agent stopped reporting its count" are different
  // problems with different repairs. A message that only said "budget exhausted" would send
  // someone to the wrong one.
  const staticRun = wf();
  loopStep(staticRun, { ...STATIC, _currentLoop: 5, _resolvedLoopCount: 5 },
           'DONE T-005 · commit abc · 7 remaining');
  assert.match(String(workflowNeedsAttention(staticRun)?.detail), /fixed|static/i);

  const silentRun = wf();
  loopStep(silentRun, { ...DYNAMIC, _currentLoop: 19, _resolvedLoopCount: 19 },
           'DONE BC-019 · commit abc');
  assert.match(String(workflowNeedsAttention(silentRun)?.detail), /did not (say|report)/i);
});

test('it names the count the agent actually reported, when it reported one', () => {
  const w = wf();
  loopStep(w, { ...STATIC, _currentLoop: 5, _resolvedLoopCount: 5 },
           'DONE T-005 · commit abc · 7 remaining');
  assert.match(String(workflowNeedsAttention(w)?.detail), /7/,
    'the number of tasks about to be dropped is the whole point of the warning');
});
