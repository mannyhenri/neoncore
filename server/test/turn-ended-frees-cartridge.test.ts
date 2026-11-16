/**
 * THE END OF A TURN FREES THE CARTRIDGE — NOW, NOT TWO MINUTES LATER.
 *
 * Every "may I start work on this cartridge?" check in the fleet (the queue, workflow launches,
 * confers, Goal Pilot stages) reads `agents.status`, and that status used to stay `working` until
 * the 2-minute idle sweep noticed the silence. So work queued behind a finished turn sat idle for
 * up to two minutes, and the grid said the cartridge was working when it was waiting at a prompt.
 *
 * SCOPE — the signals that END a turn, one per engine that has one:
 *   · claude — the Stop hook's completion check ALLOWS the stop   (agent/hooks/reporter.py)
 *   · codex  — its Stop hook posts /api/agents/turn-ended, last   (agent/hooks/codex-reporter.py)
 *   (gridlight reports `idle` itself on register.)
 * …and the cases where the cartridge must NOT be called free: a BLOCKED stop (it keeps working),
 * a turn that ended on a question (it waits for a person), and a prompt typed by hand after the
 * turn ended (the hooks mark it working again — nothing may be typed on top of it).
 */
import './helpers/isolated-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import agentsRouter from '../src/routes/agents.ts';
import { enqueue, listQueue, tickQueue } from '../src/lib/queue-runner.ts';
import { isCartridgeBusy } from '../src/lib/queue-runner.ts';

const io = installStubIO();
const app = express();
app.use(express.json());
app.use('/api/agents', agentsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
after(() => server.close());

const post = async (route: string, body: unknown) => {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};

let n = 0;
function cartridge(agentType: 'claude' | 'codex'): { id: string; session: string; repo: string } {
  const id = `turn-${agentType}-${++n}`;
  const repo = `/tmp/turn-repo-${n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, ?, 'box', ?, ?, 'working', ?, ?, ?)`)
    .run(id, `box/turn-${n}`, repo, `turn-${n}`, new Date().toISOString(), `sess-${id}`, agentType);
  io.connect(id);
  return { id, session: `sess-${id}`, repo };
}
const status = (id: string) => (db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;
const delivered = (id: string, text: string) => io.emissions.some((e) => e.event === 'command_send' && e.room === `agent:${id}` && String((e.payload as { text: string }).text).includes(text));
async function until(what: string, fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail(`timed out waiting for ${what}`);
}
const settle = () => new Promise((r) => setTimeout(r, 150));

/** How each engine says "my turn is over" — what its hook actually posts. */
const END_TURN: Record<'claude' | 'codex', (c: { id: string; session: string; repo: string }) => Promise<unknown>> = {
  claude: (c) => post('/api/agents/completion-check', { sessionId: c.session, agentType: 'claude', finalText: 'Done.' }),
  codex: (c) => post('/api/agents/turn-ended', { sessionId: c.session, machine: 'box', repoPath: c.repo, agentType: 'codex' }),
};

for (const engine of Object.keys(END_TURN) as ('claude' | 'codex')[]) {
  test(`${engine}: the end of a turn marks the cartridge idle at once, and the work queued behind it starts`, async () => {
    const c = cartridge(engine);
    assert.equal(isCartridgeBusy(c.id), true, 'precondition: mid-turn it is busy');
    const q = enqueue({ kind: 'prompt', payload: { text: `NEXT-${engine}`, targets: [c.id] }, targets: [c.id] });
    assert.ok(q.ok);
    tickQueue();
    await settle();
    assert.equal(delivered(c.id, `NEXT-${engine}`), false, 'nothing may be typed into a cartridge mid-turn');

    const before = io.emissions.length;
    await END_TURN[engine](c);
    assert.equal(status(c.id), 'idle', 'the turn is over, so the cartridge is free');
    assert.ok(io.emissions.slice(before).some((e) => e.event === 'agent_updated' && (e.payload as { id: string; status: string }).id === c.id
      && (e.payload as { status: string }).status === 'idle'), 'the grid was not told');
    // No poll needed: the turn end itself advances the queue.
    await until('the queued prompt to be delivered', () => delivered(c.id, `NEXT-${engine}`));
    assert.equal(listQueue().find((i) => q.ok && i.id === q.item.id)!.status, 'running');
  });
}

test('claude: a BLOCKED stop is not the end of the turn — the cartridge stays working', async () => {
  const c = cartridge('claude');
  db.prepare(`UPDATE agents SET standard_armed = 1, standard_offered = 1, active_objective = 'fix the thing' WHERE id = ?`).run(c.id);
  const out = await post('/api/agents/completion-check', { sessionId: c.session, agentType: 'claude', finalText: 'Fixed it.' });
  assert.equal(out.json.decision, 'block', 'precondition: no completion report → blocked');
  assert.equal(status(c.id), 'working');
});

test('claude: a turn that ended on a question waits for a person — it is not called free', async () => {
  const c = cartridge('claude');
  await post('/api/agents/completion-check', { sessionId: c.session, agentType: 'claude', finalText: 'Should I also update the README?' });
  assert.equal(status(c.id), 'waiting');
  assert.equal(isCartridgeBusy(c.id), true, 'a question a person owes an answer keeps the cartridge busy');
});

test('a prompt typed by hand after the turn ended makes it busy again — queued work never lands on top', async () => {
  const c = cartridge('claude');
  await END_TURN.claude(c);
  assert.equal(status(c.id), 'idle');
  // What reporter.py posts on UserPromptSubmit: a register that marks the agent working.
  await post('/api/agents/register', { sessionId: c.session, machine: 'box', repoPath: c.repo, agentType: 'claude', status: 'working' });
  assert.equal(status(c.id), 'working');
  const q = enqueue({ kind: 'prompt', payload: { text: 'QUEUED-AFTER-HAND', targets: [c.id] }, targets: [c.id] });
  assert.ok(q.ok);
  tickQueue();
  await settle();
  assert.equal(delivered(c.id, 'QUEUED-AFTER-HAND'), false, 'queued work was typed on top of a prompt the person is running');
});

test('turn-ended for a cartridge nobody knows is refused, not guessed', async () => {
  const out = await post('/api/agents/turn-ended', { sessionId: 'no-such-session', machine: 'nowhere', repoPath: '/nope', agentType: 'codex' });
  assert.equal(out.status, 404);
});
