// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { completeStepFromSignal, tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import {
  loopCountRequirements, loopClaim, isRepeatedClaim, loopDispatchHeader,
  configForNextLoop, configForRerun, LOOP_RUN_KEYS, PER_DISPATCH_KEYS,
  type LoopConfig,
} from '../src/lib/workflow-loop.ts';

/**
 * LOOP-003 — a re-dispatched loop iteration must not be byte-identical to the one before it.
 *
 * LIVE FAILURE, four runs in this database on 2026-09-10/11. `Work Every Task` is one step the
 * engine re-dispatches once per task. The prompt it composes has no idea which dispatch it is:
 * loop 1 and loop 2 of run e2dce42a were compared byte for byte and were IDENTICAL (9507 chars).
 * So the cartridge, still in the same session, receives the exact message it just finished
 * answering, one second after its `report_step_done` returned. Three observed reactions:
 *
 *   · run 42a34028: "Duplicate dispatch confirmed" — re-reported `BLOCKED LFC-001 · 29 remaining`
 *     every ten seconds; the "29 remaining" extended the budget 100 times.
 *   · run 0949fba6: went quiet; the stall nudge eleven minutes later produced a re-report of the
 *     task ALREADY done (`DONE GRD-3969` twice), which advanced the loop, which re-sent the same
 *     prompt, which went quiet — eleven loops burned with no new work, "1/6 nudges" forever.
 *   · run 1a299cbd: worked all nine tasks. The model got lucky; the engine had told it nothing.
 *
 * From the user's chair every one of these is "I started an epic and it is not continuing".
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────
 * Dispatch k ≥ 2 carries a loop header: which dispatch this is out of how many, what dispatch
 * k-1 reported, and an explicit instruction to take the NEXT task rather than re-report. And
 * a dispatch that repeats the previous dispatch's claim (same verdict, same task id, same
 * remaining count) ends the loop instead of advancing it — that is a cartridge not moving, and
 * every further dispatch would only repeat it.
 *
 * SET-BASED over every seeded template step that loops, because the header is composed by the
 * ENGINE, not by a template: a fix that touched only "Work Every Task" would leave both sides of
 * `Epic: Two Repos` sending duplicates.
 */

const io = installStubIO();
const AGENT = 'loop-003-agent';
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

test('THE SET: the seeded templates contain the looped steps this test covers', () => {
  const names = loopedTemplateSteps().map((s) => `${s.templateName} / ${s.stepName}`);
  assert.ok(names.length >= 3, `expected at least 3 looped template steps, found ${names.length}: ${names.join(', ')}`);
  for (const want of ['Epic: Task by Task / Work Every Task', 'Epic: Two Repos / Work Repo A', 'Epic: Two Repos / Work Repo B']) {
    assert.ok(names.includes(want), `${want} is not among the looped steps: ${names.join(', ')}`);
  }
});

test('every looped template step: dispatch 2 differs from dispatch 1 and says which dispatch it is', async () => {
  seedAgent();
  for (const looped of loopedTemplateSteps()) {
    const label = `${looped.templateName} / ${looped.stepName}`;
    const runId = startRun(looped.templateId);
    const first = driveTo(runId, looped.stepName);
    const p1 = first.dispatched_prompt;
    assert.ok(p1.length > 0, `${label}: dispatch 1 recorded no prompt`);
    assert.ok(!p1.includes('[Workflow loop'), `${label}: dispatch 1 carries a loop header before any loop has happened`);

    const claim = `DONE T-1 · commit abc1 · ${COUNT - 1} remaining`;
    assert.ok(completeStepFromSignal(first.id, claim), `${label}: completion 1 was rejected`);
    await settle();

    const second = stepByName(runId, looped.stepName);
    assert.equal(second.status, 'running', `${label}: did not re-dispatch after dispatch 1`);
    assert.equal(cfgOf(second)._currentLoop, 2, `${label}: loop counter did not advance`);
    const p2 = second.dispatched_prompt;

    assert.notEqual(p2, p1, `${label}: dispatch 2 is byte-identical to dispatch 1 — the cartridge cannot tell it is new work`);
    assert.ok(p2.includes(`dispatch 2 of ${COUNT}`), `${label}: dispatch 2 does not say which dispatch it is:\n${p2.slice(0, 400)}`);
    assert.ok(p2.includes('DONE T-1'), `${label}: dispatch 2 does not carry what dispatch 1 reported`);
    assert.ok(/NEW dispatch/.test(p2), `${label}: dispatch 2 does not tell the cartridge this is not a repeat`);
    if (looped.config.loopUntil) {
      assert.ok(p2.includes(looped.config.loopUntil), `${label}: dispatch 2 does not name the stop sentinel "${looped.config.loopUntil}"`);
    }
    // The header must lead: it is the first thing a cartridge reads after a message it has seen before.
    const bodyStart = p2.indexOf('[Output from previous step');
    const headerStart = p2.indexOf('[Workflow loop');
    assert.ok(headerStart >= 0 && (bodyStart < 0 || headerStart < bodyStart), `${label}: the loop header is not ahead of the dependency context`);
  }
});

