import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
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

// Find the `code` CLI binary — the server's shell may not have it in PATH
function findCodeBinary(): string {
  const isWin = process.platform === 'win32';
  const home = os.homedir();

  const candidates = isWin
    ? [
        path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
        path.join('C:', 'Program Files', 'Microsoft VS Code', 'bin', 'code.cmd'),
        path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join('C:', 'Program Files', 'Microsoft VS Code', 'Code.exe'),
      ]
    : [
        '/usr/local/bin/code',
        '/opt/homebrew/bin/code',
        path.join(home, '.local', 'bin', 'code'),
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Try the user's login shell to resolve it
  try {
    const cmd = isWin ? 'where code' : 'bash -lc "which code"';
    const resolved = execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch { /* ignore */ }

  return isWin ? 'code.cmd' : 'code';
}

let codeBin: string | null = null;

// POST /api/repos/open - open a repo in VS Code
router.post('/open', (req, res) => {
  const { path: repoPath } = req.body;
  if (!repoPath || typeof repoPath !== 'string') {
    return res.status(400).json({ error: 'path required' });
  }

  if (!fs.existsSync(repoPath)) {
    return res.status(400).json({ error: 'Path does not exist' });
  }

  // Cache the resolved binary path
  if (!codeBin) codeBin = findCodeBinary();

  try {
    execSync(`"${codeBin}" "${repoPath}"`, { timeout: 5000 });
    res.json({ ok: true });
  } catch {
    // Platform-specific fallbacks
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

export default router;
