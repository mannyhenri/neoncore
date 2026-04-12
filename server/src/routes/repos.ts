import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../db.js';
import {
  findCursorBinary,
  openDirectory,
} from '../lib/open-directory.js';

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
// POST /api/repos/open - open a repo with the chosen agent tool
// ---------------------------------------------------------------------------
router.post('/open', (req, res) => {
  const { path: repoPath, agentType } = req.body;
  if (!repoPath || typeof repoPath !== 'string') {
    return res.status(400).json({ error: 'path required' });
  }

  // Cursor needs a special error message when binary is missing
  if (agentType === 'cursor' && !findCursorBinary()) {
    return res.status(400).json({ error: 'Cursor not found. Is Cursor installed?' });
  }

  // openDirectory handles all agent types, including CLI + VS Code + Cursor
  const err = openDirectory(repoPath, agentType);
  if (err) return res.status(500).json({ error: err });
  res.json({ ok: true });
});

export default router;
