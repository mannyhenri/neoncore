import { Router } from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../db.js';
import { createWorktree } from '../lib/worktree.js';

const router = Router();

function getAgentRepoPath(agentId: string): string | null {
  const row = db.prepare('SELECT repo_path FROM agents WHERE id = ?')
    .get(agentId) as Record<string, unknown> | undefined;
  if (!row || !row.repo_path) return null;
  const repoPath = row.repo_path as string;
  if (!fs.existsSync(repoPath)) return null;
  return repoPath;
}

// GET /api/git/:agentId/worktrees
router.get('/:agentId/worktrees', (req, res) => {
  const repoPath = getAgentRepoPath(req.params.agentId);
  if (!repoPath) return res.status(404).json({ error: 'Agent or repo not found' });

  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: repoPath,
      timeout: 10000,
      encoding: 'utf-8',
    });

    const worktrees: { path: string; head: string; branch: string; bare: boolean }[] = [];
    let current: { path: string; head: string; branch: string; bare: boolean } | null = null;

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) worktrees.push(current);
        current = { path: line.slice(9), bare: false, branch: '', head: '' };
      } else if (line.startsWith('HEAD ') && current) {
        current.head = line.slice(5);
      } else if (line.startsWith('branch ') && current) {
        current.branch = line.slice(7).replace('refs/heads/', '');
      } else if (line === 'bare' && current) {
        current.bare = true;
      }
    }
    if (current) worktrees.push(current);

    res.json(worktrees);
  } catch {
    res.status(500).json({ error: 'Failed to list worktrees' });
  }
});

// POST /api/git/:agentId/worktrees — create a worktree
router.post('/:agentId/worktrees', (req, res) => {
  const repoPath = getAgentRepoPath(req.params.agentId);
  if (!repoPath) return res.status(404).json({ error: 'Agent or repo not found' });

  const { branch, path: worktreePath } = req.body;
  if (!branch || typeof branch !== 'string') return res.status(400).json({ error: 'branch required' });

  try {
    const result = createWorktree(repoPath, branch, worktreePath);
    res.status(201).json({ ok: true, ...result });
  } catch {
    res.status(500).json({ error: 'Failed to create worktree' });
  }
});

// DELETE /api/git/:agentId/worktrees — remove a worktree
router.delete('/:agentId/worktrees', (req, res) => {
  const repoPath = getAgentRepoPath(req.params.agentId);
  if (!repoPath) return res.status(404).json({ error: 'Agent or repo not found' });

  const { path: worktreePath } = req.body;
  if (!worktreePath || typeof worktreePath !== 'string') return res.status(400).json({ error: 'path required' });

  if (path.resolve(worktreePath) === path.resolve(repoPath)) {
    return res.status(400).json({ error: 'Cannot remove the main worktree' });
  }

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoPath, timeout: 15000, encoding: 'utf-8',
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to remove worktree' });
  }
});

// GET /api/git/:agentId/branches
router.get('/:agentId/branches', (req, res) => {
  const repoPath = getAgentRepoPath(req.params.agentId);
  if (!repoPath) return res.status(404).json({ error: 'Agent or repo not found' });

  try {
    const output = execSync("git branch -a --format='%(refname:short)'", {
      cwd: repoPath, timeout: 10000, encoding: 'utf-8',
    });
    const branches = output.trim().split('\n').filter(Boolean).map(b => b.replace(/^'|'$/g, ''));
    res.json(branches);
  } catch {
    res.status(500).json({ error: 'Failed to list branches' });
  }
});

// GET /api/git/:agentId/status
router.get('/:agentId/status', (req, res) => {
  const repoPath = getAgentRepoPath(req.params.agentId);
  if (!repoPath) return res.status(404).json({ error: 'Agent or repo not found' });

  try {
    const output = execSync('git status --porcelain -b', {
      cwd: repoPath, timeout: 10000, encoding: 'utf-8',
    });
    res.json({ status: output });
  } catch {
    res.status(500).json({ error: 'Failed to get git status' });
  }
});

// GET /api/git/:agentId/diff
router.get('/:agentId/diff', (req, res) => {
  const repoPath = getAgentRepoPath(req.params.agentId);
  if (!repoPath) return res.status(404).json({ error: 'Agent or repo not found' });

  const staged = req.query.staged === 'true';
  const cmd = staged ? 'git diff --staged' : 'git diff';

  try {
    const output = execSync(cmd, {
      cwd: repoPath, timeout: 15000, encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    });
    res.json({ diff: output });
  } catch {
    res.status(500).json({ error: 'Failed to get git diff' });
  }
});

// Find the `code` CLI binary (duplicated from repos.ts)
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

  try {
    const cmd = isWin ? 'where code' : 'bash -lc "which code"';
    const resolved = execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch { /* ignore */ }

  return isWin ? 'code.cmd' : 'code';
}

let codeBin: string | null = null;

// POST /api/git/:agentId/worktrees/open — open worktree in VS Code
router.post('/:agentId/worktrees/open', (req, res) => {
  const { path: worktreePath } = req.body;
  if (!worktreePath || typeof worktreePath !== 'string') return res.status(400).json({ error: 'path required' });
  if (!fs.existsSync(worktreePath)) return res.status(400).json({ error: 'Path does not exist' });

  if (!codeBin) codeBin = findCodeBinary();

  try {
    execSync(`"${codeBin}" "${worktreePath}"`, { timeout: 5000 });
    res.json({ ok: true });
  } catch {
    if (process.platform === 'darwin') {
      try {
        execSync(`open -a "Visual Studio Code" "${worktreePath}"`, { timeout: 5000 });
        res.json({ ok: true });
        return;
      } catch { /* fall through */ }
    }
    res.status(500).json({ error: 'Failed to open VS Code' });
  }
});

export default router;
