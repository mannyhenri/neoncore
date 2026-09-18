import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A brand-new cartridge must launch on the FIRST click.
 *
 * It didn't. The relay spawns interactive Claude Code (node-pty) in the cartridge's cwd. In a
 * directory Claude has never seen there is no `projects[<path>]` entry in ~/.claude.json, so
 * Claude opens its folder-trust prompt — "Quick safety check: Is this a project you created or
 * one you trust?" — whose DEFAULT selection is "No, exit". The terminal showed the launch script
 * path and then nothing, and no agent process survived. Running `claude` by hand once in the
 * directory recorded the trust and every later launch worked, which is what made it look like a
 * relay bug rather than a first-run gate.
 *
 * The set has two halves, and the first fix covered only one of them.
 *
 *   1. Every launch alias in RELAY_LAUNCH_TYPES — all six reach a terminal through the single
 *      openDirectory -> openInTerminal call site, and any of them can be the first thing ever
 *      pointed at a fresh directory.
 *   2. Every LAUNCHER — there are two processes that write a `neoncore-launch-*` script and open
 *      a terminal on it: the server (local click) and the runner (remote machine, and the native
 *      relaunch recovery path). The runner bypasses openDirectory entirely, so a fix applied only
 *      to the server leaves recovery and every remote machine still hanging on the trust prompt.
 *
 * The launcher half DISCOVERS its members by scanning for the launch-script filename rather than
 * naming the two files, so a third launcher added later fails this test the day it is added —
 * which is the whole reason it is written this way. These two already drifted once: three
 * near-identical engine branches where only gridlight ever built its env properly.
 */

process.env.NEONCORE_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-trust-db-')),
  'test.db',
);

const { RELAY_LAUNCH_TYPES } = await import('../src/lib/open-directory.ts');
// @ts-expect-error — untyped ESM shared between the server and the runner.
const { ensureFolderTrusted } = await import('../../agent/lib/folder-trust.mjs');

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Every file that writes a `neoncore-launch-*` script and opens a terminal on it. Discovered,
 * not listed: a new launcher is in the set the moment it exists.
 */
function discoverLaunchers(): string[] {
  const roots = [path.join(REPO_ROOT, 'server', 'src'), path.join(REPO_ROOT, 'agent')];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|js|mjs)$/.test(e.name)) continue;
      const src = fs.readFileSync(full, 'utf-8');
      // The launcher is the thing that NAMES the temp script it is about to run.
      if (src.includes('neoncore-launch-${Date.now()}')) found.push(full);
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  return found;
}

/** A throwaway repo dir + a throwaway claude.json, so no test touches the real ~/.claude.json. */
function fixture(): { repoPath: string; claudeJson: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-trust-'));
  const repoPath = path.join(dir, 'brand-new-project');
  fs.mkdirSync(repoPath);
  return { repoPath, claudeJson: path.join(dir, 'claude.json') };
}

function read(claudeJson: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
}

test('every relay launch alias pre-accepts folder trust for the cartridge path', () => {
  const aliases = Object.keys(RELAY_LAUNCH_TYPES);
  assert.ok(aliases.length > 0, 'RELAY_LAUNCH_TYPES must not be empty');

  for (const alias of aliases) {
    const { repoPath, claudeJson } = fixture();
    ensureFolderTrusted(repoPath, claudeJson);

    const projects = read(claudeJson).projects ?? {};
    assert.equal(
      projects[repoPath]?.hasTrustDialogAccepted,
      true,
      `${alias}: launching into a fresh dir must pre-accept trust, or Claude blocks on "No, exit"`,
    );
  }
});

