/**
 * Shared utilities for opening a directory in VS Code, Cursor, or a CLI terminal.
 * Used by both repos.ts and virtual-cartridges.ts.
 */

import fs from 'fs';
import { getFleetToken } from './auth.js';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { getServerBaseUrl } from './server-url.js';

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
      settings['gridlight.neoncore.serverUrl'] = getServerBaseUrl();
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
export function openInTerminal(repoPath: string, command: string, sessionId: string, extraEnv: Record<string, string> = {}): string | null {
  const neonUrl = getServerBaseUrl();
  const winExtraEnv = Object.entries(extraEnv).map(([k, v]) => `set "${k}=${v}"`);
  const posixExtraEnv = Object.entries(extraEnv).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`);

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
      ...winExtraEnv,
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
    ...posixExtraEnv,
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
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        // Registers a cartridge exactly once per new repo — rare enough that it would have
        // sat unnoticed between appearances and 401'd the first launch after strict.
        ...(getFleetToken() ? { Authorization: `Bearer ${getFleetToken()}` } : {}),
      },
    });
    req.on('error', () => { /* fire-and-forget */ });
    req.write(body);
    req.end();
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Open directory in VS Code / Cursor / CLI terminal
// ---------------------------------------------------------------------------

// Every entry here named an engine that is no longer supported. Kept as an empty map rather
// than deleted so the terminal-launch branch stays intact for a future CLI engine.
export const CLI_COMMANDS: Record<string, string> = {};

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
 * Keep the terminal relay runnable from a stable user-space path that does not
 * include broad process-match words like "agent". Some external cleanup scripts
 * use `pkill -f agent`; launching from the repo path would match
 * `<repo>/agent/relay/...` and tear down unrelated NeonCore terminals.
 */
function relayInstallDir(): string {
  return path.join(os.homedir(), '.neoncore', 'relay');
}

/**
 * What `ensureRelayInstall` copies into ~/.neoncore/relay. The set-based test parses the relay's
 * own `import` statements and fails if it imports something this list does not carry.
 */
export const RELAY_INSTALL_FILES = [
  'launch.js', 'index.js', 'resume-args.mjs', 'codex-mode.mjs', 'package.json', 'package-lock.json',
];

/** Relay imports that live outside the relay directory, copied relative to it. */
export const RELAY_INSTALL_SIBLINGS = ['../lib/fleet-token.mjs'];

/** True when both paths exist and resolve to the same real file/dir (through symlinks). */
export function samePath(a: string, b: string): boolean {
  try {
    return fs.existsSync(a) && fs.existsSync(b) && fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function ensureRelayInstall(): string {
  const sourceDir = path.join(neoncoreRepoRoot(), 'agent', 'relay');
  const targetDir = relayInstallDir();

  // If the install dir already resolves to the source — e.g. ~/.neoncore/relay is a symlink
  // straight to the repo's agent/relay, a common dev setup — there is nothing to install; the
  // launch entry already lives there. Copying a tree onto itself makes fs.cpSync throw "src
  // and dest cannot be the same", which previously escaped openDirectory and surfaced as a
  // bogus "Failed to create repo" after the repo had in fact been created and pushed.
  if (samePath(sourceDir, targetDir)) {
    return path.join(targetDir, 'launch.js');
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // Per-file guards handle a partial overlap (e.g. only some entries symlinked back to source).
  for (const filename of RELAY_INSTALL_FILES) {
    const source = path.join(sourceDir, filename);
    const dest = path.join(targetDir, filename);
    if (fs.existsSync(source) && !samePath(source, dest)) {
      fs.copyFileSync(source, dest);
    }
  }

  // Modules the relay imports from OUTSIDE its own directory. On a dev box ~/.neoncore/relay is
  // a symlink to the repo, so `../lib/fleet-token.mjs` resolves through it and everything works
  // — which is exactly why this was missing for so long. On a real install the relay is a copy,
  // that path lands in ~/.neoncore/lib, and without this the relay dies on startup with
  // ERR_MODULE_NOT_FOUND. A relay that cannot boot is a cartridge that cannot be recovered.
  for (const rel of RELAY_INSTALL_SIBLINGS) {
    const source = path.resolve(sourceDir, rel);
    const dest = path.resolve(targetDir, rel);
    if (fs.existsSync(source) && !samePath(source, dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
    }
  }

  const sourceScripts = path.join(sourceDir, 'scripts');
  const targetScripts = path.join(targetDir, 'scripts');
  if (fs.existsSync(sourceScripts) && !samePath(sourceScripts, targetScripts)) {
    fs.cpSync(sourceScripts, targetScripts, { recursive: true });
  }

  return path.join(targetDir, 'launch.js');
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
  const launchEntry = ensureRelayInstall();
  // Plain double-quotes are valid in both POSIX shells and cmd.exe; do NOT use
  // JSON.stringify here — it would double Windows backslashes, which cmd treats
  // literally and would break the path.
  return `node "${launchEntry}"`;
}

/**
 * Env handed to the relay (and through it, to the spawned `gridlight` CLI) for a
 * Gridlight terminal launch. NEONCORE_AGENT_CMD/TYPE tell the relay to spawn
 * gridlight and register it as a gridlight agent; the GRIDLIGHT_* vars are the
 * CLI's own contract for correlating transcript/permission reporting. Gateway
 * URL and API token are passed through only when configured on the server env,
 * so secrets are never hardcoded here.
 */
function buildGridlightEnv(sessionId: string): Record<string, string> {
  const neonUrl = getServerBaseUrl();
  const env: Record<string, string> = {
    NEONCORE_AGENT_CMD: process.platform === 'win32' ? 'gridlight.cmd' : 'gridlight',
    NEONCORE_AGENT_TYPE: 'gridlight',
    GRIDLIGHT_SESSION_ID: sessionId,
    GRIDLIGHT_MACHINE_NAME: os.hostname(),
    GRIDLIGHT_NEONCORE_URL: neonUrl,
    GRIDLIGHT_PERMISSION_MODE: process.env.GRIDLIGHT_PERMISSION_MODE || 'auto',
  };
  if (process.env.GRIDLIGHT_GATEWAY_URL) env.GRIDLIGHT_GATEWAY_URL = process.env.GRIDLIGHT_GATEWAY_URL;
  if (process.env.GRIDLIGHT_API_TOKEN) env.GRIDLIGHT_API_TOKEN = process.env.GRIDLIGHT_API_TOKEN;
  return env;
}

/**
 * The agent-type aliases that launch through the relay, and the engine each one spawns.
 *
 * THE registry: `relayLaunchEnv` and the set-based test both iterate it, so a new engine wired
 * into `openDirectory` without an entry here fails the test rather than silently launching a
 * cartridge that can never be resumed.
 */
export const RELAY_LAUNCH_TYPES: Record<string, 'claude' | 'gridlight' | 'codex'> = {
  'claude-terminal': 'claude',
  'claude-cli': 'claude',
  'gridlight-terminal': 'gridlight',
  'gridlight-cli': 'gridlight',
  'codex-terminal': 'codex',
  'codex-cli': 'codex',
};

/**
 * Env for a relay-backed terminal launch, or null when the alias is not relay-backed.
 *
 * `resumeSessionId` is the whole point of this function existing: it is the ONLY way a real,
 * resumable session id reaches the relay. It is omitted entirely rather than exported empty on
 * an ordinary cold start — an empty var reads as a bug in a launch script someone is debugging
 * at 2am, and the relay treats absent and empty identically anyway.
 */
export function relayLaunchEnv(
  alias: string,
  sessionId: string,
  resumeSessionId = '',
): Record<string, string> | null {
  const type = RELAY_LAUNCH_TYPES[alias];
  if (!type) return null;

  const env: Record<string, string> = type === 'gridlight'
    ? buildGridlightEnv(sessionId)
    : {
      NEONCORE_AGENT_CMD: process.platform === 'win32' ? `${type}.cmd` : type,
      NEONCORE_AGENT_TYPE: type,
    };

  // A user's own terminal session must survive a broad `pkill -f agent` from an unrelated
  // cleanup script; see relayInstallDir() for the other half of that defence.
  env.NEONCORE_RELAY_PROTECT = '1';
  if (resumeSessionId) env.NEONCORE_RESUME_SESSION_ID = resumeSessionId;
  return env;
}

/**
 * Open a directory with the specified agent type.
 * Returns an error string on failure, null on success.
 */
export function openDirectory(
  dirPath: string,
  agentType: string,
  opts: { resumeSessionId?: string } = {},
): string | null {
  if (!fs.existsSync(dirPath)) return 'Path does not exist';

  // Any engine that runs in a plain terminal behind the agent relay: claude, gridlight, codex.
  // These were three near-identical branches that drifted — only gridlight ever got its engine
  // env built properly — so they are now one lookup through RELAY_LAUNCH_TYPES. The relay
  // self-registers and opens the addressed socket, so we don't pre-register here (that would
  // just churn the agent's session id).
  const relayEnv = relayLaunchEnv(
    agentType,
    `neoncore-${RELAY_LAUNCH_TYPES[agentType] ?? 'agent'}-${Date.now()}`,
    opts.resumeSessionId || '',
  );
  if (relayEnv) {
    const sessionId = relayEnv.GRIDLIGHT_SESSION_ID
      || `neoncore-${RELAY_LAUNCH_TYPES[agentType]}-${Date.now()}`;
    return openInTerminal(dirPath, buildRelayLaunchCommand(), sessionId, relayEnv);
  }

  // CLI tools
  if (agentType in CLI_COMMANDS) {
    const sessionId = `neoncore-${agentType}-${Date.now()}`;
    const err = openInTerminal(dirPath, CLI_COMMANDS[agentType], sessionId);
    if (err) return err;
    registerCliAgent(dirPath, agentType, sessionId);
    return null;
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
