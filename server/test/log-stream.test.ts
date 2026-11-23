/**
 * THE LOGS — one stream of three kinds of line (lib/log-stream.ts):
 *   event     what every agent did, from its hooks — every machine (the activity table)
 *   terminal  the output of the processes NeonCore runs in the background on THIS machine
 *   neoncore  NeonCore's own console
 * Checked as sets: every line is found exactly once paging back from the newest to the oldest, in
 * order; every filter (kinds, problems only, search, only one source, hidden sources) keeps exactly
 * the lines it should; newer lines come after a cursor; sources are listed with their counts.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import db from '../src/db.js';
import { recordLog, readLogs, installConsoleCapture, pruneLogs, type LogQuery, type LogLine } from '../src/lib/log-stream.js';
import logsRouter from '../src/routes/logs.js';

const T0 = Date.parse('2026-11-23T09:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let n = 0;
function agent(name: string, engine: string, machine: string): string {
  const id = `lg-a-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen) VALUES (?,?,?,?,?,?, 'idle', ?)`)
    .run(id, `${machine}/${name}`, machine, `/code/${name}`, name, engine, at(0));
  return id;
}
function event(agentId: string, s: number, type: string, tool = '', input: unknown = {}, result: unknown = {}): void {
  db.prepare(`INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, tool_result, timestamp) VALUES (?,?,?,?,?,?,?)`)
    .run(`lg-e-${++n}`, agentId, type, tool, typeof input === 'string' ? input : JSON.stringify(input), JSON.stringify(result), at(s));
}

// A morning: two agents on two machines, a QA run's output, and NeonCore's own lines — interleaved.
const ledger = agent('harbour-ledger', 'claude', 'vm');
const menu = agent('diner-menu-api', 'codex', 'mac');
const want: { s: number; kind: string; source: string; text: string; problem: boolean }[] = [];
for (let i = 0; i < 120; i++) {
  const s = i * 3;
  if (i % 4 === 0) { event(ledger, s, 'tool_use', 'Bash', { command: `npm test #${i}` }); want.push({ s, kind: 'event', source: 'harbour-ledger', text: `Bash npm test #${i}`, problem: false }); }
  if (i % 4 === 1) { event(menu, s, 'assistant_message', '', `Done: step ${i}\n- Verified`); want.push({ s, kind: 'event', source: 'diner-menu-api', text: `Done: step ${i}\n- Verified`, problem: false }); }
  if (i % 4 === 2) { event(ledger, s, 'tool_error', 'Edit', { file_path: `/code/harbour-ledger/f${i}.ts` }); want.push({ s, kind: 'event', source: 'harbour-ledger', text: `Edit /code/harbour-ledger/f${i}.ts — error`, problem: true }); }
  if (i % 4 === 3) {
    recordLog({ kind: i % 8 === 3 ? 'terminal' : 'neoncore', source: i % 8 === 3 ? 'qa · Lighthouse Site' : 'NeonCore', text: i % 16 === 7 ? `request failed #${i}` : `line #${i}`, level: i % 16 === 7 ? 'problem' : 'info', at: at(s) });
    want.push({ s, kind: i % 8 === 3 ? 'terminal' : 'neoncore', source: i % 8 === 3 ? 'qa · Lighthouse Site' : 'NeonCore', text: i % 16 === 7 ? `request failed #${i}` : `line #${i}`, problem: i % 16 === 7 });
  }
}
const all = (q: LogQuery = {}): LogLine[] => {
  const out: LogLine[] = [];
  let page = readLogs({ ...q, limit: 17 });
  out.unshift(...page.lines);
  while (page.hasMore) { page = readLogs({ ...q, limit: 17, before: page.lines[0].cursor }); out.unshift(...page.lines); }
  return out;
};
const shape = (l: LogLine) => `${l.at}|${l.kind}|${l.source}|${l.text}|${l.level}`;
const expectFor = (keep: (w: (typeof want)[number]) => boolean) => want.filter(keep).map((w) => `${at(w.s)}|${w.kind}|${w.source}|${w.text}|${w.problem ? 'problem' : 'info'}`);

test('paging back from the newest finds every line exactly once, oldest first', () => {
  const got = all();
  assert.deepEqual(got.map(shape), expectFor(() => true));
  assert.equal(new Set(got.map((l) => l.cursor)).size, got.length);
  // Events say where they came from: the engine and the machine.
  const e = got.find((l) => l.source === 'diner-menu-api')!;
  assert.deepEqual([e.engine, e.machine], ['codex', 'mac']);
});

const FILTERS: { name: string; q: LogQuery; keep: (w: (typeof want)[number]) => boolean }[] = [
  { name: 'events only', q: { kinds: ['event'] }, keep: (w) => w.kind === 'event' },
  { name: 'terminal only', q: { kinds: ['terminal'] }, keep: (w) => w.kind === 'terminal' },
  { name: 'NeonCore only', q: { kinds: ['neoncore'] }, keep: (w) => w.kind === 'neoncore' },
  { name: 'events and terminal', q: { kinds: ['event', 'terminal'] }, keep: (w) => w.kind !== 'neoncore' },
  { name: 'problems only', q: { problems: true }, keep: (w) => w.problem },
  { name: 'search "#1"', q: { q: '#1' }, keep: (w) => w.text.includes('#1') },
  { name: 'search is case-blind', q: { q: 'DONE: STEP 5' }, keep: (w) => w.text.toLowerCase().includes('done: step 5') },
  { name: 'only one source', q: { only: 'harbour-ledger' }, keep: (w) => w.source === 'harbour-ledger' },
  { name: 'hide two sources', q: { hide: ['NeonCore', 'diner-menu-api'] }, keep: (w) => w.source !== 'NeonCore' && w.source !== 'diner-menu-api' },
  { name: 'problems among events', q: { problems: true, kinds: ['event'] }, keep: (w) => w.problem && w.kind === 'event' },
];
for (const f of FILTERS) {
  test(`filter — ${f.name}: exactly the lines it should keep, paged the same way`, () => {
    assert.deepEqual(all(f.q).map(shape), expectFor(f.keep));
  });
}

test('after a cursor: only what is newer; the newest page says there is nothing more after it', () => {
  const newest = readLogs({ limit: 10 });
  assert.equal(newest.lines.length, 10);
  const mid = all()[50];
  const after = readLogs({ after: mid.cursor, limit: 500 }).lines;
  assert.deepEqual(after.map(shape), all().slice(51).map(shape));
  assert.deepEqual(readLogs({ after: newest.lines[9].cursor }).lines, []);
});

test('sources: every one, with its kind, engine and how many lines it has', () => {
  const { sources } = readLogs({ limit: 1 });
  const count = (src: string) => want.filter((w) => w.source === src).length;
  assert.deepEqual(sources.map((s) => [s.source, s.kind, s.engine, s.count]).sort(), [
    ['NeonCore', 'neoncore', '', count('NeonCore')],
    ['diner-menu-api', 'event', 'codex', count('diner-menu-api')],
    ['harbour-ledger', 'event', 'claude', count('harbour-ledger')],
    ['qa · Lighthouse Site', 'terminal', '', count('qa · Lighthouse Site')],
  ].sort());
});

test('NeonCore\'s own console is captured — warnings and errors as problems — and the original still prints', () => {
  const printed: string[] = [];
  const fake = { log: (...a: unknown[]) => printed.push(a.join(' ')), info: (...a: unknown[]) => printed.push(a.join(' ')), warn: (...a: unknown[]) => printed.push(a.join(' ')), error: (...a: unknown[]) => printed.push(a.join(' ')) };
  const undo = installConsoleCapture(fake as unknown as Console);
  fake.log('[ws] Client connected:', 'abc');
  fake.warn('\u001b[33m[qa] slow\u001b[0m');
  fake.error(new Error('boom'));
  undo();
  fake.log('not captured');
  assert.deepEqual(printed, ['[ws] Client connected: abc', '\u001b[33m[qa] slow\u001b[0m', 'Error: boom', 'not captured']);
  const mine = readLogs({ kinds: ['neoncore'], limit: 3 }).lines;
  assert.deepEqual(mine.map((l) => [l.text.split('\n')[0], l.level]), [['[ws] Client connected: abc', 'info'], ['[qa] slow', 'problem'], ['Error: boom', 'problem']]);
});

test('the route answers the same, and keeps the table from growing for ever', async () => {
  const app = express(); app.use('/api/logs', logsRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/logs?kinds=terminal&limit=5&problems=1`);
    const body = await r.json() as { lines: LogLine[]; hasMore: boolean };
    assert.deepEqual(body.lines.map(shape), readLogs({ kinds: ['terminal'], limit: 5, problems: true }).lines.map(shape));
  } finally { server.close(); }
  for (let i = 0; i < 40; i++) recordLog({ kind: 'neoncore', source: 'NeonCore', text: `extra ${i}` });
  pruneLogs(25);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM log_lines').get() as { n: number }).n, 25);
  assert.equal(readLogs({ kinds: ['neoncore'], limit: 1 }).lines[0].text, 'extra 39', 'the newest are the ones kept');
});
