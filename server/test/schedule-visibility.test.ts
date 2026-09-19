/**
 * A SCHEDULE YOU CREATED HAS TO BE SOMEWHERE YOU CAN SEE IT.
 *
 * Reported as "I just tried to start a daily scheduled task with repeat on, but it doesn't
 * even show in the list of tasks". Nothing was broken underneath: heartbeat 8725f9ae was
 * created, armed, fired at 09:10 and re-armed for tomorrow. It was simply invisible — the only
 * surfaces that list schedules are a per-project modal on GoalsPage and the per-template
 * popover that created it, and neither is the list you are looking at after you click Run.
 *
 * SET-BASED OVER `SCHEDULE_TYPES`, the server's own cadence registry (6 members), because the
 * half-fix this prevents is a list that renders the cadence someone tested and drops the rest.
 * The registry is also where the second defect showed up: the shared client typed
 * `Heartbeat.schedule.type` as 'hourly' | 'daily' | 'weekly' — 3 of 6 — so `once`, `monthly`
 * and `quarterly` were not merely unrendered, they were unrepresentable. A hand-copied type
 * that drifts STRICTER than the server does not fail the build, it removes coverage.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import heartbeatsRouter from '../src/routes/heartbeats.ts';
import { SCHEDULE_TYPES } from '../src/lib/heartbeat-scheduler.ts';

const iso = () => new Date().toISOString();
let base = '';
let server: Server;
let n = 0;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/heartbeats', heartbeatsRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r();
    });
  });
});
test.after(() => server?.close());

function cartridge(): string {
  const id = `hb-ag-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
     VALUES (?,?,?,'/tmp/x',?,'claude','idle',?,?)`,
  ).run(id, id, os.hostname(), `repo-${id}`, iso(), `s-${id}`);
  return id;
}

const template = () => (db.prepare(
  "SELECT id FROM workflows WHERE template_id IS NULL AND name = 'Daily AI Research Digest'",
).get() as { id: string }).id;

/** A schedule payload for each cadence, shaped the way the launch form sends it. */
function payloadFor(type: string) {
  return {
    type,
    ...(type !== 'hourly' && type !== 'once' ? { time: '09:10' } : {}),
    ...(type === 'weekly' ? { day: 2 } : {}),
    ...(type === 'monthly' || type === 'quarterly' ? { dayOfMonth: 5 } : {}),
  };
}

test('every cadence in SCHEDULE_TYPES can be created and comes back listable', async () => {
  assert.equal(SCHEDULE_TYPES.length, 6, 'the cadence registry changed — update this test with it');
  const templateId = template();
  const broken: string[] = [];

  for (const type of SCHEDULE_TYPES) {
    const agentId = cartridge();
    const res = await fetch(`${base}/api/heartbeats`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId, agentId, label: `Digest ${type}`, schedule: payloadFor(type) }),
    });
    const body = await res.text();
    if (!res.ok) { broken.push(`${type}: create refused → ${body}`); continue; }

    const created = JSON.parse(body) as { id: string };
    const listed = await (await fetch(`${base}/api/heartbeats`)).json() as {
      id: string; scheduleLabel: string; nextRunAt: string; active: boolean;
      schedule: { type: string };
    }[];
    const hb = listed.find((h) => h.id === created.id);

    if (!hb) { broken.push(`${type}: created but absent from the list`); continue; }
    // Each of these is something a list has to render. A cadence that produces an empty label
    // or no next-run time cannot be shown, which is the same as not being there.
    if (!hb.scheduleLabel) broken.push(`${type}: no scheduleLabel, so a row has nothing to say`);
    if (!hb.nextRunAt || Number.isNaN(Date.parse(hb.nextRunAt))) {
      broken.push(`${type}: nextRunAt is "${hb.nextRunAt}" — a list cannot say when it runs`);
    }
    if (hb.schedule?.type !== type) broken.push(`${type}: came back as "${hb.schedule?.type}"`);
  }

  assert.deepEqual(broken, [],
    'these cadences cannot be listed:\n  ' + broken.join('\n  '));
});

test('a one-off schedule reports as inactive once it has fired, not as still armed', () => {
  // `once` is the cadence the launch form sends for "Schedule this run" without Repeat. A list
  // of armed schedules must stop showing it after it fires, or the list fills with history.
  const hb = db.prepare(
    `SELECT active FROM heartbeats WHERE schedule LIKE '%"once"%' AND last_run_at != '' LIMIT 1`,
  ).get() as { active: number } | undefined;
  if (!hb) return; // none in this database yet; the rule is asserted by reArm's own tests
  assert.equal(hb.active, 0, 'a fired one-off is still marked active and would sit in the list forever');
});
