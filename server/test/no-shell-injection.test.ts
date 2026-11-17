/**
 * Values that arrive in requests, or that a person typed, never reach a shell as code.
 *
 * Found in the bug hunt: the launch script wrote `export K="<JSON string>"` (bash still expands
 * `$(…)`, backticks and `$VAR` inside double quotes), and the git / VS Code routes pasted
 * request-body paths and branch names into `execSync` command strings. The server listens on
 * 0.0.0.0 with permissive auth and open CORS by default, so any of these was remote code
 * execution — and a launch context as ordinary as "run `npm test` first" ran npm test.
 *
 * Set-based over the source: every process-spawning call in the server, the runner and the
 * relay is scanned, so a new interpolated shell string fails here the day it is written.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import gitRouter from '../src/routes/git.ts';
import { openInTerminal } from '../src/lib/open-directory.ts';
// @ts-expect-error — untyped ESM shared with the agent side (types in launch-script.d.mts).
import { posixLaunchScript, windowsLaunchScript, shQuote, cmdPath } from '../../agent/lib/launch-script.mjs';

installStubIO();

const ROOT = path.resolve(import.meta.dirname, '../..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inject-'));

/** Hostile and ordinary text alike: every one must arrive byte for byte, and run nothing. */
function hostileValues(marker: string): string[] {
  return [
    `$(touch ${marker})`,
    `\`touch ${marker}\``,
    `"; touch ${marker}; echo "`,
    `'; touch ${marker}; echo '`,
    `run \`npm test\` first, then check $HOME and \${PATH}`,
    `line one\nline two; touch ${marker}\n\ttabbed`,
    `it's "quoted" \\ back\\slash`,
    '',
  ];
}

test('shQuote round-trips every value through bash untouched', () => {
  const dir = tmp();
  const marker = path.join(dir, 'pwned');
  for (const v of hostileValues(marker)) {
    const out = execFileSync('bash', ['-c', `printf '%s' ${shQuote(v)}`], { encoding: 'utf8' });
    assert.equal(out, v);
  }
  assert.equal(fs.existsSync(marker), false, 'a quoted value was executed');
});

test('the POSIX launch script carries every value as data', () => {
  const dir = tmp();
  const marker = path.join(dir, 'pwned');
  const values = hostileValues(marker);
  const env: Record<string, string> = {};
  values.forEach((v, i) => { env[`NC_TEST_${i}`] = v; });
  const cwd = path.join(dir, "repo $(touch pwned) `touch pwned` 'q' \"dq\"");
  fs.mkdirSync(cwd);
  const printer = `process.stdout.write(JSON.stringify({cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('NC_TEST_')))}))`;
  const script = posixLaunchScript({ cwd, env, argv: [process.execPath, '-e', printer] });
  const file = path.join(dir, 'launch.sh');
  fs.writeFileSync(file, script);
  const r = spawnSync('bash', [file], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.cwd, fs.realpathSync(cwd));
  assert.deepEqual(got.env, env);
  assert.equal(fs.existsSync(marker), false, 'the launch script executed part of a value');
  assert.equal(fs.existsSync(path.join(dir, 'pwned')) || fs.existsSync(path.join(cwd, 'pwned')), false, 'the folder name was executed');
});

test('the Windows launch script names a side file and never holds a value', () => {
  const dir = tmp();
  const envFile = path.join(dir, 'env.json');
  const env = { NEONCORE_LAUNCH_CONTEXT: 'a "quoted" 100% line\r\nsecond & line', NEONCORE_RESUME_SESSION_ID: '%PATH%' };
  const script = windowsLaunchScript({ cwd: 'C:\\Users\\me\\repo 50%', env, argv: ['C:\\node.exe', 'C:\\relay\\launch.js'], envFile });
  assert.ok(!script.includes('quoted') && !script.includes('second') && !script.includes('%PATH%'), script);
  assert.match(script, /cd \/d "C:\\Users\\me\\repo 50%%"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(envFile, 'utf8')), env);
  assert.throws(() => cmdPath('C:\\a"b'), /cannot quote/);
});

