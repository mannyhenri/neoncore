/**
 * EVERY TEMPLATE CAN BE PUT ON A REPEATING SCHEDULE.
 *
 * "We need to be able to schedule or put on automation ALL workflow templates."
 *
 * Two things were missing and they are different:
 *  1. CADENCE. The scheduler understood hourly/daily/weekly. Monthly and quarterly — the
 *     cadences a review, an audit or a dependency sweep actually run on — did not exist.
 *  2. REACH. A schedule could only be created from Projects → Heartbeats. There was nothing on
 *     a workflow template itself, so "schedule THIS workflow" meant knowing that heartbeats
 *     exist, that they live under a project, and that they take a template id.
 *
 * SET-BASED OVER THE CADENCE UNION, read from the type, because the failure mode is a cadence
 * that is accepted by the API and then silently falls through computeNextRunAt's `return
 * new Date(now + 1h)` default — a "quarterly" heartbeat that fires every hour forever. That is
 * worse than refusing it.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import {
  computeNextRunAt, formatScheduleLabel, SCHEDULE_TYPES, type HeartbeatSchedule,
} from '../src/lib/heartbeat-scheduler.ts';
import { STANDARD_TEMPLATE_NAMES } from '../src/db.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * The PERIOD of each cadence, in hours — the gap between two CONSECUTIVE fires.
 *
 * Not "time until the next fire": from an arbitrary Tuesday, the next weekly Monday is 6 days
 * away, not 7. Measuring that would encode the test's start date rather than the cadence. Two
 * consecutive fires are exactly one period apart, whatever day you start from, which is the
 * invariant that actually catches a cadence falling through to the hourly default.
 */
const PERIOD_HOURS: Record<string, { min: number; max: number }> = {
  hourly:    { min: 0.9,      max: 1.1 },
  daily:     { min: 23,       max: 25 },
  weekly:    { min: 24 * 6.9, max: 24 * 7.1 },
  monthly:   { min: 24 * 27,  max: 24 * 32 },   // month lengths vary
  quarterly: { min: 24 * 88,  max: 24 * 93 },
};

test('the cadence union is read from source and covers what a person would ask for', () => {
  // SCHEDULE_TYPES IS the union now (`type ScheduleType = (typeof SCHEDULE_TYPES)[number]`),
  // so there is nothing to cross-check against — that is the point. Assert the derivation
  // instead, so a future edit cannot reintroduce a hand-written second copy.
  const src = read('server/src/lib/heartbeat-scheduler.ts');
  assert.match(src, /type ScheduleType = \(typeof SCHEDULE_TYPES\)\[number\]/,
    'ScheduleType is no longer derived from SCHEDULE_TYPES — two lists that can disagree');
  assert.match(src, /type:\s*ScheduleType/,
    'HeartbeatSchedule.type is not the derived union');
  for (const needed of ['daily', 'weekly', 'monthly', 'quarterly']) {
    assert.ok(SCHEDULE_TYPES.includes(needed as never), `no ${needed} cadence`);
  }
  // 'once' belongs to the same union — it is what an unchecked "Repeat?" box stores.
  assert.ok(SCHEDULE_TYPES.includes('once' as never), "no 'once' type for a non-repeating schedule");
  console.log(`[set] ${SCHEDULE_TYPES.length} cadences: ${SCHEDULE_TYPES.join(', ')}`);
});

test('EVERY cadence computes a future next-run at its own interval — none falls through to hourly', () => {
  const from = new Date('2026-09-18T12:00:00');
  const wrong: string[] = [];

  // 'once' is deliberately excluded: it is a scheduled TIME, not a cadence, and asking when it
  // runs next has no answer — computeNextRunAt throws for it on purpose (see the 'once' tests
  // in scheduled-launch.test.ts). Every OTHER type must have a real interval.
  const CADENCES = SCHEDULE_TYPES.filter((t) => t !== 'once');
  assert.ok(CADENCES.length >= 5, 'the cadence set shrank');

  for (const type of CADENCES) {
    const schedule = { type, time: '09:00', day: 1, dayOfMonth: 1 } as HeartbeatSchedule;

    const first = new Date(computeNextRunAt(schedule, from));
    assert.ok(!Number.isNaN(first.getTime()), `${type} produced an invalid date`);
    assert.ok(first.getTime() > from.getTime(), `${type} scheduled its next run in the past`);

    // The fire AFTER that one. Their gap is the cadence's period.
    const second = new Date(computeNextRunAt(schedule, first));
    assert.ok(second.getTime() > first.getTime(), `${type} does not advance past its own fire`);

    const hours = (second.getTime() - first.getTime()) / 3_600_000;
    const want = PERIOD_HOURS[type];
    assert.ok(want, `no expected period declared for cadence "${type}" — add one`);
    if (hours < want.min || hours > want.max) {
      wrong.push(`${type}: consecutive fires are ${hours.toFixed(1)}h apart, expected ${want.min}–${want.max}h`);
    }
  }
  assert.deepEqual(wrong, [],
    'a cadence fell through to the hourly default — it would fire every hour forever:\n  ' + wrong.join('\n  '));
  console.log(`[set] ${CADENCES.length}/${CADENCES.length} repeating cadences compute their own interval`);
});

