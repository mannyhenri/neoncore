/**
 * A SCHEDULED RUN MUST BE ABLE TO ACTUALLY RUN.
 *
 * The heartbeat scheduler has existed since 2026-08-15, polls every 60s, supports
 * hourly/daily/weekly and defaults to {"type":"daily","time":"09:00"}. It had never fired a
 * usable run, and the live database held 0 heartbeats. Measured, before this:
 *
 *     heartbeat configured with agent_id='c1':
 *       steps with NO cartridge : 7/8
 *       autonomy resolved to    : 'manual'
 *       can clear unattended    : 0/10 reasons
 *
 * Three independent defects, all of which had to be fixed for "every morning, run X" to work:
 *
 *  1. `heartbeats.agent_id` is collected by the route AND the dashboard, and then passed
 *     nowhere. `cloneTemplateAsRun` had no parameter for it and copied the template's
 *     `__deferred__` executor verbatim, so every agent step landed with no cartridge.
 *  2. The cloned run took the column default autonomy `manual`, which auto-resolves NOTHING.
 *     A run that stops at the first gate at 09:00 with nobody watching is not automation.
 *  3. Nothing validated. The manual launch path refuses at the door — "validate while a human
 *     is watching" — and the scheduled path, where NO human is watching, did not check at all.
 *     It created a run marked `running` that was dead on arrival.
 *
 * SET-BASED OVER THE FIRE PATHS, because there are two (`fireHeartbeat` for the manual "fire
 * now" button and `checkDueHeartbeats` for the timer) and a fix applied to one looks identical
 * from the other. That is exactly the partial fix this suite exists to prevent.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { randomUUID } from 'crypto';
import { fireHeartbeat, checkDueHeartbeats, computeNextRunAt } from '../src/lib/heartbeat-scheduler.ts';
import { effectiveAutonomy, AUTO_RESOLVABLE, DEFAULT_AUTONOMY } from '../src/lib/autonomy.ts';
import { REASONS } from '../src/lib/workflow-attention.ts';
import { installStubIO } from './helpers/stub-io.ts';

const io = installStubIO();
const iso = () => new Date().toISOString();
let n = 0;

function cartridge(id = `hb-cart-${++n}`): string {
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
     VALUES (?,?,'mac',?,'repo','claude','idle',?,?)`,
  ).run(id, id, `/tmp/${id}`, iso(), `s-${id}`);
  io.connect(id);
  return id;
}

function heartbeat(opts: { agentId: string; template?: string; due?: boolean; projectId?: string | null }): string {
  const id = randomUUID();
  const tpl = db.prepare('SELECT id FROM workflows WHERE template_id IS NULL AND name = ?')
    .get(opts.template ?? 'Bug Hunter') as { id: string };
  const next = opts.due
    ? new Date(Date.now() - 60_000).toISOString()   // already due
    : new Date(Date.now() + 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO heartbeats (id,project_id,template_id,agent_id,schedule,label,active,next_run_at,created_at)
     VALUES (?,?,?,?,'{"type":"daily","time":"09:00"}','Morning report',1,?,?)`,
  ).run(id, opts.projectId ?? null, tpl.id, opts.agentId, next, iso());
  return id;
}

const runOf = (hbId: string): string | null => {
  const r = db.prepare('SELECT id FROM workflows WHERE template_id = (SELECT template_id FROM heartbeats WHERE id = ?) ORDER BY created_at DESC LIMIT 1')
    .get(hbId) as { id: string } | undefined;
  return r?.id ?? null;
};

const stepsOf = (runId: string) =>
  db.prepare('SELECT name, executor_type, executor_id FROM workflow_steps WHERE workflow_id = ?')
    .all(runId) as { name: string; executor_type: string; executor_id: string }[];

/** BOTH ways a heartbeat can fire. A fix to one is not a fix. */
const FIRE_PATHS: { name: string; fire: (hbId: string) => void }[] = [
  { name: 'fireHeartbeat (the "fire now" button)', fire: (id) => { fireHeartbeat(id); } },
  { name: 'checkDueHeartbeats (the 60s timer)', fire: () => { checkDueHeartbeats(); } },
];

