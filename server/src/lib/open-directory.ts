/**
 * Shared utilities for opening a directory in VS Code, Cursor, or a CLI terminal.
 * Used by both repos.ts and virtual-cartridges.ts.
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Binary finders
// ---------------------------------------------------------------------------

function findBinary(candidates: string[], shellCmd: string): string | null {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const resolved = execSync(shellCmd, { timeout: 3000 }).toString().trim().split('\n')[0];
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch { /* ignore */ }
  return null;
}

export function findCodeBinary(): string {
  const isWin = process.platform === 'win32';
  const home = os.homedir();
  const candidates = isWin
    ? [
        path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
        path.join('C:', 'Program Files', 'Microsoft VS Code', 'bin', 'code.cmd'),
      ]
    : [
        '/usr/local/bin/code',
        '/opt/homebrew/bin/code',
        path.join(home, '.local', 'bin', 'code'),
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      ];
  return findBinary(candidates, process.platform === 'win32' ? 'where code' : 'bash -lc "which code"')
    ?? (isWin ? 'code.cmd' : 'code');
}

export function findCursorBinary(): string | null {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe'),
        path.join('C:', 'Program Files', 'Cursor', 'Cursor.exe'),
      ]
    : [
        '/usr/local/bin/cursor',
        '/opt/homebrew/bin/cursor',
        '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
        path.join(home, 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app', 'bin', 'cursor'),
      ];
  return findBinary(candidates, process.platform === 'win32' ? 'where cursor' : 'bash -lc "which cursor"');
}

export function findCliBinary(name: string): string | null {
  const home = os.homedir();
  const candidates = [
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    path.join(home, '.local', 'bin', name),
    path.join(home, '.npm-global', 'bin', name),
    path.join(home, 'node_modules', '.bin', name),
  ];
  const shellCmd = process.platform === 'win32' ? `where ${name}` : `bash -lc "which ${name}"`;
  return findBinary(candidates, shellCmd);
}

// ---------------------------------------------------------------------------
// VS Code settings writer
// ---------------------------------------------------------------------------

export function writeVscodeSettings(repoPath: string, agentType: string): void {
  const vscodeDir = path.join(repoPath, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');
  try {
    if (!fs.existsSync(vscodeDir)) fs.mkdirSync(vscodeDir, { recursive: true });
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* overwrite */ }
    }
    settings['neoncore.agentType'] = agentType;
    if (agentType === 'gridlight') {
      settings['gridlight.neoncore.enabled'] = true;
      settings['gridlight.neoncore.serverUrl'] = `http://localhost:${process.env.PORT || 4040}`;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Terminal launcher
// ---------------------------------------------------------------------------

/**
 * Write a temporary shell script and open it in a terminal window.
 * Returns an error string on failure, null on success.
 */
export function openInTerminal(repoPath: string, command: string, sessionId: string): string | null {
  const neonUrl = `http://localhost:${process.env.PORT || 4040}`;

  // Windows: emit a native .cmd batch script and run it via cmd.exe. (A bash .sh
  // launched through `cmd /k` cannot execute — this is what broke Windows launch.)
  if (process.platform === 'win32') {
    const scriptPath = path.join(os.tmpdir(), `neoncore-launch-${Date.now()}.cmd`);
    // Do NOT JSON.stringify Windows paths — cmd treats backslashes literally, so
    // doubled backslashes would corrupt the path. Plain double-quotes suffice.
    fs.writeFileSync(scriptPath, [
      '@echo off',
      `cd /d "${repoPath}"`,
      `set "NEONCORE_URL=${neonUrl}"`,
      `set "NEONCORE_SESSION_ID=${sessionId}"`,
      command,
    ].join('\r\n') + '\r\n');

    setTimeout(() => { try { fs.unlinkSync(scriptPath); } catch { /* ignore */ } }, 60_000);

    try {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', scriptPath], {
        detached: true, stdio: 'ignore',
      }).unref();
      return null;
    } catch (err) {
      return `Failed to open terminal: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // POSIX (macOS / Linux): bash script that sources rc files for PATH, then runs.
  const scriptPath = path.join(os.tmpdir(), `neoncore-launch-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    `cd ${JSON.stringify(repoPath)}`,
    `export NEONCORE_URL=${JSON.stringify(neonUrl)}`,
    `export NEONCORE_SESSION_ID=${JSON.stringify(sessionId)}`,
    '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null',
    '[ -f "$HOME/.zshrc"  ] && source "$HOME/.zshrc"  2>/dev/null',
    '[ -f "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null',
    command,
  ].join('\n') + '\n');
  fs.chmodSync(scriptPath, '755');

  setTimeout(() => { try { fs.unlinkSync(scriptPath); } catch { /* ignore */ } }, 60_000);

  if (process.platform === 'darwin') {
    let iterm2Running = false;
    try { execSync('pgrep -x iTerm2', { stdio: 'ignore', timeout: 1000 }); iterm2Running = true; } catch { /* no */ }

    if (iterm2Running) {
      try {
        execSync(
          `osascript` +
          ` -e 'tell application "iTerm2"'` +
          ` -e 'set w to (create window with default profile)'` +
          ` -e 'tell current session of w'` +
          ` -e 'write text ${JSON.stringify(scriptPath)}'` +
          ` -e 'end tell'` +
          ` -e 'end tell'`,
          { timeout: 8000 }
        );
        return null;
      } catch { /* fall through to Terminal.app */ }
    }

    try {
      execSync(
        `osascript` +
        ` -e 'tell application "Terminal"'` +
        ` -e 'do script ${JSON.stringify(scriptPath)}'` +
        ` -e 'activate'` +
        ` -e 'end tell'`,
        { timeout: 8000 }
      );
      return null;
    } catch (err) {
      return `Failed to open Terminal.app: ${err instanceof Error ? err.message : String(err)}`;
    }

  } else if (process.platform === 'linux') {
    const terminals: [string, string[]][] = [
      ['gnome-terminal', ['--', 'bash', scriptPath]],
      ['xfce4-terminal', ['--command', `bash ${scriptPath}`]],
      ['konsole', ['--noclose', '-e', `bash ${scriptPath}`]],
      ['xterm', ['-e', `bash ${scriptPath}`]],
    ];
    for (const [term, args] of terminals) {
      try {
        execSync(`which ${term}`, { stdio: 'ignore', timeout: 1000 });
        spawn(term, args, { detached: true, stdio: 'ignore' }).unref();
        return null;
      } catch { /* try next */ }
    }
    return 'No terminal emulator found (tried gnome-terminal, xfce4-terminal, konsole, xterm)';
  }

  // win32 is handled at the top of this function (native .cmd path).
  return 'Unsupported platform';
}

