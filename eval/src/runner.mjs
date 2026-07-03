// Task runner: copy a task fixture to an isolated temp dir, drive the Gridlight
// terminal headlessly against it, then evaluate the task's assertions against
// the resulting end-state.
//
// Gridlight is a black box here — we spawn the `gridlight` binary (env
// GRIDLIGHT_BIN) with `-p "<prompt>" --cwd <tmp>` and configure the model via
// env, exactly as `packages/cli/src/bin/gridlight.ts` documents. Zero Gridlight
// source is imported.

import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Tracked so a SIGINT/SIGTERM handler (see cli.mjs) can kill in-flight children
// and remove temp dirs that would otherwise leak — `finally` doesn't run on a
// signal-driven exit.
export const activeWorkDirs = new Set();
export const activeChildren = new Set();

/** Kill any in-flight child (process group) and remove any leaked temp dir. */
export function emergencyCleanup() {
  for (const child of activeChildren) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
  for (const dir of activeWorkDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Env allowlist: the model runs under auto-approve, so it must NOT inherit the
// developer's third-party secrets (ANTHROPIC/OPENAI/AWS/GITHUB tokens, etc.).
// Pass only what the CLI/Node need, plus Gridlight's own non-secret config,
// then the explicit per-run overrides.
function scrubbedEnv(overrides) {
  const allow = new Set([
    'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'USER', 'LOGNAME', 'SHELL', 'TERM', 'NODE', 'NVM_DIR',
    'http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ]);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allow.has(k) || k.startsWith('GRIDLIGHT_')) env[k] = v;
  }
  return { ...env, ...overrides };
}

/**
 * @typedef {Object} RunEnv
 * @property {string} gridlightBin  binary to spawn (default "gridlight")
 * @property {string} model         GRIDLIGHT_MODEL
 * @property {string} gatewayUrl    GRIDLIGHT_GATEWAY_URL
 * @property {string} backendMode   GRIDLIGHT_BACKEND_MODE (default openai-compatible)
 * @property {boolean} neoncore     report to NeonCore during the run (default false = hermetic)
 */

/**
 * Run one task once and score it.
 * @param {import('./loadTasks.mjs').Task} task
 * @param {RunEnv} runEnv
 * @returns {Promise<{id:string, class:string, pass:boolean, checks:any[], durationMs:number, error:string|null, exitCode:number|null}>}
 */
export async function runTask(task, runEnv) {
  const work = await mkdtemp(path.join(tmpdir(), `parity-${task.id}-`));
  activeWorkDirs.add(work);
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let error = null;
  let child = null;
  const fail = (checks) => ({ id: task.id, class: task.class, pass: false, checks, durationMs: Date.now() - started, error, exitCode });
  try {
    // Fresh copy of the fixture — never run against the repo, never let one
    // task's writes leak into the next.
    await cp(task.fixtureDir, work, { recursive: true });

    // detached so we can kill the WHOLE process group on timeout — the model's
    // auto-approve bash may have spawned grandchildren that a single kill misses.
    child = spawn(runEnv.gridlightBin || 'gridlight', ['-p', task.prompt, '--cwd', work], {
      cwd: work,
      detached: true,
      env: scrubbedEnv({
        GRIDLIGHT_MODEL: runEnv.model,
        GRIDLIGHT_GATEWAY_URL: runEnv.gatewayUrl,
        GRIDLIGHT_BACKEND_MODE: runEnv.backendMode || 'gridlight',
        GRIDLIGHT_PERMISSION_MODE: 'auto', // never block on approvals headlessly
        GRIDLIGHT_TUI: '0', // force the plain, capturable path (never the Ink TUI)
        GRIDLIGHT_NEONCORE_ENABLED: runEnv.neoncore ? 'true' : 'false',
      }),
    });
    activeChildren.add(child);

    exitCode = await new Promise((resolve) => {
      let settled = false;
      let hardTimer;
      const done = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        if (hardTimer) clearTimeout(hardTimer);
        resolve(code);
      };
      const killer = setTimeout(() => {
        error = `timed out after ${task.timeoutMs}ms`;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
        // Do NOT resolve yet — wait for 'close' so we don't assert/rm against a
        // still-dying child. Secondary cap in case a leaked pipe stops 'close'.
        hardTimer = setTimeout(() => done(null), 5000);
      }, task.timeoutMs);
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => { error = error || String(e?.message || e); done(null); });
      child.on('close', (code) => done(code));
    });
    activeChildren.delete(child);

    // A run that errored, timed out, or self-reported failure is a hard fail —
    // never let a partial end-state or incidental output score it as a pass,
    // and never execute model-written code (assert verify commands) on a
    // failed/killed run.
    if (error !== null || exitCode !== 0) {
      return fail([{ name: 'run', pass: false, detail: error || `gridlight exited ${exitCode}` }]);
    }

    // Clean run — evaluate the task's assertions against the end-state.
    const assertMod = await import(pathToFileURL(task.assertPath).href);
    const assertFn = assertMod.assert || assertMod.default;
    if (typeof assertFn !== 'function') {
      throw new Error(`task ${task.id}: assert.mjs must export an "assert" function`);
    }
    const { pass, checks } = await assertFn({ cwd: work, stdout, stderr, exitCode });
    return { id: task.id, class: task.class, pass: Boolean(pass), checks: checks || [], durationMs: Date.now() - started, error, exitCode };
  } catch (err) {
    return fail([{ name: 'harness', pass: false, detail: String(err?.message || err) }]);
  } finally {
    if (child) activeChildren.delete(child);
    await rm(work, { recursive: true, force: true });
    activeWorkDirs.delete(work);
  }
}

/**
 * Run a task k times (pass@k) for a variance-aware verdict — even at temp 0
 * local models wobble, so a single run misranks models near a threshold.
 * @returns {Promise<{id:string, class:string, runs:any[], passes:number, k:number, passRate:number}>}
 */
export async function runTaskK(task, runEnv, k = 3) {
  const runs = [];
  for (let i = 0; i < k; i++) {
    runs.push(await runTask(task, runEnv));
  }
  const passes = runs.filter((r) => r.pass).length;
  return { id: task.id, class: task.class, runs, passes, k, passRate: passes / k };
}
