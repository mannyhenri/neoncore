/**
 * Shared utilities for opening a directory in VS Code or a CLI terminal.
 * Used by both repos.ts and virtual-cartridges.ts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { getServerBaseUrl } from './server-url.js';
// Shared with the runner's own launcher (agent/runner/index.js) so the two launch paths cannot
// drift. Plain ESM JS with no type declarations, same as the relay's fleet-token.mjs.
// @ts-expect-error — untyped ESM shared with the agent side.
import { ensureFolderTrusted } from '../../../agent/lib/folder-trust.mjs';
import { posixLaunchScript, windowsLaunchScript, launchTempPath } from '../../../agent/lib/launch-script.mjs';

export { ensureFolderTrusted };

// ---------------------------------------------------------------------------
// Binary finders
// ---------------------------------------------------------------------------

function findBinary(candidates: string[], lookup: [string, ...string[]]): string | null {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const resolved = execFileSync(lookup[0], lookup.slice(1), { timeout: 3000 }).toString().trim().split('\n')[0];
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
  return findBinary(candidates, process.platform === 'win32' ? ['where', 'code'] : ['bash', '-lc', 'which code'])
    ?? (isWin ? 'code.cmd' : 'code');
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
export function openInTerminal(repoPath: string, argv: string[], sessionId: string, extraEnv: Record<string, string> = {}): string | null {
  const env = {
    NEONCORE_URL: getServerBaseUrl(),
    NEONCORE_SESSION_ID: sessionId,
    ...extraEnv,
  };

  // Windows: emit a native .cmd batch script and run it via cmd.exe. (A bash .sh
  // launched through `cmd /k` cannot execute — this is what broke Windows launch.)
  // The environment travels in a JSON side file: see agent/lib/launch-script.mjs.
  if (process.platform === 'win32') {
    const scriptPath = launchTempPath('.cmd');
    const envFile = launchTempPath('.env.json');
    try {
      fs.writeFileSync(scriptPath, windowsLaunchScript({ cwd: repoPath, env, argv, envFile }));
    } catch (err) {
      return `Failed to write the launch script: ${err instanceof Error ? err.message : String(err)}`;
    }

    setTimeout(() => {
      for (const f of [scriptPath, envFile]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    }, 60_000);

    try {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', scriptPath], {
        detached: true, stdio: 'ignore',
      }).unref();
      return null;
    } catch (err) {
      return `Failed to open terminal: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // POSIX (macOS / Linux): bash script that sources rc files for PATH, then runs. Every value in
  // it is single-quoted — they come from requests and from text people type.
  const scriptPath = launchTempPath('.sh');
  fs.writeFileSync(scriptPath, posixLaunchScript({ cwd: repoPath, env, argv }));
  fs.chmodSync(scriptPath, '755');

  setTimeout(() => { try { fs.unlinkSync(scriptPath); } catch { /* ignore */ } }, 60_000);

  // `bash <script>`, not the bare path: a fresh executable waits on macOS's malware scan (and can be killed).
  if (process.platform === 'darwin') {
    let iterm2Running = false;
    try { execFileSync('pgrep', ['-x', 'iTerm2'], { stdio: 'ignore', timeout: 1000 }); iterm2Running = true; } catch { /* no */ }

    if (iterm2Running) {
      try {
        execFileSync('osascript', [
          '-e', 'tell application "iTerm2"',
          '-e', 'set w to (create window with default profile)',
          '-e', 'tell current session of w',
          '-e', `write text ${JSON.stringify(`bash ${JSON.stringify(scriptPath)}`)}`,
          '-e', 'end tell',
          '-e', 'end tell',
        ], { timeout: 8000 });
        return null;
      } catch { /* fall through to Terminal.app */ }
    }

    try {
      execFileSync('osascript', [
        '-e', 'tell application "Terminal"',
        '-e', `do script ${JSON.stringify(`bash ${JSON.stringify(scriptPath)}`)}`,
        '-e', 'activate',
        '-e', 'end tell',
      ], { timeout: 8000 });
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
        execFileSync('which', [term], { stdio: 'ignore', timeout: 1000 });
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
// Open directory in VS Code / CLI terminal
// ---------------------------------------------------------------------------

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
function buildRelayLaunchCommand(): string[] {
  return ['node', ensureRelayInstall()];
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
  // Own keys only: an agentType of 'constructor' or 'toString' arrives from request bodies.
  const type = Object.hasOwn(RELAY_LAUNCH_TYPES, alias) ? RELAY_LAUNCH_TYPES[alias] : undefined;
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
    // Before the terminal exists: a first-ever launch into this directory would otherwise stop
    // on Claude's folder-trust prompt, which defaults to "No, exit".
    ensureFolderTrusted(dirPath);
    return openInTerminal(dirPath, buildRelayLaunchCommand(), sessionId, relayEnv);
  }

  // VS Code-based tools (claude, gridlight, codex)
  const resolvedType = agentType === 'gridlight' ? 'gridlight'
    : agentType === 'codex' ? 'codex'
    : 'claude';
  writeVscodeSettings(dirPath, resolvedType);

  return openInVsCode(dirPath) ? null : 'Failed to open VS Code. Is the "code" CLI installed?';
}

/**
 * Open a folder in VS Code. The folder is passed as an ARGUMENT, never pasted into a shell
 * command line: it arrives in HTTP request bodies, and `"${path}"` inside a shell string runs
 * whatever `$(…)` or `"; …` the path carries. cmd.exe (needed for code.cmd on Windows) cannot
 * quote `"` or `%`, so such a path is refused there. True when VS Code was started.
 */
export function openInVsCode(target: string, opts: { newWindow?: boolean } = {}): boolean {
  if (!_codeBin) _codeBin = findCodeBinary();
  const isWin = process.platform === 'win32';
  if (isWin && /["%\r\n]/.test(target)) return false;
  const flag = opts.newWindow ? ['--new-window'] : [];
  const attempts: [string, string[]][] = isWin
    ? [
        ['cmd.exe', ['/d', '/s', '/c', `""${_codeBin}" ${flag.join(' ')} "${target}""`]],
        ['cmd.exe', ['/d', '/s', '/c', `start "" "Code" ${flag.join(' ')} "${target}"`]],
      ]
    : [
        [_codeBin, [...flag, target]],
        ...(process.platform === 'darwin' && !opts.newWindow ? [['open', ['-a', 'Visual Studio Code', target]] as [string, string[]]] : []),
      ];
  for (const [file, args] of attempts) {
    const r = spawnSync(file, args, { timeout: 5000, stdio: 'ignore', windowsVerbatimArguments: isWin });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}
