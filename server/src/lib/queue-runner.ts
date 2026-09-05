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

/**
 * How long a QUEUED item may wait for a busy target before its lane halts and says so.
 *
 * Deliberately far larger than MAX_STALL_TICKS, which measures liveness of something already
 * running (one minute of silence is suspicious). This measures a cartridge legitimately doing
 * work, and a real turn runs for many minutes — 240 ticks is an hour. Tuned tighter, healthy
 * lanes would halt routinely, people would learn to resume without reading the reason, and
 * the halt that mattered would be resumed along with the rest.
 *
 * The wait itself is correct behaviour; only the SILENCE is the defect. So this does not
 * dispatch onto busy work at the deadline — it stops and names the cartridge holding the lane.
 */
export const MAX_BLOCKED_TICKS = 240;

/**
 * How long a blocker may be SILENT before waiting on it counts as a wedge.
 *
 * Deliberately far longer than the recovery sweep's 5 minutes: that one asks "did this
 * executor die mid-step", while this asks "is the thing I am queued behind ever coming back".
 * A cartridge mid-`cargo build` is silent for minutes and perfectly healthy; one that has said
 * nothing for half an hour while claiming to work is not.
 */
export const BLOCKER_WEDGED_MS = 30 * 60 * 1000;

/** Halt kinds. Only a transient one may clear itself. */
const HALT_BLOCKED = 'blocked';

/**
 * A halt whose CAUSE resolves itself, so the lane must not need a human to clear it.
 *
 * REPORTED: "a task assigned for a cartridge and the agent was idled and it didn't execute it."
 * Three halts had transient causes and only one said so. The other two — a target that was
 * offline, and this process restarting mid-prompt — left the lane stopped forever, with work
 * queued behind a cartridge that had been idle for hours. Restart the server a few times in a
 * day and lanes accumulate stopped, each looking from the outside like an empty queue.
 *
 * Resuming is SAFE and is not the same as dispatching: the auto-resume path still refuses while
 * the blocker is wedged, and once the lane is open the ordinary busyTargets check holds the item
 * until the cartridge is actually free. Un-freezing a lane only lets the normal rules apply again.
 *
 * A halt for a real fault — a corrupt row, a detector that threw, a dispatch that failed three
 * times — is NOT in here on purpose. Those need a person, because nothing about waiting fixes them.
 */
const HALT_TRANSIENT = 'transient';
const SELF_CLEARING: ReadonlySet<string> = new Set([HALT_BLOCKED, HALT_TRANSIENT]);

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
    paused: ((r.paused as number) || 0) === 1,
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

  // Cartridge-scoped kinds get a per-cartridge lane; repo-scoped kinds (which can span
  // several cartridges) get a per-repo one. A `task` is aimed at exactly one cartridge, so it
  // belongs in that cartridge's lane beside prompts — not in the repo bucket, where it would
  // fail to serialise against the prompts hitting the same cartridge.
  const agentLaned = input.kind === 'prompt' || input.kind === 'task';
  const lane = input.lane || (agentLaned ? `agent:${targets[0]}` : `repo:${(payload.repoPath as string) || 'default'}`);
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

function laneState(lane: string): { paused: boolean; haltedReason: string; haltKind: string } {
  const r = db.prepare('SELECT paused, halted_reason, halt_kind FROM queue_lanes WHERE lane = ?').get(lane) as
    { paused: number; halted_reason: string; halt_kind: string } | undefined;
  return { paused: Boolean(r?.paused), haltedReason: r?.halted_reason || '', haltKind: r?.halt_kind || '' };
}

/**
 * Is this cartridge WEDGED, or merely busy?
 *
 * Busy is normal and needs patience — these cartridges run for hours. Wedged means the thing
 * we are queued behind is not coming back on its own: it is offline, or it claims to be working
 * while having said nothing for BLOCKER_WEDGED_MS. Only the second justifies stopping a lane,
 * because only the second needs a person.
 *
 * `waiting` is explicitly NOT wedged: an agent blocked on a human is alive, and halting its
 * lane would add a second thing for that human to fix.
 */
