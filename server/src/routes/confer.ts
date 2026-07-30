import { Router } from 'express';
import db from '../db.js';
import { materializeForRepos, parseAttachmentsInput } from '../lib/attachments.js';
import { fetchPeerAgent } from '../lib/peer-forward.js';
import {
  startConfer,
  recordMilestoneDone,
  listConfers,
  getConfer,
  cancelConfer,
} from '../lib/confer-conductor.js';

const router = Router();

// POST /api/confer/start — begin a milestone-driven confer between 2+ live agents.
router.post('/start', async (req, res) => {
  const { participantIds, task } = req.body as { participantIds?: unknown; task?: unknown };
  if (!Array.isArray(participantIds) || participantIds.length < 2) {
    return res.status(400).json({ error: 'Pick at least two cartridges to confer.' });
  }
  if (typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ error: 'A task is required.' });
  }
  const ids = participantIds.filter((x): x is string => typeof x === 'string');

  // Collaboration shape. `mode` defaults to divide (the historical behavior); `isolation`
  // to shared. Unknown values fall back rather than 400 — the conductor also re-validates
  // (worktree only survives for divide mode).
  const mode = req.body?.mode === 'collaborate' ? 'collaborate' : 'divide';
  const isolation = req.body?.isolation === 'worktree' ? 'worktree' : 'shared';

  let attachments;
  try {
    attachments = parseAttachmentsInput(req.body?.attachments);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const ph = ids.map(() => '?').join(',');
  type ConferRow = { id: string; repo_name: string; repo_path: string; status: string; remote?: boolean };
  const localRows = db.prepare(`SELECT id, repo_name, repo_path, status FROM agents WHERE id IN (${ph})`).all(...ids) as ConferRow[];

  // A cartridge registers with exactly ONE server, so in a two-machine fleet the other
  // machine's participants are legitimately absent here. Rejecting them as "no longer
  // exist" is what made every cross-machine confer impossible to even start.
  const localIds = new Set(localRows.map((r) => r.id));
  const remoteIds = ids.filter((id) => !localIds.has(id));
  const hydrated = await Promise.all(remoteIds.map((id) => fetchPeerAgent(id)));
  const remoteRows = hydrated
    .map((a, i) => (a ? {
      id: (a.id as string) || remoteIds[i],
      repo_name: (a.repoName as string) || '',
      repo_path: (a.repoPath as string) || '',
      status: (a.status as string) || 'idle',
      remote: true,
    } : null))
    .filter(Boolean) as ConferRow[];

  const rows = [...localRows, ...remoteRows];
  if (rows.length !== ids.length) {
    return res.status(400).json({
      error: 'One or more selected cartridges no longer exist on this server or any reachable peer.',
    });
  }
  const offline = rows.filter((r) => r.status === 'offline');
  if (offline.length > 0) {
    return res.status(400).json({ error: 'All selected cartridges must be live (one or more is offline).' });
  }

  // Repo context comes from the participants; they should share one, but we don't force it.
  const repoName = rows[0].repo_name || '';
  const repoPath = rows[0].repo_path || '';

  // Copy any attached files into EVERY participant's repo before the first milestone goes
  // out, so each agent gets a path that resolves in its own checkout. Failing here is a
  // hard 400 — a confer that started without the evidence it was supposed to work from is
  // worse than one that never started.
  const remoteParticipants = rows.filter((r) => r.remote);
  if (remoteParticipants.length > 0 && Array.isArray(attachments) && attachments.length > 0) {
    // Materializing copies files into each participant's checkout, which this server cannot
    // do for a repo on another machine. Refusing is the honest outcome: a confer that starts
    // with half its participants missing the evidence is worse than one that never started.
    return res.status(400).json({
      error: 'Attachments cannot be sent to participants on another server yet — start this confer without attachments, or use participants on one machine.',
    });
  }

  let attachmentBlocks;
  try {
    // Only local checkouts can be written to; remote participants are skipped by construction.
    attachmentBlocks = materializeForRepos(rows.filter((r) => !r.remote).map((r) => r.repo_path), attachments);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const session = startConfer({ repoName, repoPath, participantIds: ids, task: task.trim(), attachmentBlocks, mode, isolation });
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
