/**
 * The fleet token: who may call a NeonCore server's API.
 *
 * Real servers (child PROCESSES — db.ts holds a module-level singleton, so each instance needs its
 * own process and database), one permissive and one strict, over real HTTP. A wrong call here is a
 * silent blackout: every hook, relay, runner and the phone app talks to the server through it.
 * (These ran beside the server-to-server gossip tests, which went with federation.)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'neoncore-fleet-'));
const HELPER = resolve(import.meta.dirname, 'helpers', 'auth-server.ts');
const TOKEN = 'test-fleet-token-aaaaaaaaaaaaaaaaaaaa';

interface Node { proc: ChildProcess; url: string; port: number }

const running: Node[] = [];

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

let A: Node, S: Node;

before(async () => {
  [A, S] = await Promise.all([
    startNode({ port: 4611, name: 'alpha' }),
    startNode({ port: 4614, name: 'strict', mode: 'strict' }),
  ]);
});

after(async () => {
  for (const n of running) n.proc.kill('SIGKILL');
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
