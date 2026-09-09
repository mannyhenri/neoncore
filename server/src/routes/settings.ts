import { Router } from 'express';
import db from '../db.js';
import { resetFirstLaunchSentinel, runFirstLaunchSetup } from '../lib/first-launch.js';
import { SECRET_SETTING_KEYS } from '../lib/auth.js';
import { validateBudgetValue } from '../lib/budget.js';

const router = Router();

// POST /api/settings/reinstall-hooks — re-run the hook installer on this machine
router.post('/reinstall-hooks', (_req, res) => {
  const port = parseInt(process.env.PORT || '4040');
  resetFirstLaunchSentinel();
  runFirstLaunchSetup(port);
  res.json({ ok: true, message: 'Hook installation started — check server logs for progress' });
});

/**
 * Read every setting EXCEPT the secrets.
 *
 * This endpoint dumps the whole table, so any key stored here is readable by whoever can
 * call it — and while auth is permissive, that includes unauthenticated callers. Handing
 * back `fleet_token` would publish the credential that gates the fleet: read it here,
 * present it, and you are fully authorised. Secrets are replaced with a presence flag,
 * which is all the UI needs ("a token is configured") and all an attacker gets.
 */
function readableSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = SECRET_SETTING_KEYS.has(row.key)
      ? (row.value.trim() ? '__set__' : '')
      : row.value;
  }
  return settings;
}

// GET /api/settings - returns all settings as { key: value }, secrets redacted
router.get('/', (_req, res) => {
  res.json(readableSettings());
});

// PUT /api/settings - upsert settings from { key: value } body
router.put('/', (req, res) => {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  // Validate BEFORE writing anything, so a rejected budget cannot land half of a two-key
  // update. This store is a generic string upsert — fine for `projects_dir`, not fine for a
  // number the gauge divides by, where "banana" would store cleanly and surface as NaN days.
  const errors: string[] = [];
  for (const [key, value] of Object.entries(req.body)) {
    if (typeof value !== 'string') continue;
    const err = validateBudgetValue(key, value);
    if (err) errors.push(err);
  }
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  for (const [key, value] of Object.entries(req.body)) {
    if (typeof value !== 'string') continue;
    // A client that GETs settings, edits one field and PUTs the whole object back would
    // otherwise write the redaction placeholder over the real secret — silently replacing
    // the fleet token with the literal string "__set__" and locking out every agent that
    // holds the true one. Ignore the placeholder; a genuine rotation sends a real value.
    if (SECRET_SETTING_KEYS.has(key) && value === '__set__') continue;
    upsert.run(key, value, now);
  }
  res.json(readableSettings());
});

export default router;
