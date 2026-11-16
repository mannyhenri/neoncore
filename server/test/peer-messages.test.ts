// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.ts';
import commandsRouter from '../src/routes/commands.ts';
import conferRouter from '../src/routes/confer.ts';
import { startConfer } from '../src/lib/confer-conductor.ts';
import { installStubIO } from './helpers/stub-io.ts';

/**
 * AN AGENT MESSAGING ANOTHER IS NOT THE USER GIVING IT A TASK — AND A LATE COMMENT IS NOT IGNORED.
 *
 * `neoncore_message_agent` posted to /api/commands/send, the path a PERSON's prompt takes. So a
 * peer's comment was typed into the other cartridge with no sender, wrapped in the goal brief and
 * the work-standard block (a 274-char comment arrived as 1,365 chars at a Codex peer), became that
 * cartridge's ACTIVE OBJECTIVE, and reset its Stop-gate arming mid-milestone.
 *
 * And in a confer, a participant that had signalled a milestone done stayed done when its peer's
 * comments arrived afterwards — the confer moved to the next stage with them unaddressed. Now a
 * comment that lands after the recipient's done signal RE-OPENS the milestone for the recipient,
 * and tells it so.
 */

const io = installStubIO();
let base = '';
let server: Server;
const A = 'peer-a', B = 'peer-b';
const now = () => new Date().toISOString();

before(async () => {
  for (const [id, repo, type] of [[A, '/tmp/repo-api', 'claude'], [B, '/tmp/repo-web', 'codex']]) {
    io.connect(id);
    db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type, active_objective)
                VALUES (?, ?, 'box', ?, ?, 'working', ?, ?, ?, 'Build the API half of refunds')`)
      .run(id, `box/${repo.split('/').pop()}`, repo, repo.split('/').pop(), now(), `sess-${id}`, type);
  }
  // The recipient has a goal, so a USER prompt to it would carry the brief — a peer message must not.
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, status, created_at, updated_at) VALUES ('g', 'Ship refunds', 'why', 'm', 'active', ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO projects (id, goal_id, name, primary_repo, created_at, updated_at) VALUES ('p', 'g', 'Web', '/tmp/repo-web', ?, ?)`).run(now(), now());
  const app = express(); app.use(express.json()); app.use('/api/commands', commandsRouter); app.use('/api/confer', conferRouter);
  base = await new Promise<string>((r) => { server = app.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)); });
});
after(() => server?.close());

const send = (body: Record<string, unknown>) => fetch(`${base}/api/commands/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const lastText = (agentId: string) => (db.prepare('SELECT text FROM commands WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1').get(agentId) as { text: string }).text;
const agentRow = (id: string) => db.prepare('SELECT active_objective, standard_offered, standard_armed FROM agents WHERE id = ?').get(id) as { active_objective: string; standard_offered: number; standard_armed: number };

const COMMENT = 'I changed RefundRequest to carry amountCents — please match it on the web side.';

test('a peer message says who sent it and how to reply — and carries no goal brief or work standard', async () => {
  const res = await send({ agentId: B, text: COMMENT, includeMemory: false, from: A });
  assert.equal(res.status, 201, await res.text());
  const t = lastText(B);
  assert.match(t, /^\[Message from .*repo-api.* — a peer agent, not the user\. Reply with neoncore_message_agent targetAgentId: "peer-a"\.\]/);
  assert.ok(t.includes(COMMENT));
  assert.doesNotMatch(t, /\[NeonCore goal/, 'a peer message was wrapped in the goal brief');
  assert.doesNotMatch(t, /\[NeonCore work standard/, 'a peer message was wrapped in the work standard');
  assert.ok(t.length < COMMENT.length + 250, `${t.length} chars for a ${COMMENT.length}-char message`);
});

test('a peer message does not become the recipient\'s objective or reset its Stop gate', async () => {
  db.prepare("UPDATE agents SET active_objective = 'Build the web half', standard_offered = 1, standard_armed = 1 WHERE id = ?").run(B);
  await send({ agentId: B, text: COMMENT, includeMemory: false, from: A });
  assert.deepEqual(agentRow(B), { active_objective: 'Build the web half', standard_offered: 1, standard_armed: 1 });
});

test('the sender is found from its repo and engine when the relay did not say who it is', async () => {
  await send({ agentId: B, text: COMMENT, includeMemory: false, fromRepoPath: '/tmp/repo-api/', fromAgentType: 'claude' });
  assert.match(lastText(B), /targetAgentId: "peer-a"/);
});

test('a message from a PERSON (no sender) is still an ordinary prompt', async () => {
  await send({ agentId: B, text: 'Please also add a changelog entry for the refunds work.', includeMemory: false });
  const t = lastText(B);
  assert.doesNotMatch(t, /^\[Message from/);
  assert.match(t, /\[NeonCore goal/, 'a person\'s prompt lost the goal brief');
});

// ── A late comment in a confer ─────────────────────────────────────────────────

async function milestoneDone(sessionId: string, agentId: string) {
  const r = await fetch(`${base}/api/confer/${sessionId}/milestone/${agentId}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'done' }) });
  assert.equal(r.status, 200, await r.text());
}
const current = (sessionId: string) => db.prepare('SELECT current_milestone AS idx FROM confer_sessions WHERE id = ?').get(sessionId) as { idx: number };
const doneIds = (sessionId: string, idx: number) => JSON.parse((db.prepare('SELECT done_ids FROM confer_milestones WHERE session_id = ? AND idx = ?').get(sessionId, idx) as { done_ids: string }).done_ids) as string[];

test('a comment that reaches a participant AFTER its done signal re-opens the milestone for it', async () => {
  const session = startConfer({ repoName: 'repo', repoPath: '/tmp/repo-api', participantIds: [A, B], task: 'Ship refunds across both repos.' });
  await new Promise((r) => setTimeout(r, 20));
  await milestoneDone(session.id, B);                      // B: "done with Align"
  await send({ agentId: B, text: COMMENT, includeMemory: false, from: A });   // …then A's comment arrives
  const t = lastText(B);
  assert.match(t, /re-opens it for you/, 'the recipient was not told its done signal no longer stands');
  assert.match(t, new RegExp(`/api/confer/${session.id}/milestone/${B}/done`), 'no way to signal done again');
  assert.deepEqual(doneIds(session.id, 0), [], 'B\'s done signal was not withdrawn');
  await milestoneDone(session.id, A);                      // A signals — but B owes an answer now
  assert.equal(current(session.id).idx, 0, 'the confer moved on with the comment unaddressed');
  await milestoneDone(session.id, B);                      // B has dealt with it
  assert.equal(current(session.id).idx, 1, 'the confer did not advance once both were done again');
});

test('a comment to a participant that has NOT signalled yet re-opens nothing', async () => {
  const session = startConfer({ repoName: 'repo', repoPath: '/tmp/repo-api', participantIds: [A, B], task: 'Ship refunds across both repos.' });
  await new Promise((r) => setTimeout(r, 20));
  await send({ agentId: B, text: COMMENT, includeMemory: false, from: A });
  assert.doesNotMatch(lastText(B), /re-opens/);
  await milestoneDone(session.id, A);
  await milestoneDone(session.id, B);
  assert.equal(current(session.id).idx, 1);
});
