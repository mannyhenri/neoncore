/**
 * WORK MUST NOT STALL WHEN NOBODY IS WATCHING.
 *
 * Two faults, both found by leaving the fleet running unattended, and both with the same shape:
 * the system treats "not currently talking to me" as "broken or busy" when it means neither.
 *
 * ── 1. A CARTRIDGE WAITING ON NOTHING HELD ITS OWN LANE SHUT ───────────────────────────
 * `isCartridgeBusy()` returned true for `status = 'waiting'`. A cartridge that ended a session
 * in `waiting` with NO pending question is not blocked on anything — it is idle — but the queue
 * read it as busy, so its lane never drained. Observed live: three confers queued behind a
 * cartridge that had been doing nothing for half an hour, the oldest stalled 141 ticks. Nothing
 * in any UI said anything was wrong, because from the queue's point of view nothing was.
 *
 * ── 2. A PARTICIPANT THAT FINISHED BUT FORGOT TO REPORT KILLED THE WHOLE CONFER ────────
 * The conductor nudged once at 8 minutes and failed the session at 20, using ELAPSED TIME as
 * its only signal. It never asked whether the silent participant was alive. Eight confers died
 * this way — every one of them "Milestone X stalled — N participant(s) never reported" — and
 * the common case is the least deserving of failure: the agent did the work, went idle, and
 * simply never POSTed the done signal.
 *
 * Both test sets iterate the STATES rather than an example, because the bug in each case was a
 * missing branch, and an example-based test picks whichever branch happens to be written.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCartridgeBusy } from '../src/lib/queue-runner.ts';
import { reconcileConfers } from '../src/lib/confer-conductor.ts';

installStubIO();

let n = 0;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60 * 1000;

function agent(status: string, opts: { question?: string; seenMsAgo?: number; activeItem?: string } = {}): string {
  const id = `a-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status,
              last_seen, active_queue_item_id, pending_question)
              VALUES (?,?,'m',?,?,'claude',?,?,?,?)`)
    .run(id, `t/${id}`, `/r/${id}`, `r${id}`, status,
         iso(opts.seenMsAgo ?? 0), opts.activeItem ?? '', opts.question ?? '');
  return id;
}

// ── 1. the busy rule ──────────────────────────────────────────────────────────

/**
 * THE SET: every state a cartridge can be in, and whether the queue should hold work back.
 * "Busy" must mean "doing something, or blocked on a question a person still owes it" —
 * never "happens not to be idle-flagged".
 */
const BUSY_STATES: { label: string; make: () => string; busy: boolean; why: string }[] = [
  { label: 'working', make: () => agent('working'), busy: true, why: 'mid-task' },
  { label: 'working with a question', make: () => agent('working', { question: 'which file?' }), busy: true, why: 'mid-task' },
  {
    label: 'waiting WITH a real question',
    make: () => agent('waiting', { question: 'Should I delete the old table?' }),
    busy: true,
    why: 'genuinely blocked — a person owes it an answer, and new work must not jump the queue',
  },
  {
    label: 'waiting on NOTHING (the bug)',
    make: () => agent('waiting'),
    busy: false,
    why: 'stale status from a finished session — the cartridge is idle and its lane must drain',
  },
  { label: 'idle', make: () => agent('idle'), busy: false, why: 'available' },
  {
    label: 'offline',
    make: () => agent('offline'),
    busy: true,
    why:
      'it cannot take work NOW, so work aimed at it must QUEUE and wait for it to come back. ' +
      'This previously returned false, so a launch aimed at an offline cartridge dispatched ' +
      'immediately and the step died "Command not delivered" — the user reported it as the ' +
      'workflow simply not sending. The wait is already bounded: queue-runner budgets an ' +
      'unreachable target by MAX_STALL_TICKS and then halts the lane with a stated reason.',
  },
  {
    label: 'idle but holding a queue item',
    make: () => agent('idle', { activeItem: 'q-1' }),
    busy: true,
    why: 'already carrying queued work, whatever its status says',
  },
];