test('openInTerminal launches with a hostile context and resume id, and runs none of it', async () => {
  const dir = tmp();
  const marker = path.join(dir, 'pwned');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const out = path.join(dir, 'seen.json');
  const prev = { term: process.env.NEONCORE_TERMINAL, home: process.env.HOME };
  process.env.NEONCORE_TERMINAL = 'log';
  process.env.HOME = dir;
  try {
    const ctx = `fix it, then \`touch ${marker}\` and $(touch ${marker})`;
    const writer = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ctx: process.env.NEONCORE_LAUNCH_CONTEXT, resume: process.env.NEONCORE_RESUME_SESSION_ID}))`;
    const err = openInTerminal(repo, [process.execPath, '-e', writer], 'sess-1', {
      NEONCORE_LAUNCH_CONTEXT: ctx,
      NEONCORE_RESUME_SESSION_ID: `"; touch ${marker}; "`,
    });
    assert.equal(err, null);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !fs.existsSync(out)) await new Promise((r) => setTimeout(r, 50));
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(seen.ctx, ctx);
    assert.equal(seen.resume, `"; touch ${marker}; "`);
    assert.equal(fs.existsSync(marker), false, 'the launch executed text from the launch context or resume id');
  } finally {
    process.env.NEONCORE_TERMINAL = prev.term;
    process.env.HOME = prev.home;
    if (prev.term === undefined) delete process.env.NEONCORE_TERMINAL;
  }
});

test('the git routes take branch names and paths as arguments', async () => {
  const dir = tmp();
  const marker = path.join(dir, 'pwned');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const agentId = 'agent-inject';
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen)
              VALUES (?, 'a', 'm', ?, 'repo', 'idle', ?)`).run(agentId, repo, new Date().toISOString());

  const app = express();
  app.use(express.json());
  app.use('/api/git', gitRouter);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/git/${agentId}`;
  const call = (method: string, url: string, body: unknown) => fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await call('DELETE', `${base}/worktrees`, { path: `${dir}/x"; touch ${marker}; echo "` });
    await call('POST', `${base}/worktrees`, { branch: `b"; touch ${marker}; echo "`, path: path.join(dir, 'wt1') });
    await call('POST', `${base}/worktrees`, { branch: `$(touch ${marker})`, path: path.join(dir, 'wt2') });
    const refused = await call('POST', `${base}/worktrees`, { branch: '--help' });
    assert.equal(refused.status, 400, 'a branch that is an option was not refused');
    assert.equal(fs.existsSync(marker), false, 'a git route executed part of a request body');

    // The ordinary path still works: a real worktree on a real branch, listed and removed.
    const made = await call('POST', `${base}/worktrees`, { branch: 'feature/ok', path: path.join(dir, 'wt-ok') });
    assert.equal(made.status, 201);
    const branches = await (await fetch(`${base}/branches`)).json();
    assert.ok(branches.includes('feature/ok') && branches.includes('main'), JSON.stringify(branches));
    assert.ok(branches.every((b: string) => !b.startsWith("'")), 'branch names carry shell quotes');
    const list = await (await fetch(`${base}/worktrees`)).json();
    assert.ok(list.some((w: { branch: string }) => w.branch === 'feature/ok'));
    const removed = await call('DELETE', `${base}/worktrees`, { path: path.join(dir, 'wt-ok') });
    assert.equal(removed.status, 200);
  } finally {
    server.close();
  }
});

/* ── Set-based: no process is ever started from an interpolated shell string ── */

function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', 'test', 'tests'].includes(e.name)) walk(p); }
      else if (/\.(ts|m?js)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const d of ['server/src', 'agent/runner', 'agent/relay', 'agent/lib']) walk(path.join(ROOT, d));
  return out;
}

test('no exec/execSync call builds its command from an interpolated string', () => {
  const files = sources();
  assert.ok(files.length > 50, `scan found only ${files.length} files — it is broken`);
  const offenders: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // `exec(` / `execSync(` whose first argument is a template literal with a substitution, or a
    // variable holding a command (anything but a plain string literal).
    for (const m of src.matchAll(/(?<![.\w])(execSync|exec)\(\s*([^\s)][^,)]*)/g)) {
      const arg = m[2];
      const literal = /^'[^']*'$|^"[^"]*"$|^`[^`$]*`$/.test(arg.trim());
      if (!literal) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(ROOT, file)}:${line}: ${m[0].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'commands built from strings reach a shell; pass arguments to execFile/spawn instead');
});
