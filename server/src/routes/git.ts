import { Router } from 'express';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { createWorktree } from '../lib/worktree.js';
import { openInVsCode } from '../lib/open-directory.js';

/*
 * Every git call takes its arguments as an array, never a shell string: branch names and paths
 * arrive in request bodies, and `"${path}"` inside a shell command runs whatever `$(…)` or
 * `"; …` they carry.
 */
const git = (repoPath: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) =>
  execFileSync('git', args, { cwd: repoPath, timeout: opts.timeout ?? 10000, encoding: 'utf-8', maxBuffer: opts.maxBuffer });

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
    const output = git(repoPath, ['worktree', 'list', '--porcelain']);

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
  if (branch.startsWith('-')) return res.status(400).json({ error: 'branch cannot start with "-"' });
  if (worktreePath !== undefined && typeof worktreePath !== 'string') return res.status(400).json({ error: 'path must be a string' });

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
    git(repoPath, ['worktree', 'remove', '--force', path.resolve(worktreePath)], { timeout: 15000 });
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
    const output = git(repoPath, ['branch', '-a', '--format=%(refname:short)']);
    const branches = output.trim().split('\n').filter(Boolean);
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
    const output = git(repoPath, ['status', '--porcelain', '-b']);
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
  try {
    const output = git(repoPath, staged ? ['diff', '--staged'] : ['diff'], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
    res.json({ diff: output });
  } catch {
    res.status(500).json({ error: 'Failed to get git diff' });
  }
});

// POST /api/git/:agentId/worktrees/open — open worktree in VS Code
router.post('/:agentId/worktrees/open', (req, res) => {
  const { path: worktreePath } = req.body;
  if (!worktreePath || typeof worktreePath !== 'string') return res.status(400).json({ error: 'path required' });
  if (!fs.existsSync(worktreePath)) return res.status(400).json({ error: 'Path does not exist' });

  if (openInVsCode(worktreePath)) return res.json({ ok: true });
  res.status(500).json({ error: 'Failed to open VS Code' });
});

export default router;
