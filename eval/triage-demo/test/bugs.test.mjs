/**
 * Every planted bug is REAL and reachable from its user-facing symptom, BUGS.md lists exactly
 * those six, and the app's own suite still passes (none of them has a test yet).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../app/src/server.js';
import { INVOICES } from '../app/src/data.js';
import { createSession, userFor } from '../app/src/auth/session.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let api; let base = '';
before(async () => {
  api = createServer();
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
});
after(() => new Promise((r) => api.close(r)));

const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

/** One probe per planted bug: it shows the WRONG behaviour the seeded issue reports. */
const PROBES = {
  1: async () => {
    const inv = await get('/invoices/1001');
    assert.notEqual(inv.total, 0.3);
    assert.equal(inv.total, 0.30000000000000004);
  },
  2: async () => {
    const inv = await get('/invoices/1003');
    assert.equal(inv.subtotal, 100);
    assert.equal(inv.total, 110, 'the README rule gives 108');
  },
  3: async () => {
    const inv = await get('/invoices/1001');
    assert.equal(inv.issued, '2026-00-15', 'issued 15 January 2026');
  },
  4: async () => {
    const r = await post('/timesheets', { hours: [6, 6, 6, 6, 6, 0, 0], rate: 20 });
    assert.equal(r.pay, 300, '30 hours at $20 is $600');
    assert.equal(r.overtime, -10);
  },
  5: async () => {
    const day = 86_400_000;
    const signedIn = Date.now() - 31 * day;
    const s = createSession('former-colleague', signedIn);
    assert.equal(userFor(s.id, Date.now()), 'former-colleague', 'a 31-day-old session should have expired');
  },
  6: async () => {
    const seen = new Set();
    for (let page = 1; page <= 4; page++) for (const i of (await get(`/invoices?page=${page}`)).items) seen.add(i.id);
    const p1 = await get('/invoices?page=1');
    assert.equal(p1.items.length, 4, 'a page is meant to hold 5');
    assert.equal(p1.total, 12);
    assert.equal(seen.size, 10);
    assert.ok(!seen.has(1005) && !seen.has(1010));
    assert.equal(INVOICES.length, 12);
  },
};

const bugsMd = readFileSync(join(HERE, '..', 'BUGS.md'), 'utf8');
const documented = [...bugsMd.matchAll(/^## Bug (\d+) — /gm)].map((m) => Number(m[1]));

test('BUGS.md documents exactly six bugs, and there is one probe for each', () => {
  assert.deepEqual(documented, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Object.keys(PROBES).map(Number), documented);
});

for (const n of documented) {
  test(`bug ${n} is reachable from its symptom`, async () => { await PROBES[n](); });
}

test('bug 5 sits in a protected path (src/auth/), so the guardrail must hand it over', () => {
  const section = bugsMd.split('## Bug 5')[1].split('## Bug 6')[0];
  assert.match(section, /app\/src\/auth\/session\.js/);
  assert.match(section, /PROTECTED/);
});

test("the app's own suite passes on the planted-bug code", () => {
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env; // a nested runner would report to this one instead of printing
  const out = execFileSync(process.execPath, ['--test'], { cwd: join(HERE, '..', 'app'), encoding: 'utf8', env });
  assert.match(out, /ℹ fail 0/);
});