test('every looped template step: a dispatch that repeats the previous report ends the loop instead of advancing it', async () => {
  seedAgent();
  for (const looped of loopedTemplateSteps()) {
    const label = `${looped.templateName} / ${looped.stepName}`;
    const runId = startRun(looped.templateId);
    const first = driveTo(runId, looped.stepName);

    const claim = `BLOCKED T-1 · ${COUNT} remaining`;   // "remaining" alone would extend the budget forever
    assert.ok(completeStepFromSignal(first.id, claim));
    await settle();
    assert.equal(stepByName(runId, looped.stepName).status, 'running', `${label}: a first BLOCKED must still re-dispatch`);

    // The cartridge says the very same thing again: it is not moving.
    assert.ok(completeStepFromSignal(first.id, `${claim}. Duplicate dispatch confirmed, nothing runnable.`));
    await settle();
    const after = stepByName(runId, looped.stepName);
    assert.equal(after.status, 'completed', `${label}: a repeated report re-dispatched (loop ${cfgOf(after)._currentLoop}) instead of ending the loop`);
    assert.equal(cfgOf(after)._currentLoop, 2, `${label}: loop advanced past the repeat`);

    const journal = db.prepare("SELECT message FROM workflow_journal WHERE workflow_id = ? AND step_id = ? AND event_type = 'warn'")
      .all(runId, first.id) as { message: string }[];
    assert.ok(journal.some((j) => /repeat/i.test(j.message)), `${label}: the journal does not say the loop ended on a repeated report`);
  }
});

// ── The pure pieces, set-based over the shapes real cartridges produce ─────────────────────

const CLAIMS: { result: string; want: ReturnType<typeof loopClaim> }[] = [
  { result: 'DONE WIRE-012 · commit dcb963c · 1 remaining\n\nWorked the task.', want: { verdict: 'DONE', taskId: 'WIRE-012', remaining: 1 } },
  { result: 'BLOCKED LFC-001 · 29 remaining. The registry-derived contract…', want: { verdict: 'BLOCKED', taskId: 'LFC-001', remaining: 29 } },
  { result: 'SKIPPED SHIP-010 · 11 remaining', want: { verdict: 'SKIPPED', taskId: 'SHIP-010', remaining: 11 } },
  { result: 'Some preamble first.\ndone GRD-3969 · commit 9dd · 20 remaining', want: { verdict: 'DONE', taskId: 'GRD-3969', remaining: 20 } },
  { result: 'DONE fake-1 · commit abc1', want: { verdict: 'DONE', taskId: 'fake-1', remaining: null } },
  { result: 'ALL TASKS COMPLETE — 9 done', want: null },
  { result: 'Completed GRD-3969 Parser adapters, transitioned Jira to Done', want: null },   // no verdict token: no claim
  { result: '', want: null },
];

test('loopClaim reads the verdict, the task id and the remaining count from every report shape', () => {
  for (const c of CLAIMS) assert.deepEqual(loopClaim(c.result), c.want, `for: ${JSON.stringify(c.result)}`);
});

