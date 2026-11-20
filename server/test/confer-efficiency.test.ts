/**
 * A CONFER DOES ITS OWN JOB, ONCE, AND DOES NOT WAIT ON SILENCE.
 *
 * 2026-11-19: two features took most of a day. The run records showed where it went —
 *   · a 10-task stage ran THREE build rounds, then a cross-review, a converge and a finalize;
 *   · one task left open sent the run back through a whole five-milestone confer, twice (58 min
 *     and 33 min for one task);
 *   · a build round sat 344 min while participants were reminded 43 times, and the next one never
 *     ended because one idle cartridge did not send its done signal;
 *   · the cross-review inside the confer repeated what the Super QA stage after it does.
 *
 * What is checked here, each as a set:
 *   1. a single feature builds ONCE; only an epic builds in rounds, sized from its task count;
 *   2. the plan drops the milestones that repeat another's job — peer review when a QA stage
 *      follows, the merge step when every participant is in its own repo — for every mode;
 *   3. a pass for one or two leftover tasks is ONE milestone, sent only to the cartridge(s) whose
 *      repo owns them;
 *   4. the watchdog never reminds a cartridge that is working or waiting on a person, and an idle
 *      one that stays silent through two reminders is presumed done so the confer moves on;
 *   5. the prompts tell each participant to do only its own part and to say so at once when it
 *      has none.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import * as conductor from '../src/lib/confer-conductor.js';
import { resolveBuildRounds, LEFTOVER_MAX_TASKS, leftoverOwners } from '../src/lib/confer-sizing.js';
import { MAX_BUILD_ROUNDS } from '../src/lib/confer-conductor.js';
import { laterStageReviews } from '../src/lib/stage-steps.js';

const io = installStubIO();
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let seq = 0;

function agent(repo: string, status = 'idle') {
  const id = `eff-${repo}-${++seq}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen)
    VALUES (?,?,'test',?,?,'claude',?,?)`).run(id, id, `/tmp/eff-${repo}-${seq}`, repo, status, ago(0));
  io.connect(id); io.connectSocket(`sock-${id}`);
  return id;
}
const sentTo = (id: string) => (db.prepare('SELECT text FROM commands WHERE agent_id = ? ORDER BY created_at, rowid').all(id) as { text: string }[]).map((r) => r.text);
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
function toolCall(agentId: string, at: string) {
  db.prepare(`INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, tool_result, timestamp)
    VALUES (?, ?, 'PostToolUse', 'Bash', '{}', '', ?)`).run(crypto.randomUUID(), agentId, at);
}

// ── 1. how many build rounds ──────────────────────────────────────────────────

test('a single feature builds ONCE; an epic builds in rounds sized from its task count — every count, every team size', () => {
  const from = { step: 'Scope the Work', pattern: 'TASK_COUNT:\\s*(\\d+)', tasksPerRound: 2 };
  const scope = (mode: string, tasks: number | string) => `MODE: ${mode}\nSTATE: docs/progress/x.md\nTASK_COUNT: ${tasks}\nOBJECTIVE: do it`;
  const rounds = (cfg: Record<string, unknown>, people: number, out: string) =>
    resolveBuildRounds({ buildRounds: 1, buildRoundsFrom: from, ...cfg }, people, { 'Scope the Work': out });

  for (const people of [2, 3, 4]) for (const tasks of [1, 2, 4, 5, 10, 12, 40, 500]) {
    // A single feature: one build, however many parts Scope listed.
    const single = rounds({}, people, scope('TASK', tasks));
    assert.equal(single.rounds, 1, `single feature, ${tasks} parts / ${people} people → ${single.rounds} rounds`);
    assert.match(single.note, /single feature/i);
    // An epic: two tasks per participant per round, up to the ceiling.
    const epic = rounds({}, people, scope('EPIC GRD-42', tasks));
    assert.equal(epic.rounds, Math.min(MAX_BUILD_ROUNDS, Math.ceil(tasks / (people * 2))), `epic, ${tasks} tasks / ${people} people`);
    assert.match(epic.note, /epic/i);
  }
  // The 2026-11-19 case: 10 parts of ONE feature on two cartridges got 3 rounds. Now 1.
  assert.equal(rounds({}, 2, scope('TASK', 10)).rounds, 1);
  assert.equal(rounds({}, 2, scope('EPIC S12', 10)).rounds, 3);
  // Back from a coverage check with tasks open: an epic is sized to what is LEFT, a feature is still one build.
  assert.equal(rounds({ _coverageRemaining: 9 }, 2, scope('EPIC S12', 40)).rounds, 3);
  assert.equal(rounds({ _coverageRemaining: 9 }, 2, scope('TASK', 40)).rounds, 1);
  // Anything unreadable is a single build, never a guess at several: no MODE line, no count, no output.
  assert.equal(rounds({}, 2, 'TASK_COUNT: 12').rounds, 1);
  assert.equal(rounds({}, 2, scope('EPIC S12', 'unknown')).rounds, 1);
  assert.equal(resolveBuildRounds({ buildRounds: 1, buildRoundsFrom: from }, 2, {}).rounds, 1);
  // A step may cap an epic's rounds; and a confer with no sizing rule keeps the number it was given.
  assert.equal(rounds({ maxBuildRounds: 5 }, 2, scope('EPIC S12', 500)).rounds, 5);
  assert.equal(resolveBuildRounds({ buildRounds: 3 }, 2, {}).rounds, 3);
});

test('the Confer template builds once unless Scope says it is an epic', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/templates/confer.ts', import.meta.url), 'utf8');
  assert.match(src, /buildRounds: 1,/);
  assert.doesNotMatch(src, /buildRounds: [2-9]/);
  assert.match(src, /MODE: EPIC <KEY> \| TASK/, 'Scope must still report the mode the sizing reads');
});

// ── 2. the plan ───────────────────────────────────────────────────────────────

test('the plan leaves out the milestones that repeat another job — for every mode, round count and combination', () => {
  const REVIEW_KEYS = new Set(['review', 'critique', 'revise']);
  const MERGE_KEYS = new Set(['converge']);
  for (const mode of conductor.CONFER_MODES) for (const rounds of [1, 2]) for (const peerReview of [true, false]) for (const merge of [true, false]) {
    const full = conductor.conferPlan(mode, rounds).map((m) => m.key);
    const plan = conductor.conferPlan(mode, rounds, { peerReview, merge }).map((m) => m.key);
    const expected = full.filter((k) => (peerReview || !REVIEW_KEYS.has(k)) && (merge || !MERGE_KEYS.has(k)));
    assert.deepEqual(plan, expected, `${mode} ×${rounds} review=${peerReview} merge=${merge}`);
    // Whatever is dropped, it still opens by agreeing, builds `rounds` times and lands the result.
    assert.equal(plan[0], full[0]);
    assert.equal(plan.filter((k) => k === conductor.iteratingKeyFor(mode)).length, rounds);
    assert.equal(plan[plan.length - 1], 'finalize');
  }
  // The shortest shape: agree, build, land.
  assert.deepEqual(conductor.conferPlan('divide', 1, { peerReview: false, merge: false }).map((m) => m.key), ['align', 'build', 'finalize']);
});

test('a started confer drops the merge step when every participant is in its own repo, and keeps it when two share one', async () => {
  const a = agent('front'); const b = agent('back');
  const apart = conductor.startConfer({ repoName: 'front', repoPath: '/tmp/x', participantIds: [a, b], task: 't', peerReview: false });
  await tick();
  assert.deepEqual(conductor.getConfer(apart.id)!.milestones!.map((m) => m.key), ['align', 'build', 'finalize']);
  conductor.cancelConfer(apart.id);

  const c = agent('same'); const d = agent('same');
  db.prepare('UPDATE agents SET repo_path = ? WHERE id IN (?, ?)').run('/tmp/eff-shared', c, d);
  const together = conductor.startConfer({ repoName: 'same', repoPath: '/tmp/eff-shared', participantIds: [c, d], task: 't' });
  await tick();
  assert.deepEqual(conductor.getConfer(together.id)!.milestones!.map((m) => m.key), ['align', 'build', 'review', 'converge', 'finalize']);
  conductor.cancelConfer(together.id);
});

test('a QA, review or audit stage later in the pipeline is what does the reviewing', () => {
  for (const later of [['Super QA'], ['CE: Phase 6 — Ship', 'Super QA'], ['Code Review & Audit'], ['Full QA Review']]) {
    assert.equal(laterStageReviews(later), true, later.join(' + '));
  }
  for (const later of [[], ['Confer'], ['CE: Phase 6 — Ship', 'CE: Phase 7 — Compound'], ['Epic: Task by Task']]) {
    assert.equal(laterStageReviews(later), false, later.join(' + ') || '(none)');
  }
});

// ── 3. leftovers ──────────────────────────────────────────────────────────────

test('leftover tasks go to the cartridge whose repo owns them — every outstanding line, every roster', () => {
  assert.equal(LEFTOVER_MAX_TASKS, 2);
  const roster = [{ id: 'a', repoName: 'baseback' }, { id: 'b', repoName: 'backend-interlag' }, { id: 'c', repoName: 'gl-dev' }];
  const fb = (lines: string[]) => ['[TASKS STILL OPEN — coverage pass 1 of at most 10: 9 of 10 done, 1 open.]', ...lines.map((l) => `- ${l}`)].join('\n');
  const cases: [string[], string[]][] = [
    [['S12-07 screen guard — baseback — ran out of rounds'], ['a']],
    [['S12-07 screen guard — Backend-Interlag — blocked by S12-03'], ['b']],
    [['T1 x — baseback — never claimed', 'T2 y — gl-dev — never claimed'], ['a', 'c']],
    [['T1 x — baseback — never claimed', 'T2 y — baseback — blocked'], ['a']],
    // No repo named, or one nobody here owns: everyone gets it rather than nobody.
    [['T1 something with no repo'], ['a', 'b', 'c']],
    [['T1 x — some-other-repo — never claimed'], ['a', 'b', 'c']],
    [[], ['a', 'b', 'c']],
  ];
  for (const [lines, want] of cases) assert.deepEqual(leftoverOwners(fb(lines), roster), want, lines.join(' | ') || '(no lines)');
  // "baseback" must not match inside another repo's name.
  assert.deepEqual(leftoverOwners(fb(['T1 x — baseback-admin — open']), [{ id: 'a', repoName: 'baseback' }, { id: 'z', repoName: 'baseback-admin' }]), ['z']);
});

test('a leftover pass is ONE milestone to its owner alone: no align, no review, and its done signal ends the session', async () => {
  const owner = agent('baseback'); const other = agent('backend');
  const task = '[TASKS STILL OPEN — 9 of 10 done, 1 open.]\n- S12-07 screen guard — baseback — ran out of rounds\n\nThe brief.';
  const before = sentTo(other).length;
  const s = conductor.startConfer({ repoName: 'baseback', repoPath: '/tmp/eff-left', participantIds: [owner], task, leftover: true, buildRounds: 3 });
  await tick();
  const session = conductor.getConfer(s.id)!;
  assert.deepEqual(session.milestones!.map((m) => m.key), ['leftover'], 'one milestone, whatever rounds were asked for');
  assert.deepEqual(session.participantIds, [owner]);
  assert.equal(sentTo(other).length, before, 'the cartridge that owns none of it was sent nothing');
  const prompt = sentTo(owner).at(-1)!;
  assert.match(prompt, /Milestone 1\/1/);
  assert.match(prompt, /S12-07 screen guard/);
  assert.match(prompt, /ONLY/);
  assert.match(prompt, /git push/);
  assert.match(prompt, new RegExp(`/api/confer/${s.id}/milestone/${owner}/done`));
  assert.doesNotMatch(prompt, /Align|Cross-review|Converge|split the work/i);
  assert.deepEqual(conductor.recordMilestoneDone(s.id, owner, 'S12-07 done, pushed'), { ok: true });
  assert.equal(conductor.getConfer(s.id)!.status, 'completed');
});

// ── 4. the watchdog ───────────────────────────────────────────────────────────

/** A two-cartridge session on its build milestone, opened `age` ago; `done` reported, `slow` did not. */
async function onBuild(slowStatus: string, age: number) {
  const done = agent(`wd-${slowStatus}`, 'idle');
  const slow = agent(`wd-${slowStatus}`, slowStatus);
  const s = conductor.startConfer({ repoName: 'wd', repoPath: '/tmp/eff-wd', participantIds: [done, slow], task: 'wd', buildRounds: 1 });
  await tick();
  db.prepare("UPDATE confer_milestones SET status='done',done_ids=?,completed_at=? WHERE session_id=? AND idx=0").run(JSON.stringify([done, slow]), ago(age), s.id);
  db.prepare("UPDATE confer_milestones SET status='active',done_ids=?,dispatched_at=?,nudged=0 WHERE session_id=? AND idx=1").run(JSON.stringify([done]), ago(age), s.id);
  db.prepare('UPDATE confer_sessions SET current_milestone=1 WHERE id=?').run(s.id);
  return { id: s.id, slow, done };
}
const reminders = (id: string) => sentTo(id).filter((t) => /Confer · reminder/.test(t)).length;