test('EVERY cadence has a human label — no "Unknown schedule" in the UI', () => {
  const bad: string[] = [];
  for (const type of SCHEDULE_TYPES) {
    const label = formatScheduleLabel({ type, time: '09:00', day: 1, dayOfMonth: 1 } as HeartbeatSchedule);
    if (!label || /unknown/i.test(label)) bad.push(`${type} → "${label}"`);
    else if (label.length < 5) bad.push(`${type} → "${label}" (too terse to be a label)`);
  }
  assert.deepEqual(bad, [], `cadences with no usable label: ${bad.join(', ')}`);
});

test('monthly and quarterly land on the requested day of the month', () => {
  const from = new Date('2026-09-18T12:00:00');
  for (const type of ['monthly', 'quarterly'] as const) {
    const next = new Date(computeNextRunAt({ type, time: '09:00', dayOfMonth: 5 }, from));
    assert.equal(next.getDate(), 5, `${type} did not land on day 5`);
    assert.equal(next.getHours(), 9, `${type} did not land at 09:00 local`);
  }
});

test('a day-of-month past the end of a short month does not skip or overflow', () => {
  // 31st in a 30-day month is the classic off-by-one that silently rolls into the next month.
  const from = new Date('2026-04-02T12:00:00'); // April has 30 days
  const next = new Date(computeNextRunAt({ type: 'monthly', time: '09:00', dayOfMonth: 31 }, from));
  assert.equal(next.getMonth(), 3, 'rolled out of April instead of clamping to its last day');
  assert.equal(next.getDate(), 30, 'did not clamp to the last day of the month');
});

test('an unknown cadence is REFUSED, not silently run hourly', () => {
  // The old default returned "an hour from now" for anything it did not recognise, which turns
  // a typo into a job that fires 24 times a day.
  assert.throws(
    () => computeNextRunAt({ type: 'fortnightly' as never, time: '09:00' }),
    /cadence|schedule|unknown/i,
    'an unrecognised cadence was accepted and given an interval',
  );
});

// ── Reach: every template, and from the template itself ────────────────────────────────

test('EVERY template can be scheduled — nothing is structurally excluded', () => {
  const templates = db.prepare(
    'SELECT id, name FROM workflows WHERE template_id IS NULL',
  ).all() as { id: string; name: string }[];
  assert.ok(templates.length >= STANDARD_TEMPLATE_NAMES.length);

  // A heartbeat needs a template id and a cartridge, and nothing else — in particular NOT a
  // project, or "schedule this workflow" would mean "first make it belong to a project".
  const cols = db.prepare('PRAGMA table_info(heartbeats)').all() as { name: string; notnull: number }[];
  const projectCol = cols.find((c) => c.name === 'project_id');
  assert.ok(projectCol, 'heartbeats has no project_id column');
  assert.equal(projectCol!.notnull, 0, 'project_id is NOT NULL — a template could not be scheduled on its own');

  for (const t of templates) {
    const id = `sched-${t.id.slice(0, 8)}`;
    db.prepare(
      `INSERT INTO heartbeats (id,project_id,template_id,agent_id,schedule,label,active,next_run_at,created_at)
       VALUES (?,NULL,?,'some-cartridge','{"type":"monthly","time":"09:00","dayOfMonth":1}',?,1,?,?)`,
    ).run(id, t.id, t.name, new Date().toISOString(), new Date().toISOString());
  }
  const made = db.prepare('SELECT COUNT(*) c FROM heartbeats').get() as { c: number };
  assert.equal(made.c, templates.length, 'not every template could be given a schedule');
  console.log(`[set] ${templates.length}/${templates.length} templates accept a schedule`);
  db.prepare('DELETE FROM heartbeats').run();
});

test('a schedule can be created FROM the workflow list, not only from Projects', () => {
  const panel = read('dashboard/src/components/WorkflowPanel.tsx');
  assert.match(panel, /heartbeat|schedule/i,
    'the workflow template list offers no way to schedule a template — the only route to ' +
    'automation is knowing that heartbeats live under Projects');
  assert.match(panel, /createHeartbeat|\/heartbeats/,
    'WorkflowPanel mentions scheduling but never calls the heartbeat API');
});
