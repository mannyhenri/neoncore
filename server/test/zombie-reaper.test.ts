import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  findZombies,
  zombieThresholdFor,
  ZOMBIE_THRESHOLD_MS,
  SILENT_ZOMBIE_THRESHOLD_MS,
} from '../src/lib/zombie-reaper.ts';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL DEFAULT 'claude',
      status TEXT NOT NULL DEFAULT 'idle',
      last_seen TEXT
    );
  `);
  return db;
}

function addAgent(db: ReturnType<typeof freshDb>, o: {
  id: string; type?: string; status?: string; quietForMs: number;
}) {
  db.prepare('INSERT INTO agents (id, agent_type, status, last_seen) VALUES (?, ?, ?, ?)').run(
    o.id,
    o.type ?? 'claude',
    o.status ?? 'idle',
    new Date(NOW - o.quietForMs).toISOString(),
  );
}

const noSockets = () => false;
const reap = (db: ReturnType<typeof freshDb>, hasActiveSocket = noSockets) =>
  findZombies(db, { now: NOW, hasActiveSocket }).map((z) => z.id);

// ─── Threshold selection ────────────────────────────────────────────────────

test('agents that CAN report death keep the long, forgiving window', () => {
  assert.equal(zombieThresholdFor('claude'), ZOMBIE_THRESHOLD_MS);
  assert.equal(zombieThresholdFor('gridlight'), ZOMBIE_THRESHOLD_MS);
});

test('agents that CANNOT report death get the short window', () => {
  for (const type of ['codex', 'gemini', 'amazonq', 'cursor']) {
    assert.equal(zombieThresholdFor(type), SILENT_ZOMBIE_THRESHOLD_MS, type);
  }
});

test('an unknown agent type defaults to the LONG window', () => {
  // A type added later must not have its live sessions culled by a rule written before it
  // existed. Lingering is the safe failure; reaping early is the one that loses work.
  assert.equal(zombieThresholdFor('some-future-cli'), ZOMBIE_THRESHOLD_MS);
  assert.equal(zombieThresholdFor(''), ZOMBIE_THRESHOLD_MS);
  assert.equal(zombieThresholdFor(null), ZOMBIE_THRESHOLD_MS);
});

test('type matching is case-insensitive', () => {
  assert.equal(zombieThresholdFor('CLAUDE'), ZOMBIE_THRESHOLD_MS);
  assert.equal(zombieThresholdFor('Codex'), SILENT_ZOMBIE_THRESHOLD_MS);
});

// ─── The bug this fixes ─────────────────────────────────────────────────────

test('a codex session quiet for 6.7h is reaped — it cannot report death', () => {
  // The exact ghost observed: closed hours ago, still showing as idle in the grid,
  // because no codex reporter has a session-end path to fire.
  const db = freshDb();
  addAgent(db, { id: 'codex-ghost', type: 'codex', quietForMs: 6.7 * HOUR });
  assert.deepEqual(reap(db), ['codex-ghost']);
});

test('a claude session quiet for the same 6.7h is LEFT ALONE', () => {
  // The whole reason the long window exists: this one is very likely still sitting open
  // in a terminal, and reaping it is what used to make cartridges vanish while in use.
  const db = freshDb();
  addAgent(db, { id: 'claude-alive', type: 'claude', quietForMs: 6.7 * HOUR });
  assert.deepEqual(reap(db), []);
});

test('both are reaped once past 24h', () => {
  const db = freshDb();
  addAgent(db, { id: 'claude-old', type: 'claude', quietForMs: 25 * HOUR });
  addAgent(db, { id: 'codex-old', type: 'codex', quietForMs: 25 * HOUR });
  assert.deepEqual(reap(db).sort(), ['claude-old', 'codex-old']);
});

// ─── Not reaping the living ─────────────────────────────────────────────────

test('a live socket outranks any timer, however old the row', () => {
  const db = freshDb();
  addAgent(db, { id: 'connected', type: 'codex', quietForMs: 40 * HOUR });
  assert.deepEqual(reap(db, (id) => id === 'connected'), []);
});

test('a codex session quiet for 90 minutes survives — lunch is not death', () => {
  const db = freshDb();
  addAgent(db, { id: 'at-lunch', type: 'codex', quietForMs: 90 * MIN });
  assert.deepEqual(reap(db), []);
});

test('an already-offline agent is not reaped again', () => {
  const db = freshDb();
  addAgent(db, { id: 'gone', type: 'codex', status: 'offline', quietForMs: 40 * HOUR });
  assert.deepEqual(reap(db), []);
});

test('working and waiting agents are reapable, not just idle ones', () => {
  // A session killed mid-tool-call never leaves 'working'. Excluding those statuses
  // would strand exactly the cartridges most obviously stuck.
  const db = freshDb();
  addAgent(db, { id: 'w', type: 'codex', status: 'working', quietForMs: 3 * HOUR });
  addAgent(db, { id: 'q', type: 'codex', status: 'waiting', quietForMs: 3 * HOUR });
  assert.deepEqual(reap(db).sort(), ['q', 'w']);
});

// ─── Robustness ─────────────────────────────────────────────────────────────

test('a row with a missing or unparseable last_seen is skipped, not crashed on', () => {
  // This runs inside a setInterval, where an uncaught throw takes the process down and
  // then crash-loops, because the offending row is still there on restart.
  const db = freshDb();
  db.prepare("INSERT INTO agents (id, agent_type, status, last_seen) VALUES ('a','codex','idle',NULL)").run();
  db.prepare("INSERT INTO agents (id, agent_type, status, last_seen) VALUES ('b','codex','idle','not-a-date')").run();
  assert.deepEqual(reap(db), []);
});

test('reports the age and threshold that justified each reap', () => {
  // The log line is the only way to tell a correct reap from an over-eager one after the
  // fact, so the numbers behind the decision have to come back with it.
  const db = freshDb();
  addAgent(db, { id: 'codex-ghost', type: 'codex', quietForMs: 3 * HOUR });
  const [z] = findZombies(db, { now: NOW, hasActiveSocket: noSockets });
  assert.equal(z.agentType, 'codex');
  assert.equal(z.thresholdMs, SILENT_ZOMBIE_THRESHOLD_MS);
  assert.ok(Math.abs(z.ageMs - 3 * HOUR) < 1000);
});
