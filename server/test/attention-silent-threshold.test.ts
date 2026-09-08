/**
 * THE SILENT THRESHOLD ADAPTS UPWARD FOR SLOW RUNS. IT NEVER FIRES EARLIER.
 *
 * The eng review (D2) asked for `max(floor, median × N)` on the reasoning that a fixed 90
 * minutes "is wrong for a 14-minute-cadence run, where it is six missed cycles" — i.e. that it
 * should fire SOONER on fast runs. Measured against three real epic runs (74 loop gaps), that
 * reasoning is wrong and the shape is right, for the opposite reason:
 *
 *   gl-dev GRD-3412       median 13.9  p90 39.9  max  51.8   ← the 52m loop COMPLETED normally
 *   gridlight-work 3502   median  9.9  p90 17.8  max 173.1   ← 65m legit; 146m+173m = the stall
 *   film-engine   3598    median 11.3  p90 21.2  max  32.2
 *
 * Longest VERIFIED-LEGITIMATE gap: ~65 min. Shortest GENUINE stall: ~146 min. The fixed 90
 * sits between them, which is why it worked. Firing earlier is not available: `median × 3`
 * would have accused gl-dev's benchmark loop, which finished fine.
 *
 * So the floor stays, and the adaptive term exists to RAISE it for a workload slower than any
 * observed yet — a run whose median loop is 40 minutes would legitimately produce 150-minute
 * gaps (observed variance runs to 3.7× median), and a fixed 90 would accuse it every cycle.
 * On every run measured so far the floor governs and the adaptive term is inert. That is not
 * dead code; it is a guard for a case that has not happened yet, and the multiplier is set
 * with headroom over the 3.7× worst observed variance.
 *
 * Set-based over the shapes the journal can actually be in, because every interesting failure
 * is a degenerate row count or an unparseable timestamp, not the arithmetic.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  workflowNeedsAttention, medianLoopMs, silentThresholdMs,
  DISPATCH_SILENT_FLOOR_MS, STALL_MULTIPLE, STALE_AFTER_MS,
} from '../src/lib/workflow-attention.ts';

installStubIO();

let n = 0;
const MIN = 60_000;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function wf(): string {
  const id = `wf-thr-${++n}`;
  db.prepare("INSERT INTO workflows (id,name,status,created_at,template_id,run_number) VALUES (?,?,'running',?, 'tpl',1)")
    .run(id, `run ${id}`, iso());
  return id;
}

/** Write `Loop N/M` journal rows with the given gaps (minutes), oldest first. */
function loops(workflowId: string, gapsMin: number[], extra: { garbageTs?: boolean } = {}): void {
  let t = gapsMin.reduce((a, b) => a + b, 0) + 60;   // start far enough back
  const write = (ts: string, i: number) => db.prepare(
    'INSERT INTO workflow_journal (id, workflow_id, step_id, step_name, event_type, message, data, created_at) '
    + "VALUES (?,?,'','Work','log',?,'{}',?)",
  ).run(`j-${++n}`, workflowId, `Loop ${i + 1}/99 — re-dispatching`, ts);
  write(iso(t * MIN), 0);
  gapsMin.forEach((g, i) => { t -= g; write(extra.garbageTs ? 'not-a-timestamp' : iso(t * MIN), i + 1); });
}

function agent(status: string, lastSeenMsAgo: number): string {
  const id = `ag-thr-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
     VALUES (?,?,?,?,?,?,?,?,?,'')`,
  ).run(id, `m/${id}`, 'm', `/r/${id}`, 'r', 'claude', status, iso(lastSeenMsAgo), `s-${id}`);
  return id;
}