// ---------------------------------------------------------------------------
// CLI agent registration
// ---------------------------------------------------------------------------

/**
 * Register a CLI agent directly via the local API so the cartridge appears
 * in NeonCore immediately when the terminal opens, without waiting for a hook.
 */
export function registerCliAgent(repoPath: string, agentType: string, sessionId: string): void {
  const port = process.env.PORT || 4040;
  const body = JSON.stringify({
    machine: os.hostname(),
    repoPath,
    repoName: path.basename(repoPath),
    agentType,
    status: 'idle',
    sessionId,
  });
  try {
    const req = http.request({
      hostname: 'localhost',
      port: Number(port),
      path: '/api/agents/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => { /* fire-and-forget */ });
    req.write(body);
    req.end();
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Open directory in VS Code / Cursor / CLI terminal
// ---------------------------------------------------------------------------

export const CLI_COMMANDS: Record<string, string> = {
  gemini:  'gemini',
  amazonq: 'q chat',
};

let _codeBin: string | null = null;

/**
 * NeonCore repo root, resolved from this module's location so it works both in
 * dev (server/src/lib via tsx) and in the build (server/dist/lib) — three levels
 * up lands on the repo root in either case.
 */
function neoncoreRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * Build the command that boots a bare-terminal Claude Code session wired into
 * NeonCore via the agent relay — the terminal equivalent of "open in VS Code".
 *
 * All setup (dep install, hook install, relay launch) lives in the relay's
 * cross-platform Node bootstrap (agent/relay/launch.js), so this is a single
 * `node "<path>"` invocation that runs verbatim in both bash and cmd.exe. The
 * bootstrap launches the relay in the terminal's cwd (the cartridge directory),
 * so the agent registers against the right repo.
 */
function buildRelayLaunchCommand(): string {
  const launchEntry = path.join(neoncoreRepoRoot(), 'agent', 'relay', 'launch.js');
  // Plain double-quotes are valid in both POSIX shells and cmd.exe; do NOT use
  // JSON.stringify here — it would double Windows backslashes, which cmd treats
  // literally and would break the path.
  return `node "${launchEntry}"`;
}

/**
 * Open a directory with the specified agent type.
 * Returns an error string on failure, null on success.
 */
export function openDirectory(dirPath: string, agentType: string): string | null {
  if (!fs.existsSync(dirPath)) return 'Path does not exist';

  // Claude Code in a plain terminal (no VS Code) via the agent relay.
  // The relay self-registers and opens the addressed socket, so we don't
  // pre-register here (that would just churn the agent's session id).
  if (agentType === 'claude-terminal' || agentType === 'claude-cli') {
    const sessionId = `neoncore-claude-${Date.now()}`;
    return openInTerminal(dirPath, buildRelayLaunchCommand(), sessionId);
  }

  // CLI tools
  if (agentType in CLI_COMMANDS) {
    const sessionId = `neoncore-${agentType}-${Date.now()}`;
    const err = openInTerminal(dirPath, CLI_COMMANDS[agentType], sessionId);
    if (err) return err;
    registerCliAgent(dirPath, agentType, sessionId);
    return null;
  }

  // Cursor
  if (agentType === 'cursor') {
    const cursorBin = findCursorBinary();
    if (!cursorBin) return 'Cursor not found. Is Cursor installed?';
    writeVscodeSettings(dirPath, 'cursor');
    try {
      execSync(`"${cursorBin}" "${dirPath}"`, { timeout: 5000 });
      return null;
    } catch {
      return 'Failed to open Cursor';
    }
  }

  // VS Code-based tools (claude, gridlight, codex)
  const resolvedType = agentType === 'gridlight' ? 'gridlight'
    : agentType === 'codex' ? 'codex'
    : 'claude';
  writeVscodeSettings(dirPath, resolvedType);

  if (!_codeBin) _codeBin = findCodeBinary();

  try {
    execSync(`"${_codeBin}" "${dirPath}"`, { timeout: 5000 });
    return null;
  } catch {
    if (process.platform === 'darwin') {
      try {
        execSync(`open -a "Visual Studio Code" "${dirPath}"`, { timeout: 5000 });
        return null;
      } catch { /* fall through */ }
    } else if (process.platform === 'win32') {
      try {
        execSync(`start "" "Code" "${dirPath}"`, { timeout: 5000, shell: 'cmd.exe' });
        return null;
      } catch { /* fall through */ }
    }
    return 'Failed to open VS Code. Is the "code" CLI installed?';
  }
}
