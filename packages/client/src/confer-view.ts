/**
 * Which confers belong in a list beside the runs.
 *
 * SHARED, because the answer is needed on four surfaces across two apps — the desk's Active
 * Runs list, its Recent Runs list, its active count, and the phone's feed — and four copies of
 * one rule is how three of them end up right and one stays wrong. `queue-view.ts` is here for
 * the same reason.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────
 * A confer started from the Confer panel is its own thing and belongs in the list. A confer
 * created BY a workflow step is not: the run that owns it is already in the same list, so
 * showing the session too means one confer appears twice and the active count says 2.
 *
 * Reported as "I have 2 confers running at the same time for baseback and backend-interlag —
 * is there an extra one?". There was not: one confer, two participants, listed once as its run
 * and once as its session.
 *
 * `workflowId` is null for a standalone confer AND for one whose run has been deleted. Both
 * should be listed, which is exactly what this returns — a session with no run to represent it
 * must never be hidden.
 */

/** The fields this module needs. Structural, so it accepts a full ConferSession or a subset. */
export interface OwnableConfer {
  status: string;
  workflowId?: string | null;
}

/** True when a workflow run already represents this confer in the same list. */
export function isOwnedByRun(confer: OwnableConfer): boolean {
  return typeof confer.workflowId === 'string' && confer.workflowId.length > 0;
}

/**
 * The confers to show beside runs: standalone only.
 *
 * Pass the full list; filter by status afterwards, or use the helpers below.
 */
export function standaloneConfers<T extends OwnableConfer>(confers: readonly T[]): T[] {
  return confers.filter((c) => !isOwnedByRun(c));
}

/** Running confers that are not already shown as a run. The Active Runs list and its count. */
export function activeStandaloneConfers<T extends OwnableConfer>(confers: readonly T[]): T[] {
  return standaloneConfers(confers).filter((c) => c.status === 'running');
}

/**
 * Recently finished standalone confers, for a Recent Runs list.
 *
 * `withinMs` defaults to 10 minutes, the window the desk already used.
 */
export function recentStandaloneConfers<T extends OwnableConfer & { completedAt?: string | null }>(
  confers: readonly T[],
  withinMs = 10 * 60 * 1000,
  now: number = Date.now(),
): T[] {
  return standaloneConfers(confers).filter(
    (c) => c.status !== 'running' && !!c.completedAt
      && now - new Date(c.completedAt).getTime() < withinMs,
  );
}