test('EVERY cartridge state reports busy correctly', () => {
  const wrong: string[] = [];
  for (const c of BUSY_STATES) {
    const got = isCartridgeBusy(c.make());
    if (got !== c.busy) wrong.push(`${c.label}: busy=${got}, expected ${c.busy} — ${c.why}`);
  }
  assert.deepEqual(wrong, [], `the busy rule misreads a cartridge state:\n  ${wrong.join('\n  ')}`);
});

/**
 * EVERY place that decides "this cartridge cannot take work" must use the same rule.
 *
 * The first fix corrected `isCartridgeBusy` and shipped — and nothing changed, because
 * `busyTargets()` held a second copy of the same comparison. One guards ENQUEUE, the other
 * guards DISPATCH, so fixing only the first left every queued item parked exactly as before.
 *
 * Scanned from SOURCE rather than listed, so a third copy added later is caught too: any
 * comparison against 'waiting' that decides availability must be guarded by pending_question.
 * `blockerIsWedged` is exempt and named — it asks "is this cartridge DEAD", where `waiting`
 * correctly means "no, a person owes it an answer".
 */
test('EVERY availability check applies the same waiting rule', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/queue-runner.ts'), 'utf8');
  const EXEMPT = ['blockerIsWedged'];
  const unguarded: string[] = [];

  for (const m of src.matchAll(/status === 'waiting'/g)) {
    const before = src.slice(0, m.index!);
    const fn = [...before.matchAll(/function (\w+)/g)].pop()?.[1] ?? '(top level)';
    if (EXEMPT.includes(fn)) continue;
    // The decision must consult pending_question on the same line or the next.
    const line = src.slice(m.index!, m.index! + 120);
    if (!/pending_question/.test(line)) unguarded.push(`${fn}: treats 'waiting' as busy with no question check`);
  }
  assert.deepEqual(unguarded, [],
    `these block work behind a cartridge that is idle:\n  ${unguarded.join('\n  ')}`);
});

test('an unknown or empty cartridge id is not busy', () => {
  // An agent that does not exist is different from one that is offline: nothing will ever
  // bring it back, so queueing against it would wait forever with nothing to release it.
  assert.equal(isCartridgeBusy(''), false);
  assert.equal(isCartridgeBusy('nope'), false);
});

/**
 * A CARTRIDGE YOU CANNOT SEE IS A CARTRIDGE YOU CANNOT CHOOSE.
 *
 * Every workflow-launch surface filtered `status !== 'offline'` out of its picker, so a
 * cartridge that happened to be disconnected was simply absent from the dropdown — with no
 * explanation. The user tried to run a workflow on `film-engine` while it was offline, found
 * nothing to select, and reported it as "it didn't work and didn't send it". Nothing was
 * broken; the option had been removed.
 *
 * Offline is now a queueable state, so these must OFFER the cartridge and mark it, not hide it.
 * Set-based over the launch surfaces because hiding it in one of three is the same bug.
 */
test('EVERY workflow-launch surface can still choose an offline cartridge', () => {
  const UI = resolve(dirname(fileURLToPath(import.meta.url)), '../../dashboard/src');
  const SURFACES = [
    { file: 'components/WorkflowPanel.tsx', what: 'launch a workflow run' },
    { file: 'components/GoalsPage.tsx', what: 'run a workflow from a project' },
    { file: 'components/WorkflowCanvasEditor.tsx', what: 'assign a cartridge to a step' },
  ];
  const hiding: string[] = [];
  for (const s of SURFACES) {
    const src = readFileSync(resolve(UI, s.file), 'utf8');
    if (/filter\(\(a\) => a\.status !== 'offline'\)/.test(src)) {
      hiding.push(`${s.file} (${s.what}) — offline cartridges are removed from the picker`);
    }
  }
  assert.deepEqual(hiding, [],
    `you cannot launch onto a cartridge you cannot see:\n  ${hiding.join('\n  ')}`);
});

