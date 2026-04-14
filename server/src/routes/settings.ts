import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import { pushNotify } from '../lib/push-notify.js';
import { resetFirstLaunchSentinel, runFirstLaunchSetup } from '../lib/first-launch.js';
import type { PermissionRequest } from '../types.js';

const router = Router();

// Test ntfy push notification
router.post('/push-test', async (_req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('ntfy_url') as { value: string } | undefined;
  const url = row?.value?.trim();
  if (!url) {
    return res.status(400).json({ error: 'No ntfy URL configured — add one in Settings → Notifications' });
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Title': 'NeonCore Test', 'Content-Type': 'text/plain; charset=utf-8' },
      body: 'Test notification from NeonCore — push notifications are working!',
    });
    if (!r.ok) throw new Error(`ntfy returned ${r.status}: ${r.statusText}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/settings/notify-test — fires both the in-app bell AND a phone push
router.post('/notify-test', async (_req, res) => {
  const id = uuid();
  const now = new Date().toISOString();

  // Emit socket event directly (no DB insert — avoids FK constraint)
  // The dashboard bell treats any permission_requested event as actionable
  const payload: PermissionRequest = {
    id,
    agentId: 'test',
    toolName: 'AskUserQuestion',
    toolInput: '{}',
    description: 'Test notification — does this appear on your dashboard and phone?',
    status: 'pending',
    createdAt: now,
    decidedAt: null,
    response: '',
  };
  getIO().emit('permission_requested', payload);

  // Fire ntfy phone push simultaneously
  await pushNotify('NeonCore — Test', 'Test notification — does this appear on your dashboard and phone?');

  res.json({ ok: true });
});

// POST /api/settings/reinstall-hooks — re-run the hook installer on this machine
router.post('/reinstall-hooks', (req, res) => {
  const port = parseInt(process.env.PORT || '4040');
  resetFirstLaunchSentinel();
  runFirstLaunchSetup(port);
  res.json({ ok: true, message: 'Hook installation started — check server logs for progress' });
});

// GET /api/settings - returns all settings as { key: value }
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
});

// PUT /api/settings - upsert settings from { key: value } body
router.put('/', (req, res) => {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  for (const [key, value] of Object.entries(req.body)) {
    if (typeof value === 'string') {
      upsert.run(key, value, now);
    }
  }
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
});

export default router;
