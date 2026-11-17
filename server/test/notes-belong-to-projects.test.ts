/**
 * Project notes belong to the project, not to a cartridge.
 *
 * The notes table carried a foreign key to agents, and better-sqlite3 ENFORCES foreign keys.
 * A project note therefore had to borrow "any agent for this project": on a project with no
 * cartridge yet the '__project__' fallback hit the constraint and the note was refused (500),
 * and deleting the borrowed cartridge deleted the notes. An existing database is rebuilt once,
 * keeping every note.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// An EXISTING database in the old shape — created before db.ts opens it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-notes-'));
process.env.NEONCORE_DB_PATH = path.join(dir, 'old.db');
{
  const old = new Database(process.env.NEONCORE_DB_PATH);
  old.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, machine TEXT NOT NULL, repo_path TEXT NOT NULL,
      repo_name TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '', current_task TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle', trust_mode INTEGER NOT NULL DEFAULT 0, last_seen TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE notes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (agent_id) REFERENCES agents(id));
    INSERT INTO agents (id, name, machine, repo_path, repo_name, last_seen) VALUES ('a1', 'm/ledger', 'm', '/tmp/ledger', 'ledger', '2026-01-01');
    INSERT INTO notes VALUES ('n1', 'a1', 'Kept through the rebuild', '2026-01-01', '2026-01-01');
  `);
  old.close();
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const express = (await import('express')).default;
const db = (await import('../src/db.js')).default;
const journalRouter = (await import('../src/routes/journal.ts')).default;
const { deleteAgentCascade } = await import('../src/lib/agent-cleanup.ts');

test('an existing notes table loses its foreign key and keeps every note', () => {
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(notes)').all(), []);
  const n1 = db.prepare('SELECT content, project FROM notes WHERE id = ?').get('n1') as { content: string; project: string };
  assert.equal(n1.content, 'Kept through the rebuild');
  assert.equal(n1.project, 'ledger', 'the project backfill ran before the rebuild');
});

test('a project with no cartridge takes a note, and deleting a cartridge keeps them all', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/journal', journalRouter);
  const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = (p: string) => `http://127.0.0.1:${(server.address() as { port: number }).port}/api/journal/projects/${p}/notes`;
  try {
    const res = await fetch(url('no-cartridge-yet'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'First note' }) });
    assert.equal(res.status, 201, 'a project with no cartridge could not take a note');
    assert.deepEqual((await (await fetch(url('no-cartridge-yet'))).json() as { content: string }[]).map((n) => n.content), ['First note']);

    deleteAgentCascade('a1');
    assert.deepEqual((await (await fetch(url('ledger'))).json() as { content: string }[]).map((n) => n.content), ['Kept through the rebuild']);
  } finally {
    server.close();
  }
});
