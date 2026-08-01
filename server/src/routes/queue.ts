/**
 * Queue routes — add work, see it, stop it.
 *
 * Thin on purpose: every decision lives in queue-kinds.ts (what can run, how we know it ended)
 * and queue-runner.ts (when it runs). These handlers validate the request shape and delegate,
 * so there is exactly one place that decides whether an item is finished.
 */
import { Router } from 'express';
import db from '../db.js';
import { KIND_IDS, getKind, type QueueKind } from '../lib/queue-kinds.js';
import { enqueue, listQueue, cancelItem, haltLane, resumeLane, tickQueue } from '../lib/queue-runner.js';

const router = Router();

router.get('/', (_req, res) => {
  const items = listQueue();
  const lanes = db.prepare('SELECT lane, paused, halted_reason FROM queue_lanes').all() as
    { lane: string; paused: number; halted_reason: string }[];
  res.json({
    items,
    lanes: lanes.map((l) => ({ lane: l.lane, paused: Boolean(l.paused), haltedReason: l.halted_reason })),
    kinds: KIND_IDS,
  });
});

router.post('/', (req, res) => {
  const { kind, payload, targets, lane } = req.body ?? {};
  if (!KIND_IDS.includes(kind as QueueKind)) {
    return res.status(400).json({ error: `kind must be one of: ${KIND_IDS.join(', ')}` });
  }
  const out = enqueue({
    kind: kind as QueueKind,
    payload: (payload as Record<string, unknown>) ?? {},
    targets: Array.isArray(targets) ? targets : undefined,
    lane: typeof lane === 'string' ? lane : undefined,
  });
  // A rejected item is a 400 the user sees NOW, rather than an item that fails at 3am.
  if (!out.ok) return res.status(400).json({ error: out.error });
  return res.status(201).json(out.item);
});

/** Dry-run validation, so a UI can check an item before adding it. */
router.post('/validate', (req, res) => {
  const { kind, payload } = req.body ?? {};
  if (!KIND_IDS.includes(kind as QueueKind)) {
    return res.status(400).json({ error: `kind must be one of: ${KIND_IDS.join(', ')}` });
  }
  const problem = getKind(kind as QueueKind).validate((payload as Record<string, unknown>) ?? {});
  return res.json({ ok: problem === null, error: problem });
});

router.delete('/:id', (req, res) => {
  if (!cancelItem(req.params.id)) return res.status(404).json({ error: 'no queued or running item with that id' });
  res.json({ ok: true });
});

router.post('/lanes/:lane/pause', (req, res) => {
  haltLane(req.params.lane, (req.body?.reason as string) || 'paused by the user');
  res.json({ ok: true });
});

/** Resuming is explicit and manual by design: a lane halts because something needed a human,
 *  so auto-resuming would discard the only signal that asked for one. */
router.post('/lanes/:lane/resume', (req, res) => {
  resumeLane(req.params.lane);
  res.json({ ok: true });
});

/** Advance now instead of waiting for the timer — used by tests and the dashboard. */
router.post('/tick', (_req, res) => {
  tickQueue();
  res.json({ ok: true });
});

export default router;
