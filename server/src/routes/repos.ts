import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawn } from 'child_process';
import db from '../db.js';

const router = Router();

// GET /api/repos/browse?path= - list directories for the folder browser
router.get('/browse', (req, res) => {
  const browsePath = (req.query.path as string) || os.homedir();
  const resolved = path.resolve(browsePath);

  if (!fs.existsSync(resolved)) {
    return res.status(400).json({ error: 'Path does not exist', path: resolved });
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Not a directory', path: resolved });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const parent = path.dirname(resolved);

    res.json({
      current: resolved,
      parent: parent !== resolved ? parent : null,
      dirs,
    });
  } catch {
    res.status(500).json({ error: 'Cannot read directory' });
  }
});

/**
 * Parse the projects_dir setting.
 * Supports both legacy single-path string and JSON array of paths.
 */
function getProjectsDirs(): string[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'projects_dir'").get() as { value: string } | undefined;
  if (!row || !row.value) return [];
  const val = row.value.trim();
  if (val.startsWith('[')) {
    try {
      const arr = JSON.parse(val);
      return Array.isArray(arr) ? arr.filter((s: unknown) => typeof s === 'string' && s) : [];
    } catch {
      return [];
    }
  }
  return val ? [val] : [];
}

// GET /api/repos - list git repos in all configured projects directories
router.get('/', (_req, res) => {
  const projectsDirs = getProjectsDirs();
  if (projectsDirs.length === 0) {
    return res.json({ repos: [], projectsDirs: [] });
  }

  const repos: { name: string; path: string; source: string }[] = [];
  const seen = new Set<string>();

  for (const projectsDir of projectsDirs) {
    if (!fs.existsSync(projectsDir)) continue;
    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const fullPath = path.join(projectsDir, entry.name);
        if (seen.has(fullPath)) continue;
        const gitPath = path.join(fullPath, '.git');
        if (!fs.existsSync(gitPath)) continue;
        seen.add(fullPath);
        repos.push({ name: entry.name, path: fullPath, source: projectsDir });
      }
    } catch { /* skip unreadable dirs */ }
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ repos, projectsDirs });
});

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

function findCodeBinary(): string {
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

function findCursorBinary(): string | null {
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

function findCliBinary(name: string): string | null {
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
// Terminal launcher — opens a terminal window running a command at a path
// ---------------------------------------------------------------------------

/**
 * Write a temporary shell script and open it in a terminal window.
 * Using a script file avoids all shell-quoting hell with paths/commands.
 * Returns an error string on failure, null on success.
 */
function openInTerminal(repoPath: string, command: string, agentType?: string): string | null {
  const neonUrl = `http://localhost:${process.env.PORT || 4040}`;
  const repoName = path.basename(repoPath);

  // Pre-registration block — registers cartridge immediately on launch before CLI starts
  const preRegister = agentType ? [
    '# Register with NeonCore immediately so cartridge appears on launch',
    '_NC_SESSION="neoncore-launch-$$-$RANDOM"',
    `_NC_MACHINE="$(hostname 2>/dev/null || echo unknown)"`,
    `curl -sf -X POST "${neonUrl}/api/agents/register" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d "{\\"sessionId\\":\\"$_NC_SESSION\\",\\"machine\\":\\"$_NC_MACHINE\\",\\"repoPath\\":${JSON.stringify(repoPath)},\\"repoName\\":${JSON.stringify(repoName)},\\"agentType\\":${JSON.stringify(agentType)},\\"status\\":\\"idle\\"}" \\`,
    `  >/dev/null 2>&1 || true`,
    `export NEONCORE_SESSION_ID="$_NC_SESSION"`,
  ] : [];

  // Write a self-cleaning launch script
  const scriptPath = path.join(os.tmpdir(), `neoncore-launch-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    `cd ${JSON.stringify(repoPath)}`,        // JSON.stringify gives us proper shell quoting
    `export NEONCORE_URL=${JSON.stringify(neonUrl)}`,
    // Load user's shell profile so nvm/fnm paths are available
    '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null',
    '[ -f "$HOME/.zshrc"  ] && source "$HOME/.zshrc"  2>/dev/null',
    '[ -f "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null',
    ...preRegister,
    command,
  ].join('\n') + '\n');
  fs.chmodSync(scriptPath, '755');

  // Clean up after 60s regardless of outcome
  setTimeout(() => { try { fs.unlinkSync(scriptPath); } catch { /* ignore */ } }, 60_000);

  if (process.platform === 'darwin') {
    // Check if iTerm2 is running (pgrep is reliable)
    let iterm2Running = false;
    try { execSync('pgrep -x iTerm2', { stdio: 'ignore', timeout: 1000 }); iterm2Running = true; } catch { /* no */ }

    if (iterm2Running) {
      try {
        // iTerm2 AppleScript — each -e is one line, scriptPath has no special chars
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

    // Terminal.app — simplest reliable approach
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

  } else if (process.platform === 'win32') {
    try {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', scriptPath], {
        detached: true, stdio: 'ignore',
      }).unref();
      return null;
    } catch (err) {
      return `Failed to open terminal: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return 'Unsupported platform';
}

let codeBin: string | null = null;

// ---------------------------------------------------------------------------
// POST /api/repos/open - open a repo with the chosen agent tool
// ---------------------------------------------------------------------------
router.post('/open', (req, res) => {
  const { path: repoPath, agentType } = req.body;
  if (!repoPath || typeof repoPath !== 'string') {
    return res.status(400).json({ error: 'path required' });
  }
  if (!fs.existsSync(repoPath)) {
    return res.status(400).json({ error: 'Path does not exist' });
  }

  // ── CLI tools: open a terminal window running the CLI at the project path ──
  const CLI_COMMANDS: Record<string, string> = {
    gemini:  'gemini',
    amazonq: 'q chat',
    codex:   'codex',
  };

  if (agentType in CLI_COMMANDS) {
    const err = openInTerminal(repoPath, CLI_COMMANDS[agentType], agentType);
    if (err) return res.status(500).json({ error: err });
    res.json({ ok: true });
    return;
  }

  // ── Cursor: open with cursor binary ──
  if (agentType === 'cursor') {
    const cursorBin = findCursorBinary();
    if (!cursorBin) {
      return res.status(400).json({ error: 'Cursor not found. Is Cursor installed?' });
    }
    // Write workspace setting so NeonCore extension registers as cursor
    writeVscodeSettings(repoPath, 'cursor');
    try {
      execSync(`"${cursorBin}" "${repoPath}"`, { timeout: 5000 });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to open Cursor' });
    }
    return;
  }

  // ── VS Code-based tools (claude, gridlight) ──
  const resolvedType = agentType === 'gridlight' ? 'gridlight' : 'claude';
  writeVscodeSettings(repoPath, resolvedType);

  if (!codeBin) codeBin = findCodeBinary();

  try {
    execSync(`"${codeBin}" "${repoPath}"`, { timeout: 5000 });
    res.json({ ok: true });
  } catch {
    if (process.platform === 'darwin') {
      try {
        execSync(`open -a "Visual Studio Code" "${repoPath}"`, { timeout: 5000 });
        res.json({ ok: true });
        return;
      } catch { /* fall through */ }
    } else if (process.platform === 'win32') {
      try {
        execSync(`start "" "Code" "${repoPath}"`, { timeout: 5000, shell: 'cmd.exe' });
        res.json({ ok: true });
        return;
      } catch { /* fall through */ }
    }
    res.status(500).json({ error: 'Failed to open VS Code. Is the "code" CLI installed?' });
  }
});

function writeVscodeSettings(repoPath: string, agentType: string): void {
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

export default router;
