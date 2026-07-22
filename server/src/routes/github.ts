import { Router } from 'express';
import { execSync, execFileSync } from 'child_process';
import db from '../db.js';

const router = Router();

// GitHub logins are [A-Za-z0-9-]; enforce this everywhere a login reaches a shell/arg.
const LOGIN_RE = /^[A-Za-z0-9-]+$/;

function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

interface GhAccount {
  login: string;
  active: boolean;
}

/** Parse `gh auth status` into the list of logged-in accounts and which is active. */
export function listGhAccounts(): GhAccount[] {
  let out = '';
  try {
    out = execSync('gh auth status 2>&1', { encoding: 'utf8' });
  } catch (e) {
    // gh exits non-zero when not logged in; still parse whatever it printed.
    out = (e as { stdout?: Buffer }).stdout?.toString() || '';
  }
  const accounts: GhAccount[] = [];
  let last: GhAccount | null = null;
  for (const line of out.split('\n')) {
    const m = line.match(/Logged in to \S+ account (\S+)/);
    if (m) {
      last = { login: m[1], active: false };
      accounts.push(last);
      continue;
    }
    if (last && /Active account:\s*true/i.test(line)) last.active = true;
  }
  return accounts;
}

/** The account's GitHub identity, fetched with its own token (no active-account switch). */
function accountIdentity(login: string): { login: string; name: string; id: number } | null {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--user', login], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!token) return null;
    const json = execFileSync('gh', ['api', 'user'], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const u = JSON.parse(json) as { login: string; name: string | null; id: number };
    return { login: u.login, name: u.name || u.login, id: u.id };
  } catch {
    return null;
  }
}

// GET /api/github/accounts — logged-in accounts + which is active (from gh itself).
router.get('/accounts', (_req, res) => {
  try {
    res.json({ accounts: listGhAccounts() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'gh CLI not available' });
  }
});

// POST /api/github/switch { login } — switch the machine's ACTIVE gh account. This is what
// terminals + launched agents inherit, so it decides which GitHub identity they use. We also
// align git's global commit identity with the account (via its GitHub noreply email, so a
// private address is never leaked), so commits attribute correctly too.
router.post('/switch', (req, res) => {
  const login = String(req.body?.login || '').trim();
  if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'Invalid account login' });
  if (!listGhAccounts().some((a) => a.login === login)) {
    return res.status(400).json({ error: `Not a logged-in gh account: ${login}` });
  }
  try {
    execFileSync('gh', ['auth', 'switch', '--user', login], { stdio: 'pipe' });
    const id = accountIdentity(login);
    if (id) {
      execFileSync('git', ['config', '--global', 'user.name', id.name], { stdio: 'pipe' });
      execFileSync('git', ['config', '--global', 'user.email', `${id.id}+${id.login}@users.noreply.github.com`], { stdio: 'pipe' });
    }
    setSetting('github_active_account', login);
    res.json({ ok: true, accounts: listGhAccounts() });
  } catch (e) {
    const msg = (e as { stderr?: Buffer }).stderr?.toString() || (e instanceof Error ? e.message : String(e));
    res.status(500).json({ error: `Failed to switch account: ${msg.trim()}` });
  }
});

export default router;