// ── 2. the confer stall ───────────────────────────────────────────────────────

function confer(participantIds: string[]): string {
  const id = `c-${++n}`;
  db.prepare(`INSERT INTO confer_sessions (id, repo_name, repo_path, task, participant_ids, status,
              current_milestone, error, created_at, attachments, mode, isolation, worktrees, build_rounds)
              VALUES (?,'r','/r','the task',?, 'running', 0, '', ?, '[]','collaborate','shared','{}',1)`)
    .run(id, JSON.stringify(participantIds), iso(60 * MIN));
  return id;
}
function milestone(sessionId: string, dispatchedMsAgo: number, nudged = 0): string {
  const id = `m-${++n}`;
  db.prepare(`INSERT INTO confer_milestones (id, session_id, idx, key, name, status, done_ids,
              results, dispatched_at, completed_at, nudged, round)
              VALUES (?,?,0,'draft','Draft','active','[]','{}',?,NULL,?,1)`)
    .run(id, sessionId, iso(dispatchedMsAgo), nudged);
  return id;
}
const statusOf = (id: string) =>
  (db.prepare('SELECT status, error FROM confer_sessions WHERE id = ?').get(id) as { status: string; error: string });

/**
 * THE SET: what a silent participant's own state means, and what the conductor should do.
 *
 * The failure being fixed is that ALL of these took the same path — fail at 20 minutes — so the
 * agent that had done the work and the agent that had died were treated identically.
 */
const SILENT_PARTICIPANT: { label: string; status: string; seenMsAgo: number; shouldFail: boolean; why: string }[] = [
  {
    label: 'still working, seen just now',
    status: 'working', seenMsAgo: 10 * 1000, shouldFail: false,
    why: 'it is doing the work right now — failing the confer destroys work in progress',
  },
  {
    label: 'finished and went idle without reporting (the common case)',
    status: 'idle', seenMsAgo: 30 * 1000, shouldFail: false,
    why: 'the work is probably done; nudge it, do not throw the session away',
  },
  {
    label: 'blocked asking a question',
    status: 'waiting', seenMsAgo: 30 * 1000, shouldFail: false,
    why: 'a person owes it an answer — failing hides the question instead of surfacing it',
  },
  {
    label: 'offline',
    status: 'offline', seenMsAgo: 30 * 1000, shouldFail: true,
    why: 'genuinely gone — nothing will ever report, so failing is the honest outcome',
  },
  {
    label: 'flagged alive but not seen for hours',
    status: 'working', seenMsAgo: 180 * MIN, shouldFail: true,
    why: 'the status is stale; no heartbeat for hours means it is not coming back',
  },
];

test('EVERY silent-participant state gets the right outcome, not a blanket failure', () => {
  const wrong: string[] = [];
  for (const c of SILENT_PARTICIPANT) {
    const p = agent(c.status, { seenMsAgo: c.seenMsAgo });
    const s = confer([p]);
    milestone(s, 25 * MIN, 1);          // well past the old fail window, already nudged once
    reconcileConfers(Date.now());
    const failed = statusOf(s).status === 'failed';
    if (failed !== c.shouldFail) {
      wrong.push(`${c.label}: failed=${failed}, expected ${c.shouldFail} — ${c.why}`);
    }
  }
  assert.deepEqual(wrong, [], `the conductor misjudges a silent participant:\n  ${wrong.join('\n  ')}`);
});

test('a live participant is nudged REPEATEDLY, not once and then abandoned', () => {
  // The old code set `nudged = 1` and never nudged again, so one missed signal was terminal.
  const p = agent('idle', { seenMsAgo: 10 * 1000 });
  const s = confer([p]);
  const m = milestone(s, 25 * MIN, 1);            // already nudged once

  reconcileConfers(Date.now());
  const after = db.prepare('SELECT nudged FROM confer_milestones WHERE id = ?').get(m) as { nudged: number };
  assert.ok(after.nudged > 1, 'the milestone was never nudged again after its first reminder');
  assert.equal(statusOf(s).status, 'running', 'a live participant had its confer failed');
});

