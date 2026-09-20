import { guardBusy } from '../lib/queue-if-busy.js';
import { Router } from 'express';
import db from '../db.js';
import { materializeForRepos, parseAttachmentsInput } from '../lib/attachments.js';
import { fetchPeerAgent } from '../lib/peer-forward.js';
import { isLocalMachine, machineLabel } from '../lib/machine-locality.js';
import {
  startConfer,
  recordMilestoneDone,
  listConfers,
  getConfer,
  cancelConfer,
  resumeConfer,
  clampBuildRounds,
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
  // How many times the build/fix milestone runs. Clamped, never rejected — see clampBuildRounds.
  const buildRounds = clampBuildRounds(req.body?.buildRounds);

  let attachments;
  try {
    attachments = parseAttachmentsInput(req.body?.attachments);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const ph = ids.map(() => '?').join(',');
  type ConferRow = { id: string; repo_name: string; repo_path: string; status: string; machine?: string; remote?: boolean };
  // `remote` is about the FILESYSTEM, not the database. A relay on another Mac registers
  // into this very DB, so presence here says nothing about whether its repo_path exists on
  // this box — only `machine` does.
  const dbRows = (db.prepare(`SELECT id, repo_name, repo_path, status, machine FROM agents WHERE id IN (${ph})`).all(...ids) as ConferRow[])
    .map((r) => ({ ...r, remote: !isLocalMachine(r.machine) }));

  // A cartridge registers with exactly ONE server, so in a two-machine fleet the other
  // machine's participants are legitimately absent here. Rejecting them as "no longer
  // exist" is what made every cross-machine confer impossible to even start.
  const knownIds = new Set(dbRows.map((r) => r.id));
  const remoteIds = ids.filter((id) => !knownIds.has(id));
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

  const rows = [...dbRows, ...remoteRows];
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
    // Name the MACHINE — a raw foreign path reads as a stale/deleted repo and sends you
    // hunting through your own settings for a directory that was never yours.
    const machines = [...new Set(remoteParticipants.map((r) => machineLabel(r.machine)))].join(', ');
    const who = remoteParticipants.map((r) => r.repo_name || r.id).join(', ');
    return res.status(400).json({
      error: `Attachments cannot be sent to cartridges on another machine yet — ${who} runs on ${machines}. Start this confer without attachments, or pick participants on this machine.`,
    });
  }

  let attachmentBlocks;
  try {
    // Only local checkouts can be written to; remote participants are skipped by construction.
    attachmentBlocks = materializeForRepos(rows.filter((r) => !r.remote).map((r) => r.repo_path), attachments);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  // QUEUE INSTEAD OF INTERRUPT — and it must sit HERE, not at the top of the handler.
  // repoName/repoPath are resolved from the participant rows above; a check placed before that
  // resolution can only store the raw request body, and dispatch then fails hours later with
  // "NOT NULL constraint failed: confer_sessions.repo_name". What we enqueue must equal what we
  // would have dispatched.
  if (req.body?.queueIfBusy !== false) {
    const guard = guardBusy({
      kind: 'confer',
      targets: ids,
      // A confer owns its repos: a busy sibling in a participant's checkout holds it too.
      repoScoped: true,
      payload: { repoName, repoPath, participantIds: ids, task: task.trim(), mode, isolation, buildRounds },
    });
    if ('error' in guard) return res.status(400).json({ error: guard.error });
    if (guard.queued) {
      return res.status(202).json({
        queued: true,
        item: guard.item,
        note: `${guard.busy.length} cartridge(s) busy in the confer's repos — the confer was queued and starts when they are free`,
      });
    }
  }

  const session = startConfer({ repoName, repoPath, participantIds: ids, task: task.trim(), attachmentBlocks, mode, isolation, buildRounds });
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

router.post('/:id/resume', async (req, res) => {
  try {
    const result = await resumeConfer(req.params.id);
    if (!result.ok) return res.status(409).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
