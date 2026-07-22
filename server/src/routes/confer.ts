import { Router } from 'express';
import db from '../db.js';
import {
  startConfer,
  recordMilestoneDone,
  listConfers,
  getConfer,
  cancelConfer,
} from '../lib/confer-conductor.js';

const router = Router();

// POST /api/confer/start — begin a milestone-driven confer between 2+ live agents.
router.post('/start', (req, res) => {
  const { participantIds, task } = req.body as { participantIds?: unknown; task?: unknown };
  if (!Array.isArray(participantIds) || participantIds.length < 2) {
    return res.status(400).json({ error: 'Pick at least two cartridges to confer.' });
  }
  if (typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ error: 'A task is required.' });
  }
  const ids = participantIds.filter((x): x is string => typeof x === 'string');

  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, repo_name, repo_path, status FROM agents WHERE id IN (${ph})`).all(...ids) as
    { id: string; repo_name: string; repo_path: string; status: string }[];
  if (rows.length !== ids.length) {
    return res.status(400).json({ error: 'One or more selected cartridges no longer exist.' });
  }
  const offline = rows.filter((r) => r.status === 'offline');
  if (offline.length > 0) {
    return res.status(400).json({ error: 'All selected cartridges must be live (one or more is offline).' });
  }

  // Repo context comes from the participants; they should share one, but we don't force it.
  const repoName = rows[0].repo_name || '';
  const repoPath = rows[0].repo_path || '';

  const session = startConfer({ repoName, repoPath, participantIds: ids, task: task.trim() });
  res.json(session);
});

// POST /api/confer/:sessionId/milestone/:agentId/done — an agent signals a milestone complete.
// This is THE completion path; each milestone prompt bakes in the exact curl to hit it.
router.post('/:sessionId/milestone/:agentId/done', (req, res) => {
  const result = typeof req.body?.result === 'string' ? req.body.result : '';
  const outcome = recordMilestoneDone(req.params.sessionId, req.params.agentId, result);
  if (!outcome.ok) return res.status(400).json({ error: outcome.error });
  res.json({ ok: true });
});

// GET /api/confer — all confer sessions (newest first).
router.get('/', (_req, res) => {
  res.json(listConfers());
});

// GET /api/confer/:id — one session with its milestones.
router.get('/:id', (req, res) => {
  const session = getConfer(req.params.id);
  if (!session) return res.status(404).json({ error: 'Confer not found' });
  res.json(session);
});

// POST /api/confer/:id/cancel — stop a running confer.
router.post('/:id/cancel', (req, res) => {
  const session = cancelConfer(req.params.id);
  if (!session) return res.status(404).json({ error: 'Confer not found' });
  res.json(session);
});

export default router;