test('a confer with a live participant does not run forever — it fails with a diagnosable reason', () => {
  // Not failing is right up to a point; hanging silently for a day is its own failure. Past the
  // ceiling it stops, and the error has to name WHY so it is not just "stalled" again.
  const p = agent('idle', { seenMsAgo: 10 * 1000 });
  const s = confer([p]);
  milestone(s, 6 * 60 * MIN, 5);                  // six hours, nudged repeatedly
  reconcileConfers(Date.now());
  const got = statusOf(s);
  assert.equal(got.status, 'failed');
  assert.match(got.error, /alive|responsive|nudge/i,
    'the error does not distinguish "alive but silent" from "dead" — the same unhelpful message as before');
});

test('a milestone everyone reported is left alone', () => {
  const p = agent('idle');
  const s = confer([p]);
  const m = milestone(s, 25 * MIN, 1);
  db.prepare('UPDATE confer_milestones SET done_ids = ? WHERE id = ?').run(JSON.stringify([p]), m);
  reconcileConfers(Date.now());
  assert.notEqual(statusOf(s).status, 'failed', 'a completed milestone was failed');
});

test('one dead participant fails the confer even if another is alive', () => {
  // Otherwise the session waits forever on someone who will never report, which reads as
  // progress and is not.
  const alive = agent('working', { seenMsAgo: 10 * 1000 });
  const dead = agent('offline', { seenMsAgo: 30 * 1000 });
  const s = confer([alive, dead]);
  milestone(s, 25 * MIN, 1);
  reconcileConfers(Date.now());
  assert.equal(statusOf(s).status, 'failed');
  assert.match(statusOf(s).error, /offline|unreachable|gone/i, 'the error does not say which participant died');
});

// ── 3. the session race ───────────────────────────────────────────────────────

/**
 * A PROMPT DELIVERED INTO A SESSION THAT IS ALREADY GONE IS A PROMPT NOBODY READ.
 *
 * Observed: a cartridge was launched at 17:41, a workflow step dispatched to it at 17:45, and
 * the command reported `delivered: true` — because the RELAY socket accepted it. The engine
 * inside that freshly-launched relay had not attached yet, so nothing acted on the prompt. At
 * 17:49 the user typed "hello", which started a DIFFERENT session, and only then did anything
 * happen. The step sat `running` with a stored prompt for eight minutes and no error anywhere.
 *
 * Why no existing watchdog caught it: staleness is judged on `last_seen`, and `last_seen` is a
 * RELAY heartbeat. A relay with no engine attached keeps the timestamp fresh while doing
 * absolutely nothing, so the cartridge looked healthy the whole time.
 *
 * The detectable fact is narrower and reliable: the session the prompt went to is no longer the
 * session the cartridge is running. Steps therefore record the session they dispatched into,
 * and a step still waiting on a session that has since been replaced is re-sent to the live one.
 */
import { redispatchOrphanedSteps } from '../src/lib/step-session-guard.ts';

