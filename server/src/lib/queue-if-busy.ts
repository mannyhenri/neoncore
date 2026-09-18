/**
 * ONE decision, shared by every entry point that starts work on a cartridge.
 *
 * The rule is simple to state — "a cartridge works one thing at a time, so anything you
 * start while it is busy lines up behind what it is doing" — and it was implemented three
 * separate times, in three route handlers, with three different results. Prompts and confers
 * got it right. Workflows mentioned all the right identifiers and still started on top of
 * running work, because the check consulted a set of cartridges that is empty in the most
 * common case. Tasks never checked at all.
 *
 * Three implementations of one rule is three chances to get it wrong, so this is the only
 * one. A route decides WHAT it is about to drive; this decides whether that can start now.
 *
 * ── WHAT A CORRECT GUARD HAS TO DO, ALL THREE ─────────────────────────────────────────
 *   1. Check the REAL targets. Not "the cartridges pinned to this template's steps" when
 *      the cartridge actually comes from the launch modal — a proxy set that is empty in
 *      the common case is a check that never fires and reads as a check that passed.
 *   2. Store those targets on the item. The runner re-checks busyTargets(item) before it
 *      dispatches; an item with targets:[] makes that guard vacuous and lands on the busy
 *      cartridge anyway, one tick later, looking like the queue ignored it.
 *   3. Land in a lane that means something. `repo:default` is the fallback when a payload
 *      carries no repoPath — everything there serialises against unrelated work while
 *      failing to serialise against the cartridge it targets.
 *
 * All three failing at once is what made the workflow bug look like "the queue is ignored"
 * rather than "the queue is subtly wrong".
 */
import db from '../db.js';
import { enqueue, isCartridgeBusy } from './queue-runner.js';
import type { QueueKind, QueueItem } from './queue-kinds.js';
import { inboxReachable } from './inbox-client.js';
import { workflowCartridges } from './workflow-cartridges.js';

/**
 * Can this cartridge take a message while it is mid-turn? Only an addressed inbox can — the
 * relay's PTY paste lands in the input buffer behind the current turn, which is the wait
 * `deliverNow` exists to skip.
 */
function hasAddressedInbox(agentId: string): boolean {
  const row = db.prepare('SELECT inbox_pid FROM agents WHERE id = ?').get(agentId) as
    { inbox_pid?: number } | undefined;
  /*
   * REACHABLE, not merely recorded. `inbox_pid` is written once when the relay
   * starts and is never cleared when the session exits, so a stored pid is
   * evidence that a cartridge ONCE had an inbox — not that it has one now.
   * Skipping the queue on a stale pid drops the dispatch exactly the way this
   * comment above says must not happen, so the check asks the transport whether
   * it can actually be reached.
   */
  return inboxReachable(row?.inbox_pid ?? 0);
}

export interface BusyGuardSpec {
  kind: QueueKind;
  /** The cartridges this work will actually drive. Resolved by the caller, not guessed here. */
  targets: string[];
  /**
   * Everything the dispatcher will need LATER. Dispatch happens minutes or hours after
   * enqueue, so an argument the route computed but did not store is gone by then
   * (see queued-payload-sufficiency.test.ts — this is how a confer used to fail three times
   * on a NOT NULL constraint and halt its lane).
   */
  payload: Record<string, unknown>;
  /**
   * ADX-007 — "start it now", on a cartridge that is already working.
   *
   * OPT-IN ONLY. Seven call sites across five routes rely on "busy means queue", and that stays
   * the default; this is a per-dispatch override a human asks for.
   *
   * It bypasses the queue ONLY when the target can actually receive a mid-turn message — i.e.
   * it has an addressed inbox. Skipping the queue without a transport would DROP the work,
   * which is worse than making it wait, so a cartridge with no inbox queues as usual even when
   * this is set. The flag asks for "now"; it cannot manufacture a road.
   */
  deliverNow?: boolean;
}

export type BusyGuardResult =
  | { queued: true; item: QueueItem; busy: string[] }
  | { queued: false }
  | { error: string };

/**
 * Queue the work if any target cartridge is busy; otherwise report that it may start now.
 *
 * The item waits on ALL its targets, not only the ones busy at this instant — by the time
 * the lane comes round, a target that was idle may have picked something up.
 */
export function guardBusy(spec: BusyGuardSpec): BusyGuardResult {
  const targets = [...new Set(spec.targets.filter(Boolean))];
  const busy = targets.filter(isCartridgeBusy);
  if (busy.length === 0) return { queued: false };

  // ADX-007: an explicit "now" skips the wait, but only where every busy target can actually be
  // reached mid-turn. One target without an inbox is enough to queue the whole item: a dispatch
  // that reached two cartridges out of three and silently dropped the third would be worse than
  // one that waited for all of them.
  if (spec.deliverNow && busy.every(hasAddressedInbox)) return { queued: false };

  const out = enqueue({ kind: spec.kind, payload: spec.payload, targets });
  if (!out.ok) return { error: out.error };
  return { queued: true, item: out.item, busy };
}

/**
 * Which cartridges will this workflow run actually drive?
 *
 * THE BUG THIS FUNCTION IS. The previous inline query asked only for step rows with a
 * concrete executor_id:
 *
 *     SELECT DISTINCT executor_id FROM workflow_steps
 *      WHERE workflow_id = ? AND executor_id != '' AND executor_id != '__deferred__'
 *
 * A TEMPLATE's steps are '__deferred__' — "ask me at launch" — so for the single most common
 * path (pick a template, pick a cartridge, hit Run) that query returns nothing, the busy set
 * is empty, and the run starts on top of whatever the cartridge is doing. The cartridge was
 * never in the step rows; it arrived in the request body.
 *
 * So the answer is the union of all three ways a step gets an executor, matching what the
 * start handler itself does further down:
 *   · executor_id already pinned on the step
 *   · body.agentId       — fills EVERY step that hasn't got one
 *   · body.agentOverrides — per-step assignment from the run modal
 */
export function resolveWorkflowTargets(
  workflowId: string,
  body: Record<string, unknown> | undefined,
): string[] {
  // Delegates to the shared resolver. This used to carry its own copy reading executor_id,
  // body.agentId and body.agentOverrides — three of the seven sources — so a run-level CONFER
  // resolved to NO targets and the busy guard happily started it on top of live work. The
  // launch guard had been taught about confer and this had not, which is precisely the
  // "satisfies one guard, fails the other" split the header warned about.
  return workflowCartridges(workflowId, body);
}
