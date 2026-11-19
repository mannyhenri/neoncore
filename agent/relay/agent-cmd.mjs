/**
 * Find the agent CLI the relay is about to spawn.
 *
 * WHY THIS EXISTS. The relay used to hand a bare `claude` to node-pty and trust PATH. A cartridge
 * terminal gets PATH from a fresh login shell, and that PATH moves under you: on 2026-11-19 a
 * newer nvm node became the default, `claude` lived in the OLD version's global bin, and every
 * launch from the dashboard died ~20 ms after start. node-pty reports a missing binary as a
 * plain exit code 1, `log()` writes only to ~/.neoncore/relay.log, so the terminal showed
 * nothing but "Launching NeonCore relay..." and the dashboard showed a cartridge with no command
 * channel. Shells already open still had the old PATH, so it "worked in my terminal".
 *
 * So: PATH first (what the person configured wins), then the places agent CLIs are actually
 * installed, including every nvm node version's bin. Null means it is nowhere — the caller
 * says so out loud instead of spawning into a silent exit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Compare `v22.15.1`-style directory names, newest first. Non-versions sort last. */
function byVersionDesc(a, b) {
  const parse = (s) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(s) || []).slice(1).map(Number);
  const va = parse(a);
  const vb = parse(b);
  if (!va.length || !vb.length) return vb.length - va.length;
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
  return 0;
}

/** The install locations searched after PATH, in order. */
export function fallbackDirs({ home = os.homedir(), env = process.env } = {}) {
  const dirs = [
    path.join(home, '.local', 'bin'),          // Claude Code native installer
    path.join(home, '.claude', 'local'),       // Claude Code legacy local install
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const nvmDir = env.NVM_DIR || path.join(home, '.nvm');
  try {
    const versions = fs.readdirSync(path.join(nvmDir, 'versions', 'node')).sort(byVersionDesc);
    for (const v of versions) dirs.push(path.join(nvmDir, 'versions', 'node', v, 'bin'));
  } catch { /* no nvm */ }
  return dirs;
}

/**
 * @returns {{ path: string, via: 'explicit' | 'path' | 'fallback' } | null}
 *   `via: 'fallback'` means PATH did not have it — worth a log line, because the person's
 *   shell is broken in a way they will hit outside NeonCore too.
 */
export function resolveAgentCommand(cmd, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (!cmd) return null;
  // Windows: `claude.cmd` resolution goes through PATHEXT and cmd.exe; leave it to the OS
  // rather than half-reimplement it here.
  if (platform === 'win32') return { path: cmd, via: 'path' };

  if (cmd.includes('/')) return isExecutableFile(cmd) ? { path: cmd, via: 'explicit' } : null;

  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (isExecutableFile(p)) return { path: p, via: 'path' };
  }
  for (const dir of fallbackDirs({ home, env })) {
    const p = path.join(dir, cmd);
    if (isExecutableFile(p)) return { path: p, via: 'fallback' };
  }
  return null;
}