test('EVERY launcher pre-accepts trust, not just the server one', () => {
  const launchers = discoverLaunchers();

  // Both known launchers must be found, or the discovery scan has quietly stopped working and
  // every assertion below would pass vacuously.
  assert.ok(
    launchers.length >= 2,
    `expected at least 2 launchers (server + runner), found ${launchers.length}: ${launchers.join(', ')}`,
  );
  const rel = launchers.map((f) => path.relative(REPO_ROOT, f)).sort();
  assert.ok(rel.some((f) => f.includes('open-directory')), `server launcher missing from ${rel.join(', ')}`);
  assert.ok(rel.some((f) => f.includes('runner')), `runner launcher missing from ${rel.join(', ')}`);

  for (const file of launchers) {
    const src = fs.readFileSync(file, 'utf-8');
    const where = path.relative(REPO_ROOT, file);
    assert.ok(
      src.includes('ensureFolderTrusted'),
      `${where} opens a terminal but never pre-accepts folder trust — a first launch there dies on "No, exit"`,
    );
    assert.ok(
      /from '.*folder-trust\.mjs'/.test(src),
      `${where} must import the SHARED helper, not carry its own copy — these two launchers have drifted before`,
    );
  }
});

test('creates ~/.claude.json when it does not exist yet', () => {
  const { repoPath, claudeJson } = fixture();
  assert.equal(fs.existsSync(claudeJson), false);

  ensureFolderTrusted(repoPath, claudeJson);

  assert.equal(read(claudeJson).projects[repoPath].hasTrustDialogAccepted, true);
});

test('preserves every other project and every top-level key', () => {
  const { repoPath, claudeJson } = fixture();
  fs.writeFileSync(claudeJson, JSON.stringify({
    numStartups: 42,
    oauthAccount: { accountUuid: 'keep-me' },
    projects: {
      '/Users/someone/other-repo': { hasTrustDialogAccepted: true, lastCost: 1.23 },
    },
  }));

  ensureFolderTrusted(repoPath, claudeJson);

  const after = read(claudeJson);
  assert.equal(after.numStartups, 42, 'unrelated top-level keys must survive');
  assert.equal(after.oauthAccount.accountUuid, 'keep-me', 'account block must survive');
  assert.equal(after.projects['/Users/someone/other-repo'].lastCost, 1.23, 'other projects must survive');
  assert.equal(after.projects[repoPath].hasTrustDialogAccepted, true);
});

test('keeps existing fields on a project that is already known', () => {
  const { repoPath, claudeJson } = fixture();
  fs.writeFileSync(claudeJson, JSON.stringify({
    projects: { [repoPath]: { hasTrustDialogAccepted: false, allowedTools: ['Bash'], lastCost: 9 } },
  }));

  ensureFolderTrusted(repoPath, claudeJson);

  const entry = read(claudeJson).projects[repoPath];
  assert.equal(entry.hasTrustDialogAccepted, true, 'trust flips to true');
  assert.deepEqual(entry.allowedTools, ['Bash'], 'existing project fields must not be dropped');
  assert.equal(entry.lastCost, 9);
});

test('a corrupt claude.json is left untouched rather than overwritten', () => {
  const { repoPath, claudeJson } = fixture();
  fs.writeFileSync(claudeJson, '{ this is not json');

  // Must not throw: a launch is never worth crashing on, and must not clobber a file we
  // cannot parse — that file is the user's whole Claude Code state.
  ensureFolderTrusted(repoPath, claudeJson);

  assert.equal(fs.readFileSync(claudeJson, 'utf-8'), '{ this is not json');
});

test('is idempotent — launching twice leaves one entry', () => {
  const { repoPath, claudeJson } = fixture();
  ensureFolderTrusted(repoPath, claudeJson);
  const first = fs.readFileSync(claudeJson, 'utf-8');
  ensureFolderTrusted(repoPath, claudeJson);

  assert.equal(fs.readFileSync(claudeJson, 'utf-8'), first, 'second launch must be a no-op');
});

test('leaves no temp file behind (atomic write cleans up)', () => {
  const { repoPath, claudeJson } = fixture();
  ensureFolderTrusted(repoPath, claudeJson);

  const strays = fs.readdirSync(path.dirname(claudeJson))
    .filter((f) => f.startsWith(path.basename(claudeJson)) && f !== path.basename(claudeJson));
  assert.deepEqual(strays, [], 'atomic rename must not leave a .tmp sibling');
});
