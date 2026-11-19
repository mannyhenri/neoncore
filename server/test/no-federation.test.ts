/**
 * The server is isolated to its own machine: it never links with another NeonCore server.
 *
 * REQUESTED: "right now we are connecting multiple machines together and reporting to each other
 * and I would rather not do this anymore and keep the server isolated to the machine I'm working
 * on" — server-to-server links only; the server stays reachable on the network (the phone app,
 * relays). Federation had three faces, and each is held here against a live fake peer that
 * claims to own an agent and records every request that reaches it:
 *
 *   INBOUND  — what another server pushed in: POST /api/peers/ping, POST /api/peers, DELETE /api/peers
 *   OUTBOUND — where this server reached out: forwarding a prompt or an agent message to an agent
 *              it does not own, and finding confer participants on other servers
 *   STATE    — the `peers` roster, and GET /api/peers listing it
 *
 * The federation modules themselves are gone, so nothing can start a gossip tick.
 */
import './helpers/isolated-db.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import commandsRouter from '../src/routes/commands.ts';
import conferRouter from '../src/routes/confer.ts';
import peersRouter from '../src/routes/peers.ts';

installStubIO();
const listen = (app: express.Express) => new Promise<{ server: Server; url: string }>((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
});

// The fake peer: owns `remote-agent`, and records every request that reaches it.
const hits: string[] = [];
const peerApp = express();
peerApp.use(express.json());
peerApp.use((req, _res, next) => { hits.push(`${req.method} ${req.path}`); next(); });
peerApp.get('/api/agents/remote-agent', (_req, res) => res.json({ id: 'remote-agent', name: 'laptop/repo', repoName: 'repo', repoPath: '/r', status: 'idle', agentType: 'claude' }));
peerApp.post('/api/commands/send', (_req, res) => res.status(201).json({ id: 'c1', delivered: true }));
peerApp.post('/api/peers/ping', (_req, res) => res.json({ peers: [] }));
const peer = await listen(peerApp);

const app = express();
app.use(express.json());
app.use('/api/commands', commandsRouter);
app.use('/api/confer', conferRouter);
app.use('/api/peers', peersRouter);
const me = await listen(app);
after(() => { me.server.close(); peer.server.close(); });

const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${me.url}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

const here = path.dirname(fileURLToPath(import.meta.url));
const FEDERATION_MODULES = ['src/lib/federation.ts', 'src/lib/peer-scheduler.ts', 'src/lib/peer-forward.ts'];

test('the federation modules are gone, and so is the roster table', () => {
  for (const m of FEDERATION_MODULES) assert.ok(!fs.existsSync(path.join(here, '..', m)), `${m} still exists`);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peers'").get();
  assert.equal(table, undefined, 'the peers table is still created');
});

test('INBOUND: every route another server pushed into is gone', async () => {
  const INBOUND: [string, string, unknown][] = [
    ['POST', '/api/peers/ping', { me: peer.url, peers: [peer.url] }],
    ['POST', '/api/peers', { url: peer.url }],
    ['DELETE', '/api/peers', { url: peer.url }],
  ];
  for (const [method, route, body] of INBOUND) {
    const out = await call(method, route, body);
    assert.equal(out.status, 404, `${method} ${route} still answers (${out.status})`);
  }
});

test('STATE: GET /api/peers names this server and no peers — even with an old roster left behind', async () => {
  // A roster written before the upgrade must not resurface.
  db.exec(`CREATE TABLE IF NOT EXISTS peers (url TEXT PRIMARY KEY, server_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '', last_ok_at TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
    consecutive_failures INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL)`);
  db.prepare('INSERT OR REPLACE INTO peers (url, added_at) VALUES (?, ?)').run(peer.url, new Date().toISOString());
  const out = await call('GET', '/api/peers');
  assert.equal(out.status, 200);
  assert.ok(out.json.self?.serverId, 'this server\'s identity is still reported (the phone app reads it)');
  assert.deepEqual(out.json.peers, []);
});

test('OUTBOUND: nothing this server does reaches another server', async () => {
  hits.length = 0;
  // A prompt or an agent message to an agent this server does not own: not found, not forwarded.
  const send = await call('POST', '/api/commands/send', { agentId: 'remote-agent', text: 'hello' });
  assert.equal(send.status, 404, `sending to an agent on another server answered ${send.status}`);
  // A confer naming an agent on another server: it is not looked up there.
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
              VALUES ('local-agent','box/repo','box','/tmp/nf-repo','repo','claude','idle',?,'s-local')`).run(new Date().toISOString());
  const confer = await call('POST', '/api/confer', { participantIds: ['local-agent', 'remote-agent'], task: 'pair on it' });
  assert.ok(confer.status >= 400, `a confer with an agent on another server was accepted (${confer.status})`);
  assert.deepEqual(hits, [], `this server contacted the other one: ${hits.join(', ')}`);
});