function blockerIsWedged(agentId: string): boolean {
  const a = db.prepare('SELECT status, last_seen FROM agents WHERE id = ?').get(agentId) as
    { status?: string; last_seen?: string } | undefined;
  if (!a) return true;                       // vanished entirely
  if (a.status === 'offline') return true;
  if (a.status === 'waiting') return false;  // blocked on a person, not dead
  const silent = a.last_seen ? Date.now() - Date.parse(a.last_seen) : Infinity;
  return Number.isFinite(silent) ? silent > BLOCKER_WEDGED_MS : true;
}

/** Stop a lane WITH a reason. Other lanes keep draining — a problem in one cartridge is never a
 *  reason to stop the machine. */
export function haltLane(lane: string, reason: string, haltedBy = '', kind = ''): void {
  db.prepare(`
    INSERT INTO queue_lanes (lane, paused, halted_reason, halted_by, halt_kind) VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(lane) DO UPDATE SET paused = 1, halted_reason = excluded.halted_reason,
      halt_kind = excluded.halt_kind,
                                    halted_by = excluded.halted_by
  `).run(lane, reason, haltedBy, kind);
  console.warn(`[queue] lane ${lane} HALTED: ${reason}`);
}

export function resumeLane(lane: string): void {
  db.prepare(`
    INSERT INTO queue_lanes (lane, paused, halted_reason, halted_by) VALUES (?, 0, '', '')
    ON CONFLICT(lane) DO UPDATE SET paused = 0, halted_reason = '', halted_by = ''
  `).run(lane);
  db.prepare("UPDATE queue_items SET attempts = 0, stall_ticks = 0 WHERE lane = ? AND status = 'queued'").run(lane);
  emit();
}

/**
 * Put a finished-but-unsuccessful item back in its lane.
 *
 * Retry is not "clear the error". Four separate pieces of state independently prevent an item
 * from running again — the terminal status, the attempt counter (which would halt the lane
 * after one more failure), the stall counter, and the lane halt the failure caused. Clearing
 * three of them yields an item that sits in the queue looking healthy and never runs, which is
 * strictly worse than a visible failure.
 *
 * started_at is cleared too, or the 6h ceiling would measure from the ORIGINAL start and a
 * retried item could time out immediately.
 *
 * The lane is resumed ONLY if it was halted by THIS item. A lane stopped by something else —
 * or by a human — stays stopped, otherwise retrying one item silently restarts work somebody
 * deliberately paused.
 */
/**
 * Statuses a row may be cleared in. Derived from what each MEANS, not from the words "done,
 * failed, cancelled": `blocked` reads as finished and is not — it is stopped and waiting on a
 * human, and removing it discards the only record of why a lane stopped.
 */
const CLEARABLE: QueueStatus[] = ['done', 'failed', 'cancelled'];

/**
 * Delete ONE finished row. Returns false if it is still live, so the caller cannot quietly
 * remove work in flight by passing the wrong id.
 *
 * Deliberately per item rather than a bulk sweep: a bulk clear removes rows the user never
 * looked at, and this is the only destructive action on the page with no undo.
 */
