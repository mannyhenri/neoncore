import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { completeStepFromSignal, tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import { loopCountRequirements, madeNoProgress, personAskFrom, type LoopConfig } from '../src/lib/workflow-loop.ts';

/**
 * A LOOP THAT IS NOT MOVING STOPS — AND SAYS WHAT IT IS WAITING FOR.
 *
 * LIVE FAILURE, 2026-11-21/22, run 26cf47f8 (Gridlight "Sharding", CE Develop and Optimize). The
 * develop step was dispatched 314 times, 288 of them under a minute apart. From dispatch ~3 on,
 * every answer was the same in substance:
 *
 *   "Pass 2, dispatch 103 of 103: no task workable. T3 (next outstanding) is WAITING ON the
 *    person's v2 prompts lock … every further dispatch is a no-op. 3 remaining.
 *    NEXT: Person: lock docs/…/prompts.proposed-v2.json as contract v2 and lift the pause"
 *
 * The repeat guard (LOOP-003) only knows a report that LEADS with DONE/BLOCKED/SKIPPED, so it
 * never fired, and "3 remaining" extended the budget a hundred times. Tokens burned for nothing,
 * and the one thing that would have moved the run — the person's decision — was never asked.
 *
 * THE RULE: a dispatch that finished no task and left the remaining count where it was made no
 * progress (the first dispatch is measured against the count it was given). One that says outright
 * that nothing can be worked ends the loop at once; two no-progress dispatches in a row end it. Either way the person is told — as "needs you", with
 * the agent's own ask — instead of the loop extending itself.
 *
 * SET-BASED over every seeded looped template step (the engine composes the loop, not a template)
 * × every no-progress shape seen live; and the controls: progress never stops a loop early.
 */
const io = installStubIO();
const AGENT = 'loop-np-agent';
const COUNT = 3;   // what the upstream step will claim, for every pattern it owes

function seedAgent(): void {
  io.connect(AGENT);
  db.prepare(`INSERT OR REPLACE INTO agents
      (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
      VALUES (?, 'box/loop-repo', 'box', '/tmp/loop-repo', 'loop-repo', 'idle', ?, 'sess-1', 'claude')`)
    .run(AGENT, new Date().toISOString());
}

interface LoopedStep { templateId: string; templateName: string; stepName: string; config: LoopConfig & Record<string, unknown> }

/** THE SET: every step in every seeded template that the engine re-dispatches. */
function loopedTemplateSteps(): LoopedStep[] {
  const rows = db.prepare(`
    SELECT w.id AS template_id, w.name AS template_name, s.name AS step_name, s.executor_config AS cfg
      FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
     WHERE w.template_id IS NULL
     ORDER BY w.name, s.created_at
  `).all() as { template_id: string; template_name: string; step_name: string; cfg: string }[];
  return rows
    .map((r) => ({ templateId: r.template_id, templateName: r.template_name, stepName: r.step_name, config: JSON.parse(r.cfg) }))
    .filter((r) => !!r.config.loopCountFrom?.step || (Number(r.config.loopCount) || 1) > 1);
}

/**
 * A line that satisfies a loop-count pattern, for the sibling that owes it. Derived from the
 * pattern itself rather than hardcoded per template, and checked against the same RegExp the
 * reader uses — a pattern this cannot sample fails the test loudly instead of quietly skipping.
 */
function sampleFor(pattern: string): string {
  // An optional literal (`TASKS:?`) is written as present — the documented form of the line.
  const line = pattern.replace(/(\\?[^\\()])\?/g, '$1')
    .replace(/\\s\*/g, ' ').replace(/\(\\d\+\)/g, String(COUNT)).replace(/\\/g, '');
  assert.ok(new RegExp(pattern).test(line), `could not build a sample for /${pattern}/ — got "${line}"`);
  return line;
}

function startRun(templateId: string): string {
  // A cartridge runs one step at a time (workflow-executor-v2 cartridgeHold): a run left mid-flight
  // by an earlier test on this same fake cartridge would hold this one. End them first.
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  const runId = cloneTemplateAsRun(templateId, null, 'docs/plans/EPIC-fake.md');
  assert.ok(runId, 'cloneTemplateAsRun returned nothing');
  db.prepare('UPDATE workflow_steps SET executor_id = ? WHERE workflow_id = ?').run(AGENT, runId);
  db.prepare("UPDATE workflows SET status = 'running' WHERE id = ?").run(runId!);
  return runId!;
}

interface StepRow { id: string; name: string; status: string; executor_config: string; dispatched_prompt: string }
const stepByName = (runId: string, name: string): StepRow => {
  const r = db.prepare('SELECT id, name, status, executor_config, dispatched_prompt FROM workflow_steps WHERE workflow_id = ? AND name = ?')
    .get(runId, name) as StepRow | undefined;
  assert.ok(r, `no step named "${name}"`);
  return r!;
};
const cfgOf = (s: StepRow) => JSON.parse(s.executor_config) as Record<string, unknown>;

/** Complete every running upstream step with whatever counts it owes until `target` is running. */
function driveTo(runId: string, target: string): StepRow {
  for (let guard = 0; guard < 12; guard++) {
    tickWorkflowsOnce();
    const t = stepByName(runId, target);
    if (t.status === 'running') return t;
    const running = db.prepare(
      "SELECT id, name FROM workflow_steps WHERE workflow_id = ? AND status = 'running' AND name != ?",
    ).all(runId, target) as { id: string; name: string }[];
    assert.ok(running.length > 0, `nothing running and "${target}" is ${t.status} — the run is stuck`);
    const siblings = (db.prepare('SELECT name, executor_config FROM workflow_steps WHERE workflow_id = ?').all(runId) as { name: string; executor_config: string }[])
      .map((s) => ({ name: s.name, config: JSON.parse(s.executor_config) as LoopConfig }));
    for (const r of running) {
      const owed = loopCountRequirements(r.name, siblings).map((o) => sampleFor(o.pattern));
      assert.ok(completeStepFromSignal(r.id, ['Upstream done.', ...owed].join('\n')), `"${r.name}" would not complete`);
    }
  }
  assert.fail(`"${target}" never started`);
}

/** The re-dispatch is fired without being awaited; let the prompt write land. */
const settle = () => new Promise<void>((r) => setImmediate(r));


interface Shape { name: string; reports: string[]; stopsAfter: number }
const ASK = 'NEXT: Person: lock docs/pipeline-shard-72b/prompts.proposed-v2.json as contract v2 and lift the pause.';
/** THE SET of no-progress shapes. `stopsAfter`: the dispatch after which the loop must have ended. */
const STALLS: Shape[] = [
  { name: 'says nothing can be worked (prose, no verdict)', stopsAfter: 1,
    reports: [`Pass 2, dispatch 1 of ${COUNT}: no task workable. T3 is WAITING ON the person's v2 prompts lock; T7 waits on the same lock. ${COUNT} remaining.\n${ASK}`] },
  { name: 'says every further dispatch is a no-op', stopsAfter: 1,
    reports: [`Nothing ran. Until the lock lands every further dispatch is a no-op. ${COUNT} remaining.\n${ASK}`] },
  { name: 'prose, same count twice, no task finished', stopsAfter: 2,
    reports: [`Looked at T3 again; still waiting on its input. ${COUNT} remaining.`, `Checked T3; nothing changed. ${COUNT} remaining.`] },
  { name: 'BLOCKED on a different task each time, count never drops', stopsAfter: 2,
    reports: [`BLOCKED T-1 · ${COUNT} remaining`, `BLOCKED T-2 · ${COUNT} remaining`] },
];

const notices = () => io.emissions.filter((e) => e.event === 'workflow_notification').map((e) => e.payload as { title: string; body: string; kind: string });

for (const shape of STALLS) {
  test(`every looped template step × ${shape.name}: the loop ends and the person is asked`, async () => {
    seedAgent();
    for (const looped of loopedTemplateSteps()) {
      const label = `${looped.templateName} / ${looped.stepName}`;
      const runId = startRun(looped.templateId);
      const step = driveTo(runId, looped.stepName);
      const before = notices().length;
      for (let i = 0; i < shape.reports.length; i++) {
        assert.ok(completeStepFromSignal(step.id, shape.reports[i]), `${label}: completion ${i + 1} rejected`);
        await settle();
        const now = stepByName(runId, looped.stepName);
        if (i + 1 < shape.stopsAfter) assert.equal(now.status, 'running', `${label}: stopped after ${i + 1}, before the stall was established`);
      }
      const after = stepByName(runId, looped.stepName);
      assert.notEqual(after.status, 'running', `${label}: still re-dispatching after ${shape.stopsAfter} no-progress dispatch(es) (loop ${cfgOf(after)._currentLoop})`);
      assert.ok(!cfgOf(after)._loopExtensions, `${label}: a no-progress report extended the budget`);
      const told = notices().slice(before).filter((n) => /not moving|waiting/i.test(n.title));
      assert.equal(told.length, 1, `${label}: expected one notice that the loop stopped, got ${JSON.stringify(notices().slice(before).map((n) => n.title))}`);
      assert.equal(told[0].kind, 'needs-you', `${label}: a loop waiting on progress is the person's to unblock, not a failure`);
      if (shape.reports.some((r) => r.includes(ASK))) assert.match(told[0].body, /lock docs\/pipeline-shard-72b/, `${label}: the agent's ask is not in the notice`);
    }
  });
}

test('every looped template step: a loop that finishes a task each dispatch is never stopped early, and still extends when work grew', async () => {
  seedAgent();
  for (const looped of loopedTemplateSteps()) {
    const label = `${looped.templateName} / ${looped.stepName}`;
    const runId = startRun(looped.templateId);
    const step = driveTo(runId, looped.stepName);
    // The epic grew by one: COUNT dispatches, each DONE, the count dropping by one — but the last still says 1 remaining.
    for (let i = 1; i <= COUNT; i++) {
      assert.ok(completeStepFromSignal(step.id, `DONE T-${i} · commit c${i} · ${COUNT + 1 - i} remaining`));
      await settle();
      assert.equal(stepByName(runId, looped.stepName).status, 'running', `${label}: stopped after DONE T-${i} with work left`);
    }
    if (looped.config.loopCountFrom?.step) assert.equal(cfgOf(stepByName(runId, looped.stepName))._loopExtensions, 1, `${label}: did not extend for the task that appeared`);
  }
});

// ── the pure pieces ─────────────────────────────────────────────────────────────

test('madeNoProgress over every report shape', () => {
  const cases: { prev: number | null; result: string; want: boolean; why: string }[] = [
    { prev: 3, result: 'DONE T-3 · commit a · 2 remaining', want: false, why: 'finished a task' },
    { prev: 3, result: 'DONE T-3 · commit a · 3 remaining', want: false, why: 'finished a task even though the epic grew' },
    { prev: 3, result: 'BLOCKED T-4 · 3 remaining', want: true, why: 'nothing finished, count unchanged' },
    { prev: 3, result: 'Still waiting on T3. 3 remaining.', want: true, why: 'prose, count unchanged' },
    { prev: 3, result: 'Fixed half of T3. 2 remaining.', want: false, why: 'the count dropped' },
    { prev: null, result: 'BLOCKED T-1 · 3 remaining', want: false, why: 'nothing to compare with yet' },
    { prev: 3, result: 'Worked on it.', want: false, why: 'no count: silence is not evidence' },
    { prev: null, result: 'no task workable — all three wait on the person. 3 remaining.', want: true, why: 'says so outright' },
    { prev: null, result: 'every further dispatch is a no-op until the lock lands', want: true, why: 'says so outright' },
    { prev: 3, result: 'ALL TASKS COMPLETE — 10 done', want: false, why: 'the sentinel is progress' },
  ];
  for (const c of cases) assert.equal(madeNoProgress(c.prev, c.result).stalled, c.want, `${c.why}: ${c.result}`);
  assert.equal(madeNoProgress(null, 'no task workable. 3 remaining.').explicit, true);
  assert.equal(madeNoProgress(3, 'BLOCKED T-4 · 3 remaining').explicit, false);
});

test('personAskFrom: the agent\'s ask of a person, or empty', () => {
  assert.equal(personAskFrom(`blah\n${ASK}\n---`), 'Person: lock docs/pipeline-shard-72b/prompts.proposed-v2.json as contract v2 and lift the pause.');
  assert.equal(personAskFrom('DONE T-1 · 2 remaining\nNEXT: T-2 — wire the parser'), '', 'a NEXT naming the agent\'s own next task is not an ask');
  assert.equal(personAskFrom('NEXT: you need to approve the schema change before T4 can start'), 'you need to approve the schema change before T4 can start');
  assert.equal(personAskFrom('no next line here'), '');
});
