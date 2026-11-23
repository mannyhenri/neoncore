/**
 * THE THEME CREATOR, server side (lib/custom-themes.ts, routes/themes.ts).
 *
 * Duplicate a theme, give it a name, replace any picture or sound; whatever is not replaced stays as
 * drawn. One theme is in use for everyone, and while a theme of your own is in use every replaced
 * file is served in place of the original at the ORIGINAL's address — so nothing else in the app has
 * to know. Checked as sets: every way an asset path can be wrong, every file type, the switch of the
 * theme in use, and what the middleware serves for every combination of in use / replaced.
 */
import './helpers/isolated-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-themes-'));
process.env.NEONCORE_THEMES_DIR = path.join(TMP, 'themes');
const PUBLIC = path.join(TMP, 'public');
for (const f of ['world/terrain.jpg', 'world/bridge/captain.png', 'sound/ui-tap.mp3', 'logo.png']) {
  fs.mkdirSync(path.dirname(path.join(PUBLIC, f)), { recursive: true });
  fs.writeFileSync(path.join(PUBLIC, f), `original ${f}`);
}
const { listThemes, createTheme, renameTheme, deleteTheme, setActiveTheme, activeTheme, setAsset, revertAsset, themeMiddleware, setPublicDir, ThemeError, BUILT_IN_THEMES } = await import('../src/lib/custom-themes.js');
const themesRouter = (await import('../src/routes/themes.js')).default;
setPublicDir(PUBLIC);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpg body')]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from('mp3 body')]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE'), Buffer.from('wav body')]);
const refused = (fn: () => unknown, what: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ThemeError && what.test((e as Error).message), String(what));

test('the built-in themes are listed, the base one in use by default; a duplicate starts with nothing replaced', () => {
  const l = listThemes();
  assert.deepEqual(l.builtIn.map((t) => t.id), ['scifi', 'fantasy']);
  assert.equal(BUILT_IN_THEMES[0].name, 'Neon Outpost');
  assert.equal(l.active, 'scifi');
  assert.deepEqual(l.custom, []);
  const t = createTheme({ name: '  Harbour  Night ', from: 'scifi' });
  assert.deepEqual([t.name, t.base, Object.keys(t.overrides).length], ['Harbour Night', 'scifi', 0]);
  const f = createTheme({ name: 'Elfwood', from: 'fantasy' });
  assert.equal(f.base, 'fantasy');
  refused(() => createTheme({ name: '', from: 'scifi' }), /needs a name/);
  refused(() => createTheme({ name: 'X', from: 'nowhere' }), /no theme/);
  assert.deepEqual(listThemes().custom.map((x) => x.name).sort(), ['Elfwood', 'Harbour Night']);
});

test('replacing an asset: every wrong path and every wrong file is refused with a reason; the right ones are kept', () => {
  const t = createTheme({ name: 'Assets', from: 'scifi' });
  const BAD_PATHS: [string, RegExp][] = [
    ['', /which picture or sound/], ['/api/themes', /not a picture or sound/], ['/world/../secret.png', /not a picture or sound/],
    ['/index.html', /not a picture or sound/], ['/world/nothing-here.png', /no such picture or sound/], ['world/terrain.jpg', /not a picture or sound/],
  ];
  for (const [p, why] of BAD_PATHS) refused(() => setAsset(t.id, p, PNG), why);
  refused(() => setAsset(t.id, '/world/terrain.jpg', Buffer.from('not an image at all')), /a picture \(PNG, JPEG, GIF or WebP\)/);
  refused(() => setAsset(t.id, '/sound/ui-tap.mp3', PNG), /a sound \(MP3, WAV or OGG\)/);
  refused(() => setAsset(t.id, '/world/terrain.jpg', Buffer.alloc(21 * 1024 * 1024, 0xff)), /too large/);
  refused(() => setAsset('scifi', '/world/terrain.jpg', JPG), /built-in theme/);
  refused(() => setAsset('nope', '/world/terrain.jpg', JPG), /no theme/);
  // Any picture type may replace any picture; a sound any sound.
  for (const [p, bytes] of [['/world/terrain.jpg', PNG], ['/world/bridge/captain.png', JPG], ['/sound/ui-tap.mp3', WAV], ['/logo.png', PNG]] as const) {
    assert.ok(setAsset(t.id, p, bytes).overrides[p], p);
  }
  // A reward's art slot need not exist yet: it is a known place for a picture.
  assert.ok(setAsset(t.id, '/rewards/commend.png', PNG).overrides['/rewards/commend.png']);
  assert.deepEqual(Object.keys(revertAsset(t.id, '/logo.png').overrides).sort(), ['/rewards/commend.png', '/sound/ui-tap.mp3', '/world/bridge/captain.png', '/world/terrain.jpg']);
});

