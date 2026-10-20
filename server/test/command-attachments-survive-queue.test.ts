/**
 * A PICTURE SENT TO A BUSY CARTRIDGE ARRIVES WITH THE PICTURE.
 *
 * Reported as: "why when I attach pictures in neoncore they no longer show???? that's a
 * regression" — and "nope it's supposed to accept pictures".
 *
 * The dashboard sends every prompt with `queueIfBusy: true`. Since the queue landed, a prompt to
 * a busy cartridge is parked as a `prompt` item — and that item stored `{ text }` only. The
 * attachments were validated, then dropped on the floor; when the item dispatched later it
 * called sendCommandToAgent with `undefined` attachments. An idle cartridge still got its
 * picture, which is why it looked intermittent: it depended on whether the agent was mid-turn.
 * The peer-forward path (a cartridge owned by another server) dropped them the same way.
 *
 * SET-BASED over every road a composer attachment takes to a cartridge:
 *   1. direct       — idle cartridge, delivered now
 *   2. queued       — busy cartridge, stored, then dispatched by the queue
 *   3. forwarded    — cartridge owned by a peer server
 */
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { installStubIO } from './helpers/stub-io.ts';
import db from '../src/db.ts';
import commandsRouter from '../src/routes/commands.ts';
import { QUEUE_KINDS } from '../src/lib/queue-kinds.ts';
import { rowToItem } from '../src/lib/queue-runner.ts';
import { forwardMessageToOwner } from '../src/lib/peer-forward.ts';

installStubIO();

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // a PNG header is enough
const picture = { name: 'screenshot.png', mimeType: 'image/png', size: PNG.length, dataBase64: PNG.toString('base64') };

let server: http.Server;
let base = '';
let n = 0;

before(async () => {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/commands', commandsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

function cartridge(status: 'idle' | 'working'): { id: string; repo: string } {
  const id = `attach-${process.pid}-${++n}`;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-attach-q-'));
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
     VALUES (?,?,?,?,?,'claude',?,?,?)`,
  ).run(id, id, os.hostname(), repo, path.basename(repo), status, new Date().toISOString(), `s-${id}`);
  return { id, repo };
}

/** Every file the attachment writer put into this repo, by name. */
function attachedFiles(repo: string): string[] {
  const root = path.join(repo, '.neoncore', 'attachments');
  const out: string[] = [];
  const walk = (d: string) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name !== 'metadata.json' && out.push(e.name));
  walk(root);
  return out;
}

const send = (agentId: string) => fetch(`${base}/api/commands/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId, text: 'what is wrong in this screenshot?', attachments: [picture], queueIfBusy: true }),
});

test('1. direct: an idle cartridge gets the picture written into its repo', async () => {
  const { id, repo } = cartridge('idle');
  const res = await send(id);
  assert.equal(res.status, 201);
  assert.deepEqual(attachedFiles(repo), ['screenshot.png']);
});

test('2. queued: a busy cartridge gets the picture when the queue delivers it', async () => {
  const { id, repo } = cartridge('working');
  const res = await send(id);
  assert.equal(res.status, 202, 'a busy cartridge should queue the prompt');
  const { item } = await res.json() as { item: { id: string } };

  const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(item.id) as Record<string, unknown>;
  const payload = JSON.parse(String(row.payload_json));
  assert.equal(payload.attachments?.length, 1, 'the queued item did not store the attachment — it is gone before dispatch');
  assert.equal(attachedFiles(repo).length, 0, 'nothing should be written before the queue delivers');

  // The lane comes round: the queue dispatches the stored item.
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(id);
  const prompt = QUEUE_KINDS.find((k) => k.kind === 'prompt')!;
  await prompt.dispatch(rowToItem(row));
  assert.deepEqual(attachedFiles(repo), ['screenshot.png'], 'the queue delivered the prompt without its picture');

  const cmd = db.prepare('SELECT text FROM commands WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as { text: string };
  assert.match(cmd.text, /screenshot\.png/, 'the prompt the cartridge receives does not point at the picture');
});

test('3. forwarded: a cartridge owned by a peer server gets the picture in the forwarded request', async () => {
  const PEER = 'http://peer-owner.local:4040';
  db.prepare("INSERT OR REPLACE INTO peers (url, server_id, name, version, added_at) VALUES (?, '', '', '', ?)")
    .run(PEER, new Date().toISOString());
  const sent: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(PEER) && u.includes('/api/agents/')) return new Response(JSON.stringify({ id: 'remote-agent' }), { status: 200 });
    if (u.startsWith(PEER) && u.endsWith('/api/commands/send')) {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ delivered: true }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    const out = await forwardMessageToOwner('remote-agent', 'look at this', [picture]);
    assert.equal(out.ok, true);
    assert.equal((sent[0] as { attachments?: unknown[] }).attachments?.length, 1,
      'the forwarded request dropped the picture, so the owning server never sees it');
  } finally {
    globalThis.fetch = original;
    db.prepare('DELETE FROM peers WHERE url = ?').run(PEER);
  }
});

test('clients see that a queued prompt has a picture, never its bytes', async () => {
  const { publicQueueItem } = await import('../src/lib/queue-runner.ts');
  const { id } = cartridge('working');
  const res = await send(id);
  const { item } = await res.json() as { item: Record<string, unknown> };
  // The 202 body is what the dashboard shows for the queued prompt.
  const atts = (item.payload as { attachments: Record<string, unknown>[] }).attachments;
  assert.equal(atts[0].name, 'screenshot.png');
  assert.equal(atts[0].dataBase64, undefined, 'the route sent the image bytes back to the client');

  const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(item.id) as Record<string, unknown>;
  assert.equal(JSON.parse(String(row.payload_json)).attachments[0].dataBase64, picture.dataBase64, 'the stored item must keep the bytes for dispatch');
  assert.equal((publicQueueItem(rowToItem(row)).payload.attachments as Record<string, unknown>[])[0].dataBase64, undefined);
});