export function removeItem(id: string): boolean {
  const marks = CLEARABLE.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM queue_items WHERE id = ? AND status IN (${marks})`)
    .run(id, ...CLEARABLE);
  if (info.changes) emit();
  return info.changes > 0;
}

export function retryItem(id: string): boolean {
  const row = db.prepare('SELECT id, lane, status FROM queue_items WHERE id = ?').get(id) as
    { id: string; lane: string; status: QueueStatus } | undefined;
  if (!row) return false;
  // Only terminal states. Retrying a running item would double-dispatch it.
  if (!['failed', 'cancelled'].includes(row.status)) return false;

  db.prepare(`UPDATE queue_items
              SET status = 'queued', attempts = 0, stall_ticks = 0, error = '',
                  started_at = NULL, finished_at = NULL
              WHERE id = ?`).run(id);

  const lane = db.prepare('SELECT paused, halted_by FROM queue_lanes WHERE lane = ?')
    .get(row.lane) as { paused: number; halted_by: string } | undefined;
  if (lane?.paused && lane.halted_by === id) resumeLane(row.lane);

  emit();
  return true;
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
/**
 * ONE definition of busy, shared with the route guard.
 *
 * This used to consult only active_queue_item_id, so a cartridge working on something a
 * human started by hand read as FREE and the next queued item dispatched straight on top of
 * it. The route said busy, the runner said free, and the collision the queue exists to
 * prevent happened one tick after the queue politely deferred it.
 *
 * The item's OWN stamp is exempt: a target already stamped for this item is doing this
 * item's work, and counting that as busy would deadlock the item against itself.
 */
function busyTargets(item: QueueItem): string[] {
  if (item.targets.length === 0) return [];
  const placeholders = item.targets.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, status, active_queue_item_id, pending_question FROM agents WHERE id IN (${placeholders})`
  ).all(...item.targets) as
    { id: string; status: string; active_queue_item_id: string; pending_question: string }[];
  return rows
    .filter((r) => {
      if (r.active_queue_item_id === item.id) return false; // ours — already working for us
      if (r.active_queue_item_id) return true;              // held by another item
      if (r.status === 'working') return true;
      // Same rule as isCartridgeBusy: `waiting` blocks only when a person actually owes this
      // cartridge an answer. THIS COPY IS WHY THE FIRST FIX DID NOT WORK — isCartridgeBusy
      // guards ENQUEUE, this guards DISPATCH, and correcting only the first left every queued
      // item still parked behind a cartridge idling with a stale `waiting` flag. Observed
      // straight after that fix shipped: two confers and a prompt sat waiting while the
      // cartridge did nothing.
      if (r.status === 'waiting') return (r.pending_question || '').trim().length > 0;
      return false;
    })
    .map((r) => r.id);
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
  const row = db.prepare('SELECT status, active_queue_item_id, pending_question FROM agents WHERE id = ?')
    .get(agentId) as { status?: string; active_queue_item_id?: string; pending_question?: string } | undefined;
  if (!row) return false;
  // Already carrying queued work, whatever its status claims.
  if (row.active_queue_item_id) return true;
  if (row.status === 'working') return true;

  /**
   * `waiting` counts ONLY when there is a real question outstanding.
   *
   * A cartridge that ends a session in `waiting` with no pending question is not blocked on
   * anything — it is idle with a stale flag — but this returned true for it, so the queue held
   * its lane shut indefinitely. Seen live: three confers stacked behind a cartridge that had
   * been doing nothing for half an hour, the oldest stalled 141 ticks, and no surface anywhere
   * said anything was wrong, because from the queue's point of view nothing was.
   *
   * With a genuine question it stays busy on purpose: a person owes it an answer, and the next
   * prompt to arrive is treated as that answer (see `isAnswerToPendingQuestion`), so letting
   * queued work jump in would feed unrelated text to a blocked agent.
   */
  if (row.status === 'waiting') return (row.pending_question || '').trim().length > 0;

  /**
   * OFFLINE COUNTS. It cannot take work now, so work aimed at it must QUEUE and wait.
   *
   * This returned false, on the reasoning that queueing against something absent waits forever.
   * But the runner already budgets exactly this case — an unreachable target burns MAX_STALL_TICKS
   * and then halts the lane with a stated reason — so the wait is bounded and visible, while
   * returning false meant the work dispatched into a cartridge with no channel and the step died
   * "Command not delivered". Reported as a workflow that "didn't work and didn't send".
   *
   * An UNKNOWN agent (no row at all) is still not busy, above: nothing will ever bring it back,
   * so there the original reasoning holds.
   */
  if (row.status === 'offline') return true;

  return false;
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
  const state = laneState(lane);
  if (state.paused) {
    // A halt for "the cartridge was busy" is transient by definition. If it outlives its cause
    // the lane sits stopped with work queued behind a cartridge that is free again — the exact
    // overnight failure the halt existed to prevent. So that ONE kind clears itself; a halt
    // from a real dispatch failure still waits for a human.
    if (!SELF_CLEARING.has(state.haltKind)) return;
    const next = db.prepare(
      "SELECT * FROM queue_items WHERE lane = ? AND status = 'queued' AND paused = 0 ORDER BY position LIMIT 1",
    ).get(lane) as Record<string, unknown> | undefined;
    if (!next) return;
    const stillWedged = rowToItem(next).targets.some(blockerIsWedged);
    if (stillWedged) return;
    console.log(`[queue] lane ${lane} auto-resumed — the blocker is healthy again`);
    resumeLane(lane);
  }

  const runningRow = db.prepare("SELECT * FROM queue_items WHERE lane = ? AND status = 'running' ORDER BY position LIMIT 1")
    .get(lane) as Record<string, unknown> | undefined;

  if (runningRow) {
    const item = rowToItem(runningRow);
    if (settleRunning(item, lane, now) === 'wait') return;
  }

  // `paused = 0` is what makes a per-item pause a SKIP rather than a block: the lane steps
  // over a parked item and runs the next eligible one.
  const nextRow = db.prepare("SELECT * FROM queue_items WHERE lane = ? AND status = 'queued' AND paused = 0 ORDER BY position LIMIT 1")
    .get(lane) as Record<string, unknown> | undefined;
  if (!nextRow) return;
  const next = rowToItem(nextRow);

  // Quarantine before dispatch: an unreadable row can never run, and retrying it forever would
  // block the lane on a row nobody can fix without seeing it.
  if (next.corrupt) {
    finish(next, 'failed', 'unreadable queue row — payload or targets is not valid JSON');
    haltLane(lane, `item ${next.id.slice(0, 8)} is corrupt`, next.id);
    return;
  }

  const busy = busyTargets(next);
  if (busy.length) {
    // Wait — but count the wait. Unbounded silent waiting is the failure this whole file is
    // written against: an item behind a cartridge wedged in 'working' or parked on a
    // permission prompt would sit there all night looking exactly like a healthy queue.
    // startItem() zeroes this on dispatch, so it always measures ONE continuous block rather
    // than the sum of every polite wait this lane has ever done.
    const ticks = next.stallTicks + 1;
    db.prepare('UPDATE queue_items SET stall_ticks = ? WHERE id = ?').run(ticks, next.id);
    // Time alone is NOT a wedge. These cartridges legitimately work for hours, and halting on
    // duration stopped healthy lanes and left them stopped after the work finished. Halt only
    // when the blocker is not coming back by itself.
    if (ticks >= MAX_BLOCKED_TICKS) {
      const wedged = busy.filter(blockerIsWedged);
      if (wedged.length > 0) {
        haltLane(
          lane,
          `waited ${Math.round((ticks * TICK_MS) / 60000)} min for ${wedged.join(', ')}, which is offline or silent — nothing behind it can run`,
          next.id,
          HALT_BLOCKED,
        );
      }
      // Healthy but busy: keep waiting, and stop re-counting so the log is not noise.
      else db.prepare('UPDATE queue_items SET stall_ticks = ? WHERE id = ?').run(MAX_BLOCKED_TICKS, next.id);
    }
    return;
  }

  void startItem(next);
}