function stepRow(opts: {
  status: string; agentId: string; dispatchSession: string; prompt?: string; attempts?: number;
}): string {
  const id = `s-${++n}`;
  db.prepare(`INSERT INTO workflows (id, name, status, template_id, created_at)
              VALUES (?,?, 'running','tpl',?)`).run(`w-${id}`, 'run', iso(0));
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id,
              executor_config, auto_advance, recovery_status, position_y, created_at,
              dispatched_prompt, dispatch_session_id, recovery_attempts)
              VALUES (?,?,?,?,'claude-code',?,'{}',1,'',0,?,?,?,?)`)
    .run(id, `w-${id}`, 'step', opts.status, opts.agentId, iso(0),
         opts.prompt ?? 'do the research', opts.dispatchSession, opts.attempts ?? 0);
  return id;
}
function agentWithSession(sessionId: string): string {
  const id = `ag-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status,
              last_seen, active_queue_item_id, pending_question, session_id)
              VALUES (?,?,'m',?,?,'claude','idle',?,'','',?)`)
    .run(id, `t/${id}`, `/r/${id}`, `r${id}`, iso(0), sessionId);
  return id;
}

const RACE_CASES: { label: string; make: () => string; resend: boolean; why: string }[] = [
  {
    label: 'session unchanged since dispatch',
    make: () => { const a = agentWithSession('sess-A'); return stepRow({ status: 'running', agentId: a, dispatchSession: 'sess-A' }); },
    resend: false, why: 'the prompt went where the cartridge still is — nothing to fix',
  },
  {
    label: 'session REPLACED since dispatch (the bug)',
    make: () => { const a = agentWithSession('sess-NEW'); return stepRow({ status: 'running', agentId: a, dispatchSession: 'sess-OLD' }); },
    resend: true, why: 'the prompt is sitting in a session that no longer exists — nobody will ever read it',
  },
  {
    label: 'step not running',
    make: () => { const a = agentWithSession('sess-NEW'); return stepRow({ status: 'completed', agentId: a, dispatchSession: 'sess-OLD' }); },
    resend: false, why: 'finished work must never be re-sent',
  },
  {
    label: 'no dispatch session recorded (row predates this fix)',
    make: () => { const a = agentWithSession('sess-NEW'); return stepRow({ status: 'running', agentId: a, dispatchSession: '' }); },
    resend: false, why: 'nothing to compare — guessing would re-send work that may be in progress',
  },
  {
    label: 'already re-sent once',
    make: () => { const a = agentWithSession('sess-NEW'); return stepRow({ status: 'running', agentId: a, dispatchSession: 'sess-OLD', attempts: 1 }); },
    resend: false, why: 'a re-send that does not take must not become a loop',
  },
];

test('EVERY dispatched-step state is judged correctly against the session race', () => {
  const wrong: string[] = [];
  for (const c of RACE_CASES) {
    const id = c.make();
    const resent = redispatchOrphanedSteps().includes(id);
    if (resent !== c.resend) wrong.push(`${c.label}: resent=${resent}, expected ${c.resend} — ${c.why}`);
  }
  assert.deepEqual(wrong, [], `the session-race guard misjudges a step:\n  ${wrong.join('\n  ')}`);
});

test('a re-sent step records the attempt and the session it moved to', () => {
  const a = agentWithSession('sess-LIVE');
  const id = stepRow({ status: 'running', agentId: a, dispatchSession: 'sess-DEAD' });
  redispatchOrphanedSteps();
  const row = db.prepare('SELECT dispatch_session_id, recovery_attempts FROM workflow_steps WHERE id = ?')
    .get(id) as { dispatch_session_id: string; recovery_attempts: number };
  assert.equal(row.dispatch_session_id, 'sess-LIVE', 'the step still points at the dead session');
  assert.ok(row.recovery_attempts >= 1, 'the attempt was not counted, so this could loop');
});

test('EVERY step dispatch records the session it targeted', () => {
  // Three call sites write dispatched_prompt. One that forgets the session is a step the guard
  // can never judge — it would silently fall into the "no dispatch session" case forever.
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/workflow-executor-v2.ts'), 'utf8');
  // Matched on the assignment itself, not on a one-line SQL shape — the statement is now a
  // multi-line template literal, and the original regex silently found ZERO sites, which would
  // have passed this test on nothing had it not asserted a minimum count.
  const writes = [...src.matchAll(/dispatched_prompt = \?/g)];
  assert.ok(writes.length >= 3, `expected the known dispatch sites, found ${writes.length}`);
  const missing = writes.filter((m) => {
    const around = src.slice(m.index!, m.index! + 320);
    return !/dispatch_session_id/.test(around);
  }).length;
  assert.equal(missing, 0, `${missing} dispatch site(s) store the prompt without recording the session`);
});
