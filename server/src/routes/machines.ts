import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { getIO, isMachineOnline, dispatchLaunchToMachine } from '../ws.js';
import type { Machine, MachineRepo } from '../types.js';

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

  const { repoPath, agentType, context } = req.body || {};
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

  const sessionId = `remote-${randomUUID().slice(0, 8)}`;
  const ok = dispatchLaunchToMachine(req.params.id, {
    repoPath,
    agentType,
    sessionId,
    context: typeof context === 'string' ? context : '',
  });
  if (!ok) return res.status(409).json({ error: 'Machine is offline' });

  console.log(`[machines] Dispatched launch to ${req.params.id}: ${agentType} @ ${repoPath}`);
  res.json({ ok: true, sessionId });
});

// Forget a machine (e.g. decommissioned). Does not stop anything already running.
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM machines WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

export default router;
