import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  COMPLETION_MARKER,
  MAX_STOP_BLOCKS,
  STANDARD_OPT_OUT,
  WORK_STANDARD_SHORT,
  evaluateStop,
  parseCompletionBlock,
  shouldInjectStandard,
  validateCompletionPayload,
} from '../src/lib/work-standard.ts';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      agent_type TEXT NOT NULL DEFAULT 'claude',
      active_objective TEXT NOT NULL DEFAULT '',
      standard_armed INTEGER NOT NULL DEFAULT 0,
      standard_blocks INTEGER NOT NULL DEFAULT 0,
      standard_state TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

function addAgent(db: ReturnType<typeof freshDb>, o: {
  id?: string; sessionId?: string; type?: string;
  objective?: string; armed?: boolean; blocks?: number;
} = {}) {
  db.prepare(
    'INSERT INTO agents (id, session_id, agent_type, active_objective, standard_armed, standard_blocks) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    o.id ?? 'agent-1',
    o.sessionId ?? 'sess-1',
    o.type ?? 'claude',
    o.objective ?? 'Fix the report copy bug',
    o.armed === false ? 0 : 1,
    o.blocks ?? 0,
  );
  return o.id ?? 'agent-1';
}

const readAgent = (db: ReturnType<typeof freshDb>, id = 'agent-1') =>
  db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;

const GOOD_BLOCK = `All twelve sections now copy.

${COMPLETION_MARKER}
scope: 15/15 — 12 report sections + 3 attachment types, per REPORT_SECTIONS
verify: npm test -- report-copy → 15 passed, 0 failed
deferred: none`;

// ─── Injection predicate ────────────────────────────────────────────────────

test('a real ask carries the standard', () => {
  assert.equal(shouldInjectStandard('Fix the bug where copying a report drops some sections'), true);
});

// Set-based: EVERY continuation word must be skipped, not a sample of them. A new word
// added to the regex without a matching skip is exactly the kind of gap this catches.
const CONTINUATIONS = [
  'y', 'n', 'yes', 'no', 'ok', 'okay', 'k', 'sure', 'go', 'go ahead', 'proceed',
  'continue', 'next', 'stop', 'wait', 'thanks', 'thank you', 'ty', 'done',
  'nice', 'good', 'great', 'perfect',
];

test('no conversational continuation gets the standard', () => {
  const injected = CONTINUATIONS.filter((c) => shouldInjectStandard(c));
  assert.deepEqual(injected, [], `these replies were treated as asks: ${injected.join(', ')}`);
});

test('continuations are skipped regardless of case and trailing punctuation', () => {
  const noisy = CONTINUATIONS.flatMap((c) => [c.toUpperCase(), `${c}.`, `  ${c}!  `]);
  const injected = noisy.filter((c) => shouldInjectStandard(c));
  assert.deepEqual(injected, [], `these replies were treated as asks: ${injected.join(', ')}`);
});

test('server-generated context blocks are not asks', () => {
  assert.equal(shouldInjectStandard('[Project Context for neoncore]\n\n## Recent Sessions\nlots of text here'), false);
  assert.equal(shouldInjectStandard('[Memory: decision: use sqlite | gotcha: relay must be running]'), false);
});

test('an already-standardised prompt is not double-injected', () => {
  assert.equal(shouldInjectStandard(WORK_STANDARD_SHORT + '\n\nFix the copy bug in reports'), false);
});

test('the opt-out marker sends a prompt raw', () => {
  assert.equal(shouldInjectStandard(`${STANDARD_OPT_OUT} just tell me what this function does, do not change anything`), false);
});

test('empty and whitespace prompts inject nothing', () => {
  assert.equal(shouldInjectStandard(''), false);
  assert.equal(shouldInjectStandard('   \n  '), false);
});

// ─── Completion block parsing ───────────────────────────────────────────────

