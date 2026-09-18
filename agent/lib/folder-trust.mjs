import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Pre-accept Claude Code's folder-trust prompt for a cartridge path.
 *
 * Every NeonCore launch ends the same way: interactive Claude Code, spawned by the relay into
 * a PTY whose cwd is the cartridge directory. For a directory Claude has never seen there is no
 * `projects[<path>]` entry in ~/.claude.json, so it opens "Quick safety check: Is this a project
 * you created or one you trust?" — and the DEFAULT selection is "No, exit". Inside the relay's
 * PTY that reads as a terminal that printed the launch script path and then died, which is how
 * a brand-new cartridge failed to start at all. Launching from the dashboard IS the act of
 * trusting the folder, so record it the way answering the prompt by hand does.
 *
 * This lives in agent/lib because there are TWO launchers and they must not drift: the server's
 * openDirectory (local click) and the runner's own launch (remote machine + native relaunch
 * recovery). They already drifted once — three near-identical engine branches where only one
 * ever built its env properly — so this is one function with two callers, not two copies.
 *
 * Best-effort by design: a launch must never fail because this file was unreadable, and a
 * claude.json we cannot parse is left EXACTLY as found — that file is the user's whole Claude
 * Code state, and overwriting it to dodge a prompt would be a far worse bug than the prompt.
 * The write is atomic (temp + rename) so a crash mid-write cannot truncate it.
 *
 * @param {string} repoPath Absolute path of the cartridge directory being launched.
 * @param {string} [claudeJsonPath] Override for ~/.claude.json (tests only).
 */
export function ensureFolderTrusted(repoPath, claudeJsonPath) {
  const target = claudeJsonPath || path.join(os.homedir(), '.claude.json');
  try {
    let data = {};
    if (fs.existsSync(target)) {
      try {
        data = JSON.parse(fs.readFileSync(target, 'utf-8'));
      } catch {
        return; // unparseable — leave it alone rather than clobber it
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    }

    const projects = data.projects && typeof data.projects === 'object' && !Array.isArray(data.projects)
      ? data.projects
      : {};
    const existing = projects[repoPath] && typeof projects[repoPath] === 'object'
      ? projects[repoPath]
      : {};

    // Already trusted: do not rewrite. Claude Code writes this file constantly, and a pointless
    // read-modify-write is a chance to lose whatever it wrote between our read and our write.
    if (existing.hasTrustDialogAccepted === true) return;

    projects[repoPath] = { ...existing, hasTrustDialogAccepted: true };
    data.projects = projects;

    const tmp = `${target}.neoncore-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, target);
  } catch { /* best-effort: never block a launch */ }
}
