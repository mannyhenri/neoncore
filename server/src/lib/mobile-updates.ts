/**
 * OVER-THE-AIR UPDATES FOR THE PHONE APP — served by this server.
 *
 * The phone app is a React Native app built in Xcode; its JavaScript can be replaced without a new
 * build. A published update is a folder in updatesDir() (mobile/updates/<version>/ in the repo,
 * git-ignored): manifest.json and its files — main.jsbundle and the assets
 * next to it. `mobile/scripts/ota-publish.mjs` builds and publishes one.
 *
 * The app asks for the newest update for its RUNTIME — the native build's compatibility number
 * (mobile/src/ota.ts OTA_RUNTIME = AppDelegate's NeonCoreUpdates.runtime): a bundle only ever runs
 * on the native code it was built for. It downloads every file, checks each one's sha256, and
 * switches on its next launch (ios/NeonCore/NeonCorePush.swift NeonCoreUpdates).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface UpdateFile { path: string; sha256: string; bytes: number }
export interface UpdateManifest { version: string; runtime: string; createdAt: string; bundle: string; files: UpdateFile[] }

/** server/{src,dist}/lib → the repo's mobile app, when this server runs from the repo. */
const REPO_MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mobile');
/** NEONCORE_MOBILE_UPDATES_DIR, else mobile/updates/ in the repo (git-ignored), else ~/.neoncore/mobile-updates. */
export const updatesDir = () => process.env.NEONCORE_MOBILE_UPDATES_DIR
  || (fs.existsSync(path.join(REPO_MOBILE, 'package.json')) ? path.join(REPO_MOBILE, 'updates') : path.join(os.homedir(), '.neoncore', 'mobile-updates'));
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/;
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function readManifest(version: string): UpdateManifest | null {
  if (!VERSION.test(version)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(updatesDir(), version, 'manifest.json'), 'utf8')) as UpdateManifest;
    if (m.version !== version || !Array.isArray(m.files) || !m.files.some((f) => f.path === m.bundle)) return null;
    return m;
  } catch { return null; }
}

/** A file of an update, as a path on disk — only one the manifest lists. */
export function updateFile(version: string, file: string): string | null {
  const m = readManifest(version);
  if (!m || !m.files.some((f) => f.path === file)) return null;
  const root = path.resolve(updatesDir(), version);
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) return null;
  return full;
}

/** Every file there and matching its hash — checked once per manifest, not on every request. */
const verified = new Map<string, boolean>();
function complete(m: UpdateManifest): boolean {
  const key = `${m.version}@${m.createdAt}`;
  if (!verified.has(key)) verified.set(key, m.files.every((f) => { const p = updateFile(m.version, f.path); return !!p && sha(p) === f.sha256; }));
  return verified.get(key)!;
}

/**
 * The newest complete update for a runtime — null when there is none, or the phone already has it.
 * `since`: the phone runs the code built into the app, built at that moment — only an update
 * published after it is newer.
 */
export function latestUpdate(runtime: string, current = '', since = ''): UpdateManifest | null {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(updatesDir()); } catch { return null; }
  const best = dirs.map(readManifest).filter((m): m is UpdateManifest => !!m && m.runtime === runtime && (!since || m.createdAt > since) && complete(m))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return !best || best.version === current ? null : best;
}

/** Publish a built bundle (main.jsbundle + assets/…) as an update. */
export function publishUpdate(from: string, opts: { version: string; runtime: string; createdAt?: string }): UpdateManifest {
  if (!VERSION.test(opts.version)) throw new Error(`"${opts.version}" is not a usable version name`);
  if (!fs.existsSync(path.join(from, 'main.jsbundle'))) throw new Error(`no main.jsbundle in ${from}`);
  const to = path.join(updatesDir(), opts.version);
  if (fs.existsSync(to)) throw new Error(`${opts.version} is already published`);
  const files: UpdateFile[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push({ path: path.relative(from, p).split(path.sep).join('/'), sha256: sha(p), bytes: fs.statSync(p).size });
    }
  };
  walk(from);
  fs.mkdirSync(to, { recursive: true });
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(to, f.path)), { recursive: true }); fs.copyFileSync(path.join(from, f.path), path.join(to, f.path)); }
  const manifest: UpdateManifest = { version: opts.version, runtime: opts.runtime, createdAt: opts.createdAt ?? new Date().toISOString(), bundle: 'main.jsbundle', files };
  fs.writeFileSync(path.join(to, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
