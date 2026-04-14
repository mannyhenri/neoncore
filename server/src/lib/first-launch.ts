/**
 * First-launch hook installer.
 *
 * On the very first time NeonCore starts (detected via a sentinel file in the
 * user's home directory), automatically installs the Claude Code hooks for the
 * local machine.  Subsequent starts are a no-op.
 *
 * This runs as a background task after the server is already listening, so a
 * slow Python environment never delays startup.
 */

import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sentinel lives in the home directory so it's per-user and survives app updates
const SENTINEL = join(homedir(), '.neoncore-hooks-installed');

// Resolve the agent installer relative to this file's location:
// server/src/lib/first-launch.ts → ../../.. → repo root → agent/install.py
const INSTALLER = join(__dirname, '..', '..', '..', 'agent', 'install.py');

function tryInstall(python: string, url: string): boolean {
  try {
    execFileSync(python, [INSTALLER, '--url', url], {
      timeout: 30_000,
      env: { ...process.env, NEONCORE_URL: url },
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export function runFirstLaunchSetup(port: number): void {
  if (existsSync(SENTINEL)) return;

  // Run after the current event-loop tick so it never delays the startup banner
  setImmediate(() => {
    if (!existsSync(INSTALLER)) {
      console.warn('[setup] Hook installer not found — skipping first-launch setup');
      return;
    }

    const url = `http://localhost:${port}`;
    console.log(`[setup] First launch — installing Claude Code hooks (${url})...`);

    const ok = tryInstall('python3', url) || tryInstall('python', url);
    if (ok) {
      writeFileSync(SENTINEL, new Date().toISOString(), 'utf-8');
      console.log('[setup] Hooks installed successfully');
    } else {
      console.warn(
        '[setup] Hook auto-install failed — run manually:',
        `NEONCORE_URL=${url} python3 agent/install.py`,
      );
    }
  });
}

/**
 * Reset the sentinel so the next startup re-runs hook installation.
 * Called by the reinstall-hooks API endpoint so users can trigger it from the dashboard.
 */
export function resetFirstLaunchSentinel(): void {
  try {
    if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
  } catch { /* non-fatal */ }
}