function dispatchedStep(w: string, startedMsAgo: number, executor: string): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (id,workflow_id,name,description,position_x,position_y,status,executor_type,executor_id,
        executor_config,auto_advance,created_at,recovery_status,dispatched_prompt,result,started_at)
     VALUES (?,?,'Work Every Task','',0,1,'running','claude-code',?,'{}',1,?,'','do it','',?)`,
  ).run(`st-thr-${++n}`, w, executor, iso(), iso(startedMsAgo));
}

// ── SET 1: medianLoopMs over every shape the journal can be in ──────────────
const MEDIAN_CASES: { label: string; gaps: number[]; garbage?: boolean; want: number | null }[] = [
  { label: 'no loop rows at all', gaps: [], want: null },
  { label: 'one row — no gap exists yet', gaps: [], want: null },
  { label: 'two rows — a single gap IS the median', gaps: [12], want: 12 },
  { label: 'three gaps — the middle one', gaps: [5, 20, 11], want: 11 },
  // Lower middle of [4,10,12,40] is 10. Deliberately the lower of the two, not their average:
  // averaging invents a duration that never occurred, and a smaller median keeps the adaptive
  // term conservative — the floor governs more often, which is the safe direction.
  { label: 'even count — lower middle, not an average', gaps: [4, 10, 12, 40], want: 10 },
  { label: 'a huge outlier does not drag the median', gaps: [10, 11, 12, 13, 300], want: 12 },
  { label: 'unparseable timestamps yield nothing', gaps: [10, 10, 10], garbage: true, want: null },
];

test('medianLoopMs handles EVERY journal shape, including the degenerate ones', () => {
  const wrong: string[] = [];
  for (const c of MEDIAN_CASES) {
    const w = wf();
    if (c.label.startsWith('one row')) {
      loops(w, []);                       // the helper always writes one anchor row
    } else if (c.gaps.length) {
      loops(w, c.gaps, { garbageTs: c.garbage });
    }
    const got = medianLoopMs(w);
    const gotMin = got === null ? null : Math.round(got / MIN);
    if (gotMin !== c.want) wrong.push(`${c.label}: got ${gotMin}, want ${c.want}`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

// ── SET 2: the floor governs unless the run is genuinely slow ───────────────
test('the floor governs every cadence observed in production', () => {
  // Real medians: 9.9, 11.3, 13.9 minutes. None reaches the floor once multiplied.
  const wrong: string[] = [];
  for (const medianMin of [9.9, 11.3, 13.9]) {
    const w = wf();
    loops(w, [medianMin, medianMin, medianMin]);
    const t = silentThresholdMs(w);
    if (t !== DISPATCH_SILENT_FLOOR_MS) {
      wrong.push(`median ${medianMin}min → threshold ${(t / MIN).toFixed(1)}min, expected the floor`);
    }
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('a genuinely slow run raises the threshold above the floor', () => {
  // A 40-minute median has legitimately produced 150-minute gaps at the observed 3.7x variance.
  // A fixed floor would accuse it every cycle; this is the case the adaptive term exists for.
  const w = wf();
  loops(w, [40, 40, 40]);
  const t = silentThresholdMs(w);
  assert.ok(t > DISPATCH_SILENT_FLOOR_MS, `expected above the floor, got ${(t / MIN).toFixed(1)}min`);
  assert.equal(Math.round(t / MIN), Math.round(40 * STALL_MULTIPLE));
});

test('a run with no journal history falls back to the floor, never to zero', () => {
  // The first loop of every run has no gaps yet. A null median that leaked through as 0 would
  // make the threshold 0 and accuse every dispatch instantly.
  assert.equal(silentThresholdMs(wf()), DISPATCH_SILENT_FLOOR_MS);
});

// ── SET 3: the detector honours the adapted threshold at its boundary ───────
test('agent-silent fires on each side of the threshold it actually computed', () => {
  const cases = [
    { label: 'fast run, dispatch under the floor', gaps: [12, 12, 12], ageMin: 60, fires: false },
    { label: 'fast run, dispatch over the floor', gaps: [12, 12, 12], ageMin: 120, fires: true },
    { label: 'slow run, dispatch over the OLD floor but under its own threshold',
      gaps: [40, 40, 40], ageMin: 120, fires: false },
    { label: 'slow run, dispatch over its own threshold', gaps: [40, 40, 40], ageMin: 300, fires: true },
  ];
  const wrong: string[] = [];
  for (const c of cases) {
    const w = wf();
    loops(w, c.gaps);
    dispatchedStep(w, c.ageMin * MIN, agent('working', 5_000));
    const got = workflowNeedsAttention(w);
    const fired = got?.reason === 'agent-silent';
    if (fired !== c.fires) wrong.push(`${c.label}: fired=${fired}, expected ${c.fires}`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('the detail names the threshold it USED, not the constant', () => {
  // A slow run told "dispatched over 90 minutes ago" when its own threshold was 240 would send
  // someone looking for a stall that the detector itself does not believe in.
  const w = wf();
  loops(w, [40, 40, 40]);
  dispatchedStep(w, 300 * MIN, agent('working', 5_000));
  const got = workflowNeedsAttention(w);
  assert.equal(got?.reason, 'agent-silent');
  assert.match(String(got?.detail), new RegExp(`over ${Math.round(40 * STALL_MULTIPLE)} minutes`),
    `detail should quote the computed threshold; got: ${got?.detail}`);
});

test('the multiplier clears the worst legitimate variance observed', () => {
  // Observed max/median on a run with NO stall in it: 3.7x (gl-dev). The multiplier must exceed
  // that with headroom, or the adaptive term becomes a false-positive generator on slow runs.
  assert.ok(STALL_MULTIPLE > 3.7,
    `STALL_MULTIPLE=${STALL_MULTIPLE} does not clear the 3.7x worst observed legitimate variance`);
});