test('a cartridge that is working, or waiting on a person, is never reminded and never presumed done — however long it takes', async () => {
  for (const status of ['working', 'waiting']) for (const age of [9 * MIN, 30 * MIN, 3 * 60 * MIN]) {
    const s = await onBuild(status, age);
    for (let i = 0; i < 3; i++) conductor.reconcileConfers();
    assert.equal(reminders(s.slow), 0, `${status} after ${age / MIN} min was reminded`);
    const after = conductor.getConfer(s.id)!;
    assert.equal(after.status, 'running');
    assert.equal(after.currentMilestone, 1, `${status} after ${age / MIN} min: the milestone moved on without it`);
    assert.deepEqual(after.milestones![1].doneIds, [s.done]);
    conductor.cancelConfer(s.id);
  }
});

test('an idle cartridge that used a tool a moment ago is still at it: not reminded', async () => {
  const s = await onBuild('idle', 30 * MIN);
  toolCall(s.slow, ago(1 * MIN));
  conductor.reconcileConfers(); conductor.reconcileConfers();
  assert.equal(reminders(s.slow), 0);
  assert.equal(conductor.getConfer(s.id)!.currentMilestone, 1);
  conductor.cancelConfer(s.id);
});

test('an idle, silent cartridge is reminded — and after two reminders with no answer it is presumed done and the confer moves on', async () => {
  // Under the first reminder: nothing yet.
  const early = await onBuild('idle', 5 * MIN);
  conductor.reconcileConfers();
  assert.equal(reminders(early.slow), 0);
  conductor.cancelConfer(early.id);

  // One reminder due: reminded, not presumed.
  const once = await onBuild('idle', 9 * MIN);
  conductor.reconcileConfers(); conductor.reconcileConfers();
  assert.equal(reminders(once.slow), 1, 'one reminder per stall window, not one per sweep');
  assert.equal(conductor.getConfer(once.id)!.currentMilestone, 1);
  conductor.cancelConfer(once.id);

  // Past the second reminder and still silent.
  const s = await onBuild('idle', 25 * MIN);
  conductor.reconcileConfers();
  assert.equal(conductor.getConfer(s.id)!.currentMilestone, 1, 'presumed before it was ever reminded');
  assert.equal(reminders(s.slow), 1);
  conductor.reconcileConfers();
  await tick();
  const after = conductor.getConfer(s.id)!;
  assert.equal(after.status, 'running');
  assert.equal(after.currentMilestone, 2, 'the confer did not move on');
  assert.equal(after.milestones![1].status, 'done');
  const results = JSON.parse((db.prepare('SELECT results FROM confer_milestones WHERE session_id=? AND idx=1').get(s.id) as { results: string }).results);
  assert.match(results[s.slow], /PRESUMED DONE/);
  assert.match(String((db.prepare('SELECT error FROM confer_sessions WHERE id=?').get(s.id) as { error: string }).error), /presumed done/i, 'the session must say it happened');
  conductor.cancelConfer(s.id);
});

