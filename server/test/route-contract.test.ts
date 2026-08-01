/**
 * The client and the route must AGREE, not merely be connected.
 *
 * route-has-caller.test.ts proves every route has a caller. This confer then produced three
 * defects that all passed that guard, because "has a caller" and "has a CORRECT caller" are
 * different claims:
 *
 *   - POST /api/queue returns a bare QueueItem; the client declared an { ok, item, error }
 *     envelope. Both UIs branched on `res.ok`, which is undefined on a QueueItem, so EVERY
 *     successful enqueue reported "rejected" — failing in the worst direction, saying failed
 *     when it worked.
 *   - GET /api/queue sends `kinds`; QueueView omitted it, so the panel hardcoded the kind
 *     registry the server was already shipping.
 *   - POST /api/queue/validate had a route and a client function and no caller at all.
 *
 * One root cause: the client describing the server from memory instead of from the server.
 * So this drives the REAL router and compares the client's DECLARED response shape against the
 * ACTUAL body. It is the altitude above route-has-caller, found the way we find every altitude
 * — by shipping a dead one first.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';

installStubIO();

const ROOT = path.join(import.meta.dirname, '..', '..');
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'packages/client/src/client.ts'), 'utf8');
const CLIENT_TYPES = fs.readFileSync(path.join(ROOT, 'packages/client/src/types.ts'), 'utf8');

/**
 * Field names the client SAYS a call returns.
 *
 * Handles both forms the client uses: an inline literal (`request<{ ok: boolean }>`) and a named
 * type (`request<QueueView>`), which is resolved out of types.ts. A resolver that silently
 * returned [] for the named form would make this test pass by checking nothing — the exact
 * failure mode it exists to catch — so an unresolvable name throws instead.
 */
function declaredFields(methodName: string): string[] {
  const at = CLIENT_SRC.indexOf(`${methodName}:`);
  assert.notEqual(at, -1, `client.ts has no method named ${methodName}`);
  const req = CLIENT_SRC.indexOf('request<', at);
  assert.notEqual(req, -1, `${methodName} does not call request<...>`);

  // Brace/angle match so a nested object type is not truncated.
  let depth = 0;
  let end = req + 'request<'.length;
  for (let i = req + 'request<'.length - 1; i < CLIENT_SRC.length; i++) {
    const ch = CLIENT_SRC[i];
    if (ch === '<') depth++;
    else if (ch === '>' && --depth === 0) { end = i; break; }
  }
  const generic = CLIENT_SRC.slice(req + 'request<'.length, end).trim();

  if (generic.startsWith('{')) {
    return [...generic.matchAll(/(\w+)\??\s*:/g)].map((m) => m[1]);
  }
  // Named type, possibly written as import('./types').QueueView
  const name = generic.replace(/^import\([^)]*\)\./, '').trim();
  const decl = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(CLIENT_TYPES);
  assert.ok(decl, `could not resolve the declared type '${name}' — a resolver that gives up silently would make this test vacuous`);
  return [...decl[1].matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1]);
}

// ─── A live server carrying the real router ─────────────────────────────────

const app = express();
app.use(express.json());
const server = http.createServer(app);
app.use('/api/queue', (await import('../src/routes/queue.js')).default);
await new Promise<void>((r) => server.listen(0, () => r()));
const { port } = server.address() as import('node:net').AddressInfo;
const BASE = `http://127.0.0.1:${port}/api/queue`;

test.after(() => { server.close(); });

/** A cartridge to target, so enqueue takes the success path rather than 400ing. */
const AGENT = 'contract-agent';
db.prepare(`INSERT INTO agents (id, name, machine, repo_path, agent_type, status, last_seen)
            VALUES (?,?,?,?,?,?,?)`)
  .run(AGENT, 'contract/agent', 'm', '/r', 'claude', 'working', new Date().toISOString());

/**
 * Every queue call, the request that exercises it, and the client method that claims its shape.
 * A table so a new route is one entry — the same reason the queue kinds are data.
 */
