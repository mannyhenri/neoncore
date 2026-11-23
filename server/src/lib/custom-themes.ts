/**
 * THE THEME CREATOR — themes of your own (Settings → Themes).
 *
 * A theme is how NeonCore looks and sounds: every picture (the captain and his sets of animations,
 * the crew, the maps, the props) and every sound. Two are built in (Neon Outpost, the sci-fi one;
 * Guild Village, the fantasy one). Duplicate one, give it a name, and replace whatever you want —
 * whatever you do not replace stays as drawn. A theme of your own keeps its base (the built-in it
 * came from) and the files that replace the base's.
 *
 * ONE theme is in use for everyone (the `theme.active` setting). While a theme of your own is in use
 * themeMiddleware serves each replaced file AT THE ORIGINAL'S ADDRESS, ahead of the static files,
 * so nothing else in the app has to know about themes. Replaced files are sent with no-cache.
 *
 * Stored in ~/.neoncore/themes/<id>/ (NEONCORE_THEMES_DIR): theme.json and the files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import db from '../db.js';

export class ThemeError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export type ThemeBase = 'scifi' | 'fantasy';
export const BUILT_IN_THEMES: readonly { id: ThemeBase; name: string; blurb: string }[] = [
  { id: 'scifi', name: 'Neon Outpost', blurb: 'The drawn sci-fi outpost NeonCore ships with.' },
  { id: 'fantasy', name: 'Guild Village', blurb: 'The drawn fantasy village and its guild.' },
];
export interface CustomTheme {
  id: string; name: string; base: ThemeBase; createdAt: string; updatedAt: string;
  /** Asset path (as served, e.g. /world/terrain.jpg) → the file that replaces it. */
  overrides: Record<string, { file: string; bytes: number; at: string }>;
}

const MAX_BYTES = 20 * 1024 * 1024;
/** Where pictures and sounds live; a replacement must be one of them. */
const ASSET_ROOTS = ['/world/', '/sound/', '/rewards/', '/qa/', '/triage/'];
const APP_FILES = ['/background.png', '/logo.png', '/name_grid.png'];
/** Art slots that need not exist yet (a reward's emblem): a picture may be put there. */
const SLOTS = [/^\/rewards\/[a-z0-9-]+\.png$/];
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const SOUND_EXT = /\.(mp3|wav|ogg)$/i;

let publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'public');
/** Where the original files are served from (index.ts sets it; tests point it elsewhere). */
export function setPublicDir(dir: string): void { publicDir = dir; }

const themesDir = () => process.env.NEONCORE_THEMES_DIR || path.join(os.homedir(), '.neoncore', 'themes');
const dirOf = (id: string) => path.join(themesDir(), id);
const isBuiltIn = (id: string): id is ThemeBase => BUILT_IN_THEMES.some((t) => t.id === id);
const cleanName = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const nowIso = () => new Date().toISOString();

function read(id: string): CustomTheme | null {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'theme.json'), 'utf8')) as CustomTheme; } catch { return null; }
}
/** Bumped by every change, so the middleware never serves a theme out of date. */
let version = 0;
function write(t: CustomTheme): CustomTheme {
  version++;
  fs.mkdirSync(path.join(dirOf(t.id), 'files'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(t.id), 'theme.json'), JSON.stringify(t, null, 2));
  return t;
}
function mustOwn(id: string): CustomTheme {
  if (isBuiltIn(id)) throw new ThemeError('a built-in theme cannot be changed — duplicate it and change the copy');
  const t = read(id);
  if (!t) throw new ThemeError('there is no theme with that id', 404);
  return t;
}
function customThemes(): CustomTheme[] {
  try { return fs.readdirSync(themesDir()).map(read).filter((t): t is CustomTheme => t !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); } catch { return []; }
}