/** Returns 'wait' when the lane must not start anything else this tick. */
function settleRunning(item: QueueItem, lane: string, now: number): 'wait' | 'advance' {
  // CEILING FIRST, before the detector: a wedged item is exactly where the detector answers
  // 'running' forever, so the ceiling must not sit behind it.
  const started = item.startedAt ? Date.parse(item.startedAt) : now;
  if (now - started > ITEM_CEILING_MS) {
    finish(item, 'failed', `exceeded the ${Math.round(ITEM_CEILING_MS / 3600000)}h ceiling with no completion signal`);
    haltLane(lane, `item ${item.id.slice(0, 8)} timed out`, item.id);
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
      // Transient: an offline cartridge comes back. The auto-resume path will not release the
      // lane until it does, so this cannot dispatch into a machine that is still gone.
      haltLane(lane, `a target of ${item.id.slice(0, 8)} stayed offline`, item.id, HALT_TRANSIENT);
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
    haltLane(lane, `detector for ${item.kind} threw`, item.id);
    return 'wait';
  }

  if (verdict.state === 'running') return 'wait';
  if (verdict.state === 'needs_attention') {
    finish(item, 'failed', verdict.reason);
    haltLane(lane, verdict.reason, item.id);
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
    haltLane(item.lane, `dispatch failed ${attempts}x: ${reason}`, item.id);
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
      // Transient: "may still be mid-prompt" stops being true the moment that cartridge is
      // free, and the auto-resume path asks exactly that. Left permanent, every deploy or crash
      // that caught a running prompt stopped its lane until someone noticed.
      haltLane(item.lane, `restarted while ${stillWorking.join(', ')} was still working — may still be mid-prompt`, item.id, HALT_TRANSIENT);
    } else {
      console.log(`[queue] reconcile: lane ${item.lane} continues — no target was still working`);
    }
  }
}

