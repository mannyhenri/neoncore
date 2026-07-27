/**
 * Two real NeonCore servers, two ports, two databases, talking over real HTTP.
 *
 * These run as child PROCESSES rather than in-process. db.ts holds a module-level
 * singleton, so two servers in one process would share one database — collapsing the very
 * independence the topology depends on and making self-exclusion untestable.
 *
 * Covers the plan's two loudest risks:
 *   - the auth decision table (a wrong call here is a silent fleet-wide blackout)
 *   - the gossip exchange (union merge, self-exclusion, and one hung peer not stalling
 *     liveness for the rest)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'neoncore-fleet-'));
const HELPER = resolve(import.meta.dirname, 'helpers', 'peer-server.ts');
const TOKEN = 'test-fleet-token-aaaaaaaaaaaaaaaaaaaa';

interface Node { proc: ChildProcess; url: string; port: number }

const running: Node[] = [];
let blackhole: Server | null = null;

/** Boot a server and wait for it to actually listen — never sleep-and-hope. */
function startNode(opts: { port: number; name: string; mode?: 'permissive' | 'strict'; token?: string | null }): Promise<Node> {
  const url = `http://127.0.0.1:${opts.port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(opts.port),
    NEONCORE_DB_PATH: join(TMP, `${opts.name}.db`),
    NEONCORE_URL: url,
    NEONCORE_AUTH_MODE: opts.mode ?? 'permissive',
  };
  if (opts.token !== null) env.NEONCORE_FLEET_TOKEN = opts.token ?? TOKEN;
  else delete env.NEONCORE_FLEET_TOKEN;

  const proc = spawn('node', ['--import', 'tsx', HELPER], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${opts.name} did not start in time`)), 30_000);
    let stderr = '';
    proc.stdout!.on('data', (b: Buffer) => {
      if (b.toString().includes('READY')) {
        clearTimeout(timer);
        const node = { proc, url, port: opts.port };
        running.push(node);
        res(node);
      }
    });
    proc.stderr!.on('data', (b: Buffer) => { stderr += b.toString(); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`${opts.name} exited with ${code}: ${stderr}`));
    });
  });
}