export function activeTheme(): string {
  const v = (db.prepare("SELECT value FROM settings WHERE key = 'theme.active'").get() as { value?: string } | undefined)?.value ?? '';
  return isBuiltIn(v) || read(v) ? v : 'scifi';
}
/** The built-in theme the one in use is drawn on (what the dashboard loads). */
export function activeBase(): ThemeBase {
  const a = activeTheme();
  return isBuiltIn(a) ? a : read(a)?.base ?? 'scifi';
}
export function setActiveTheme(id: string): void {
  if (!isBuiltIn(id) && !read(id)) throw new ThemeError('there is no theme with that id', 404);
  version++;
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('theme.active', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(id, nowIso());
}

export function listThemes(): { active: string; activeBase: ThemeBase; builtIn: typeof BUILT_IN_THEMES; custom: CustomTheme[] } {
  return { active: activeTheme(), activeBase: activeBase(), builtIn: BUILT_IN_THEMES, custom: customThemes() };
}

/** Duplicate a theme. From a built-in one: nothing replaced yet. From one of yours: its replacements too. */
export function createTheme(input: { name?: unknown; from?: unknown }): CustomTheme {
  const name = cleanName(input.name);
  if (!name) throw new ThemeError('a theme needs a name');
  const from = String(input.from ?? '');
  const source = isBuiltIn(from) ? null : read(from);
  if (!isBuiltIn(from) && !source) throw new ThemeError('there is no theme with that id to duplicate', 404);
  const t: CustomTheme = { id: randomUUID().slice(0, 8), name, base: source ? source.base : from as ThemeBase, createdAt: nowIso(), updatedAt: nowIso(), overrides: {} };
  write(t);
  if (source) {
    for (const [p, o] of Object.entries(source.overrides)) {
      fs.copyFileSync(path.join(dirOf(source.id), 'files', o.file), path.join(dirOf(t.id), 'files', o.file));
      t.overrides[p] = { ...o };
    }
    write(t);
  }
  return t;
}
export function renameTheme(id: string, name: unknown): CustomTheme {
  const t = mustOwn(id);
  const n = cleanName(name);
  if (!n) throw new ThemeError('a theme needs a name');
  return write({ ...t, name: n, updatedAt: nowIso() });
}
/** Gone, with its files. If it was in use, its base is in use again. */
export function deleteTheme(id: string): void {
  const t = mustOwn(id);
  if (activeTheme() === id) setActiveTheme(t.base);
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  version++;
}

/** The asset path, made safe, or why not. */
function assetPath(p: unknown): string {
  const raw = String(p ?? '');
  if (!raw) throw new ThemeError('which picture or sound? (its path, e.g. /world/terrain.jpg)');
  const norm = path.posix.normalize(raw);
  const known = norm === raw && norm.startsWith('/') && !norm.includes('..') && (ASSET_ROOTS.some((r) => norm.startsWith(r)) || APP_FILES.includes(norm)) && (IMAGE_EXT.test(norm) || SOUND_EXT.test(norm));
  if (!known) throw new ThemeError(`${raw} is not a picture or sound of a theme`);
  if (!fs.existsSync(path.join(publicDir, norm)) && !SLOTS.some((r) => r.test(norm))) throw new ThemeError(`there is no such picture or sound: ${norm}`, 404);
  return norm;
}
function kindOf(b: Buffer): 'image' | 'sound' | null {
  const h = (n: number) => b.subarray(0, n);
  if (h(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
  if (h(4).toString('latin1') === 'GIF8') return 'image';
  if (h(4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';
  if (h(3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'sound';
  if (h(4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return 'sound';
  if (h(4).toString('latin1') === 'OggS') return 'sound';
  return null;
}

/** Replace one picture or sound in a theme of your own. */
export function setAsset(id: string, p: unknown, bytes: Buffer): CustomTheme {
  const t = mustOwn(id);
  const at = assetPath(p);
  if (bytes.length > MAX_BYTES) throw new ThemeError('that file is too large — 20 MB at most');
  const want = IMAGE_EXT.test(at) ? 'image' : 'sound';
  if (kindOf(bytes) !== want) throw new ThemeError(want === 'image' ? `${at} needs a picture (PNG, JPEG, GIF or WebP)` : `${at} needs a sound (MP3, WAV or OGG)`);
  const file = `${createHash('sha1').update(at).digest('hex').slice(0, 16)}${path.extname(at)}`;
  fs.mkdirSync(path.join(dirOf(id), 'files'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(id), 'files', file), bytes);
  return write({ ...t, updatedAt: nowIso(), overrides: { ...t.overrides, [at]: { file, bytes: bytes.length, at: nowIso() } } });
}
/** Back to the original. */
export function revertAsset(id: string, p: unknown): CustomTheme {
  const t = mustOwn(id);
  const at = String(p ?? '');
  const o = t.overrides[at];
  if (!o) return t;
  fs.rmSync(path.join(dirOf(id), 'files', o.file), { force: true });
  const { [at]: _gone, ...rest } = t.overrides;
  void _gone;
  return write({ ...t, updatedAt: nowIso(), overrides: rest });
}
/** The file that replaces `assetPath` in theme `id`, or null. */
export function overrideFile(id: string, p: string): string | null {
  const t = read(id);
  const o = t?.overrides[p];
  return t && o ? path.join(dirOf(id), 'files', o.file) : null;
}

/** Ahead of the static files: while a theme of your own is in use, its replaced files at the originals' addresses. */
export function themeMiddleware(): RequestHandler {
  let cache: { version: number; theme: CustomTheme | null } = { version: -1, theme: null };
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!(ASSET_ROOTS.some((r) => req.path.startsWith(r)) || APP_FILES.includes(req.path))) return next();
    // The theme in use, re-read only after a change (version).
    if (cache.version !== version) { const id = activeTheme(); cache = { version, theme: isBuiltIn(id) ? null : read(id) }; }
    const o = cache.theme?.overrides[req.path];
    if (!cache.theme || !o) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(dirOf(cache.theme.id), 'files', o.file));
  };
}
