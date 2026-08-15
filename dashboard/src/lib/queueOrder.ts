import type { QueueItem } from '@neoncore/client';

/**
 * How the queue is ORDERED on screen, in one place, because two surfaces show it.
 *
 * The list was sorted by `createdAt` descending while the ↑/↓ controls manipulate `position`
 * within a `lane`. Pressing an arrow moved the row in the database and the list did not budge,
 * which reads exactly like a dead button — and every layer underneath reported success, so
 * there was nothing to notice. A list sorted by one key and reordered by another makes the
 * control unusable, not merely untidy.
 *
 * Live rows are therefore ordered the way the runner will actually take them; finished rows
 * are history and get the opposite treatment, newest first.
 */

const LIVE = new Set(['queued', 'running', 'blocked']);

export function isLive(item: QueueItem): boolean {
  return LIVE.has(item.status as string);
}

/**
 * Run order for live rows, recency for finished ones.
 *
 * Lanes are kept together rather than interleaved: `position` is only comparable WITHIN a lane,
 * so merging two lanes by position would produce a sequence that means nothing. Sorting is
 * stable, so rows sharing a position keep their relative order instead of shuffling on each
 * 5-second poll.
 */
export function orderQueueRows(items: QueueItem[]): QueueItem[] {
  const live = items.filter(isLive);
  const finished = items.filter((i) => !isLive(i));

  const byRunOrder = [...live].sort((a, b) => {
    if (a.lane !== b.lane) return a.lane < b.lane ? -1 : 1;
    return a.position - b.position;
  });

  const byRecency = [...finished].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return [...byRunOrder, ...byRecency];
}

/**
 * Is this row at either end of its lane?
 *
 * Used to disable an arrow that cannot move anything. The API treats an out-of-range move as a
 * harmless no-op — right for the API, wrong for a button, because an inert control is
 * indistinguishable from a broken one. Finished rows are excluded: they are not in the running
 * order, so one sitting below a live row must not make that row look like it can move down.
 */
export function lanePosition(
  all: QueueItem[],
  id: string,
): { isFirst: boolean; isLast: boolean } {
  const self = all.find((i) => i.id === id);
  if (!self) return { isFirst: true, isLast: true };
  const siblings = all
    .filter((i) => i.lane === self.lane && i.status === 'queued')
    .sort((a, b) => a.position - b.position);
  const idx = siblings.findIndex((i) => i.id === id);
  if (idx === -1) return { isFirst: true, isLast: true };
  return { isFirst: idx === 0, isLast: idx === siblings.length - 1 };
}