test('a well-formed block parses', () => {
  const b = parseCompletionBlock(GOOD_BLOCK);
  assert.ok(b);
  assert.match(b.scope, /^15\/15/);
  assert.match(b.verify, /15 passed/);
  assert.equal(b.deferred, 'none');
});

test('no marker means no report', () => {
  assert.equal(parseCompletionBlock('I fixed the summary and findings sections. Let me know if you want the rest.'), null);
});

test('the unedited template is not a report', () => {
  const templated = `${COMPLETION_MARKER}\nscope: <done>/<total>\nverify: <exact command run> → <actual result>\ndeferred: none`;
  assert.equal(parseCompletionBlock(templated), null);
});

// Each placeholder must be rejected on its own — one lenient value is a hole in the gate.
const PLACEHOLDERS = ['', '   ', 'TBD', 'todo', 'n/a', 'na', '-', '...', 'pending', 'unknown', '<actual result>'];

test('no placeholder passes as verification', () => {
  const accepted = PLACEHOLDERS.filter((p) =>
    parseCompletionBlock(`${COMPLETION_MARKER}\nscope: 3/3 — all call sites\nverify: ${p}\ndeferred: none`) !== null
  );
  assert.deepEqual(accepted, [], `these were accepted as real verification: ${accepted.map((p) => JSON.stringify(p)).join(', ')}`);
});

test('no placeholder passes as scope', () => {
  const accepted = PLACEHOLDERS.filter((p) =>
    parseCompletionBlock(`${COMPLETION_MARKER}\nscope: ${p}\nverify: npm test → 9 passed\ndeferred: none`) !== null
  );
  assert.deepEqual(accepted, [], `these were accepted as real scope: ${accepted.map((p) => JSON.stringify(p)).join(', ')}`);
});

test('deferred defaults to none when omitted', () => {
  const b = parseCompletionBlock(`${COMPLETION_MARKER}\nscope: 2/2 — both handlers\nverify: npm test → ok`);
  assert.equal(b?.deferred, 'none');
});

test('a real deferral is preserved', () => {
  const b = parseCompletionBlock(
    `${COMPLETION_MARKER}\nscope: 14/15 — 12 sections + 3 attachments\nverify: npm test → 14 passed\ndeferred: audit-log section — needs a retention decision (#412)`
  );
  assert.match(b!.deferred, /audit-log/);
});

test('the last block wins when the agent quoted the template first', () => {
  const text = `I will finish with:\n${COMPLETION_MARKER}\nscope: <done>/<total>\nverify: <cmd>\n\n...work...\n\n${COMPLETION_MARKER}\nscope: 4/4 — every call site of copyFrom\nverify: npx vitest run copy → 4 passed`;
  const b = parseCompletionBlock(text);
  assert.ok(b, 'a real block after a quoted template must still be accepted');
  assert.match(b.scope, /^4\/4/);
});

test('a "verify:" line inside pasted log output cannot fake a report', () => {
  const text = `Here is the log:\n  verify: something happened\n\nAll done, no block filed.`;
  assert.equal(parseCompletionBlock(text), null);
});

// ─── Structured payload validation ──────────────────────────────────────────

test('explicit fields validate', () => {
  const v = validateCompletionPayload({ scope: '15/15 — all sections', verify: 'npm test → 15 passed' });
  assert.equal(v.ok, true);
});

test('a legacy free-text result carrying a block still validates', () => {
  const v = validateCompletionPayload({ result: GOOD_BLOCK });
  assert.equal(v.ok, true);
  assert.ok(v.ok && v.block.verify.includes('15 passed'));
});

test('a claim of done with no verification is rejected with an actionable reason', () => {
  const v = validateCompletionPayload({ result: 'Fixed it, should work now.' });
  assert.equal(v.ok, false);
  assert.ok(!v.ok && /verify/i.test(v.reason));
  assert.ok(!v.ok && /scope/i.test(v.reason));
});

test('scope without verify is still rejected', () => {
  const v = validateCompletionPayload({ scope: '15/15 — all sections', verify: '' });
  assert.equal(v.ok, false);
});

