/**
 * The drain loop — one tick, every lane, crash-safe.
 *
 * Design rules, each of which exists because of a specific way this hurts someone at 3am:
 *
 *  - ADVANCE ONLY ON AN EXPLICIT SIGNAL. Never on idle. See queue-kinds.ts for why.
 *  - A CARTRIDGE RUNS ONE THING AT A TIME. The lane is the ordering unit, but the real
 *    invariant is per-cartridge, and a multi-target item spans several — so an item claims
 *    EVERY target before it starts (see canStart).
 *  - HALT ON A GENUINE WEDGE, RETRY A BLIP. Halting is the safety property that makes this
 *    safe to leave alone; halting on a socket blip, a reconnect or a deploy restart is a queue
 *    nobody can leave running. Every recoverable condition has a BUDGET, and only exhausting
 *    the budget halts.
 *  - NOTHING THROWS OUT OF THE READ PATH. listQueue() feeds emit() and the route, so a single
 *    corrupt row must never take the API down with it.
 *  - STATE LIVES IN THE DATABASE. 24/7 means restarts happen unattended too.
 */
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import { getKind, type QueueItem, type QueueKind, type QueueStatus } from './queue-kinds.js';

/** A wedged item — an agent blocked on a permission prompt nobody will answer overnight —
 *  emits no signal ever, and signal-only advancement cannot see it. The honest cost of
 *  rejecting idle inference. */
const ITEM_CEILING_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 15_000;

/** Consecutive dispatch failures before we stop retrying. The startup race between the runner's
 *  first tick and the websocket coming up is the motivating case: recoverable in seconds. */
export const MAX_DISPATCH_ATTEMPTS = 3;
/** Consecutive ticks a running item's target may be unreachable. A relay reconnect or a window
 *  reload is one or two ticks; a dead cartridge stays gone. */
export const MAX_STALL_TICKS = 4;

function nowIso(): string { return new Date().toISOString(); }

/**
 * Deserialize defensively.
 *
 * The guard belongs HERE, at the boundary, not around the detector: rowToItem is reached
 * through listQueue(), which emit() calls on every state change and which GET /api/queue calls
 * directly. An unguarded JSON.parse meant one corrupt row 500'd the whole queue API and killed
 * every socket notification — for lanes with nothing to do with the bad row.
 */
function safeParse<T>(raw: unknown, fallback: T): { value: T; ok: boolean } {
  if (typeof raw !== 'string' || raw === '') return { value: fallback, ok: true };
  try { return { value: JSON.parse(raw) as T, ok: true }; } catch { return { value: fallback, ok: false }; }
}

export function rowToItem(r: Record<string, unknown>): QueueItem {
  const payload = safeParse<Record<string, unknown>>(r.payload_json, {});
  const targets = safeParse<string[]>(r.targets_json, []);
  return {
    id: r.id as string,
    kind: r.kind as QueueKind,
    payload: payload.value,
    targets: Array.isArray(targets.value) ? targets.value : [],
    lane: (r.lane as string) || 'default',
    status: (r.status as QueueStatus) || 'queued',
    position: (r.position as number) || 0,
    handle: (r.handle as string) || '',
    result: (r.result as string) || '',
    error: (r.error as string) || '',
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string) || null,
    finishedAt: (r.finished_at as string) || null,
    attempts: (r.attempts as number) || 0,
    stallTicks: (r.stall_ticks as number) || 0,
    // Quarantined rather than skipped: an unreadable item is work the user queued, and
    // silently ignoring it loses that work with no trace.
    corrupt: !payload.ok || !targets.ok,
  };
}

function emit(): void {
  try { getIO().emit('queue_updated', listQueue() as never); } catch { /* no socket in tests */ }
}