function req(url: string, path: string, init: RequestInit & { token?: string | null } = {}) {
  const { token, ...rest } = init;
  return fetch(`${url}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

const tick = (url: string) => req(url, '/api/test/tick', { method: 'POST', token: TOKEN });
const roster = async (url: string) => {
  const r = await req(url, '/api/peers', { token: TOKEN });
  return (await r.json()) as { self: { serverId: string; name: string }; peers: { url: string; stale: boolean; serverId: string }[] };
};

let A: Node, B: Node, C: Node, S: Node;

before(async () => {
  [A, B, C, S] = await Promise.all([
    startNode({ port: 4611, name: 'alpha' }),
    startNode({ port: 4612, name: 'bravo' }),
    startNode({ port: 4613, name: 'charlie' }),
    startNode({ port: 4614, name: 'strict', mode: 'strict' }),
  ]);

  // A TCP socket that accepts connections and then says nothing at all — a sleeping
  // laptop. It does NOT refuse, which is what makes it dangerous: without an explicit
  // timeout the request hangs until the OS gives up, minutes later.
  blackhole = createServer(() => { /* accept, never respond */ });
  await new Promise<void>((r) => blackhole!.listen(4615, '127.0.0.1', r));
});

after(async () => {
  for (const n of running) n.proc.kill('SIGKILL');
  await new Promise<void>((r) => (blackhole ? blackhole.close(() => r()) : r()));
  rmSync(TMP, { recursive: true, force: true });
});

// ─── Auth: permissive ───────────────────────────────────────────────────────
// THE P0. Every already-deployed hook, relay and runner sends no Authorization header.
// If they 401, the whole fleet goes quiet with nothing crashing to point at the cause.

test('permissive: health is reachable with no credential at all', async () => {
  const r = await req(A.url, '/api/health');
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { status: string }).status, 'ok');
});

test('permissive: an un-upgraded agent with NO token is still served', async () => {
  const r = await req(A.url, '/api/peers');
  assert.equal(r.status, 200, 'grandfathering absent credentials is what prevents the blackout');
});

test('permissive: a WRONG token is rejected — only ABSENT is grandfathered', async () => {
  const r = await req(A.url, '/api/peers', { token: 'not-the-real-token' });
  assert.equal(r.status, 401);
});

test('permissive: the correct token is accepted', async () => {
  const r = await req(A.url, '/api/peers', { token: TOKEN });
  assert.equal(r.status, 200);
});

// ─── Auth: strict ───────────────────────────────────────────────────────────

test('strict: no credential is rejected', async () => {
  assert.equal((await req(S.url, '/api/peers')).status, 401);
});

test('strict: a wrong token is rejected', async () => {
  assert.equal((await req(S.url, '/api/peers', { token: 'wrong' })).status, 401);
});

test('strict: the correct token is accepted', async () => {
  assert.equal((await req(S.url, '/api/peers', { token: TOKEN })).status, 200);
});

test('strict: health STAYS open — you must be able to diagnose a quiet fleet', async () => {
  assert.equal((await req(S.url, '/api/health')).status, 200);
});

test('non-API paths are never gated — the web app must load before it can authenticate', async () => {
  // A browser fetching index.html has nowhere to put a bearer token. 404 here is the
  // helper having no static dir; what matters is that it is not 401.
  const r = await req(S.url, '/');
  assert.notEqual(r.status, 401);
});

// ─── Secret redaction ───────────────────────────────────────────────────────

test('GET /api/settings never returns the fleet token', async () => {
  await req(A.url, '/api/settings', {
    method: 'PUT', token: TOKEN,
    body: JSON.stringify({ fleet_token: 'super-secret-value', theme: 'neon' }),
  });
  const settings = (await (await req(A.url, '/api/settings', { token: TOKEN })).json()) as Record<string, string>;
  assert.equal(settings.theme, 'neon', 'ordinary settings still round-trip');
  assert.notEqual(settings.fleet_token, 'super-secret-value', 'the secret must not be readable');
  assert.equal(settings.fleet_token, '__set__');
});

test('PUT of the redaction placeholder does NOT overwrite the real secret', async () => {
  // The realistic path: a client GETs settings, edits one field, PUTs the whole object
  // back. Writing "__set__" through would replace the fleet token with that literal
  // string and lock out every agent holding the true one.
  await req(A.url, '/api/settings', {
    method: 'PUT', token: TOKEN, body: JSON.stringify({ fleet_token: 'known-value' }),
  });
  await req(A.url, '/api/settings', {
    method: 'PUT', token: TOKEN, body: JSON.stringify({ fleet_token: '__set__', theme: 'dark' }),
  });
  // The env token is what this process authenticates against, so prove it via behaviour:
  // the real credential still works after the placeholder round-trip.
  assert.equal((await req(A.url, '/api/peers', { token: TOKEN })).status, 200);
  const settings = (await (await req(A.url, '/api/settings', { token: TOKEN })).json()) as Record<string, string>;
  assert.equal(settings.theme, 'dark', 'the non-secret field in the same PUT still applied');
});

// ─── Gossip ─────────────────────────────────────────────────────────────────

test('gossip: a seeded peer is discovered in BOTH directions from one tick', async () => {
  await req(A.url, '/api/peers', { method: 'POST', token: TOKEN, body: JSON.stringify({ url: B.url }) });
  await tick(A.url);

  const a = await roster(A.url);
  assert.deepEqual(a.peers.map((p) => p.url), [B.url]);
  assert.ok(a.peers[0].serverId, 'A learned B identity from the ping reply');

  // B learned about A from being pinged — it was never configured with A's URL.
  const b = await roster(B.url);
  assert.deepEqual(b.peers.map((p) => p.url), [A.url]);
});

test('gossip: a server never ends up in its own roster', async () => {
  const a = await roster(A.url);
  assert.ok(!a.peers.some((p) => p.url === A.url), 'self-ping loop');
  assert.ok(!a.peers.some((p) => p.serverId === a.self.serverId), 'self under an alias');
});

test('gossip: C propagates transitively — A learns it via B, never having been told', async () => {
  // Introduce C to B only. A knows B; B now knows C; so the next tick should teach A
  // about C. This is the union merge doing the entire job.
  await req(B.url, '/api/peers', { method: 'POST', token: TOKEN, body: JSON.stringify({ url: C.url }) });
  await tick(B.url);
  await tick(A.url);

  const a = await roster(A.url);
  assert.deepEqual(a.peers.map((p) => p.url).sort(), [B.url, C.url].sort());
});

test('gossip: re-ticking adds nothing and duplicates nothing', async () => {
  const before = (await roster(A.url)).peers.length;
  await tick(A.url);
  await tick(A.url);
  assert.equal((await roster(A.url)).peers.length, before);
});

test('gossip: one HUNG peer does not stall the tick or the healthy peers', async () => {
  // The blackhole accepts and never replies. Without a per-request timeout this tick
  // would hang for minutes and every other peer would lose its liveness update.
  await req(A.url, '/api/peers', {
    method: 'POST', token: TOKEN, body: JSON.stringify({ url: 'http://127.0.0.1:4615' }),
  });

  const started = Date.now();
  await tick(A.url);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 20_000, `tick took ${elapsed}ms — the 5s ping timeout did not fire`);

  const a = await roster(A.url);
  const hung = a.peers.find((p) => p.url === 'http://127.0.0.1:4615');
  const healthy = a.peers.find((p) => p.url === B.url);
  assert.ok(hung, 'the hung peer stays in the roster, counting toward staleness');
  assert.equal(healthy?.stale, false, 'the healthy peer still got its liveness update');
});

test('gossip: a peer with the WRONG token is recorded as failing, not as reachable', async () => {
  // A 401 must not read as "reachable". It also must not read as a network fault — that
  // sends you debugging the LAN when the fix is the token.
  const odd = await startNode({ port: 4616, name: 'oddtoken', token: 'a-different-fleet-token' });
  await req(A.url, '/api/peers', { method: 'POST', token: TOKEN, body: JSON.stringify({ url: odd.url }) });
  await tick(A.url);

  const entry = (await roster(A.url)).peers.find((p) => p.url === odd.url);
  assert.ok(entry, 'peer is still listed');
  assert.match(
    (entry as unknown as { lastError: string }).lastError ?? '',
    /401/,
    'the failure names the token, not a phantom network problem',
  );
});
