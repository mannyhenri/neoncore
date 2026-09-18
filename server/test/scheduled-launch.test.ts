/**
 * SCHEDULE A RUN FROM THE LAUNCH FORM.
 *
 * "I want on ALL workflows, the ability to do this when the Run Workflow button turns green:
 *  an option 'Schedule this run' … and another option 'Repeat?'"
 *
 * The previous attempt put a separate control on the template ROW. That is a different thing:
 * it schedules a template with no access to the cartridge, context, prompt answers or
 * attachments the launch form collects. Scheduling belongs IN the form, as an alternative to
 * pressing Run now, so a scheduled run is configured exactly like an immediate one.
 *
 * FOUR COMBINATIONS, and each is a real choice:
 *   neither            → run now (unchanged)
 *   schedule only      → run ONCE at the chosen time, then stop
 *   schedule + repeat  → first run at the chosen time, then on the cadence
 *   repeat only        → start now and keep repeating
 *
 * `once` is why SCHEDULE_TYPES grows: "scheduled but not repeating" had no representation, and
 * without it a one-off scheduled run would silently become a daily one — the worst possible
 * misreading of an unchecked box.
 *
 * initial_context is on the heartbeat because the launch form collects it. A scheduled run that
 * drops what you typed is not the same run you configured.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { randomUUID } from 'crypto';
import {
  computeNextRunAt, fireHeartbeat, checkDueHeartbeats, SCHEDULE_TYPES, isScheduleType,
  type HeartbeatSchedule,
} from '../src/lib/heartbeat-scheduler.ts';
import { installStubIO } from './helpers/stub-io.ts';

installStubIO();
const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const iso = () => new Date().toISOString();
let n = 0;

function cartridge(): string {
  const id = `sl-cart-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
     VALUES (?,?,'mac',?,'repo','claude','idle',?,?)`,
  ).run(id, id, `/tmp/${id}`, iso(), `s-${id}`);
  return id;
}

function schedule(opts: { type: string; firstRunAt: string; agentId: string; context?: string }): string {
  const id = randomUUID();
  const tpl = db.prepare("SELECT id FROM workflows WHERE template_id IS NULL AND name = 'Bug Hunter'").get() as { id: string };
  db.prepare(
    `INSERT INTO heartbeats (id,project_id,template_id,agent_id,schedule,label,active,next_run_at,created_at,initial_context)
     VALUES (?,NULL,?,?,?,'from the launch form',1,?,?,?)`,
  ).run(id, tpl.id, opts.agentId, JSON.stringify({ type: opts.type, time: '09:00', dayOfMonth: 1 }),
        opts.firstRunAt, iso(), opts.context ?? '');
  return id;
}

const latestRun = () =>
  db.prepare("SELECT id, initial_context FROM workflows WHERE template_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get() as { id: string; initial_context: string } | undefined;

// ── 'once' — the unchecked Repeat box ──────────────────────────────────────────────────

test("'once' exists — scheduled-but-not-repeating must be representable", () => {
  assert.ok(isScheduleType('once'),
    "no 'once' cadence: an unchecked Repeat box would have to be stored as something that DOES " +
    'repeat, which is the worst possible misreading of it');
  assert.equal(SCHEDULE_TYPES.length, 6, `expected 6 schedule types, found ${SCHEDULE_TYPES.length}`);
  console.log(`[set] ${SCHEDULE_TYPES.length} types: ${SCHEDULE_TYPES.join(', ')}`);
});

test('a one-off fires at its time and then STOPS', () => {
  const agentId = cartridge();
  const hb = schedule({ type: 'once', firstRunAt: new Date(Date.now() - 60_000).toISOString(), agentId });

  const sweep = checkDueHeartbeats();
  assert.ok(sweep.fired.some((f) => f.heartbeatId === hb), 'the one-off did not fire');

  const row = db.prepare('SELECT active, last_run_at FROM heartbeats WHERE id = ?').get(hb) as { active: number; last_run_at: string };
  assert.ok(row.last_run_at, 'no last_run_at recorded');
  assert.equal(row.active, 0,
    'a one-off is still active after firing — it will run again, which is exactly what an ' +
    'unchecked "Repeat?" box said not to do');

  // And a second sweep must not fire it again.
  const before = db.prepare("SELECT COUNT(*) c FROM workflows WHERE template_id IS NOT NULL").get() as { c: number };
  checkDueHeartbeats();
  const after = db.prepare("SELECT COUNT(*) c FROM workflows WHERE template_id IS NOT NULL").get() as { c: number };
  assert.equal(after.c, before.c, 'the one-off fired a second time');
});

test('a REPEATING schedule stays active and re-arms', () => {
  const agentId = cartridge();
  const hb = schedule({ type: 'daily', firstRunAt: new Date(Date.now() - 60_000).toISOString(), agentId });
  checkDueHeartbeats();
  const row = db.prepare('SELECT active, next_run_at FROM heartbeats WHERE id = ?').get(hb) as { active: number; next_run_at: string };
  assert.equal(row.active, 1, 'a repeating schedule was deactivated after one run');
  assert.ok(Date.parse(row.next_run_at) > Date.now(), 'it did not re-arm for the next run');
});

test("computeNextRunAt refuses to invent a cadence for 'once'", () => {
  // Asking "when does a one-off run NEXT" is a question with no answer. Returning anything
  // would turn it into a repeating schedule.
  assert.throws(() => computeNextRunAt({ type: 'once' } as HeartbeatSchedule), /once|repeat|cadence/i);
});

// ── the first-run time is honoured, not recomputed ─────────────────────────────────────

test('the chosen FIRST run time is used verbatim — not rounded to the cadence', () => {
  const agentId = cartridge();
  const at = new Date(Date.now() + 3 * 3600_000).toISOString();  // 3h from now
  for (const type of ['once', 'daily', 'weekly', 'monthly', 'quarterly']) {
    const hb = schedule({ type, firstRunAt: at, agentId });
    const row = db.prepare('SELECT next_run_at FROM heartbeats WHERE id = ?').get(hb) as { next_run_at: string };
    assert.equal(row.next_run_at, at,
      `${type}: the first run was moved to ${row.next_run_at} — "Schedule this run" picked ${at}`);
  }
});

// ── the form's context survives ────────────────────────────────────────────────────────

test('what you typed in the launch form reaches the scheduled run', () => {
  const agentId = cartridge();
  const context = 'GRD-3449 installers/bootstrap — check the signing step';
  const hb = schedule({ type: 'once', firstRunAt: new Date(Date.now() - 60_000).toISOString(), agentId, context });
  fireHeartbeat(hb);

  const run = latestRun();
  assert.ok(run, 'no run created');
  assert.match(run!.initial_context, /GRD-3449 installers\/bootstrap/,
    'the context typed into the launch form was dropped — the scheduled run is not the run ' +
    'that was configured');
});

test('a scheduled run still lands on the configured cartridge', () => {
  const agentId = cartridge();
  const hb = schedule({ type: 'once', firstRunAt: new Date(Date.now() - 60_000).toISOString(), agentId });
  fireHeartbeat(hb);
  const run = latestRun()!;
  const orphaned = db.prepare(
    `SELECT COUNT(*) c FROM workflow_steps WHERE workflow_id = ?
      AND executor_type IN ('claude-code','quality-gate','review-gate','command')
      AND (executor_id = '' OR executor_id = '__deferred__')`,
  ).get(run.id) as { c: number };
  assert.equal(orphaned.c, 0, 'a scheduled run landed with steps that have no cartridge');
});

// ── the controls are in BOTH launch forms ──────────────────────────────────────────────

/** The one component both forms render. Its options are the options, once. */
const CONTROL = 'dashboard/src/components/LaunchSchedule.tsx';