const CALLS: { name: string; method: string; clientMethod: string; drive: () => Promise<Response> }[] = [
  { name: 'GET /api/queue', method: 'GET', clientMethod: 'getQueue', drive: () => fetch(BASE) },
  {
    name: 'POST /api/queue', method: 'POST', clientMethod: 'enqueueItem',
    drive: () => fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'prompt', payload: { text: 'contract probe' }, targets: [AGENT] }),
    }),
  },
  { name: 'POST /api/queue/tick', method: 'POST', clientMethod: 'tickQueue', drive: () => fetch(`${BASE}/tick`, { method: 'POST' }) },
  {
    name: 'POST /api/queue/lanes/:lane/pause', method: 'POST', clientMethod: 'pauseQueueLane',
    drive: () => fetch(`${BASE}/lanes/${encodeURIComponent(`agent:${AGENT}`)}/pause`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }),
  },
  {
    name: 'POST /api/queue/lanes/:lane/resume', method: 'POST', clientMethod: 'resumeQueueLane',
    drive: () => fetch(`${BASE}/lanes/${encodeURIComponent(`agent:${AGENT}`)}/resume`, { method: 'POST' }),
  },
];

test('the call table covers every queue route the server mounts', () => {
  // Without this the table can silently fall behind the router and every assertion below keeps
  // passing while a new route goes unchecked — a green number pointed at a shrinking scope.
  const routeSrc = fs.readFileSync(path.join(ROOT, 'server/src/routes/queue.ts'), 'utf8');
  const mounted = [...routeSrc.matchAll(/^router\.(get|post|delete|put)\(/gm)].length;
  const covered = CALLS.length + 1; // + DELETE /:id, driven separately below
  assert.equal(covered, mounted,
    `the server mounts ${mounted} queue routes but this table drives ${covered} — add the missing one`);
});

for (const call of CALLS) {
  test(`${call.name}: the client's declared response matches the REAL body`, async () => {
    const res = await call.drive();
    assert.ok(res.ok, `${call.name} returned HTTP ${res.status} — the contract cannot be checked against an error`);
    const body = (await res.json()) as Record<string, unknown>;

    const declared = declaredFields(call.clientMethod);
    assert.ok(declared.length > 0, `no declared fields parsed for ${call.clientMethod} — the parser is broken`);

    const actual = Object.keys(body ?? {});
    const invented = declared.filter((f) => !actual.includes(f));
    assert.deepEqual(
      invented, [],
      `${call.clientMethod} declares field(s) the server never sends: ${invented.join(', ')}\n` +
      `  declared: ${declared.join(', ')}\n  actual:   ${actual.join(', ')}\n` +
      `A UI branching on an invented field reads undefined — which is how every successful ` +
      `enqueue reported "rejected".`,
    );
  });
}

test('DELETE /api/queue/:id: the client\'s declared response matches the REAL body', async () => {
  const created = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'prompt', payload: { text: 'to cancel' }, targets: [AGENT] }),
  });
  const item = (await created.json()) as { id?: string };
  assert.ok(item.id, 'enqueue must return an item with an id for cancel to be testable');

  const res = await fetch(`${BASE}/${item.id}`, { method: 'DELETE' });
  assert.ok(res.ok, `DELETE returned HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;

  const invented = declaredFields('cancelQueueItem').filter((f) => !Object.keys(body).includes(f));
  assert.deepEqual(invented, [], `cancelQueueItem declares field(s) the server never sends: ${invented.join(', ')}`);
});

/**
 * The reverse direction. The enqueue defect was the client inventing a field; the `kinds` defect
 * was the client DROPPING one the server sends — a registry re-declared by hand in the UI
 * because the type erased the evidence that it already arrived.
 */
test('GET /api/queue: the client type does not DROP fields the server sends', async () => {
  const body = (await (await fetch(BASE)).json()) as Record<string, unknown>;
  const declared = declaredFields('getQueue');
  const dropped = Object.keys(body).filter((f) => !declared.includes(f));
  assert.deepEqual(
    dropped, [],
    `the server sends field(s) the client type omits: ${dropped.join(', ')}\n` +
    `A dropped field is invisible to every consumer, so the UI re-declares it by hand — which ` +
    `is exactly how the kind registry got hardcoded in the panel.`,
  );
});
