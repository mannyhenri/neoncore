/**
 * REPLAYING A CACHED TEST — no AI. NeonCore spawns the runner (packages/qa-runner, Playwright)
 * with a spec file and reads one JSON object from its stdout (docs/plans/qa-section.md).
 *
 * Injectable (setQaRunner) so the engine's tests drive every run kind without a browser.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RunnerResult, RunnerSpec } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** server/src/lib/qa or server/dist/lib/qa → the repo root. */
export const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');
export const RUNNER_CLI = path.join(REPO_ROOT, 'packages', 'qa-runner', 'cli.mjs');

/** Where runs keep their evidence: NEONCORE_QA_DIR, else ~/.neoncore/qa. */
export function qaDataDir(): string {
  return process.env.NEONCORE_QA_DIR || path.join(os.homedir(), '.neoncore', 'qa');
}
export function runDir(runId: string): string {
  return path.join(qaDataDir(), 'runs', runId);
}

export type QaRunner = (spec: RunnerSpec, outDir: string) => Promise<RunnerResult>;

const blocked = (error: string): RunnerResult => ({ status: 'blocked', steps: [], console: [], network: [], trace: '', durationMs: 0, error });

export const spawnRunner: QaRunner = async (spec, outDir) => {
  fs.mkdirSync(outDir, { recursive: true });
  const specFile = path.join(outDir, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
  if (!fs.existsSync(RUNNER_CLI)) return blocked(`the QA runner is not installed (${RUNNER_CLI})`);
  const timeoutMs = Math.max(1, spec.budget?.minutes ?? 15) * 60_000 + 30_000;
  return await new Promise<RunnerResult>((resolve) => {
    const child = spawn(process.execPath, [RUNNER_CLI, 'run', '--spec', specFile, '--out', outDir], { cwd: REPO_ROOT, env: process.env });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve(blocked(`the runner could not start: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        // The runner prints ONE JSON object, pretty-printed over many lines; a stray log line
        // before it must not cost the result, so fall back to the last {…} block.
        const text = out.trim();
        let parsed: RunnerResult;
        try { parsed = JSON.parse(text) as RunnerResult; } catch { parsed = JSON.parse(text.slice(text.lastIndexOf('\n{') + 1)) as RunnerResult; }
        resolve({ ...parsed, steps: parsed.steps ?? [], console: parsed.console ?? [], network: parsed.network ?? [] });
      } catch {
        resolve(blocked(`the runner exited ${code} without a result${err ? `: ${err.trim().slice(-500)}` : ''}`));
      }
    });
  });
};

let current: QaRunner = spawnRunner;
export function setQaRunner(r: QaRunner | null): void { current = r ?? spawnRunner; }
export function qaRunner(): QaRunner { return current; }
