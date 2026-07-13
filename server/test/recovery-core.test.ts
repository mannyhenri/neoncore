import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  renderReplayContext,
  resolveSessionId,
  detectInterruptedSteps,
  markAgentStepsInterrupted,
  recoverStep,
  EXECUTOR_STALE_MS,
} from '../src/lib/recovery-core.ts';

const NOW = 1_700_000_000_000;
const GRACE = 90_000;

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_steps (
      id TEXT PRIMARY KEY, workflow_id TEXT DEFAULT 'w1', name TEXT DEFAULT 's',
      status TEXT NOT NULL, executor_id TEXT NOT NULL DEFAULT '', started_at TEXT,
      native_session_id TEXT NOT NULL DEFAULT '', interrupted_at TEXT,
      recovery_status TEXT NOT NULL DEFAULT '', recovery_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'idle', last_seen TEXT);
    CREATE TABLE messages (
      id TEXT, agent_id TEXT, session_id TEXT, seq INTEGER, role TEXT, content TEXT, ts TEXT
    );
  `);
  return db;
}

function addStep(db, o) {
  db.prepare(
    `INSERT INTO workflow_steps (id, status, executor_id, started_at, native_session_id, recovery_status, recovery_attempts)
     VALUES (@id, @status, @executor_id, @started_at, @native_session_id, @recovery_status, @recovery_attempts)`
  ).run({
    id: o.id, status: o.status, executor_id: o.executor_id ?? '',
    started_at: o.started_at ?? null, native_session_id: o.native_session_id ?? '',
    recovery_status: o.recovery_status ?? '', recovery_attempts: o.recovery_attempts ?? 0,
  });
}
// lastSeen defaults to NOW — i.e. "this agent just did something". Tests that want a
// dead-but-not-yet-flagged executor pass an old timestamp explicitly.
const addAgent = (db, id, status, lastSeen = new Date(NOW).toISOString()) =>
  db.prepare('INSERT INTO agents (id, status, last_seen) VALUES (?, ?, ?)').run(id, status, lastSeen);
function addMsg(db, agentId, sessionId, seq, role, blocks, ts) {
  db.prepare('INSERT INTO messages (id, agent_id, session_id, seq, role, content, ts) VALUES (?,?,?,?,?,?,?)')
    .run(`m${seq}-${sessionId}`, agentId, sessionId, seq, role, JSON.stringify(blocks), ts);
}

const oldStart = new Date(NOW - 200_000).toISOString();
const recentStart = new Date(NOW - 10_000).toISOString();
const aliveNo = () => false;
const aliveYes = () => true;

// ── renderReplayContext (pure) ──────────────────────────────────────────────

test('renderReplayContext: empty transcript → header + no-transcript note', () => {
  const out = renderReplayContext([]);
  assert.match(out, /RESUMING/);
  assert.match(out, /No prior transcript/);
  assert.match(out, /Continue the task now/);
});

test('renderReplayContext: single turn renders text verbatim with role', () => {
  const out = renderReplayContext([{ role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'hello world' }]) }]);
  assert.match(out, /\[assistant\]/);
  assert.match(out, /hello world/);
});

test('renderReplayContext: keeps last N verbatim and notes omitted count', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: JSON.stringify([{ type: 'text', text: `turn-${i}` }]),
  }));
  const out = renderReplayContext(rows, { verbatimTurns: 10 });
  assert.match(out, /\[5 earlier turn\(s\) omitted/);
  assert.doesNotMatch(out, /turn-4\b/); // omitted
  assert.match(out, /turn-14/);         // kept
});

test('renderReplayContext: renders tool_use and tool_result blocks', () => {
  const out = renderReplayContext([{
    role: 'assistant',
    content: JSON.stringify([
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', content: 'file1\nfile2' },
      { type: 'thinking', thinking: 'secret' },
    ]),
  }]);
  assert.match(out, /→ Bash\(/);
  assert.match(out, /← result: file1/);
  assert.doesNotMatch(out, /secret/); // thinking omitted
});

test('renderReplayContext: malformed content does not throw', () => {
  const out = renderReplayContext([{ role: 'user', content: 'not-json' }]);
  assert.match(out, /not-json/);
});

// ── resolveSessionId ────────────────────────────────────────────────────────

test('resolveSessionId: returns the latest session by ts', () => {
  const db = freshDb();
  addMsg(db, 'a1', 'old-sess', 0, 'user', [{ type: 'text', text: 'x' }], '2024-01-01T00:00:00Z');
  addMsg(db, 'a1', 'new-sess', 0, 'user', [{ type: 'text', text: 'y' }], '2024-06-01T00:00:00Z');
  assert.equal(resolveSessionId(db, 'a1'), 'new-sess');
  assert.equal(resolveSessionId(db, 'nope'), '');
});

// ── detectInterruptedSteps ──────────────────────────────────────────────────

test('detect: running + offline agent + past grace → interrupted', () => {
  const db = freshDb();
  addAgent(db, 'a1', 'offline');
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', started_at: oldStart });
  addMsg(db, 'a1', 'sess-1', 0, 'user', [{ type: 'text', text: 'hi' }], '2024-06-01T00:00:00Z');
  const marked = detectInterruptedSteps(db, { now: NOW, graceMs: GRACE, isAlive: aliveNo });
  assert.deepEqual(marked, ['s1']);
  const row = db.prepare('SELECT recovery_status, native_session_id, interrupted_at FROM workflow_steps WHERE id = ?').get('s1');
  assert.equal(row.recovery_status, 'interrupted');
  assert.equal(row.native_session_id, 'sess-1');
  assert.ok(row.interrupted_at);
});

test('detect: agent still working → left alone', () => {
  const db = freshDb();
  addAgent(db, 'a1', 'working');
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', started_at: oldStart });
  assert.deepEqual(detectInterruptedSteps(db, { now: NOW, graceMs: GRACE, isAlive: aliveNo }), []);
});

// The whole point of decoupling recovery from the `offline` flag. Agents that merely go
// quiet must stay VISIBLE in the grid, so `offline` is now only set by a real death signal
// (SessionEnd / socket drop / 24h zombie reap). A hard-killed executor fires NONE of those
// and can sit as 'working' for a day — recovery must still catch it, via activity staleness.
// If this ever regresses, crashed workflow steps silently hang for 24h.
test('detect: executor stuck "working" but silent past EXECUTOR_STALE_MS → interrupted', () => {
  const db = freshDb();
  const longDead = new Date(NOW - EXECUTOR_STALE_MS - 60_000).toISOString();
  addAgent(db, 'a1', 'working', longDead); // never marked offline — no death signal fired
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', started_at: oldStart });
  addMsg(db, 'a1', 'sess-1', 0, 'user', [{ type: 'text', text: 'hi' }], '2024-06-01T00:00:00Z');
  assert.deepEqual(detectInterruptedSteps(db, { now: NOW, graceMs: GRACE, isAlive: aliveNo }), ['s1']);
});

test('detect: executor quiet but within EXECUTOR_STALE_MS → left alone (just idling)', () => {
  const db = freshDb();
  const recentlyQuiet = new Date(NOW - 60_000).toISOString();
  addAgent(db, 'a1', 'idle', recentlyQuiet);
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', started_at: oldStart });
  assert.deepEqual(detectInterruptedSteps(db, { now: NOW, graceMs: GRACE, isAlive: aliveNo }), []);
});

test('detect: offline but live socket → left alone', () => {
  const db = freshDb();
  addAgent(db, 'a1', 'offline');
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', started_at: oldStart });
  assert.deepEqual(detectInterruptedSteps(db, { now: NOW, graceMs: GRACE, isAlive: aliveYes }), []);
});

test('detect: offline but within grace → left alone', () => {
  const db = freshDb();
  addAgent(db, 'a1', 'offline');
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', started_at: recentStart });
  assert.deepEqual(detectInterruptedSteps(db, { now: NOW, graceMs: GRACE, isAlive: aliveNo }), []);
});

test('detect: idempotent — already-flagged step is not re-marked', () => {
  const db = freshDb();
  addAgent(db, 'a1', 'offline');
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', started_at: oldStart, recovery_status: 'recovering' });
  assert.deepEqual(detectInterruptedSteps(db, { now: NOW, graceMs: GRACE, isAlive: aliveNo }), []);
});

test('detect: deferred / no-agent steps are ignored', () => {
  const db = freshDb();
  addStep(db, { id: 's1', status: 'running', executor_id: '__deferred__', started_at: oldStart });
  addStep(db, { id: 's2', status: 'running', executor_id: '', started_at: oldStart });
  assert.deepEqual(detectInterruptedSteps(db, { now: NOW, graceMs: GRACE, isAlive: aliveNo }), []);
});

// ── markAgentStepsInterrupted (relay fast path) ─────────────────────────────

test('markAgentStepsInterrupted: flags only the agent\'s running unflagged steps', () => {
  const db = freshDb();
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1' });
  addStep(db, { id: 's2', status: 'completed', executor_id: 'a1' });
  addStep(db, { id: 's3', status: 'running', executor_id: 'a2' });
  addMsg(db, 'a1', 'sess-a1', 0, 'user', [{ type: 'text', text: 'hi' }], '2024-06-01T00:00:00Z');
  const marked = markAgentStepsInterrupted(db, 'a1', { now: NOW });
  assert.deepEqual(marked, ['s1']);
  assert.equal(db.prepare('SELECT recovery_status FROM workflow_steps WHERE id=?').get('s1').recovery_status, 'interrupted');
  assert.equal(db.prepare('SELECT recovery_status FROM workflow_steps WHERE id=?').get('s3').recovery_status, '');
});

// ── recoverStep ─────────────────────────────────────────────────────────────

test('recoverStep: interrupted step → dispatches replay, marks recovered', () => {
  const db = freshDb();
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', recovery_status: 'interrupted', native_session_id: 'sess-1' });
  addMsg(db, 'a1', 'sess-1', 0, 'assistant', [{ type: 'text', text: 'did step one' }], '2024-06-01T00:00:00Z');
  const dispatched = [];
  const r = recoverStep(db, 's1', { now: NOW, dispatch: (a, t) => dispatched.push({ a, t }) });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].a, 'a1');
  assert.match(dispatched[0].t, /did step one/);
  const row = db.prepare('SELECT status, recovery_status, recovery_attempts FROM workflow_steps WHERE id=?').get('s1');
  assert.equal(row.status, 'running');
  assert.equal(row.recovery_status, 'recovered');
  assert.equal(row.recovery_attempts, 1);
});

test('recoverStep: missing step → ok false', () => {
  const db = freshDb();
  const r = recoverStep(db, 'nope', { now: NOW, dispatch: () => {} });
  assert.equal(r.ok, false);
});

test('recoverStep: not in a recoverable state → ok false, no dispatch', () => {
  const db = freshDb();
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', recovery_status: 'recovered' });
  let called = 0;
  const r = recoverStep(db, 's1', { now: NOW, dispatch: () => { called++; } });
  assert.equal(r.ok, false);
  assert.equal(called, 0);
});

test('recoverStep: CAS makes concurrent calls dispatch exactly once', () => {
  const db = freshDb();
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', recovery_status: 'interrupted', native_session_id: 'sess-1' });
  let called = 0;
  const dispatch = () => { called++; };
  const r1 = recoverStep(db, 's1', { now: NOW, dispatch });
  const r2 = recoverStep(db, 's1', { now: NOW, dispatch });
  assert.equal(called, 1);
  assert.equal([r1.ok, r2.ok].filter(Boolean).length, 1);
});

test('recoverStep: exceeding max attempts → recovery_failed', () => {
  const db = freshDb();
  addStep(db, { id: 's1', status: 'running', executor_id: 'a1', recovery_status: 'interrupted', recovery_attempts: 3 });
  let called = 0;
  const r = recoverStep(db, 's1', { now: NOW, dispatch: () => { called++; }, maxAttempts: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.recoveryStatus, 'recovery_failed');
  assert.equal(called, 0);
  assert.equal(db.prepare('SELECT recovery_status FROM workflow_steps WHERE id=?').get('s1').recovery_status, 'recovery_failed');
});