/**
 * Run a waiting item NOW, because a human said so.
 *
 * This is the one place allowed to dispatch onto a busy cartridge, and the distinction is
 * the whole point: the bug this feature exists to fix is the SYSTEM deciding to start work
 * on top of running work. A person looking at the queue, seeing what is holding it, and
 * choosing to go anyway is not that — it is the escape hatch that makes the automatic
 * caution safe to keep. Without it, "queue instead of interrupt" has no manual override and
 * an item behind a wedged cartridge is unreachable.
 *
 * Everything that could keep it queued is undone together, for the same reason retryItem
 * undoes all four: clearing three of four leaves an item that looks started and never runs.
 */
export function startNow(itemId: string): { ok: true } | { ok: false; error: string } {
  const raw = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(itemId) as Record<string, unknown> | undefined;
  if (!raw) return { ok: false, error: 'no such queue item' };
  const item = rowToItem(raw);

  if (item.corrupt) return { ok: false, error: 'this row is unreadable and cannot be dispatched' };
  if (item.status === 'running') return { ok: false, error: 'this item is already running' };
  if (item.status === 'done' || item.status === 'failed' || item.status === 'cancelled') {
    return { ok: false, error: `this item is already ${item.status} — use retry instead` };
  }

  // THE LIMIT OF THE OVERRIDE. "Go anyway" is meaningful when the cartridge is busy with work
  // the queue does not own — the only cost is two things talking at once. It is NOT meaningful
  // when the cartridge already carries another queue item: stamp() overwrites
  // active_queue_item_id unconditionally, so dispatching would move the stamp, land this
  // prompt on top of in-flight work, and bind the RUNNING item's completion report to this
  // one. The first item could then never complete and this one would complete on work it never
  // did. An override that silently corrupts attribution is not an override.
  const carrying = db.prepare(
    `SELECT a.id, a.active_queue_item_id FROM agents a
      WHERE a.id IN (${item.targets.map(() => '?').join(',') || "''"})
        AND a.active_queue_item_id != '' AND a.active_queue_item_id != ?`,
  ).all(...item.targets, itemId) as { id: string; active_queue_item_id: string }[];
  if (carrying.length > 0) {
    const other = carrying[0].active_queue_item_id.slice(0, 8);
    return {
      ok: false,
      error: `${carrying[0].id} is already running queue item ${other}. `
        + `Starting this now would land it on top of that work and misattribute its completion. `
        + `Cancel or wait for ${other}, or use Start now once it finishes.`,
    };
  }

  // A halted lane is one of the ways an item gets stuck, so starting by hand has to clear it
  // too. Otherwise the item runs and everything behind it stays stopped, and the user has to
  // find a second, differently-named control to get the lane moving again.
  resumeLane(item.lane);

  // Jump the lane: the human asked for THIS one, not for whatever happens to be first.
  const { m } = db.prepare('SELECT COALESCE(MIN(position), 0) AS m FROM queue_items WHERE lane = ?')
    .get(item.lane) as { m: number };
  db.prepare("UPDATE queue_items SET position = ?, stall_ticks = 0, attempts = 0, error = '', paused = 0 WHERE id = ?")
    .run(m - 1, itemId);

  const fresh = rowToItem(db.prepare('SELECT * FROM queue_items WHERE id = ?').get(itemId) as Record<string, unknown>);
  console.log(`[queue] start-now: ${getKind(fresh.kind).describe(fresh)} (${itemId.slice(0, 8)}) dispatched by hand`);
  void startItem(fresh);
  return { ok: true };
}

