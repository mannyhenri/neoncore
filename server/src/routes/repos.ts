import { Router } from 'express';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../db.js';
import { dispatchSetReposToMachine, isMachineOnline } from '../ws.js';
import {
  findCursorBinary,
  openDirectory,
} from '../lib/open-directory.js';

// Fallback GitHub owner when the request doesn't specify one and no active account is set.
const DEFAULT_OWNER = 'mannyhenri';

function getSetting(key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() || '';
}

/**
 * Environment for `gh repo create`, authenticated as the chosen owner account. Creating under
 * a specific account requires *that* account's token — the machine's active gh account may be
 * a different one (e.g. a personal account with no rights to the other's context). We fetch the
 * owner's own token via `gh auth token --user`, so the create authenticates correctly without
 * disturbing the active account. Falls back to the active account if no token is found.
 */
function ghEnvForOwner(owner: string): NodeJS.ProcessEnv {
  if (!/^[A-Za-z0-9-]+$/.test(owner)) return process.env;
  try {
    const token = execFileSync('gh', ['auth', 'token', '--user', owner], { stdio: 'pipe' }).toString().trim();
    return token ? { ...process.env, GH_TOKEN: token } : process.env;
  } catch {
    return process.env;
  }
}

/**
 * Add a freshly-created folder to the LOCAL machine's runner allowlist so it shows up in the
 * "+ Launch" list. The runner owns the list, so we send it the existing folders plus the new
 * one and let it re-validate + re-register (broadcast as machine_updated). Best-effort: if no
 * local runner is registered/online we skip silently — the repo is still created and the
 * auto-launch path still works.
 */
function addToLocalLaunchList(repoPath: string, repoName: string): void {
  try {
    // Match on a normalized hostname: the runner registers bare ("Mannys-Mac-Pro") while the
    // server's os.hostname() often carries a ".local" suffix, so an exact compare misses.
    const norm = (h: string) => h.replace(/\.local$/i, '').toLowerCase();
    const host = norm(os.hostname());
    const rows = db.prepare('SELECT id, hostname, repos FROM machines').all() as Record<string, unknown>[];
    const local = rows.find((r) => norm(r.hostname as string) === host && isMachineOnline(r.id as string));
    if (!local) return;
    const existing = JSON.parse((local.repos as string) || '[]') as { path: string; name?: string }[];
    if (existing.some((r) => r.path === repoPath)) return;
    const next = [
      ...existing.map((r) => ({ path: r.path, name: r.name || path.basename(r.path) })),
      { path: repoPath, name: repoName },
    ];
    dispatchSetReposToMachine(local.id as string, next);
  } catch {
    /* best-effort — never fail the create over the launch list */
  }
}

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

// ---------------------------------------------------------------------------
// POST /api/repos/create - scaffold a brand-new project:
//   mkdir → starter files → git init + first commit → gh repo create + push
//   → (optionally) launch an agent so a cartridge appears in the new folder.
// Runs on the server host; relies on the `gh` CLI being authenticated here.
// ---------------------------------------------------------------------------
router.post('/create', (req, res) => {
  const { name, parentDir, description, isPrivate, agentType, owner: ownerRaw } = req.body as {
    name?: string;
    parentDir?: string;
    description?: string;
    isPrivate?: boolean;
    agentType?: string;
    owner?: string;
  };

  // Validate name: GitHub repo rules AND safe as a folder name (no separators).
  if (!name || typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return res.status(400).json({
      error: 'Repo name must contain only letters, numbers, dots, dashes, or underscores.',
    });
  }

  // Owner: explicit choice → the configured active account → hardcoded default. Validated to a
  // GitHub-login shape since it flows into `owner/name` and `gh auth token --user`.
  const owner =
    (typeof ownerRaw === 'string' && /^[A-Za-z0-9-]+$/.test(ownerRaw.trim()) && ownerRaw.trim()) ||
    getSetting('github_active_account') ||
    DEFAULT_OWNER;

  // Resolve the parent directory: explicit choice → first configured projects_dir → home.
  const parent = path.resolve(
    (typeof parentDir === 'string' && parentDir.trim()) || getProjectsDirs()[0] || os.homedir(),
  );
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return res.status(400).json({ error: `Parent directory does not exist: ${parent}` });
  }

  const targetPath = path.join(parent, name);
  if (fs.existsSync(targetPath)) {
    return res.status(409).json({ error: `A folder named "${name}" already exists in ${parent}.` });
  }

  const desc = typeof description === 'string' ? description.trim() : '';
  const visFlag = isPrivate === false ? '--public' : '--private';

  // Step tracking so a failure message can say exactly how far we got — and, crucially,
  // whether the local folder was already created (so the user isn't left guessing).
  let folderCreated = false;
  try {
    // 1. Folder + starter files.
    fs.mkdirSync(targetPath, { recursive: true });
    folderCreated = true;
    fs.writeFileSync(path.join(targetPath, 'README.md'), `# ${name}\n\n${desc || 'Created with NeonCore.'}\n`);
    fs.writeFileSync(path.join(targetPath, '.gitignore'), ['node_modules/', '.DS_Store', '.env', '*.log', ''].join('\n'));

    // 2. git init + first commit. -c supplies an identity so the commit never fails when
    //    no global git user is configured on the host.
    const run = (cmd: string) => execSync(cmd, { cwd: targetPath, stdio: 'pipe' });
    run('git init -b main');
    run('git add -A');
    run('git -c user.name="NeonCore" -c user.email="neoncore@gridlight.ai" commit -m "Initial commit"');

    // 3. Create the GitHub repo and push. `gh` must be authed on this host. execFileSync (no
    //    shell) so the free-text description can't inject shell commands.
    const ghArgs = ['repo', 'create', `${owner}/${name}`, visFlag, '--source', '.', '--remote', 'origin', '--push'];
    if (desc) ghArgs.push('--description', desc);
    const out = execFileSync('gh', ghArgs, { cwd: targetPath, stdio: 'pipe', env: ghEnvForOwner(owner) }).toString();
    const repoUrl = out.match(/https?:\/\/\S+/)?.[0] || `https://github.com/${owner}/${name}`;

    // 3.5. Register the folder in the local machine's "+ Launch" allowlist so it's launchable
    //      again later without an Edit-folders round-trip.
    addToLocalLaunchList(targetPath, name);

    // 4. Optionally launch an agent so a cartridge appears immediately. A launch failure is
    //    non-fatal — the repo already exists and is pushed, so we surface it without failing
    //    the request. openDirectory returns an error string for expected failures, but a
    //    deeper throw (e.g. relay-install fs errors) must not turn a created repo into a
    //    "Failed to create repo" — catch it here and report it as a launch error instead.
    let launchError: string | null = null;
    if (agentType && agentType !== 'none') {
      try {
        launchError = openDirectory(targetPath, agentType);
      } catch (e) {
        launchError = e instanceof Error ? e.message : String(e);
      }
    }

    return res.json({ ok: true, path: targetPath, repoUrl, launchError });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString();
    const msg = stderr || (err instanceof Error ? err.message : String(err));
    // Non-destructive on failure: we never delete the folder. Tell the user where it landed
    // so they can retry the push manually rather than silently losing their local commit.
    const suffix = folderCreated
      ? ` The local folder was created at ${targetPath}; fix the issue and push manually, or remove it and retry.`
      : '';
    return res.status(500).json({ error: `Failed to create repo: ${msg.trim()}${suffix}` });
  }
});

export default router;
