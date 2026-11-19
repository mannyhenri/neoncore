/**
 * The agent's full final answer, for the Agents screen.
 *
 * REQUESTED: "the final response from the agent, is there a way we could show it on the agents
 * screen, the full final answer?" The screen had only `last_message` — the first 500 characters of
 * the latest assistant text — and the scene's bubble summarises even that. The transcript (the
 * `messages` table, shipped by the hook reporter) holds all of it.
 *
 * The final answer is the trailing run of assistant TEXT after the last user turn or tool result.
 * THE SET is every content block type a transcript carries: only `text` is answer; `thinking`,
 * `tool_use` and `tool_result` never are. Plus the shapes a turn can end in.
 */
import './helpers/isolated-db.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import agentsRouter from '../src/routes/agents.ts';
import { finalAnswerOf, ANSWER_BLOCK_TYPES, TRANSCRIPT_BLOCK_TYPES } from '../src/lib/final-answer.ts';
import { installStubIO } from './helpers/stub-io.ts';

installStubIO();
const app = express();
app.use(express.json());
app.use('/api/agents', agentsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
after(() => server.close());

let n = 0;
function agent(): string {
  const id = `fa-agent-${++n}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
              VALUES (?,?,'m',?,'repo','claude','idle',?,?)`).run(id, id, `/tmp/fa-${n}`, new Date().toISOString(), `s-${n}`);
  return id;
}
let seq = 0;
function msg(agentId: string, role: string, content: unknown, session = 'sess') {
  seq++;
  db.prepare(`INSERT INTO messages (id, agent_id, session_id, seq, role, content, ts) VALUES (?,?,?,?,?,?,?)`)
    .run(`m-${seq}`, agentId, session, seq, role, typeof content === 'string' ? content : JSON.stringify(content), new Date(Date.UTC(2026, 10, 19, 12, 0, seq)).toISOString());
}
const LONG = 'A'.repeat(3000) + ' — the end of a long answer.';

test('every block type: only text is part of the answer', () => {
  assert.deepEqual([...ANSWER_BLOCK_TYPES], ['text']);
  for (const type of TRANSCRIPT_BLOCK_TYPES) {
    const a = agent();
    msg(a, 'user', [{ type: 'text', text: 'do it' }]);
    const block = type === 'text' ? { type, text: 'ANSWER' }
      : type === 'thinking' ? { type, thinking: 'ANSWER' }
      : type === 'tool_use' ? { type, name: 'Bash', input: 'ANSWER' }
      : { type, content: 'ANSWER' };
    msg(a, 'assistant', [{ type: 'text', text: 'before' }, block]);
    const out = finalAnswerOf(a)!;
    assert.equal(out.text.includes('ANSWER'), ANSWER_BLOCK_TYPES.has(type), `a ${type} block ${ANSWER_BLOCK_TYPES.has(type) ? 'is missing from' : 'leaked into'} the answer`);
  }
});

test('the answer is the trailing assistant text after the last tool result — in full, past 500 characters', () => {
  const a = agent();
  msg(a, 'user', [{ type: 'text', text: 'fix the bug' }]);
  msg(a, 'assistant', [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: '{}' }]);
  msg(a, 'user', [{ type: 'tool_result', content: 'ok' }]);
  msg(a, 'assistant', [{ type: 'text', text: 'First part.' }]);
  msg(a, 'assistant', [{ type: 'text', text: LONG }]);
  const out = finalAnswerOf(a)!;
  assert.equal(out.text, `First part.\n\n${LONG}`);
  assert.ok(!out.text.includes('Looking.'), 'text from before the last tool call is not the final answer');
  assert.equal(out.complete, true);
});

test('a turn still running (last message is a tool call) shows the latest answer so far, marked incomplete', () => {
  const a = agent();
  msg(a, 'user', [{ type: 'text', text: 'go' }]);
  msg(a, 'assistant', [{ type: 'text', text: 'Earlier answer.' }]);
  msg(a, 'user', [{ type: 'text', text: 'and now this' }]);
  msg(a, 'assistant', [{ type: 'tool_use', name: 'Bash', input: '{}' }]);
  const out = finalAnswerOf(a)!;
  assert.equal(out.text, 'Earlier answer.');
  assert.equal(out.complete, false);
});

test('only the latest session counts; a string content is read as text', () => {
  const a = agent();
  msg(a, 'assistant', [{ type: 'text', text: 'old session answer' }], 'old');
  msg(a, 'user', 'hi', 'new');
  msg(a, 'assistant', 'plain string answer', 'new');
  assert.equal(finalAnswerOf(a)!.text, 'plain string answer');
});

test('no transcript: null, and the route says so with 404', async () => {
  const a = agent();
  assert.equal(finalAnswerOf(a), null);
  assert.equal((await fetch(`${base}/api/agents/${a}/final-answer`)).status, 404);
});

test('the route returns the answer', async () => {
  const a = agent();
  msg(a, 'user', [{ type: 'text', text: 'q' }]);
  msg(a, 'assistant', [{ type: 'text', text: LONG }]);
  const body = await (await fetch(`${base}/api/agents/${a}/final-answer`)).json() as { text: string; complete: boolean; at: string };
  assert.equal(body.text, LONG);
  assert.equal(body.complete, true);
  assert.ok(body.at);
});