test('the shared control offers both options and every cadence', () => {
  const src = read(CONTROL);
  assert.match(src, /Schedule this run/, 'no "Schedule this run" checkbox');
  assert.match(src, /Repeat\?/, 'no "Repeat?" checkbox');
  for (const cadence of ['daily', 'weekly', 'monthly', 'quarterly']) {
    assert.match(src, new RegExp(`value="${cadence}"`), `Repeat offers no ${cadence} cadence`);
  }
  // datetime, not a bare time: "Schedule this run" picks WHEN, which includes the day.
  assert.match(src, /type="datetime-local"/, 'the first-run picker cannot choose a date');
});

test('EVERY launch form renders the shared control — and SCHEDULES instead of starting', () => {
  const FORMS = [
    'dashboard/src/components/WorkflowPanel.tsx',
    'dashboard/src/components/WorkflowCanvasEditor.tsx',
  ];
  const missing: string[] = [];
  for (const f of FORMS) {
    const src = read(f);
    // Delegation, not a copy of the strings. Two forms that each spell out their own options
    // is how every other launch control in this codebase drifted — see confer-launch-gate.
    if (!/<LaunchSchedule\b/.test(src)) missing.push(`${f}: does not render <LaunchSchedule>`);
    // Rendering it is not enough: the Run handler has to branch on it, or the checkbox is
    // decoration and the green button still starts the run immediately.
    if (!/isScheduledLaunch\(/.test(src)) missing.push(`${f}: Run handler ignores the schedule`);
    if (!/createHeartbeat\(/.test(src)) missing.push(`${f}: never creates a schedule`);
    // And the button must say what it will do.
    if (!/launchButtonLabel\(/.test(src)) missing.push(`${f}: button still says "Run Workflow" when it would schedule`);
  }
  assert.deepEqual(missing, [],
    `a launch form is missing the scheduling options:\n  ${missing.join('\n  ')}`);
  console.log(`[set] ${FORMS.length}/${FORMS.length} launch forms offer Schedule + Repeat`);
});