export function listQueue(): QueueItem[] {
  const rows = db.prepare('SELECT * FROM queue_items ORDER BY lane, position, created_at').all() as Record<string, unknown>[];
  return rows.map(rowToItem);
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export function enqueue(input: {
  kind: QueueKind; payload: Record<string, unknown>; targets?: string[]; lane?: string;
}): { ok: true; item: QueueItem } | { ok: false; error: string } {
  let def;
  try { def = getKind(input.kind); } catch (err) { return { ok: false, error: (err as Error).message }; }

  const payload = { ...input.payload };
  const targets = input.targets?.length ? input.targets : (payload.targets as string[]) || [];
  // Validation at the door, while a human is watching — not at 3am when it comes up.
  const problem = def.validate({ ...payload, targets });
  if (problem) return { ok: false, error: problem };

  const lane = input.lane || (input.kind === 'prompt' ? `agent:${targets[0]}` : `repo:${(payload.repoPath as string) || 'default'}`);
  const next = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM queue_items WHERE lane = ?')
    .get(lane) as { n: number }).n;

  const id = uuid();
  db.prepare(`
    INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(id, input.kind, JSON.stringify(payload), JSON.stringify(targets), lane, next, nowIso());

  const item = rowToItem(db.prepare('SELECT * FROM queue_items WHERE id = ?').get(id) as Record<string, unknown>);
  emit();
  return { ok: true, item };
}

// ---------------------------------------------------------------------------
// Lane control
// ---------------------------------------------------------------------------

function laneState(lane: string): { paused: boolean; haltedReason: string } {
  const r = db.prepare('SELECT paused, halted_reason FROM queue_lanes WHERE lane = ?').get(lane) as
    { paused: number; halted_reason: string } | undefined;
  return { paused: Boolean(r?.paused), haltedReason: r?.halted_reason || '' };
}

/** Stop a lane WITH a reason. Other lanes keep draining — a problem in one cartridge is never a
 *  reason to stop the machine. */
export function haltLane(lane: string, reason: string): void {
  db.prepare(`
    INSERT INTO queue_lanes (lane, paused, halted_reason) VALUES (?, 1, ?)
    ON CONFLICT(lane) DO UPDATE SET paused = 1, halted_reason = excluded.halted_reason
  `).run(lane, reason);
  console.warn(`[queue] lane ${lane} HALTED: ${reason}`);
}

export function resumeLane(lane: string): void {
  db.prepare(`
    INSERT INTO queue_lanes (lane, paused, halted_reason) VALUES (?, 0, '')
    ON CONFLICT(lane) DO UPDATE SET paused = 0, halted_reason = ''
  `).run(lane);
  db.prepare("UPDATE queue_items SET attempts = 0, stall_ticks = 0 WHERE lane = ? AND status = 'queued'").run(lane);
  emit();
}

export function cancelItem(id: string): boolean {
  const info = db.prepare("UPDATE queue_items SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','running')")
    .run(nowIso(), id);
  if (info.changes) { unstampFor(id); emit(); }
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Binding + the per-cartridge invariant
// ---------------------------------------------------------------------------

function stamp(agentIds: string[], itemId: string): void {
  const s = db.prepare('UPDATE agents SET active_queue_item_id = ? WHERE id = ?');
  for (const a of agentIds) s.run(itemId, a);
}

/** Always clear the stamp when an item leaves 'running', however it left — a stale stamp would
 *  bind the NEXT completion report to an item that has already finished. */
function unstampFor(itemId: string): void {
  db.prepare("UPDATE agents SET active_queue_item_id = '' WHERE active_queue_item_id = ?").run(itemId);
}

/**
 * An item claims EVERY target before it starts.
 *
 * `lane` names one cartridge, so a prompt queued to [A,B] sits in lane agent:A while an item
 * queued to B sits in lane agent:B — and both tick, driving cartridge B from two lanes at once.
 * "One thing at a time" is the premise of the whole design and multi-target is exactly the case
 * the user asked for ("one or many cartridges").
 *
 * The stamp already records who is busy, so the check is a lookup rather than a second
 * bookkeeping system. Cost: a fan-out waits for its busiest target. That is the honest meaning
 * of "run this on A, B and C".
 */
function busyTargets(item: QueueItem): string[] {
  if (item.targets.length === 0) return [];
  const placeholders = item.targets.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id FROM agents WHERE id IN (${placeholders}) AND active_queue_item_id != '' AND active_queue_item_id != ?`
  ).all(...item.targets, item.id) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Can this cartridge take new work RIGHT NOW?
 *
 * 'working' and 'waiting' both mean no: waiting is blocked on a question, and dropping a new
 * prompt on top of an unanswered one is how the answer gets misread as a reply to the wrong
 * thing. A stamped agent is mid queue-item even if its status has not caught up yet, so the
 * stamp counts too.
 *
 * An UNKNOWN agent is deliberately not busy. Treating absence as busy would queue work against
 * a cartridge that does not exist, where it would wait forever with nothing to release it —
 * absence of evidence is not evidence of work.
 */
export function isCartridgeBusy(agentId: string): boolean {
  if (!agentId) return false;
  const row = db.prepare('SELECT status, active_queue_item_id FROM agents WHERE id = ?')
    .get(agentId) as { status?: string; active_queue_item_id?: string } | undefined;
  if (!row) return false;
  if (row.active_queue_item_id) return true;
  return row.status === 'working' || row.status === 'waiting';
}

function finish(item: QueueItem, status: QueueStatus, detail: string): void {
  db.prepare('UPDATE queue_items SET status = ?, finished_at = ?, result = ?, error = ? WHERE id = ?')
    .run(status, nowIso(), status === 'done' ? detail : '', status === 'done' ? '' : detail, item.id);
  unstampFor(item.id);
  emit();
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export function tickQueue(now = Date.now()): void {
  const lanes = db.prepare("SELECT DISTINCT lane FROM queue_items WHERE status IN ('queued','running')")
    .all() as { lane: string }[];
  for (const { lane } of lanes) {
    // Per-lane catch: one broken lane must never stop the others, and an exception here would
    // otherwise propagate out of the interval callback and kill the loop for the whole machine.
    try { tickLane(lane, now); } catch (err) {
      console.error(`[queue] lane ${lane} tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function tickLane(lane: string, now: number): void {
  if (laneState(lane).paused) return;

  const runningRow = db.prepare("SELECT * FROM queue_items WHERE lane = ? AND status = 'running' ORDER BY position LIMIT 1")
    .get(lane) as Record<string, unknown> | undefined;

  if (runningRow) {
    const item = rowToItem(runningRow);
    if (settleRunning(item, lane, now) === 'wait') return;
  }

  const nextRow = db.prepare("SELECT * FROM queue_items WHERE lane = ? AND status = 'queued' ORDER BY position LIMIT 1")
    .get(lane) as Record<string, unknown> | undefined;
  if (!nextRow) return;
  const next = rowToItem(nextRow);

  // Quarantine before dispatch: an unreadable row can never run, and retrying it forever would
  // block the lane on a row nobody can fix without seeing it.
  if (next.corrupt) {
    finish(next, 'failed', 'unreadable queue row — payload or targets is not valid JSON');
    haltLane(lane, `item ${next.id.slice(0, 8)} is corrupt`);
    return;
  }

  const busy = busyTargets(next);
  if (busy.length) return; // a target is running something else; wait, do not halt

  void startItem(next);
}

/** Returns 'wait' when the lane must not start anything else this tick. */
function settleRunning(item: QueueItem, lane: string, now: number): 'wait' | 'advance' {
  // CEILING FIRST, before the detector: a wedged item is exactly where the detector answers
  // 'running' forever, so the ceiling must not sit behind it.
  const started = item.startedAt ? Date.parse(item.startedAt) : now;
  if (now - started > ITEM_CEILING_MS) {
    finish(item, 'failed', `exceeded the ${Math.round(ITEM_CEILING_MS / 3600000)}h ceiling with no completion signal`);
    haltLane(lane, `item ${item.id.slice(0, 8)} timed out`);
    return 'wait';
  }

  // A target that is unreachable RIGHT NOW may be reconnecting. Budgeted, not fatal on sight.
  const unreachable = item.targets.filter((t) => {
    const a = db.prepare('SELECT status FROM agents WHERE id = ?').get(t) as { status?: string } | undefined;
    return !a || a.status === 'offline';
  });
  if (unreachable.length) {
    const ticks = item.stallTicks + 1;
    db.prepare('UPDATE queue_items SET stall_ticks = ? WHERE id = ?').run(ticks, item.id);
    if (ticks >= MAX_STALL_TICKS) {
      finish(item, 'failed', `target unreachable for ${ticks} ticks: ${unreachable.join(', ')}`);
      haltLane(lane, `a target of ${item.id.slice(0, 8)} stayed offline`);
    }
    return 'wait';
  }
  if (item.stallTicks) db.prepare('UPDATE queue_items SET stall_ticks = 0 WHERE id = ?').run(item.id);

  let verdict;
  try {
    verdict = getKind(item.kind).isComplete(item);
  } catch (err) {
    // A throwing detector is "cannot tell", which halts. It must never read as complete, and it
    // must not take the tick down with it.
    finish(item, 'failed', `detector threw: ${err instanceof Error ? err.message : String(err)}`);
    haltLane(lane, `detector for ${item.kind} threw`);
    return 'wait';
  }

  if (verdict.state === 'running') return 'wait';
  if (verdict.state === 'needs_attention') {
    finish(item, 'failed', verdict.reason);
    haltLane(lane, verdict.reason);
    return 'wait';
  }
  finish(item, 'done', verdict.reason);
  console.log(`[queue] ${item.kind} ${item.id.slice(0, 8)} done — ${verdict.reason}`);
  return 'advance';
}

/**
 * Arm the work standard for a queued prompt.
 *
 * armOnWork only arms on a MUTATING tool, deliberately: answering a question should never
 * oblige you to file a completion report. Correct for free conversation and fatal as a queue
 * signal — a read-only prompt ("research X", "review this") would never arm, so evaluateStop
 * never returns cleared, so the item could never complete and would hang to the 6h ceiling.
 * A QUEUED ITEM IS NOT FREE CONVERSATION: it is dispatched work with a known objective, which
 * is the exact condition lazy arming was carved out to protect. So arm it here.
 */
function armForQueue(agentIds: string[]): void {
  const arm = db.prepare(
    `UPDATE agents SET standard_offered = 1, standard_armed = 1, standard_blocks = 0, standard_state = ''
     WHERE id = ?`,
  );
  for (const a of agentIds) arm.run(a);
}

async function startItem(item: QueueItem): Promise<void> {
  db.prepare("UPDATE queue_items SET status = 'running', started_at = ?, stall_ticks = 0 WHERE id = ?").run(nowIso(), item.id);
  stamp(item.targets, item.id);

  try {
    const { handle, targets } = await getKind(item.kind).dispatch(item);
    const live = targets.length ? targets : item.targets;
    db.prepare('UPDATE queue_items SET handle = ?, targets_json = ?, attempts = 0 WHERE id = ?')
      .run(handle, JSON.stringify(live), item.id);
    if (targets.length) stamp(targets, item.id);
    if (item.kind === 'prompt') armForQueue(live);
    console.log(`[queue] started ${getKind(item.kind).describe(item)} (${item.id.slice(0, 8)})`);
    emit();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const attempts = item.attempts + 1;

    // TRANSIENT UNTIL PROVEN OTHERWISE. The motivating case is the startup race: the runner's
    // first tick can land before the websocket is up, and halting there killed every lane at
    // once on "WebSocket not initialized". Put it back in the queue, keep its position, retry.
    if (attempts < MAX_DISPATCH_ATTEMPTS) {
      db.prepare("UPDATE queue_items SET status = 'queued', started_at = NULL, attempts = ? WHERE id = ?")
        .run(attempts, item.id);
      unstampFor(item.id);
      console.warn(`[queue] dispatch attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS} failed for ${item.id.slice(0, 8)}: ${reason}`);
      emit();
      return;
    }
    // Budget exhausted: retrying forever is its own silent failure — a queue that looks busy
    // and completes nothing.
    db.prepare('UPDATE queue_items SET attempts = ? WHERE id = ?').run(attempts, item.id);
    finish(item, 'failed', `dispatch failed ${attempts}x: ${reason}`);
    haltLane(item.lane, `dispatch failed ${attempts}x: ${reason}`);
  }
}

/**
 * Boot-time reconcile. A restart mid-item leaves a 'running' row; unattended operation means
 * restarts happen unattended too.
 *
 * The ITEM always fails — its completion arrived while we were down, the stamp is gone, and
 * guessing is what this whole design refuses to do. But the LANE only halts when the target is
 * still 'working', because that is the only case where continuing is actually unsafe. An idle
 * or offline agent is demonstrably not mid-prompt, and halting there means every deploy leaves
 * a lane needing a human — over a week of restarts the queue converges on fully stopped.
 */
export function reconcileQueue(): void {
  const rows = db.prepare("SELECT * FROM queue_items WHERE status = 'running'").all() as Record<string, unknown>[];
  for (const r of rows) {
    const item = rowToItem(r);
    if (item.kind !== 'prompt') {
      console.log(`[queue] reconcile: re-observing ${item.kind} ${item.handle.slice(0, 8)}`);
      continue;
    }
    const stillWorking = item.targets.filter((t) => {
      const a = db.prepare('SELECT status FROM agents WHERE id = ?').get(t) as { status?: string } | undefined;
      return a?.status === 'working';
    });
    finish(item, 'failed', 'server restarted while this prompt was running — its completion could not be observed');
    if (stillWorking.length) {
      haltLane(item.lane, `restarted while ${stillWorking.join(', ')} was still working — may still be mid-prompt`);
    } else {
      console.log(`[queue] reconcile: lane ${item.lane} continues — no target was still working`);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startQueueRunner(): void {
  if (timer) return;
  reconcileQueue();
  timer = setInterval(() => {
    try { tickQueue(); } catch (err) {
      console.error(`[queue] tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }, TICK_MS);
  console.log(`[queue] runner started — advancing on explicit completion signals only, every ${TICK_MS / 1000}s`);
}

export function stopQueueRunner(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