// ── The cartridge ──────────────────────────────────────────────────────────────────────

test('EVERY fire path gives the run the cartridge the heartbeat was configured with', () => {
  for (const path of FIRE_PATHS) {
    const agentId = cartridge();
    const hb = heartbeat({ agentId, due: true });
    path.fire(hb);

    const runId = runOf(hb);
    assert.ok(runId, `${path.name}: no run was created`);
    const steps = stepsOf(runId);
    const AGENT_TYPES = new Set(['claude-code', 'quality-gate', 'review-gate', 'command']);
    const agentSteps = steps.filter((s) => AGENT_TYPES.has(s.executor_type));
    assert.ok(agentSteps.length > 0, 'fixture template has no agent steps — test is vacuous');

    const orphaned = agentSteps.filter((s) => !s.executor_id || s.executor_id === '__deferred__');
    assert.deepEqual(orphaned.map((s) => s.name), [],
      `${path.name}: ${orphaned.length}/${agentSteps.length} steps landed with NO cartridge — ` +
      'the run is marked running and dies on its first dispatch');
  }
  console.log(`[set] ${FIRE_PATHS.length}/${FIRE_PATHS.length} fire paths assign the cartridge`);
});

// ── The posture ────────────────────────────────────────────────────────────────────────

test('EVERY fire path gives the run a posture that can clear a gate unattended', () => {
  for (const path of FIRE_PATHS) {
    const agentId = cartridge();
    const hb = heartbeat({ agentId, due: true });
    path.fire(hb);
    const runId = runOf(hb)!;

    const level = effectiveAutonomy(runId).level;
    assert.notEqual(level, 'manual',
      `${path.name}: the run resolved to 'manual', which auto-resolves nothing — it will stop ` +
      'at the first of 10 attention reasons with nobody there');
    assert.ok(AUTO_RESOLVABLE[level].length > 0,
      `${path.name}: posture '${level}' clears no attention reason`);
  }
});

test('a scheduled run starts at the SAME posture as a hand-launched one', () => {
  // Owner's instruction: default to `full`, "I always turn it on anyways". A schedule is a
  // launch you are not present for, not a weaker one, so it gets no special lower posture.
  const agentId = cartridge();
  const hb = heartbeat({ agentId, due: true });
  fireHeartbeat(hb);
  assert.equal(effectiveAutonomy(runOf(hb)!).level, DEFAULT_AUTONOMY);
  assert.equal(DEFAULT_AUTONOMY, 'full');
});

test('even `full` cannot clear breakage — the ceiling holds', () => {
  // What `full` actually delegates, asserted so the grant stays visible: it adds exactly
  // `decision` and `agent-waiting` over `advance`, and touches none of the five breakage
  // reasons. If a future change let a posture clear `failed`, this is where it is caught.
  const full = AUTO_RESOLVABLE.full;
  assert.ok(full.includes('decision'), "'full' is expected to decide for you — that is the point");
  assert.ok(full.includes('agent-waiting'), "'full' is expected to answer the agent's question");
  for (const breakage of ['failed', 'interrupted', 'channel-lost', 'budget-exhaustion', 'autonomy-expiring']) {
    assert.ok(!full.includes(breakage as never),
      `'full' would auto-resolve ${breakage} — that is breakage, not a gate`);
  }
  assert.ok(full.length < REASONS.length, 'no posture may clear everything');
});

test('an explicit posture on the heartbeat is honoured over the default', () => {
  const agentId = cartridge();
  const hb = heartbeat({ agentId, due: true });
  db.prepare("UPDATE heartbeats SET autonomy = 'advance' WHERE id = ?").run(hb);
  fireHeartbeat(hb);
  assert.equal(effectiveAutonomy(runOf(hb)!).level, 'advance',
    'a heartbeat set to a lower posture must keep it — the default is a default, not a policy');
});

// ── The refusal ────────────────────────────────────────────────────────────────────────

