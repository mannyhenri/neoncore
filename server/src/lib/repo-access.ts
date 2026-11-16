/**
 * REPO ACCESS — NeonCore touching a repo ITSELF: read files, write one file, run one command.
 *
 * Everything else in NeonCore reaches a repo through an agent. The acceptance contract
 * (lib/acceptance-contract.ts) cannot: its whole point is that "the tests pass" is established by
 * NeonCore running them, and "the tests were not changed" by NeonCore hashing them — not by an
 * agent saying so. So this module gives the server exactly three verbs, and nothing more.
 *
 * ── WHERE THE REPO IS ──────────────────────────────────────────────────────────────────
 * A repo on this server's disk (the cartridge that runs there reports this host as its machine —
 * lib/machine-locality.ts) is handled here directly. A repo on another machine is handled by that
 * machine's RUNNER (agent/runner/repo-ops.js), over its socket, with an ack — the same point-to-
 * point channel "+ Launch" uses. The two implementations apply the same rules: paths stay inside
 * the repo, output is capped to its tail, a command that outruns its timeout is killed with its
 * process group, NEONCORE_* variables (tokens) are not passed to the command.
 *
 * `NEONCORE_REPO_ACCESS=runner` forces the runner path even for a local repo — the sandbox check
 * uses it so the remote path is exercised end to end on one machine.
 *
 * ── WHAT MAY BE RUN ────────────────────────────────────────────────────────────────────
 * Only commands a PERSON has seen: a criterion's test command runs when the person clicks "Run
 * them now" or "Approve & lock" on the acceptance review, and after that only the LOCKED commands
 * run (after each stage). Nothing an agent submits is executed on its say-so alone.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import db from '../db.js';
import { isLocalMachine, normalizeHostname, machineLabel } from './machine-locality.js';
import { normalizeRepoPath } from './resolve-agent.js';
import type { RepoOpRequest, RepoOpResult } from '../types.js';

export const READ_MAX_BYTES = 256 * 1024;
export const OUTPUT_MAX_CHARS = 8000;
export const RUN_TIMEOUT_MAX_MS = 30 * 60_000;
const CAPTURE_MAX_CHARS = 512 * 1024;

/** Default per-command limit for an acceptance check. */
export function checkTimeoutMs(): number {
  const v = Number(process.env.NEONCORE_ACCEPTANCE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, RUN_TIMEOUT_MAX_MS) : 5 * 60_000;
}

export interface FileRead { path: string; exists: boolean; content: string; sha256: string; bytes: number; error?: string }
export interface CommandRun { exitCode: number | null; timedOut: boolean; output: string; durationMs: number }

export interface RepoAccess {
  where: 'local' | 'remote';
  /** "this machine" or the other machine's name — for messages. */
  label: string;
  readFiles(paths: string[]): Promise<FileRead[]>;
  writeFile(relPath: string, content: string): Promise<void>;
  run(command: string, timeoutMs?: number): Promise<CommandRun>;
}

export class RepoAccessError extends Error {}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical repo-relative path (forward slashes), or null for absolute / `..` / empty. */
export function safeRelPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const raw = p.trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.includes('\0')) return null;
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** Absolute path for a repo-relative one, or null when it would land outside the repo (symlinks included). */
export function resolveInRepo(repoPath: string, rel: string): string | null {
  const safe = safeRelPath(rel);
  if (!safe) return null;
  const root = path.resolve(repoPath).replace(/[\\/]+$/, '');
  const abs = path.resolve(root, safe);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
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

export function checkEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // NEONCORE_* carry tokens. NODE_TEST_CONTEXT is node's test-runner plumbing: inherited, it makes a
  // nested `node --test` report to a parent that is not there instead of exiting non-zero.
  for (const [k, v] of Object.entries(base)) if (!/^NEONCORE_/i.test(k) && k !== 'NODE_TEST_CONTEXT') env[k] = v;
  env.CI = '1';
  return env;
}

// ── local ─────────────────────────────────────────────────────────────────────

