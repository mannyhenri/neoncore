// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { completeStepFromSignal, tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';

/**
 * The stub records emissions instead of transmitting, and `connect()` registers the room that
 * makes a cartridge look reachable. Without it the very first dispatch fails with "no command
 * channel" and the step goes straight to `failed` — which is correct behaviour, and useless for
 * testing what happens after a dispatch lands.
 */
const io = installStubIO();

/**
 * A whole epic run, end to end, against a fake epic.
 *
 * ASKED FOR DIRECTLY: "have we tested it against a small fake jira epic?" We had not. Every test
 * so far checked a PIECE — the resolver in isolation, the template's config, the seeding. None of
 * them proved the thing actually claimed: hand it an epic with N tasks and it works all N without
 * a human, then reports.
 *
 * That gap matters more than usual here, because the guarantee moved. The old template asked one
 * agent to remember to keep going; the new one asks the ENGINE to re-dispatch. Whether the engine
 * really does that, the right number of times, driven by a number another step produced, is a
 * property of four components talking to each other — and no unit test can see it.
 *
 * Driven by tickWorkflowsOnce() and completeStepFromSignal() rather than by waiting, because the
 * real loop advances on a completion webhook and a 15-second poll. Sleeping through a twelve-task
 * epic is not a test anyone runs twice.
 */

const AGENT = 'epic-runner-agent';
const TASKS_IN_FAKE_EPIC = 3;

function seedAgent(): void {
  io.connect(AGENT);          // a relay is listening for this cartridge
  db.prepare(`INSERT OR REPLACE INTO agents
      (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
      VALUES (?, 'box/epic-repo', 'box', '/tmp/epic-repo', 'epic-repo', 'idle', ?, 'sess-1', 'claude')`)
    .run(AGENT, new Date().toISOString());
}

/** A run of the real seeded template, with the fake epic as its launch context. */
function startRun(): string {
  const tpl = db.prepare(
    "SELECT id FROM workflows WHERE name = 'Epic: Task by Task' AND template_id IS NULL",
  ).get() as { id: string } | undefined;
  assert.ok(tpl, 'the template is not seeded');

  const runId = cloneTemplateAsRun(tpl!.id, null, 'docs/plans/EPIC-fake.md');
  assert.ok(runId, 'cloneTemplateAsRun returned nothing');

  // Every step is dispatched to our fake cartridge, and the run is live.
  db.prepare("UPDATE workflow_steps SET executor_id = ? WHERE workflow_id = ?").run(AGENT, runId);
  db.prepare("UPDATE workflows SET status = 'running' WHERE id = ?").run(runId!);
  return runId!;
}

function stepByName(runId: string, name: string): { id: string; status: string; config: string } {
  const r = db.prepare(
    'SELECT id, status, executor_config AS config FROM workflow_steps WHERE workflow_id = ? AND name = ?',
  ).get(runId, name) as { id: string; status: string; config: string } | undefined;
  assert.ok(r, `no step named "${name}" in the run`);
  return r!;
}

const loopOf = (cfg: string) => (JSON.parse(cfg)._currentLoop as number) || 1;
const resolvedOf = (cfg: string) => JSON.parse(cfg)._resolvedLoopCount as number | undefined;

/** What step 1 reports for a three-task epic. */
const LOAD_RESULT = [
  'EPIC: docs/plans/EPIC-fake.md',
  'STATE: docs/plans/EPIC-fake.md',
  'ROOT: /tmp/epic-repo',
  'TESTS: npm test',
  `TASKS: ${TASKS_IN_FAKE_EPIC}`,
].join('\n');

test('a 3-task epic runs all 3 tasks with no human input, then reports', () => {
  seedAgent();
  const runId = startRun();

  // ── Step 1 dispatches on its own ──
  tickWorkflowsOnce();
  const load = stepByName(runId, 'Load Epic');
  assert.equal(load.status, 'running', 'the run did not dispatch its first step by itself');

  // The cartridge reports the epic and, critically, the COUNT.
  assert.ok(completeStepFromSignal(load.id, LOAD_RESULT), 'step 1 would not complete');

  // ── The work step picks up without anyone touching it ──
  tickWorkflowsOnce();
  let work = stepByName(runId, 'Work Every Task');
  assert.equal(work.status, 'running', 'the work step did not start after step 1 — a human would be needed here');

  // ── Each completion re-dispatches, up to the count step 1 reported ──
  const dispatches: number[] = [];
  for (let i = 1; i <= TASKS_IN_FAKE_EPIC; i++) {
    work = stepByName(runId, 'Work Every Task');
    dispatches.push(loopOf(work.config));
    assert.ok(
      completeStepFromSignal(work.id, `DONE fake-${i} · commit abc${i} · ${TASKS_IN_FAKE_EPIC - i} remaining`),
      `completion ${i} was rejected`,
    );
  }

  work = stepByName(runId, 'Work Every Task');
  assert.equal(resolvedOf(work.config), TASKS_IN_FAKE_EPIC,
    'the loop count was not read from step 1 — coverage is back to whatever the prompt remembers');
  assert.deepEqual(dispatches, [1, 2, 3],
    `expected one dispatch per task, got loops ${dispatches.join(', ')}`);
  assert.equal(work.status, 'completed', 'the work step did not finish after covering every task');

  // ── And it moves on to report, unattended ──
  tickWorkflowsOnce();
  assert.equal(stepByName(runId, 'Verify Coverage').status, 'running',
    'the run stopped before reporting — the sweep never started');
});

test('the loop stops early when the tasks run out before the count does', () => {
  // The count is an upper bound on ATTEMPTS. A state doc that turns out to hold fewer real tasks
  // must not spend the remaining dispatches telling an agent to do nothing.
  seedAgent();
  const runId = startRun();

  tickWorkflowsOnce();
  const load = stepByName(runId, 'Load Epic');
  completeStepFromSignal(load.id, LOAD_RESULT);   // claims 3

  tickWorkflowsOnce();
  let work = stepByName(runId, 'Work Every Task');
  assert.equal(work.status, 'running');

  completeStepFromSignal(work.id, 'DONE fake-1 · commit abc1 · 2 remaining');
  work = stepByName(runId, 'Work Every Task');
  assert.equal(loopOf(work.config), 2, 'it did not re-dispatch for the second task');

  // The cartridge finds nothing left.
  completeStepFromSignal(work.id, 'ALL TASKS COMPLETE — 1 done, 0 skipped');

  work = stepByName(runId, 'Work Every Task');
  assert.equal(work.status, 'completed',
    'the sentinel did not end the loop — a third dispatch would go looking for work that is not there');
  assert.equal(loopOf(work.config), 2, 'it re-dispatched anyway after being told the work was done');
});

test('a run whose step 1 reports no count still runs once rather than zero times', () => {
  // The fallback that keeps a missing number from becoming a wild one — asserted through the
  // whole engine, not just the resolver, because "falls back" is only reassuring if the run
  // still makes progress.
  seedAgent();
  const runId = startRun();

  tickWorkflowsOnce();
  const load = stepByName(runId, 'Load Epic');
  completeStepFromSignal(load.id, 'EPIC: x\nSTATE: y\nROOT: /tmp\nTESTS: npm test');  // no TASKS line

  tickWorkflowsOnce();
  const work = stepByName(runId, 'Work Every Task');
  assert.equal(work.status, 'running');

  completeStepFromSignal(work.id, 'DONE fake-1 · commit abc1');
  const after = stepByName(runId, 'Work Every Task');
  assert.equal(resolvedOf(after.config), 1, 'a missing count did not fall back to a single pass');
  assert.equal(after.status, 'completed');
});