test('a heartbeat whose cartridge is GONE refuses to fire — it creates no dead run', () => {
  const hb = heartbeat({ agentId: 'cartridge-that-was-removed', due: true });
  const before = db.prepare('SELECT COUNT(*) c FROM workflows WHERE template_id IS NOT NULL').get() as { c: number };

  const out = fireHeartbeat(hb) as { error?: string };
  assert.ok(out.error, 'fired anyway with a cartridge that does not exist');
  assert.match(out.error!, /cartridge/i, 'the refusal does not say what is wrong');

  const after = db.prepare('SELECT COUNT(*) c FROM workflows WHERE template_id IS NOT NULL').get() as { c: number };
  assert.equal(after.c, before.c, 'a run was created and left dead — refuse BEFORE cloning');
});

test('the refusal is REPORTED — a heartbeat that silently never fires is worse than one that errors', () => {
  // Asserted on the sweep's RETURN VALUE, not on a websocket emission. The notice is
  // fire-and-forget through a dynamic import (kept dynamic to avoid an import cycle), so
  // waiting on it made this test flaky — it passed alone and failed in the full suite. A
  // caller that cannot find out what the sweep did is the actual defect; the emit is a
  // courtesy on top. Both now exist, and this pins the one that can be relied on.
  const hb = heartbeat({ agentId: 'also-gone', due: true });
  const sweep = checkDueHeartbeats();

  const mine = sweep.skipped.find((sk) => sk.heartbeatId === hb);
  assert.ok(mine,
    'the sweep skipped this heartbeat and reported nothing — at 09:00 with no human watching, ' +
    'a silent skip is indistinguishable from a heartbeat that is working');
  assert.match(mine!.reason, /cartridge/i, 'the report does not say WHY it skipped');
  assert.ok(!sweep.fired.some((f) => f.heartbeatId === hb), 'it was reported as both fired and skipped');
});

test('a sweep reports what it FIRED too, so a working schedule is observable', () => {
  const agentId = cartridge();
  const hb = heartbeat({ agentId, due: true });
  const sweep = checkDueHeartbeats();
  const fired = sweep.fired.find((f) => f.heartbeatId === hb);
  assert.ok(fired, 'a healthy heartbeat fired but the sweep did not report it');
  assert.ok(fired!.runId, 'reported a fire with no run id');
});

test('a refused fire still advances next_run_at — it must not retry every 60 seconds forever', () => {
  const hb = heartbeat({ agentId: 'gone-too', due: true });
  checkDueHeartbeats();
  const row = db.prepare('SELECT next_run_at FROM heartbeats WHERE id = ?').get(hb) as { next_run_at: string };
  assert.ok(Date.parse(row.next_run_at) > Date.now(),
    'next_run_at was left in the past — the scheduler will re-refuse this every single tick');
});

// ── Still a scheduler ──────────────────────────────────────────────────────────────────

test('a heartbeat that is not due is left alone', () => {
  const agentId = cartridge();
  const hb = heartbeat({ agentId, due: false });
  checkDueHeartbeats();
  const row = db.prepare('SELECT last_run_at FROM heartbeats WHERE id = ?').get(hb) as { last_run_at: string | null };
  assert.equal(row.last_run_at, null, 'fired a heartbeat that was not due');
});

test('daily scheduling lands on the NEXT 09:00, never an hour from now', () => {
  // computeNextRunAt works in LOCAL time (setHours), so a fixed UTC string would assert a
  // different thing in every timezone. Build "just past 09:00 local" explicitly instead.
  const from = new Date(); from.setHours(9, 30, 0, 0);
  const next = new Date(computeNextRunAt({ type: 'daily', time: '09:00' }, from));

  assert.ok(next.getTime() > from.getTime(), 'the next run is not in the future');
  assert.equal(next.getHours(), 9, 'a daily 09:00 heartbeat must land at 09:00 local');
  assert.equal(next.getMinutes(), 0);
  // The failure this guards: falling through to the hourly branch, which would be 10:30.
  const hoursAway = (next.getTime() - from.getTime()) / 3_600_000;
  assert.ok(hoursAway > 20, `next run is only ${hoursAway.toFixed(1)}h away — that is not daily`);
});
