/**
 * THE PHONE APP'S UPDATES (lib/mobile-updates.ts):
 *   GET /api/mobile/update?runtime=1&current=<version>&since=<app built at>   { update: manifest | null }
 *   GET /api/mobile/update/:version/files/<path>          one file a manifest lists
 */
import { Router } from 'express';
import { latestUpdate, updateFile } from '../lib/mobile-updates.js';

const router = Router();

router.get('/update', (req, res) => {
  const runtime = String(req.query.runtime ?? '');
  if (!runtime) return res.status(400).json({ error: 'runtime is required' });
  res.json({ update: latestUpdate(runtime, String(req.query.current ?? ''), String(req.query.since ?? '')) });
});

router.get(/^\/update\/([^/]+)\/files\/(.+)$/, (req, res) => {
  const params = req.params as unknown as Record<string, string>;
  let version = '', file = '';
  try { version = decodeURIComponent(params[0]); file = decodeURIComponent(params[1]); } catch { return res.status(404).end(); }
  const full = updateFile(version, file);
  if (!full) return res.status(404).json({ error: 'no such file in that update' });
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(full);
});

export default router;