/**
 * Move a queued item one place up or down WITHIN its lane.
 *
 * Positions are swapped rather than renumbered: renumbering the whole lane would rewrite rows
 * the runner may be reading, and a gap-based scheme drifts until two items collide. A swap is
 * closed over the set of positions already in use.
 */
export function moveItem(itemId: string, direction: 'up' | 'down'): { ok: true } | { ok: false; error: string } {
  const raw = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(itemId) as Record<string, unknown> | undefined;
  if (!raw) return { ok: false, error: 'no such queue item' };
  const item = rowToItem(raw);
  // Work already in flight has left the queue's control — its position no longer decides
  // anything, and moving it would only make the list lie about what is happening.
  if (item.status !== 'queued') return { ok: false, error: `only a queued item can be reordered — this one is ${item.status}` };

  const neighbour = db.prepare(
    direction === 'up'
      ? "SELECT * FROM queue_items WHERE lane = ? AND status = 'queued' AND position < ? ORDER BY position DESC LIMIT 1"
      : "SELECT * FROM queue_items WHERE lane = ? AND status = 'queued' AND position > ? ORDER BY position ASC LIMIT 1",
  ).get(item.lane, item.position) as Record<string, unknown> | undefined;

  // Already at the end. A no-op, not an error: the button exists on every row, and refusing
  // the first row's "up" would be a failure message for doing nothing wrong.
  if (!neighbour) return { ok: true };

  const other = rowToItem(neighbour);
  const swap = db.prepare('UPDATE queue_items SET position = ? WHERE id = ?');
  swap.run(other.position, item.id);
  swap.run(item.position, other.id);
  emit();
  return { ok: true };
}

/**
 * Hold ONE item without holding its lane.
 *
 * A paused item is skipped by the runner, not blocking — everything behind it keeps draining.
 * If it blocked, this would be `haltLane` with a friendlier name, and pausing one thing would
 * silently stop five others.
 *
 * Stored as a column rather than a status because `blocked` already means "the system stopped
 * this and a human must look", which needs different UI and different recovery from "I parked
 * this deliberately". A paused item is still `queued`; it is simply not eligible.
 */
export function pauseItem(itemId: string): { ok: true } | { ok: false; error: string } {
  const raw = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as { status?: string } | undefined;
  if (!raw) return { ok: false, error: 'no such queue item' };
  if (raw.status !== 'queued') return { ok: false, error: `only a queued item can be paused — this one is ${raw.status}` };
  db.prepare('UPDATE queue_items SET paused = 1 WHERE id = ?').run(itemId);
  emit();
  return { ok: true };
}

export function resumeItem(itemId: string): { ok: true } | { ok: false; error: string } {
  const raw = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as { status?: string } | undefined;
  if (!raw) return { ok: false, error: 'no such queue item' };
  // Position is untouched by pause/resume, so it returns to exactly where it was waiting.
  db.prepare('UPDATE queue_items SET paused = 0 WHERE id = ?').run(itemId);
  emit();
  return { ok: true };
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
