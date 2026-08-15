/**
 * Which goal the Goals workspace is showing.
 *
 * The master–detail layout splits the page across two regions App owns separately — the
 * list in the left rail, the working surface in the right pane — so "which goal" stops
 * being local accordion state and becomes the one value both regions read.
 *
 * It is also the value that can go stale. A goal id can be deleted mid-session, arrive
 * from a week-old notification link, or name the unassigned bucket on a day when every
 * project has a goal. Each of those left the 2/3 pane blank beside a full rail, which
 * reads as "loading" or "broken" rather than "that goal is gone".
 *
 * Hence the split this module is built around: `requested` is what the URL or the user
 * asked for, and `resolveSelection` returns what can actually be SHOWN. The caller never
 * renders `requested` directly.
 */

/** The bucket for projects with no goal. Not a goal id — no goal will ever have this id. */
export const UNASSIGNED = 'unassigned';

const PREFIX = '#goal/';

/**
 * Read a selection out of `location.hash`.
 *
 * Returns null for anything that is not a goal link, INCLUDING `#goal/` with an empty
 * id — an empty string would otherwise flow on as a goal id that matches nothing and
 * resolve to a blank pane, which is the failure this module exists to prevent.
 */
export function parseGoalHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  const raw = hash.slice(PREFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    // A malformed escape is a broken link, not a goal.
    return null;
  }
}

/** The addressable form of a selection, so a notification can point at one goal. */
export function goalHash(selection: string): string {
  return `${PREFIX}${encodeURIComponent(selection)}`;
}

/**
 * What the workspace can actually show, given what was asked for.
 *
 * Order matters: an explicit, still-valid request always wins, because falling back over
 * a request the user just made would fight their click. Everything after it is the
 * never-blank guarantee.
 */
export function resolveSelection({
  goalIds,
  hasUnassigned,
  requested,
}: {
  goalIds: string[];
  hasUnassigned: boolean;
  requested: string | null;
}): string | null {
  if (requested && goalIds.includes(requested)) return requested;
  if (requested === UNASSIGNED && hasUnassigned) return UNASSIGNED;
  // The request named something that no longer exists — fall back rather than blank out.
  if (goalIds.length > 0) return goalIds[0];
  if (hasUnassigned) return UNASSIGNED;
  // Genuinely nothing to show. The workspace renders its empty state; it does not get
  // handed a fabricated id to fail on.
  return null;
}
