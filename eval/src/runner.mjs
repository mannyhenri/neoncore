// Task runner: copy a task fixture to an isolated temp dir, drive the Gridlight
// terminal headlessly against it, then evaluate the task's assertions against
// the resulting end-state.
//
// Gridlight is a black box here — we spawn the `gridlight` binary (env
// GRIDLIGHT_BIN) with `-p "<prompt>" --cwd <tmp>` and configure the model via
// env, exactly as `packages/cli/src/bin/gridlight.ts` documents. Zero Gridlight
// source is imported, satisfying the "no new agent code in Gridlight" criterion.

import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
 * @returns {Promise<{id:string, class:string, pass:boolean, checks:any[], durationMs:number, error:string|null, stdout:string, exitCode:number|null}>}
 */
export async function runTask(task, runEnv) {
  const work = await mkdtemp(path.join(tmpdir(), `parity-${task.id}-`));
  const started = Date.now();
  let stdout = '';
  let exitCode = null;
  let error = null;
  try {
    // Fresh copy of the fixture — never run against the repo, never let one
    // task's writes leak into the next.
    await cp(task.fixtureDir, work, { recursive: true });

    const child = spawn(runEnv.gridlightBin || 'gridlight', ['-p', task.prompt, '--cwd', work], {
      cwd: work,
      env: {
        ...process.env,
        GRIDLIGHT_MODEL: runEnv.model,
        GRIDLIGHT_GATEWAY_URL: runEnv.gatewayUrl,
        GRIDLIGHT_BACKEND_MODE: runEnv.backendMode || 'openai-compatible',
        GRIDLIGHT_PERMISSION_MODE: 'auto', // never block on approvals headlessly
        GRIDLIGHT_TUI: '0', // force the plain, capturable path (never the Ink TUI)
        GRIDLIGHT_NEONCORE_ENABLED: runEnv.neoncore ? 'true' : 'false',
      },
    });

    exitCode = await new Promise((resolve) => {
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        error = `timed out after ${task.timeoutMs}ms`;
        resolve(null);
      }, task.timeoutMs);
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stdout += d.toString(); });
      child.on('error', (e) => { error = String(e?.message || e); clearTimeout(killer); resolve(null); });
      child.on('close', (code) => { clearTimeout(killer); resolve(code); });
    });

    // Evaluate the task's own assertions against the end-state.
    const assertMod = await import(pathToFileURL(task.assertPath).href);
    const assertFn = assertMod.assert || assertMod.default;
    if (typeof assertFn !== 'function') {
      throw new Error(`task ${task.id}: assert.mjs must export an "assert" function`);
    }
    const { pass, checks } = await assertFn({ cwd: work, stdout, exitCode });
    return { id: task.id, class: task.class, pass: Boolean(pass), checks: checks || [], durationMs: Date.now() - started, error, stdout, exitCode };
  } catch (err) {
    return { id: task.id, class: task.class, pass: false, checks: [], durationMs: Date.now() - started, error: String(err?.message || err), stdout, exitCode };
  } finally {
    await rm(work, { recursive: true, force: true });
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
