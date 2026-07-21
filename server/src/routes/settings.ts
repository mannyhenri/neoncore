import { Router } from 'express';
import db from '../db.js';
import { resetFirstLaunchSentinel, runFirstLaunchSetup } from '../lib/first-launch.js';

const router = Router();

// POST /api/settings/reinstall-hooks — re-run the hook installer on this machine
router.post('/reinstall-hooks', (_req, res) => {
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
