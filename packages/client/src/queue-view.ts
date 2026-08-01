/**
 * Rules for showing queue items next to the things they create.
 *
 * Shared because both surfaces face the same question and got it wrong the same way: a confer
 * queued against a busy cartridge appeared once as its own queue item and again as the real
 * ConferCard the moment it started, so one confer read as two.
 */
import type { QueueItem } from './types.js';

/** Kinds that produce a session with its own card. A prompt does not — it is a task-list row. */
const SESSION_KINDS = new Set(['confer', 'workflow']);

/**
 * Is this item waiting to become a session, with nothing else on screen representing it?
 *
 * `handle` is the discriminator, not `status`. A dispatched item carries the id of the session
 * it created, and that session owns the rendering from then on — so a handle means "something
 * else is already showing this". Keying on status alone is what produced the duplicate: a
 * `running` item has dispatched, but "running" reads like "still ours to show".
 *
 * The reverse case matters too and is why this is not simply `status === 'queued'`: an item
 * marked running that has NOT yet produced a handle is mid-dispatch, and nothing else on screen
 * represents it. Dropping it there would blink the session out of view during handoff.
 */
export function isWaitingSession(item: QueueItem): boolean {
  if (!SESSION_KINDS.has(item.kind)) return false;
  if (item.handle) return false;
  return item.status === 'queued' || item.status === 'running';
}
