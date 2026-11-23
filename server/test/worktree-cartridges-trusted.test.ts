/**
 * A CARTRIDGE IN A WORKTREE NEONCORE MADE STARTS IN TRUST.
 *
 * REQUESTED: "when we create the new worktree to work on a feature can we automatically set it to
 * trust instead of me always manually approving them." Every cartridge registered in MANUAL mode
 * unless its machine's hooks opted in, so each new feature worktree's cartridge stopped for a person
 * on every command until its mode was switched by hand.
 *
 * Worktrees are made in five places (a feature's workspace, Confer, a workflow step, a Triage issue,
 * the dashboard's "new worktree") — all through lib/worktree.ts createWorktree, which now records
 * each one. A cartridge that FIRST registers in a recorded worktree starts in trust.
 *
 * SET-BASED, two halves:
 *   1. the creators are DISCOVERED by scanning src/ — every `createWorktree(` caller and every raw
 *      `worktree add`; a raw one outside lib/worktree.ts would bypass the record and fails here.
 *   2. every engine in SUPPORTED_ENGINES registers in a recorded worktree → trust; elsewhere → manual;
 *      the switch off → manual; a cartridge that already exists keeps the mode a person gave it.
 */
import './helpers/isolated-db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import agentsRouter from '../src/routes/agents.ts';
import { createWorktree, isNeoncoreWorktree, WORKTREE_TRUST_SETTING } from '../src/lib/worktree.ts';
import { SUPPORTED_ENGINES } from '../src/types.ts';

installStubIO();
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const app = express();
app.use(express.json());
app.use('/api/agents', agentsRouter);
let server: Server;
let base = '';
before(() => new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; ok(); }); }));
after(() => server.close());

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-trust-'));
  const r = path.join(dir, 'app');
  fs.mkdirSync(r);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: r, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return r;
}
async function register(repoPath: string, agentType: string, extra: Record<string, unknown> = {}): Promise<{ id: string; mode: string }> {
  const r = await fetch(`${base}/api/agents/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine: 'box', repoPath, repoName: path.basename(repoPath), agentType, status: 'idle', ...extra }) });
  assert.ok(r.status === 200 || r.status === 201, await r.clone().text());
  return r.json() as Promise<{ id: string; mode: string }>;
}
const setSwitch = (on: boolean | null) => {
  if (on === null) db.prepare('DELETE FROM settings WHERE key = ?').run(WORKTREE_TRUST_SETTING);
  else db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, '') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(WORKTREE_TRUST_SETTING, on ? '1' : '0');
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

test('every worktree NeonCore makes goes through createWorktree — discovered, not listed', () => {
  const files = walk(SRC);
  const callers = files.filter((f) => /\bcreateWorktree\(/.test(fs.readFileSync(f, 'utf8')) && !f.endsWith(path.join('lib', 'worktree.ts')));
  const rel = callers.map((f) => path.relative(SRC, f)).sort();
  // The five creators known today; a new one is welcome — it is covered because it calls createWorktree.
  for (const known of ['lib/feature-workspace.ts', 'lib/confer-conductor.ts', 'lib/workflow-executor-v2.ts', 'lib/triage/sandbox.ts', 'routes/git.ts']) {
    assert.ok(rel.includes(known), `${known} creates worktrees through createWorktree (found: ${rel.join(', ')})`);
  }
  // A raw `git worktree add` anywhere else (code, not a prompt string) would make a worktree the record never sees.
  const raw = files.filter((f) => !f.endsWith(path.join('lib', 'worktree.ts')) && !f.includes(`${path.sep}templates${path.sep}`))
    .filter((f) => /\[\s*'worktree'\s*,\s*'add'/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(raw.map((f) => path.relative(SRC, f)), [], 'a worktree made outside createWorktree');
});

test('every engine: a cartridge first registering in a worktree NeonCore made starts in trust', async () => {
  setSwitch(null); // the default is on
  for (const engine of SUPPORTED_ENGINES) {
    const r = repo();
    const { path: wt } = createWorktree(r, `feature/${engine}-x`);
    assert.ok(isNeoncoreWorktree(wt));
    const agent = await register(wt, engine);
    assert.equal(agent.mode, 'trust', `${engine} in a NeonCore worktree`);
    const row = db.prepare('SELECT trust_mode, agent_mode FROM agents WHERE id = ?').get(agent.id) as { trust_mode: number; agent_mode: string };
    assert.deepEqual(row, { trust_mode: 1, agent_mode: 'trust' });
    // The same path spelled differently (trailing slash) is the same worktree.
    assert.ok(isNeoncoreWorktree(`${wt}/`));
  }
});

test('elsewhere, with the switch off, and for a cartridge that already exists, nothing changes', async () => {
  for (const engine of SUPPORTED_ENGINES) {
    setSwitch(null);
    const r = repo();
    assert.equal((await register(r, engine)).mode, 'manual', `${engine} in an ordinary repo stays manual`);

    const { path: wt } = createWorktree(r, `feature/${engine}-off`);
    setSwitch(false);
    assert.equal((await register(wt, engine)).mode, 'manual', `${engine}: the switch off`);

    setSwitch(null);
    const { path: wt2 } = createWorktree(r, `feature/${engine}-kept`);
    const first = await register(wt2, engine);
    assert.equal(first.mode, 'trust');
    db.prepare("UPDATE agents SET agent_mode = 'manual', trust_mode = 0 WHERE id = ?").run(first.id); // a person chose manual
    assert.equal((await register(wt2, engine)).mode, 'manual', `${engine}: a mode a person chose is kept on every later register`);
  }
});

test('a worktree reused (it already existed) is still recorded', () => {
  const r = repo();
  const { path: wt } = createWorktree(r, 'feature/again');
  db.prepare('DELETE FROM neoncore_worktrees').run();
  createWorktree(r, 'feature/again');
  assert.ok(isNeoncoreWorktree(wt));
});
