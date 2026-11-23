/**
 * "THE CARTRIDGE FINISHED WITHOUT SUBMITTING" MUST MEAN ITS TURN FINISHED.
 *
 * requestWentSilent judges every delivered Goal Pilot request — the planner's answer, the
 * acceptance tests, the reviewer's verdicts. It used to read `idle` as "finished". But the 2-minute
 * staleness sweep (index.ts) also sets `idle` in the MIDDLE of a turn, whenever one tool call runs
 * longer than that: no hook fires while a command runs. On 2026-11-21 gl-dev ran a 10-minute red
 * test run while writing acceptance tests; at minute 3 the request was failed, re-sent twice into
 * the still-busy cartridge, and failed again.
 *
 * SET-BASED: every engine NeonCore drives reports its turn's end (routes/agents.ts turnEnded); for
 * each, a long tool call is not silence and an ended turn is. An engine that never reports a turn
 * end keeps the old rule, and a cartridge that went offline is silent for every engine.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import db from '../src/db.ts';
import { requestWentSilent, PLANNER_SILENT_MS } from '../src/lib/goal-pilot-runner.ts';
import { noteTurnEndedForSilence, TURN_END_ENGINES } from '../src/lib/goal-pilot-runner.ts';

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function setup(agentType: string, now: number) {
  const agentId = randomUUID();
  const requestId = randomUUID();
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, status, agent_type, last_seen)
              VALUES (?, ?, 'test', ?, 'working', ?, ?)`)
    .run(agentId, `silence-${agentType}-${agentId.slice(0, 4)}`, `/tmp/silence-${agentId}`, agentType, iso(now - 12 * MIN));
  db.prepare(`INSERT INTO goal_pilot_requests (id, pilot_id, kind, status, agent_id, created_at, dispatched_at)
              VALUES (?, 'pilot-x', 'tests', 'pending', ?, ?, ?)`)
    .run(requestId, agentId, iso(now - 15 * MIN), iso(now - 15 * MIN));
  db.pragma('foreign_keys = ON');
  // Its last hook event, 12 minutes ago — then one long tool call, which fires nothing.
  db.prepare(`INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, timestamp) VALUES (?, ?, 'PostToolUse', 'Write', '{}', ?)`)
    .run(randomUUID(), agentId, iso(now - 12 * MIN));
  return { agentId, requestId };
}

test('the engines that report a turn end are the ones NeonCore drives', () => {
  assert.deepEqual([...TURN_END_ENGINES].sort(), ['claude', 'codex']);
});

for (const engine of TURN_END_ENGINES) {
  test(`${engine}: a long tool call mid-turn is not silence, though the sweep marked it idle`, () => {
    const now = Date.now();
    const { agentId, requestId } = setup(engine, now);
    db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(agentId); // what the 2-minute sweep does
    assert.ok(now - PLANNER_SILENT_MS > Date.parse(iso(now - 12 * MIN)));
    assert.equal(requestWentSilent(requestId, now), false);
  });

  test(`${engine}: a turn that ended after the request arrived, then quiet, is silence`, () => {
    const now = Date.now();
    const { agentId, requestId } = setup(engine, now);
    noteTurnEndedForSilence(agentId, now - 10 * MIN);
    db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(agentId);
    assert.equal(requestWentSilent(requestId, now), true);
  });

  test(`${engine}: a turn that ended BEFORE the request arrived does not count`, () => {
    const now = Date.now();
    const { agentId, requestId } = setup(engine, now);
    noteTurnEndedForSilence(agentId, now - 20 * MIN);
    db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(agentId);
    assert.equal(requestWentSilent(requestId, now), false);
  });

  test(`${engine}: a cartridge that went offline is silent, turn end or not`, () => {
    const now = Date.now();
    const { agentId, requestId } = setup(engine, now);
    db.prepare(`UPDATE agents SET status = 'offline' WHERE id = ?`).run(agentId);
    assert.equal(requestWentSilent(requestId, now), true);
  });
}

test('an engine that never reports a turn end keeps the idle-and-quiet rule', () => {
  const now = Date.now();
  const { agentId, requestId } = setup('gemini', now);
  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(agentId);
  assert.equal(requestWentSilent(requestId, now), true);
});

test('the turn end survives a restart: it is stored on the cartridge, not in memory', () => {
  const now = Date.now();
  const { agentId } = setup('claude', now);
  noteTurnEndedForSilence(agentId, now - 10 * MIN);
  const row = db.prepare('SELECT turn_ended_at FROM agents WHERE id = ?').get(agentId) as { turn_ended_at: string };
  assert.equal(row.turn_ended_at, iso(now - 10 * MIN));
});
