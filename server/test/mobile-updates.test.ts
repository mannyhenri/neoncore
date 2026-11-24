/**
 * OVER-THE-AIR UPDATES FOR THE PHONE APP, from this server (lib/mobile-updates.ts).
 *
 * A published update is a folder: manifest.json + its files (the JS bundle and its assets). The
 * phone asks for the newest update for ITS runtime (the native build's compatibility number) and
 * downloads each file, checking its sha256. Checked as sets:
 *   · the newest of several versions, per runtime; none when the phone already has it
 *   · a manifest whose files are missing or do not match their hashes is never offered
 *   · every file is served byte for byte; nothing outside an update's folder is ever served
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-updates-'));
process.env.NEONCORE_MOBILE_UPDATES_DIR = DIR;
const { latestUpdate, updateFile, publishUpdate } = await import('../src/lib/mobile-updates.js');
const router = (await import('../src/routes/mobile.js')).default;

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
function write(version: string, runtime: string, createdAt: string, files: Record<string, string>, opts: { badHash?: string; missing?: string } = {}) {
  const dir = path.join(DIR, version);
  fs.mkdirSync(dir, { recursive: true });
  const list = Object.entries(files).map(([p, body]) => {
    const buf = Buffer.from(body);
    if (p !== opts.missing) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), buf); }
    return { path: p, sha256: p === opts.badHash ? '0'.repeat(64) : sha(buf), bytes: buf.length };
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version, runtime, createdAt, bundle: 'main.jsbundle', files: list }));
}

write('0.8.0-1', '1', '2026-11-23T10:00:00Z', { 'main.jsbundle': 'one', 'assets/a.png': 'A' });
write('0.8.0-2', '1', '2026-11-23T11:00:00Z', { 'main.jsbundle': 'two', 'assets/src/x/b.png': 'B' });
write('0.8.0-3', '2', '2026-11-23T12:00:00Z', { 'main.jsbundle': 'three' });                       // another runtime
write('0.8.0-4', '1', '2026-11-23T13:00:00Z', { 'main.jsbundle': 'four' }, { missing: 'main.jsbundle' });   // incomplete
write('0.8.0-5', '1', '2026-11-23T14:00:00Z', { 'main.jsbundle': 'five' }, { badHash: 'main.jsbundle' });   // corrupt

test('the newest complete update for the phone\'s runtime — and none when it already has it', () => {
  assert.equal(latestUpdate('1')?.version, '0.8.0-2');
  assert.equal(latestUpdate('2')?.version, '0.8.0-3');
  assert.equal(latestUpdate('9'), null);
  assert.equal(latestUpdate('1', '0.8.0-2'), null, 'already has the newest');
  assert.equal(latestUpdate('1', '0.8.0-1')?.version, '0.8.0-2');
  assert.deepEqual(latestUpdate('1')!.files.map((f) => f.path).sort(), ['assets/src/x/b.png', 'main.jsbundle']);
  // Running the code built into the app: only what was published after that build is newer.
  assert.equal(latestUpdate('1', '', '2026-11-23T10:30:00Z')?.version, '0.8.0-2');
  assert.equal(latestUpdate('1', '', '2026-11-23T11:30:00Z'), null, 'the app was built after the newest update');
});

test('publishing: a folder of built files becomes an update, with every file hashed', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'built-'));
  fs.writeFileSync(path.join(src, 'main.jsbundle'), 'six');
  fs.mkdirSync(path.join(src, 'assets', 'img'), { recursive: true });
  fs.writeFileSync(path.join(src, 'assets', 'img', 'c.png'), 'C');
  const m = publishUpdate(src, { version: '0.8.0-6', runtime: '1', createdAt: '2026-11-23T15:00:00Z' });
  assert.deepEqual(m.files.map((f) => [f.path, f.sha256, f.bytes]).sort(), [['assets/img/c.png', sha(Buffer.from('C')), 1], ['main.jsbundle', sha(Buffer.from('six')), 3]]);
  assert.equal(latestUpdate('1')?.version, '0.8.0-6');
  assert.throws(() => publishUpdate(src, { version: '0.8.0-6', runtime: '1' }), /already published/);
  assert.throws(() => publishUpdate(path.join(src, 'nope'), { version: '0.8.0-7', runtime: '1' }), /main\.jsbundle/);
});

test('over HTTP: the manifest, every file byte for byte, and nothing outside an update', async () => {
  const app = express(); app.use('/api/mobile', router);
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mobile`;
  try {
    const r = await fetch(`${base}/update?runtime=1&current=0.8.0-1`);
    assert.equal(r.status, 200);
    const { update } = await r.json();
    assert.equal(update.version, '0.8.0-6');
    for (const f of update.files) {
      const res = await fetch(`${base}/update/${update.version}/files/${f.path.split('/').map(encodeURIComponent).join('/')}`);
      assert.equal(res.status, 200, f.path);
      assert.equal(sha(Buffer.from(await res.arrayBuffer())), f.sha256, f.path);
    }
    assert.deepEqual(await (await fetch(`${base}/update?runtime=1&current=0.8.0-6`)).json(), { update: null });
    assert.deepEqual(await (await fetch(`${base}/update?runtime=1&since=2030-01-01T00:00:00Z`)).json(), { update: null });
    assert.equal((await (await fetch(`${base}/update?runtime=1&since=2026-11-23T14:30:00Z`)).json()).update.version, '0.8.0-6');
    assert.equal((await fetch(`${base}/update`)).status, 400, 'a runtime is required');
    for (const bad of ['../0.8.0-1/main.jsbundle', '..%2F..%2Fsecret', 'manifest.json', 'assets/../../0.8.0-2/main.jsbundle']) {
      assert.equal((await fetch(`${base}/update/0.8.0-6/files/${bad}`)).status, 404, bad);
    }
    assert.equal((await fetch(`${base}/update/..%2F/files/main.jsbundle`)).status, 404);
    assert.equal(updateFile('0.8.0-6', 'nope.png'), null);
  } finally { server.close(); }
});
