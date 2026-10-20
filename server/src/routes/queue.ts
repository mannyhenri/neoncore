/**
 * Queue routes — add work, see it, stop it.
 *
 * Thin on purpose: every decision lives in queue-kinds.ts (what can run, how we know it ended)
 * and queue-runner.ts (when it runs). These handlers validate the request shape and delegate,
 * so there is exactly one place that decides whether an item is finished.
 */
import { Router } from 'express';
import db from '../db.js';
import { KIND_IDS, getKind, type QueueKind, type QueueItem } from '../lib/queue-kinds.js';
import { enqueue, listQueue, cancelItem, retryItem, removeItem, haltLane, resumeLane, tickQueue, startNow, moveItem, pauseItem, resumeItem, publicQueueItem } from '../lib/queue-runner.js';

const router = Router();

/**
 * The wire form of a queue item: the row plus what it IS, in words.
 *
 * `description` is DERIVED on every read rather than stored at enqueue, because a queued workflow
 * names the run it points at and that run can be renamed while the item waits its turn — which
 * for a queue is most of its life. Each kind's own `describe` is the single authority, the same
 * one `[queue] started …` prints, so the panel and the log say the same words about the same item.
 *
 * Applied by EVERY response that returns an item, not just the list: an item that arrives from
 * enqueue without a description renders as a uuid until the next poll replaces it, which reads
 * as a bug in the queue rather than in the serializer.
 */
const toWire = (i: QueueItem) => ({ ...publicQueueItem(i), description: getKind(i.kind).describe(i) });

router.get('/', (_req, res) => {
  const items = listQueue().map(toWire);
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
  return res.status(201).json(toWire(out.item));
});

/** Cancel a queued or running item. Cancelling unstamps its agents, so a late completion
 *  report from the cancelled item cannot bind to whatever runs next. */
router.delete('/:id', (req, res) => {
  if (!cancelItem(req.params.id)) return res.status(404).json({ error: 'no queued or running item with that id' });
  res.json({ ok: true });
});

/** Put a failed or cancelled item back in its lane, undoing everything that stopped it. */
/**
 * Remove ONE finished row. 409 rather than 404 when the row is still live: the item exists,
 * the action just does not apply to it yet, and the caller should be told which.
 */
router.delete('/:id/remove', (req, res) => {
  if (!removeItem(req.params.id)) {
    return res.status(409).json({ error: 'only a finished item can be cleared — cancel it first' });
  }
  res.json({ ok: true });
});

// Run a waiting item NOW. The one sanctioned way to dispatch onto a busy cartridge — a
// person looked at what is holding the lane and chose to go anyway.
router.post('/:id/start', (req, res) => {
  const out = startNow(req.params.id);
  if (!out.ok) return res.status(409).json({ error: out.error });
  res.json({ ok: true });
});

// Reorder one place within the lane. Up/down rather than an absolute index: the client never
// has to know the lane's numbering, so two people reordering at once cannot write conflicting
// absolute positions.
router.post('/:id/move', (req, res) => {
  const dir = req.body?.direction;
  if (dir !== 'up' && dir !== 'down') return res.status(400).json({ error: "direction must be 'up' or 'down'" });
  const out = moveItem(req.params.id, dir);
  if (!out.ok) return res.status(409).json({ error: out.error });
  res.json({ ok: true });
});

// Park ONE item. The lane keeps draining around it — that is the difference from pausing a lane.
router.post('/:id/pause', (req, res) => {
  const out = pauseItem(req.params.id);
  if (!out.ok) return res.status(409).json({ error: out.error });
  res.json({ ok: true });
});

router.post('/:id/resume', (req, res) => {
  const out = resumeItem(req.params.id);
  if (!out.ok) return res.status(409).json({ error: out.error });
  res.json({ ok: true });
});

router.post('/:id/retry', (req, res) => {
  if (!retryItem(req.params.id)) {
    return res.status(409).json({ error: 'only a finished item (done, failed or cancelled) can be retried' });
  }
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
