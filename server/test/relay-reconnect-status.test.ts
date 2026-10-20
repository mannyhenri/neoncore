/**
 * A RELAY THAT RECONNECTS IS STILL THERE.
 *
 * Reported as: "why are we seeing only two repos on neoncore, I've got at least 6 opened."
 *
 * At 17:08:13 every relay socket dropped at once (the server stayed up). Each relay reconnected
 * and rejoined its agent room within half a second — but `disconnect` had already marked every
 * cartridge offline, interrupted its session and ended its session record, and neither
 * `join_agent_room` nor `register_extension` ever set it back. The dashboard hides offline
 * cartridges, so every idle session vanished until it next ran a tool. Only the three that did
 * work afterwards came back.
 *
 * SET-BASED over the socket lifecycle that decides a cartridge's status: disconnect, and both
 * ways a relay rejoins (join_agent_room, register_extension).
 */
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as connect, type Socket } from 'socket.io-client';
import db from '../src/db.ts';
import { initWebSocket } from '../src/ws.ts';

process.env.NEONCORE_DISCONNECT_GRACE_MS = '250';
const GRACE = 250;

let server: http.Server;
let ioServer: ReturnType<typeof initWebSocket>;
let url = '';
let n = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = http.createServer();
  ioServer = initWebSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => new Promise<void>((r) => { ioServer.close(); server.close(() => r()); }));

function cartridge(status = 'idle'): { id: string; repo: string } {
  const id = `reconnect-${++n}`;
  const repo = `/tmp/${id}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,active_objective)
     VALUES (?,?,?,?,?,'claude',?,?,?,'keep working')`,
  ).run(id, id, 'test-mac', repo, id, status, new Date().toISOString(), `s-${id}`);
  return { id, repo };
}

const row = (id: string) => db.prepare('SELECT status, recovery_status FROM agents WHERE id = ?')
  .get(id) as { status: string; recovery_status: string };

/** A relay: connects, registers its path, joins its agent room — exactly what agent/relay does. */
async function relay(id: string, repo: string, how: 'join_agent_room' | 'register_extension'): Promise<Socket> {
  const s = connect(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise<void>((r, j) => { s.once('connect', () => r()); s.once('connect_error', j); });
  if (how === 'join_agent_room') {
    s.emit('register_extension', { machine: 'test-mac', repoPath: repo });
    s.emit('join_agent_room', { agentId: id });
  } else {
    s.emit('register_extension', { machine: 'test-mac', repoPath: repo, agentType: 'claude' });
  }
  await wait(50);
  return s;
}

for (const how of ['join_agent_room', 'register_extension'] as const) {
  test(`${how}: a blip — drop and reconnect inside the grace window — leaves the cartridge untouched`, async () => {
    const { id, repo } = cartridge('idle');
    const first = await relay(id, repo, how);
    first.disconnect();
    await wait(30);
    const second = await relay(id, repo, how);

    await wait(GRACE + 150);
    assert.deepEqual(row(id), { status: 'idle', recovery_status: '' },
      'a relay that reconnected in half a second was left offline / interrupted');
    second.disconnect();
  });

  test(`${how}: a real outage goes offline, and rejoining brings it back`, async () => {
    const { id, repo } = cartridge('idle');
    const first = await relay(id, repo, how);
    first.disconnect();

    await wait(GRACE + 150);
    assert.equal(row(id).status, 'offline', 'a relay gone past the grace window must still go offline');

    const second = await relay(id, repo, how);
    assert.deepEqual(row(id), { status: 'idle', recovery_status: '' },
      'the relay is back, but the cartridge is still hidden as offline / interrupted');
    second.disconnect();
  });
}

test('rejoining never downgrades a cartridge that is mid-task', async () => {
  const { id, repo } = cartridge('working');
  const s = await relay(id, repo, 'join_agent_room');
  assert.equal(row(id).status, 'working');
  s.disconnect();
});

test('an interruption from something other than a socket drop survives a rejoin', async () => {
  const { id, repo } = cartridge('idle');
  db.prepare("UPDATE agents SET status = 'offline', recovery_status = 'interrupted' WHERE id = ?").run(id);
  const s = await relay(id, repo, 'join_agent_room');
  assert.deepEqual(row(id), { status: 'idle', recovery_status: 'interrupted' },
    'rejoin cleared a recovery flag it did not set — that session may really need resuming');
  s.disconnect();
});