// ── 5. the prompts ────────────────────────────────────────────────────────────

test('every agreeing and building prompt says: your own part only, and say so at once when you have none', async () => {
  for (const mode of conductor.CONFER_MODES) for (const rounds of [1, 2]) {
    const a = agent(`pr-${mode}-a`); const b = agent(`pr-${mode}-b`);
    const s = conductor.startConfer({ repoName: 'pr', repoPath: '/tmp/eff-pr', participantIds: [a, b], task: 'the task', mode, buildRounds: rounds });
    await tick();
    const session = conductor.getConfer(s.id)!;
    const me = { id: a, agentType: 'claude', name: a, status: 'idle', repoPath: '/tmp/a' };
    const peer = { id: b, agentType: 'claude', name: b, status: 'idle', repoPath: '/tmp/b' };
    session.milestones!.forEach((m, idx) => {
      const prompt = conductor.buildMilestonePrompt(session, idx, me, [peer], {});
      if (idx === 0) assert.match(prompt, /only (the|your) part/i, `${mode} ×${rounds} ${m.name}: no ownership rule`);
      if (m.key === conductor.iteratingKeyFor(mode) || idx === 0) {
        assert.match(prompt, /NOTHING OF YOURS/, `${mode} ×${rounds} ${m.name}: no fast exit for a participant with nothing to do`);
      }
      if (m.key === conductor.iteratingKeyFor(mode)) {
        assert.match(prompt, /do not (review|test|redo)/i, `${mode} ×${rounds} ${m.name}: building must not drift into reviewing`);
      }
    });
    conductor.cancelConfer(s.id);
  }
});
