/**
 * Deleting a cartridge releases the tasks it held.
 *
 * A task is claimable only while `assigned_agent_id IS NULL`. When a cartridge is deleted — by
 * hand, or by the cleanup scheduler once it has been offline past the retention window — its
 * claimed and in-progress tasks kept pointing at an agent that can never come back (a returning
 * session registers a NEW row), so no cartridge could ever take them. They now go back to the
 * queue. Finished tasks keep their history.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { deleteAgentCascade } from '../src/lib/agent-cleanup.ts';

const now = () => new Date().toISOString();

test('an unfinished task held by a deleted cartridge goes back to the queue; finished ones keep their history', () => {
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen)
              VALUES ('gone', 'm/r', 'm', '/tmp/r', 'r', 'offline', ?)`).run(now());
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen)
              VALUES ('other', 'm/s', 'm', '/tmp/s', 's', 'idle', ?)`).run(now());
  const statuses = ['queued', 'claimed', 'in_progress', 'done', 'failed', 'cancelled'];
  for (const s of statuses) {
    db.prepare(`INSERT INTO tasks (id, title, status, assigned_agent_id, created_at, claimed_at)
                VALUES (?, ?, ?, 'gone', ?, ?)`).run(`t-${s}`, s, s, now(), now());
  }
  db.prepare(`INSERT INTO tasks (id, title, status, assigned_agent_id, created_at, claimed_at)
              VALUES ('t-other', 'x', 'in_progress', 'other', ?, ?)`).run(now(), now());

  deleteAgentCascade('gone');

  const row = (id: string) => db.prepare('SELECT status, assigned_agent_id, claimed_at FROM tasks WHERE id = ?').get(id) as
    { status: string; assigned_agent_id: string | null; claimed_at: string | null };
  for (const s of ['queued', 'claimed', 'in_progress']) {
    const r = row(`t-${s}`);
    assert.equal(r.status, 'queued', `${s} task was not returned to the queue`);
    assert.equal(r.assigned_agent_id, null, `${s} task still points at the deleted cartridge`);
    assert.equal(r.claimed_at, null);
  }
  for (const s of ['done', 'failed', 'cancelled']) {
    const r = row(`t-${s}`);
    assert.equal(r.status, s, `a ${s} task was rewritten`);
    assert.equal(r.assigned_agent_id, 'gone', `a ${s} task lost who did it`);
  }
  assert.equal(row('t-other').assigned_agent_id, 'other', "another cartridge's task was touched");
});

test('deleting a cartridge keeps the project notes written while it existed', async () => {
  /*
   * Project notes (the journal's Notes panel) were stored under "any agent for this project",
   * and the cascade deletes notes by agent_id — so reaping a cartridge that had been offline
   * past the retention window silently deleted its project's notes.
   */
  const express = (await import('express')).default;
  const journalRouter = (await import('../src/routes/journal.ts')).default;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen)
              VALUES ('note-owner', 'm/ledger', 'm', '/tmp/ledger', 'ledger', 'offline', ?)`).run(now());
  const app = express();
  app.use(express.json());
  app.use('/api/journal', journalRouter);
  const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/journal/projects/ledger/notes`;
  try {
    const made = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Refunds go through the ledger first.' }) });
    assert.equal(made.status, 201);
    // A note written before the fix, still carrying the cartridge's id.
    db.prepare(`INSERT INTO notes (id, agent_id, project, content, created_at, updated_at)
                VALUES ('legacy-note', 'note-owner', 'ledger', 'Old note', ?, ?)`).run(now(), now());

    deleteAgentCascade('note-owner');

    const notes = await (await fetch(base)).json() as { content: string }[];
    assert.deepEqual(notes.map((n) => n.content).sort(), ['Old note', 'Refunds go through the ledger first.']);
  } finally {
    server.close();
  }
});
