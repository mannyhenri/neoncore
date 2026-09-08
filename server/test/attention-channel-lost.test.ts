/**
 * AN ALIVE CARTRIDGE WITH NO COMMAND CHANNEL IS A STALL NOTHING ELSE CATCHES.
 *
 * On 2026-09-06 a cartridge was restored with a plain `claude --resume` and no relay. It was
 * demonstrably alive — hooks reporting, tools running — but nothing could dispatch to it. The
 * workflow's next dispatch bounced with "Command not delivered: no command channel", the step
 * went `failed`, and `failed` is NEVER_AUTO, so the run stopped until a human looked.
 *
 * `detectInterruptedSteps` cannot catch it. It requires the agent to be DEAD by activity
 * staleness first (`if (!dead) continue;`) and uses the live socket only as a veto
 * (`if (opts.isAlive(...)) continue;`). An agent that is working perfectly and merely
 * unreachable never qualifies. This is the inverse-liveness hole, the same shape as
 * `agent-silent`: alive by one measure, gone by the one that matters.
 *
 * ── WHY A GRACE WINDOW, AND WHY THE OBSERVATION IS NOT IN THE DETECTOR ─────────────────
 * `hasActiveSocket` goes false for EVERY relay the instant the server restarts, and they
 * reconnect a second or two later. Four server restarts happened during one evening of
 * development; each would have fired this reason for every running workflow. So absence must
 * persist across a window before it counts — the same `graceMs` idiom `detectInterruptedSteps`
 * already uses.
 *
 * The timer lives in the 60-second sweep, NOT in `workflowNeedsAttention`. That function is
 * called from four places including `routes/workflows.ts` on every dashboard list request, and
 * its own header promises it is DERIVED — "computed from the rows every time it is asked".
 * A dashboard GET must not advance a stall timer.
 *
 * ── THE COLD-MAP CASE IS THE ONE THAT MATTERS ─────────────────────────────────────────
 * After a server restart the map is empty and every socket is briefly absent. If "no record"
 * meant "absent forever" the reason would fire for every run on every deploy. The first
 * observation must START the clock, never trip it.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  workflowNeedsAttention, observeChannels, __resetChannelStateForTest,
  CHANNEL_GRACE_MS, STALE_AFTER_MS,
} from '../src/lib/workflow-attention.ts';

installStubIO();

let n = 0;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function wf(): string {
  const id = `wf-ch-${++n}`;
  db.prepare("INSERT INTO workflows (id,name,status,created_at,template_id,run_number) VALUES (?,?,'running',?, 'tpl',1)")
    .run(id, `run ${id}`, iso());
  return id;
}

function agent(status = 'working', lastSeenMsAgo = 5_000): string {
  const id = `ag-ch-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
     VALUES (?,?,?,?,?,?,?,?,?,'')`,
  ).run(id, `m/${id}`, 'm', `/r/${id}`, 'r', 'claude', status, iso(lastSeenMsAgo), `s-${id}`);
  return id;
}

function runningStep(w: string, executor: string, startedMsAgo = 60_000): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (id,workflow_id,name,description,position_x,position_y,status,executor_type,executor_id,
        executor_config,auto_advance,created_at,recovery_status,dispatched_prompt,result,started_at)
     VALUES (?,?,'Work','',0,1,'running','claude-code',?,'{}',1,?,'','do it','',?)`,
  ).run(`st-ch-${++n}`, w, executor, iso(), iso(startedMsAgo));
}

/** The sweep, as the notifier runs it: observe, then ask. */
const DEAD = () => false;
const LIVE = () => true;
function sweep(agentIds: string[], isAlive: (id: string) => boolean, atMsAgo = 0): void {
  observeChannels(agentIds, isAlive, Date.now() - atMsAgo);
}

// ── THE SET: every shape the absence timer can be in ────────────────────────
interface Case {
  label: string;
  /** Sweeps to run, oldest first: [msAgo, alive]. */
  sweeps: [number, boolean][];
  fires: boolean;
}

const CASES: Case[] = [
  {
    label: 'never observed at all (cold map, e.g. straight after a restart)',
    sweeps: [],
    fires: false,
  },
  {
    label: 'FIRST observation of an absent socket — starts the clock, never trips it',
    sweeps: [[0, false]],
    fires: false,
  },
  {
    label: 'absent, but not yet for the full grace window',
    sweeps: [[CHANNEL_GRACE_MS / 2, false], [0, false]],
    fires: false,
  },
  {
    label: 'absent continuously for longer than the grace window',
    sweeps: [[CHANNEL_GRACE_MS * 2, false], [0, false]],
    fires: true,
  },
  {
    label: 'socket present — nothing to report',
    sweeps: [[CHANNEL_GRACE_MS * 2, true], [0, true]],
    fires: false,
  },
  {
    label: 'absent long, then RECONNECTS — the clock is cleared',
    sweeps: [[CHANNEL_GRACE_MS * 2, false], [CHANNEL_GRACE_MS, true], [0, true]],
    fires: false,
  },
  {
    label: 'absent, reconnects, then absent again — the clock RESTARTS from the new absence',
    sweeps: [[CHANNEL_GRACE_MS * 3, false], [CHANNEL_GRACE_MS * 2, true], [0, false]],
    fires: false,
  },
];