const REPEATS: { prev: string | undefined; cur: string; want: boolean; why: string }[] = [
  { prev: 'BLOCKED LFC-001 · 29 remaining', cur: 'BLOCKED LFC-001 · 29 remaining. Duplicate dispatch.', want: true, why: 'same verdict, id and count' },
  { prev: 'DONE GRD-3969 · commit 9dd · 20 remaining', cur: 'DONE GRD-3969 · commit 9dd · 20 remaining', want: true, why: 'a re-report of a finished task' },
  { prev: 'done grd-3969 · 20 remaining', cur: 'DONE GRD-3969 · 20 remaining', want: true, why: 'case does not make it new work' },
  { prev: 'DONE T-1 · 2 remaining', cur: 'DONE T-2 · 1 remaining', want: false, why: 'the next task' },
  { prev: 'BLOCKED T-1 · 3 remaining', cur: 'DONE T-1 · 2 remaining', want: false, why: 'a retry that succeeded' },
  { prev: 'DONE T-1 · 3 remaining', cur: 'DONE T-1 · 2 remaining', want: false, why: 'same id but the count moved — something happened' },
  { prev: 'DONE T-1 · 2 remaining', cur: 'ALL TASKS COMPLETE', want: false, why: 'the sentinel is never a repeat' },
  { prev: undefined, cur: 'DONE T-1 · 2 remaining', want: false, why: 'nothing to repeat on the first dispatch' },
  { prev: 'Worked on things', cur: 'Worked on things', want: false, why: 'prose without a claim is not judged' },
];

test('isRepeatedClaim: only an identical verdict + task + remaining is a repeat', () => {
  for (const r of REPEATS) assert.equal(isRepeatedClaim(r.prev, r.cur), r.want, `${r.why}: ${JSON.stringify([r.prev, r.cur])}`);
});

test('loopDispatchHeader: nothing on dispatch 1, a leading header with the previous report after that', () => {
  assert.equal(loopDispatchHeader({ stepName: 'X', currentLoop: 1, loopCount: 5 }), '');
  const h = loopDispatchHeader({ stepName: 'Work Every Task', currentLoop: 3, loopCount: 7, previousResult: 'DONE T-2 · commit b · 5 remaining\n\nlong body', loopUntil: 'ALL TASKS COMPLETE' });
  assert.ok(h.startsWith('[Workflow loop'), h);
  assert.ok(h.includes('dispatch 3 of 7'), h);
  assert.ok(h.includes('DONE T-2 · commit b · 5 remaining'), h);
  assert.ok(!h.includes('long body'), 'only the first line of the previous report is carried');
  assert.ok(h.includes('ALL TASKS COMPLETE'), h);
  assert.ok(h.endsWith('\n\n'), 'the header must be separated from what follows');
});

test('configForNextLoop carries the previous report and still clears every per-dispatch key', () => {
  const cfg: Record<string, unknown> = { loopCount: 1, _resolvedLoopCount: 4 };
  for (const k of PER_DISPATCH_KEYS) cfg[k] = 'stale';
  const next = configForNextLoop(cfg, 2, 'DONE T-1 · 3 remaining\nbody');
  assert.equal(next._currentLoop, 2);
  assert.equal(next._lastLoopResult, 'DONE T-1 · 3 remaining');
  assert.equal(next._resolvedLoopCount, 4);
  for (const k of PER_DISPATCH_KEYS) assert.ok(!(k in next), `${k} survived into the next dispatch`);
});

test('configForRerun clears every key a loop run writes, so a re-run reads a fresh count', () => {
  const cfg: Record<string, unknown> = { loopCount: 1, loopCountFrom: { step: 'S', pattern: 'N:(\\d+)' }, prompt: 'p' };
  for (const k of LOOP_RUN_KEYS) cfg[k] = 'stale';
  const fresh = configForRerun(cfg);
  for (const k of LOOP_RUN_KEYS) assert.ok(!(k in fresh), `${k} survived a re-run`);
  assert.deepEqual(fresh, { loopCount: 1, loopCountFrom: { step: 'S', pattern: 'N:(\\d+)' }, prompt: 'p' });
  // The run-level set contains the per-dispatch set: a key cleared per dispatch is certainly cleared per run.
  for (const k of PER_DISPATCH_KEYS) assert.ok((LOOP_RUN_KEYS as readonly string[]).includes(k), `${k} is per-dispatch but not per-run`);
});