// ─── The stop gate ──────────────────────────────────────────────────────────

test('an unknown session is never blocked', () => {
  const db = freshDb();
  assert.deepEqual(evaluateStop(db, { sessionId: 'nope', finalText: 'hi' }), { decision: 'allow', cleared: false });
});

test('an unarmed agent is never blocked', () => {
  const db = freshDb();
  addAgent(db, { armed: false });
  assert.equal(evaluateStop(db, { sessionId: 'sess-1', finalText: 'chatting' }).decision, 'allow');
});

test('an armed agent with no live objective is never blocked', () => {
  const db = freshDb();
  addAgent(db, { objective: '' });
  assert.equal(evaluateStop(db, { sessionId: 'sess-1', finalText: 'chatting' }).decision, 'allow');
});

test('stopping mid-task without a report is blocked', () => {
  const db = freshDb();
  addAgent(db);
  const d = evaluateStop(db, { sessionId: 'sess-1', finalText: 'I fixed two of the sections. Let me know if you want the others.' });
  assert.equal(d.decision, 'block');
  assert.ok(d.decision === 'block' && /complete set/i.test(d.reason));
  assert.equal(readAgent(db).standard_blocks, 1);
});

test('the objective text is quoted back in the block reason', () => {
  const db = freshDb();
  addAgent(db, { objective: 'Copy every section into the new report' });
  const d = evaluateStop(db, { sessionId: 'sess-1', finalText: 'partial work' });
  assert.ok(d.decision === 'block' && d.reason.includes('Copy every section'));
});

test('a filed report closes the objective and disarms the gate', () => {
  const db = freshDb();
  addAgent(db, { blocks: 1 });
  const d = evaluateStop(db, { sessionId: 'sess-1', finalText: GOOD_BLOCK });
  assert.deepEqual(d, { decision: 'allow', cleared: true });
  const row = readAgent(db);
  assert.equal(row.active_objective, '');
  assert.equal(row.standard_armed, 0);
  assert.equal(row.standard_blocks, 0);
});

test('an agent is released after the cap and flagged for review, not trapped', () => {
  const db = freshDb();
  addAgent(db, { blocks: MAX_STOP_BLOCKS });
  const d = evaluateStop(db, { sessionId: 'sess-1', finalText: 'still not done' });
  assert.equal(d.decision, 'allow');
  const row = readAgent(db);
  assert.equal(row.standard_state, 'needs_review');
  assert.equal(row.standard_armed, 0);
});

test('blocking never exceeds the cap across a full run', () => {
  const db = freshDb();
  addAgent(db);
  const decisions = Array.from({ length: MAX_STOP_BLOCKS + 3 }, () =>
    evaluateStop(db, { sessionId: 'sess-1', finalText: 'no report here' }).decision
  );
  const blocked = decisions.filter((d) => d === 'block').length;
  assert.equal(blocked, MAX_STOP_BLOCKS, `expected exactly ${MAX_STOP_BLOCKS} blocks, got ${blocked}: ${decisions.join(',')}`);
});

test('stop_hook_active short-circuits the gate even below the cap', () => {
  const db = freshDb();
  addAgent(db);
  const d = evaluateStop(db, { sessionId: 'sess-1', finalText: 'no report', stopHookActive: true });
  assert.equal(d.decision, 'allow');
  assert.equal(readAgent(db).standard_state, 'needs_review');
});

test('the gate resolves the right cartridge when one repo runs two engines', () => {
  const db = freshDb();
  addAgent(db, { id: 'claude-1', sessionId: 'shared', type: 'claude' });
  addAgent(db, { id: 'codex-1', sessionId: 'shared', type: 'codex' });
  evaluateStop(db, { sessionId: 'shared', agentType: 'codex', finalText: 'no report' });
  assert.equal(readAgent(db, 'codex-1').standard_blocks, 1);
  assert.equal(readAgent(db, 'claude-1').standard_blocks, 0, 'the other engine\'s cartridge must be untouched');
});