test('EVERY absence-timer shape resolves correctly', () => {
  const wrong: string[] = [];
  for (const c of CASES) {
    __resetChannelStateForTest();
    const w = wf();
    const a = agent();
    runningStep(w, a);
    for (const [msAgo, alive] of c.sweeps) sweep([a], alive ? LIVE : DEAD, msAgo);
    const got = workflowNeedsAttention(w);
    const fired = got?.reason === 'channel-lost';
    if (fired !== c.fires) wrong.push(`${c.label}: fired=${fired}, expected ${c.fires}`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('a server restart does not fire it for every run — the regression this guards', () => {
  // Simulate the exact sequence: healthy for a long time, then the process restarts (state gone)
  // and every socket is briefly absent before the relays reconnect.
  __resetChannelStateForTest();
  const w = wf();
  const a = agent();
  runningStep(w, a);
  sweep([a], LIVE, CHANNEL_GRACE_MS * 5);          // healthy before the restart
  __resetChannelStateForTest();                    // the restart: in-memory state is gone
  sweep([a], DEAD, 0);                             // first sweep after boot, relays not back yet
  assert.notEqual(workflowNeedsAttention(w)?.reason, 'channel-lost',
    'a restart must not look like a lost channel');
  sweep([a], LIVE, 0);                             // relays reconnect seconds later
  assert.equal(workflowNeedsAttention(w), null);
});

test('it only concerns steps that are RUNNING on that agent', () => {
  __resetChannelStateForTest();
  const w = wf();
  const a = agent();
  db.prepare(
    `INSERT INTO workflow_steps
       (id,workflow_id,name,description,position_x,position_y,status,executor_type,executor_id,
        executor_config,auto_advance,created_at,recovery_status,dispatched_prompt,result,started_at)
     VALUES (?,?,'Done','',0,1,'completed','claude-code',?,'{}',1,?,'','x','ok',?)`,
  ).run(`st-ch-${++n}`, w, a, iso(), iso(60_000));
  sweep([a], DEAD, CHANNEL_GRACE_MS * 2);
  sweep([a], DEAD, 0);
  assert.equal(workflowNeedsAttention(w), null, 'a finished step owes nothing to a lost channel');
});

test('a DEAD agent is reported as interrupted, not channel-lost — cause beats symptom order', () => {
  // An agent that died has no socket either. `interrupted` is the accurate reading and it is
  // higher precedence; channel-lost is specifically the ALIVE-but-unreachable case.
  __resetChannelStateForTest();
  const w = wf();
  const a = agent('offline', STALE_AFTER_MS * 3);
  db.prepare(
    `INSERT INTO workflow_steps
       (id,workflow_id,name,description,position_x,position_y,status,executor_type,executor_id,
        executor_config,auto_advance,created_at,recovery_status,dispatched_prompt,result,started_at)
     VALUES (?,?,'Work','',0,1,'running','claude-code',?,'{}',1,?,'interrupted','do it','',?)`,
  ).run(`st-ch-${++n}`, w, a, iso(), iso(60_000));
  sweep([a], DEAD, CHANNEL_GRACE_MS * 2);
  sweep([a], DEAD, 0);
  assert.equal(workflowNeedsAttention(w)?.reason, 'interrupted');
});

test('channel-lost outranks the symptoms it causes', () => {
  // A cartridge with no channel will also look idle once it stops reporting. Reporting the
  // CAUSE is what lets a person fix it; "went quiet" sends them looking at the agent.
  __resetChannelStateForTest();
  const w = wf();
  const a = agent('idle', STALE_AFTER_MS * 2);     // also satisfies agent-idle
  runningStep(w, a, STALE_AFTER_MS * 3);
  sweep([a], DEAD, CHANNEL_GRACE_MS * 2);
  sweep([a], DEAD, 0);
  assert.equal(workflowNeedsAttention(w)?.reason, 'channel-lost');
});

test('observing is NOT the detector — asking twice cannot advance the clock', () => {
  // workflowNeedsAttention is called from routes/workflows.ts on every dashboard list request.
  // If asking advanced the timer, polling the dashboard would manufacture a stall.
  __resetChannelStateForTest();
  const w = wf();
  const a = agent();
  runningStep(w, a);
  sweep([a], DEAD, 0);                             // one observation, at "now"
  for (let i = 0; i < 50; i++) workflowNeedsAttention(w);
  assert.notEqual(workflowNeedsAttention(w)?.reason, 'channel-lost',
    'reading the state must never advance it');
});
