/**
 * REPO OPERATIONS a NeonCore server may ask this machine's runner to perform — for the Goal Pilot's
 * ACCEPTANCE CONTRACT (server/src/lib/acceptance-contract.ts, docs/GOAL-PILOT.md).
 *
 * The server verifies a goal by itself rather than taking an agent's word for it: it reads the
 * locked acceptance-test files to check their hashes, runs each criterion's test command, and —
 * when the person chooses "restore the approved version" — writes a test file back. When the repo
 * is on the server's own disk it does that directly (server/src/lib/repo-access.ts). When the repo
 * lives on ANOTHER machine, the server sends a `repo_op` over this runner's socket and these
 * functions do it here. The two implementations follow the same rules, and the same cases are
 * tested against both (server/test/repo-access.test.ts).
 *
 * THE RULES
 *   · Only repos in this runner's allowlist (`repos` in runner.config.json) — the same allowlist
 *     that bounds where a cartridge may be launched. A path outside it is refused.
 *   · Only paths INSIDE the repo: relative, no `..`, no absolute paths, no escaping through a
 *     symlinked parent.
 *   · Reads are capped; a command's output is kept to its tail; a command that outruns its
 *     timeout is killed with its whole process group.
 *   · Commands run with this machine's environment minus NEONCORE_* variables (tokens), with
 *     CI=1 so test runners do not wait for a watch-mode keypress.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';

export const READ_MAX_BYTES = 256 * 1024;
export const OUTPUT_MAX_CHARS = 8000;
export const RUN_TIMEOUT_MAX_MS = 30 * 60_000;
const CAPTURE_MAX_BYTES = 512 * 1024;

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A repo-relative path in canonical form (forward slashes, no leading ./), or null when it is not
 * one: absolute, drive-lettered, empty, or climbing out with `..`.
 */
export function safeRelPath(p) {
  if (typeof p !== 'string') return null;
  const raw = p.trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.includes('\0')) return null;
  const parts = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '');

/** Is `repoPath` one of the allowlisted repos (compared as resolved paths)? */
export function allowedRepo(repos, repoPath) {
  const want = norm(repoPath);
  return (repos || []).some((r) => norm(typeof r === 'string' ? r : r && r.path) === want);
}

/** The absolute path for a repo-relative one, or null when it would land outside the repo. */
export function resolveInRepo(repoPath, rel) {
  const safe = safeRelPath(rel);
  if (!safe) return null;
  const root = norm(repoPath);
  const abs = path.resolve(root, safe);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  // A symlinked directory inside the repo must not lead out of it.
  let dir = path.dirname(abs);
  while (dir.length >= root.length) {
    if (fs.existsSync(dir)) {
      const real = fs.realpathSync(dir);
      const realRoot = fs.realpathSync(root);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
      break;
    }
    dir = path.dirname(dir);
  }
  return abs;
}

export function readRepoFiles(repoPath, paths) {
  return (Array.isArray(paths) ? paths : []).map((p) => {
    const rel = safeRelPath(p) || String(p);
    const abs = resolveInRepo(repoPath, p);
    if (!abs) return { path: rel, exists: false, content: '', sha256: '', bytes: 0, error: 'not a path inside the repo' };
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return { path: rel, exists: false, content: '', sha256: '', bytes: 0, error: 'not a file' };
      if (st.size > READ_MAX_BYTES) return { path: rel, exists: true, content: '', sha256: '', bytes: st.size, error: `larger than ${READ_MAX_BYTES} bytes` };
      const content = fs.readFileSync(abs, 'utf8');
      return { path: rel, exists: true, content, sha256: sha256(content), bytes: st.size };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { path: rel, exists: false, content: '', sha256: '', bytes: 0 };
      return { path: rel, exists: false, content: '', sha256: '', bytes: 0, error: String(err && err.message || err) };
    }
  });
}

export function writeRepoFile(repoPath, rel, content) {
  const abs = resolveInRepo(repoPath, rel);
  if (!abs) throw new Error(`"${rel}" is not a path inside the repo`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content));
}

/** The environment a check runs with: this machine's, minus NeonCore's secrets. */
export function checkEnv(base = process.env) {
  const env = {};
  // NODE_TEST_CONTEXT: node's test-runner plumbing — inherited, a nested `node --test` would not exit non-zero.
  for (const [k, v] of Object.entries(base)) if (!/^NEONCORE_/i.test(k) && k !== 'NODE_TEST_CONTEXT') env[k] = v;
  env.CI = '1';
  return env;
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

/** Run one shell command in the repo. Never rejects: a command that cannot start is exit null + error text. */
export function runRepoCommand(repoPath, command, timeoutMs = 5 * 60_000) {
  const limit = Math.max(1000, Math.min(Number(timeoutMs) || 0, RUN_TIMEOUT_MAX_MS));
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = `${out}${extra}`.trim();
      resolve({
        exitCode, timedOut,
        output: text.length > OUTPUT_MAX_CHARS ? `…${text.slice(-(OUTPUT_MAX_CHARS - 1))}` : text,
        durationMs: Date.now() - started,
      });
    };
    let child;
    try {
      child = spawn(String(command), {
        cwd: repoPath, shell: true, env: checkEnv(), detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err) {
      finish(null, `could not start: ${err && err.message}`);
      return;
    }
    const take = (chunk) => {
      if (out.length < CAPTURE_MAX_BYTES) out += chunk.toString('utf8');
      else out = out.slice(-CAPTURE_MAX_BYTES / 2) + chunk.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, limit);
    child.on('error', (err) => finish(null, `\n${err.message}`));
    child.on('close', (code) => finish(timedOut ? null : code, timedOut ? `\n(timed out after ${Math.round(limit / 1000)}s — killed)` : ''));
  });
}

/** The runner's handler for a `repo_op`: validate against the allowlist, then do it. */
export async function handleRepoOp(payload, { repos }) {
  const p = payload || {};
  if (!p.repoPath || !allowedRepo(repos, p.repoPath)) {
    return { ok: false, error: `${p.repoPath || '(no repo)'} is not one of this machine's exposed repos` };
  }
  if (!fs.existsSync(p.repoPath)) return { ok: false, error: `${p.repoPath} does not exist on this machine` };
  try {
    if (p.op === 'read') return { ok: true, files: readRepoFiles(p.repoPath, p.paths) };
    if (p.op === 'write') { writeRepoFile(p.repoPath, p.path, p.content ?? ''); return { ok: true }; }
    if (p.op === 'run') {
      if (typeof p.command !== 'string' || !p.command.trim()) return { ok: false, error: 'no command' };
      return { ok: true, run: await runRepoCommand(p.repoPath, p.command, p.timeoutMs) };
    }
    return { ok: false, error: `unknown op "${p.op}"` };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}
