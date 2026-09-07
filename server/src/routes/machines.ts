import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { getIO, isMachineOnline, dispatchLaunchToMachine, dispatchSetReposToMachine, dispatchScanToMachine } from '../ws.js';
import type { Machine, MachineRepo } from '../types.js';
import { launchResumeDecision, lastResumableSession } from '../lib/last-session.js';

const router = Router();

function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() || null;
}

/** The shared secret a runner must present to register. Empty = open (dev). */
function pairingToken(): string | null {
  return getSetting('machine_pairing_token');
}

function normalizeRepos(raw: unknown): MachineRepo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === 'object' && typeof (r as MachineRepo).path === 'string')
    .map((r) => {
      const rep = r as MachineRepo;
      const p = rep.path.trim();
      return { path: p, name: (rep.name || p.split(/[\\/]/).filter(Boolean).pop() || p).trim() };
    })
    .filter((r) => r.path);
}

function normalizeMachine(row: Record<string, unknown>): Machine {
  return {
    id: row.id as string,
    hostname: (row.hostname as string) ?? '',
    platform: (row.platform as string) ?? '',
    arch: (row.arch as string) ?? '',
    repos: JSON.parse((row.repos as string) || '[]'),
    // Trust the live socket over the stored flag — a crashed runner may have left it 'online'.
    status: isMachineOnline(row.id as string) ? 'online' : 'offline',
    lastSeen: (row.last_seen as string) ?? '',
  };
}

// Runner registers itself (or refreshes its repo list). Idempotent on machineId.
router.post('/register', (req, res) => {
  const { machineId, hostname, platform, arch, repos, token } = req.body || {};
  if (!machineId || typeof machineId !== 'string') {
    return res.status(400).json({ error: 'machineId is required' });
  }

  const expected = pairingToken();
  if (expected && token !== expected) {
    return res.status(401).json({ error: 'Invalid pairing token' });
  }

  const now = new Date().toISOString();
  const reposJson = JSON.stringify(normalizeRepos(repos));

  db.prepare(`
    INSERT INTO machines (id, hostname, platform, arch, repos, status, last_seen, created_at)
    VALUES (?, ?, ?, ?, ?, 'online', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      hostname = excluded.hostname, platform = excluded.platform, arch = excluded.arch,
      repos = excluded.repos, status = 'online', last_seen = excluded.last_seen
  `).run(machineId, hostname || '', platform || '', arch || '', reposJson, now, now);

  const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId) as Record<string, unknown>;
  const machine = normalizeMachine(row);
  getIO().emit('machine_updated', machine);
  res.json({ ok: true, machine });
});

// List all known machines with live online status.
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM machines ORDER BY hostname').all() as Record<string, unknown>[];
  res.json(rows.map(normalizeMachine));
});

// Launch a cartridge on a specific machine. The runner spawns the relay in the chosen repo.
router.post('/:id/launch', (req, res) => {
  const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Machine not found' });

  const { repoPath, agentType, context, resumeSessionId, fresh } = req.body || {};
  if (!repoPath || typeof repoPath !== 'string') {
    return res.status(400).json({ error: 'repoPath is required' });
  }
  if (!agentType || typeof agentType !== 'string') {
    return res.status(400).json({ error: 'agentType is required' });
  }

  // Only launch inside the runner's declared allowlist — never an arbitrary path.
  const repos = JSON.parse((row.repos as string) || '[]') as MachineRepo[];
  if (!repos.some((r) => r.path === repoPath)) {
    return res.status(400).json({ error: 'repoPath is not in this machine\'s allowed repos' });
  }

  if (!isMachineOnline(req.params.id)) {
    return res.status(409).json({ error: 'Machine is offline' });
  }

  // `sessionId` is a LABEL for this launch, not a resumable session — hence the synthetic
  // `remote-` prefix. `resumeSessionId` is the real thing: a native session id the caller wants
  // this cartridge to come back as. Keeping them separate is what stops an ordinary launch from
  // trying to resume `remote-8f3a91c2`, which is not a session anyone can resume.
  const sessionId = `remote-${randomUUID().slice(0, 8)}`;

  // RESUME IS THE DEFAULT. Launching a cartridge for a project is where continuity is expected,
  // so the last real session for this machine+repo+engine is picked up unless the caller asks
  // for `fresh`. The lookup refuses synthetic labels, and the relay on the far machine still
  // vetoes a session whose transcript is gone — this server cannot see that disk.
  const machineHost = (row.hostname as string) || '';
  const resume = launchResumeDecision({
    fresh: fresh === true,
    resumeSessionId: typeof resumeSessionId === 'string' ? resumeSessionId : '',
    lastSession: lastResumableSession(repoPath, agentType, machineHost),
  });

  const ok = dispatchLaunchToMachine(req.params.id, {
    repoPath,
    agentType,
    sessionId,
    context: typeof context === 'string' ? context : '',
    resumeSessionId: resume,
  });
  if (!ok) return res.status(409).json({ error: 'Machine is offline' });

  console.log(`[machines] Dispatched launch to ${req.params.id}: ${agentType} @ ${repoPath}`
    + (resume ? ` (resuming ${resume})` : ' (fresh session)'));
  // `resumed` is reported back so the UI can say which it did rather than leaving the person to
  // guess whether their context came with them.
  res.json({ ok: true, sessionId, resumed: resume || null });
});

// Set a machine's exposed-folder allowlist from the portal. The runner is the authority on
// what exists on its disk, so we just forward the desired list; it validates + persists +
// re-registers, and the change lands via that register (broadcast as machine_updated).
router.put('/:id/repos', (req, res) => {
  const row = db.prepare('SELECT id FROM machines WHERE id = ?').get(req.params.id) as { id: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Machine not found' });
  if (!Array.isArray(req.body?.repos)) return res.status(400).json({ error: 'repos array required' });
  if (!isMachineOnline(req.params.id)) return res.status(409).json({ error: 'Machine is offline' });

  const repos = normalizeRepos(req.body.repos);
  dispatchSetReposToMachine(req.params.id, repos);
  console.log(`[machines] Sent repo-list update to ${req.params.id} (${repos.length} folders)`);
  res.json({ ok: true });
});

// Ask a machine's runner to scan a directory on its own disk and add the git repos it finds.
router.post('/:id/scan', (req, res) => {
  const row = db.prepare('SELECT id FROM machines WHERE id = ?').get(req.params.id) as { id: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Machine not found' });
  const root = req.body?.root;
  if (!root || typeof root !== 'string') return res.status(400).json({ error: 'root path required' });
  if (!isMachineOnline(req.params.id)) return res.status(409).json({ error: 'Machine is offline' });

  dispatchScanToMachine(req.params.id, root.trim());
  console.log(`[machines] Sent scan request to ${req.params.id}: ${root}`);
  res.json({ ok: true });
});

// Forget a machine (e.g. decommissioned). Does not stop anything already running.
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM machines WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

export default router;