function readLocal(repoPath: string, paths: string[]): FileRead[] {
  return paths.map((p) => {
    const rel = safeRelPath(p) ?? String(p);
    const abs = resolveInRepo(repoPath, p);
    const none = { path: rel, exists: false, content: '', sha256: '', bytes: 0 };
    if (!abs) return { ...none, error: 'not a path inside the repo' };
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return { ...none, error: 'not a file' };
      if (st.size > READ_MAX_BYTES) return { ...none, exists: true, bytes: st.size, error: `larger than ${READ_MAX_BYTES} bytes` };
      const content = fs.readFileSync(abs, 'utf8');
      return { path: rel, exists: true, content, sha256: sha256(content), bytes: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return none;
      return { ...none, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function killTree(pid: number | undefined, child: { kill: (s: NodeJS.Signals) => boolean }): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(-pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

export function runLocal(repoPath: string, command: string, timeoutMs = checkTimeoutMs()): Promise<CommandRun> {
  const limit = Math.max(1000, Math.min(timeoutMs, RUN_TIMEOUT_MAX_MS));
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const text = `${out}${extra}`.trim();
      resolve({
        exitCode, timedOut, durationMs: Date.now() - started,
        output: text.length > OUTPUT_MAX_CHARS ? `…${text.slice(-(OUTPUT_MAX_CHARS - 1))}` : text,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd: repoPath, shell: true, env: checkEnv(), detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err) {
      finish(null, `could not start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const take = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > CAPTURE_MAX_CHARS) out = out.slice(-CAPTURE_MAX_CHARS / 2);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    timer = setTimeout(() => { timedOut = true; killTree(child.pid, child); }, limit);
    child.on('error', (err) => finish(null, `\n${err.message}`));
    child.on('close', (code) => finish(timedOut ? null : code, timedOut ? `\n(timed out after ${Math.round(limit / 1000)}s — killed)` : ''));
  });
}

export function localRepoAccess(repoPath: string): RepoAccess {
  return {
    where: 'local',
    label: 'this machine',
    async readFiles(paths) {
      if (!fs.existsSync(repoPath)) throw new RepoAccessError(`${repoPath} does not exist on this machine`);
      return readLocal(repoPath, paths);
    },
    async writeFile(rel, content) {
      const abs = resolveInRepo(repoPath, rel);
      if (!abs) throw new RepoAccessError(`"${rel}" is not a path inside the repo`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    async run(command, timeoutMs) {
      if (!fs.existsSync(repoPath)) throw new RepoAccessError(`${repoPath} does not exist on this machine`);
      return runLocal(repoPath, command, timeoutMs);
    },
  };
}

// ── remote (through the machine's runner) ───────────────────────────────────────

export type MachineCall = (machineId: string, request: RepoOpRequest, timeoutMs: number) => Promise<RepoOpResult>;

export function remoteRepoAccess(machineId: string, label: string, repoPath: string, call: MachineCall): RepoAccess {
  const ask = async (req: RepoOpRequest, timeoutMs: number): Promise<RepoOpResult> => {
    const res = await call(machineId, req, timeoutMs);
    if (!res || !res.ok) throw new RepoAccessError(`${label}: ${res?.error || 'the runner did not answer'}`);
    return res;
  };
  return {
    where: 'remote',
    label,
    async readFiles(paths) {
      const res = await ask({ machineId, repoPath, op: 'read', paths }, 60_000);
      return res.files ?? [];
    },
    async writeFile(rel, content) {
      if (!safeRelPath(rel)) throw new RepoAccessError(`"${rel}" is not a path inside the repo`);
      await ask({ machineId, repoPath, op: 'write', path: rel, content }, 60_000);
    },
    async run(command, timeoutMs = checkTimeoutMs()) {
      // The socket waits a little longer than the command may run, so the runner's own timeout
      // (which kills the process) is what ends a slow check, not a dropped ack.
      const res = await ask({ machineId, repoPath, op: 'run', command, timeoutMs }, timeoutMs + 30_000);
      return res.run ?? { exitCode: null, timedOut: false, output: 'the runner returned no result', durationMs: 0 };
    },
  };
}

// ── which one ─────────────────────────────────────────────────────────────────

let callMachine: MachineCall | null = null;
/** Wired by ws.ts at startup (keeps this module free of Socket.IO). */
export function setMachineCall(fn: MachineCall | null): void { callMachine = fn; }

let override: ((repoPath: string) => RepoAccess) | null = null;
/** TEST ONLY — replace the resolution with a stand-in (a fake runner, a recording spy). */
export function setRepoAccessForTests(fn: ((repoPath: string) => RepoAccess) | null): void { override = fn; }

/** The machine a repo lives on, from the cartridges NeonCore has seen there ('' = unknown). */
function machineOfRepo(repoPath: string): string {
  const want = normalizeRepoPath(repoPath);
  const rows = db.prepare(`SELECT repo_path, machine FROM agents WHERE repo_path != '' ORDER BY last_seen DESC`).all() as
    { repo_path: string; machine: string | null }[];
  return rows.find((r) => normalizeRepoPath(r.repo_path) === want)?.machine ?? '';
}

function machineIdForHost(host: string, repoPath: string): string | null {
  const rows = db.prepare('SELECT id, hostname, repos FROM machines ORDER BY last_seen DESC').all() as
    { id: string; hostname: string; repos: string }[];
  const want = normalizeRepoPath(repoPath);
  const holdsRepo = (r: { repos: string }) => {
    try { return (JSON.parse(r.repos || '[]') as { path?: string }[]).some((x) => normalizeRepoPath(x.path ?? '') === want); } catch { return false; }
  };
  const byHost = rows.filter((r) => normalizeHostname(r.hostname) === normalizeHostname(host));
  return (byHost.find(holdsRepo) ?? byHost[0] ?? rows.find(holdsRepo))?.id ?? null;
}

/**
 * How to reach this repo. Throws RepoAccessError with a sentence the person can act on when it
 * cannot be reached at all (its machine has no runner connected).
 */
export function repoAccessFor(repoPath: string): RepoAccess {
  if (override) return override(repoPath);
  const host = machineOfRepo(repoPath);
  const local = isLocalMachine(host);
  if (local && process.env.NEONCORE_REPO_ACCESS !== 'runner') return localRepoAccess(repoPath);
  const machineId = machineIdForHost(local ? os.hostname() : host, repoPath);
  const where = local ? 'this machine' : machineLabel(host);
  if (!machineId || !callMachine) {
    throw new RepoAccessError(`${path.basename(repoPath)} is on ${where}, which has no NeonCore runner connected — start the runner there (agent/runner) so NeonCore can check the tests.`);
  }
  return remoteRepoAccess(machineId, `${where} (runner)`, repoPath, callMachine);
}