test('what is served, for every combination of the theme in use and whether the asset was replaced', async () => {
  const mine = createTheme({ name: 'Served', from: 'scifi' });
  setAsset(mine.id, '/world/terrain.jpg', PNG);
  const other = createTheme({ name: 'Other', from: 'scifi' });
  setAsset(other.id, '/world/bridge/captain.png', JPG);
  const app = express();
  app.use(themeMiddleware());
  app.use(express.static(PUBLIC));
  app.use('/api/themes', express.json({ limit: '30mb' }), themesRouter);
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const get = async (p: string) => { const r = await fetch(base + p); return { body: Buffer.from(await r.arrayBuffer()), cache: r.headers.get('cache-control') ?? '' }; };
    for (const active of ['scifi', mine.id, other.id]) {
      setActiveTheme(active);
      assert.equal(activeTheme(), active);
      for (const [p, replacedIn, bytes] of [['/world/terrain.jpg', mine.id, PNG], ['/world/bridge/captain.png', other.id, JPG], ['/sound/ui-tap.mp3', '', null]] as const) {
        const r = await get(p);
        if (active === replacedIn) {
          assert.deepEqual(r.body, bytes, `${active} ${p}`);
          assert.match(r.cache, /no-cache/, 'a replaced file is never kept by the browser');
        } else assert.equal(r.body.toString(), `original ${p.slice(1)}`, `${active} ${p}`);
      }
    }
    // A theme not in use can still be looked at: its replaced files by their path.
    setActiveTheme('scifi');
    const peek = await get(`/api/themes/${mine.id}/files?path=${encodeURIComponent('/world/terrain.jpg')}`);
    assert.deepEqual(peek.body, PNG);
    // The routes: list, duplicate, rename, use, replace (base64), revert, delete.
    const j = (p: string, method: string, body?: unknown) => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const made = await (await j('/api/themes', 'POST', { name: 'Via route', from: mine.id })).json() as { id: string; overrides: Record<string, unknown> };
    assert.deepEqual(Object.keys(made.overrides), ['/world/terrain.jpg'], 'a duplicate of a theme of your own keeps its replacements');
    assert.equal((await j(`/api/themes/${made.id}`, 'PUT', { name: 'Renamed' })).status, 200);
    assert.equal((await j(`/api/themes/${made.id}/assets`, 'PUT', { path: '/sound/ui-tap.mp3', dataBase64: MP3.toString('base64') })).status, 200);
    assert.equal((await j(`/api/themes/${made.id}/assets`, 'PUT', { path: '/sound/ui-tap.mp3', dataBase64: PNG.toString('base64') })).status, 400);
    assert.equal((await j('/api/themes/active', 'PUT', { id: made.id })).status, 200);
    assert.deepEqual((await get('/sound/ui-tap.mp3')).body, MP3);
    assert.equal((await j(`/api/themes/${made.id}/assets?path=${encodeURIComponent('/sound/ui-tap.mp3')}`, 'DELETE')).status, 200);
    assert.equal((await get('/sound/ui-tap.mp3')).body.toString(), 'original sound/ui-tap.mp3');
    const list = await (await j('/api/themes', 'GET')).json() as { active: string; custom: { id: string; name: string }[] };
    assert.equal(list.active, made.id);
    assert.ok(list.custom.some((c) => c.id === made.id && c.name === 'Renamed'));
    // Deleting the theme in use puts its base back in use.
    assert.equal((await j(`/api/themes/${made.id}`, 'DELETE')).status, 204);
    assert.equal(activeTheme(), 'scifi');
    assert.equal((await j('/api/themes/active', 'PUT', { id: 'nowhere' })).status, 404);
  } finally { server.close(); }
});

test('rename and delete: a name is needed; a built-in theme cannot be renamed or deleted', () => {
  const t = createTheme({ name: 'Temp', from: 'scifi' });
  assert.equal(renameTheme(t.id, 'Temp 2').name, 'Temp 2');
  refused(() => renameTheme(t.id, '   '), /needs a name/);
  refused(() => renameTheme('fantasy', 'X'), /built-in theme/);
  refused(() => deleteTheme('scifi'), /built-in theme/);
  deleteTheme(t.id);
  assert.ok(!listThemes().custom.some((c) => c.id === t.id));
  assert.ok(!fs.existsSync(path.join(process.env.NEONCORE_THEMES_DIR!, t.id)), 'its files are gone');
});
