import { describe, it, expect } from 'vitest';
import { orderQueueRows, lanePosition } from '../lib/queueOrder';
import type { QueueItem } from '@neoncore/client';

/**
 * The queue list must be shown in RUN ORDER, because that is what the arrows manipulate.
 *
 * THE BUG THIS PINS. TasksPage sorted its queue rows by `createdAt` descending and ignored
 * `lane` and `position` — the two fields that actually decide what runs next. So pressing ↑
 * on a row moved it in the database (verified against the live server: pos 42 → 41, HTTP 200)
 * and the list did not budge. From the outside that is indistinguishable from a dead button,
 * which is exactly how it was reported.
 *
 * A list sorted by one key and reordered by another is not a cosmetic mismatch: it makes the
 * control unusable while every layer underneath reports success.
 */

let n = 0;
function item(over: Partial<QueueItem> = {}): QueueItem {
  n += 1;
  return {
    id: over.id ?? `i${n}`,
    kind: 'prompt',
    payload: {},
    targets: [],
    lane: 'agent:a',
    status: 'queued',
    position: 0,
    handle: '',
    result: '',
    error: '',
    createdAt: new Date(2026, 0, n).toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    stallTicks: 0,
    ...over,
  } as QueueItem;
}

const ids = (rows: QueueItem[]) => rows.map((r) => r.id);

describe('queue row ordering', () => {
  it('orders LIVE items by lane then position — the order they will actually run in', () => {
    const rows = orderQueueRows([
      item({ id: 'b', lane: 'agent:a', position: 2 }),
      item({ id: 'a', lane: 'agent:a', position: 1 }),
      item({ id: 'c', lane: 'agent:a', position: 3 }),
    ]);
    expect(ids(rows)).toEqual(['a', 'b', 'c']);
  });

  it('reflects a reorder — the property the arrows depend on', () => {
    // Same rows, positions swapped, as the server leaves them after a move.
    const before = orderQueueRows([
      item({ id: 'x', lane: 'agent:a', position: 1 }),
      item({ id: 'y', lane: 'agent:a', position: 2 }),
    ]);
    const after = orderQueueRows([
      item({ id: 'x', lane: 'agent:a', position: 2 }),
      item({ id: 'y', lane: 'agent:a', position: 1 }),
    ]);
    expect(ids(before)).toEqual(['x', 'y']);
    expect(ids(after)).toEqual(['y', 'x']);
  });

  it('does NOT order live items by createdAt — the exact defect', () => {
    // Newest-first would put 'late' on top even though it runs last.
    const rows = orderQueueRows([
      item({ id: 'late', lane: 'agent:a', position: 9, createdAt: new Date(2026, 5, 1).toISOString() }),
      item({ id: 'early', lane: 'agent:a', position: 1, createdAt: new Date(2026, 0, 1).toISOString() }),
    ]);
    expect(ids(rows)).toEqual(['early', 'late']);
  });

  it('keeps lanes together rather than interleaving them', () => {
    // Positions are only comparable WITHIN a lane, so interleaving two lanes by position
    // produces an order that means nothing.
    const rows = orderQueueRows([
      item({ id: 'a2', lane: 'agent:a', position: 2 }),
      item({ id: 'b1', lane: 'repo:/x', position: 1 }),
      item({ id: 'a1', lane: 'agent:a', position: 1 }),
      item({ id: 'b2', lane: 'repo:/x', position: 2 }),
    ]);
    const lanes = rows.map((r) => r.lane);
    expect(lanes).toEqual([...lanes].sort());
    expect(ids(rows)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('puts finished rows after live ones, newest first', () => {
    // A finished item has no meaningful position, and what you want from history is the most
    // recent thing — the opposite of what you want from a queue.
    const rows = orderQueueRows([
      item({ id: 'old-done', status: 'done', createdAt: new Date(2026, 0, 1).toISOString() }),
      item({ id: 'live', status: 'queued', position: 5 }),
      item({ id: 'new-done', status: 'failed', createdAt: new Date(2026, 6, 1).toISOString() }),
      item({ id: 'running', status: 'running', position: 1 }),
    ]);
    expect(ids(rows)).toEqual(['running', 'live', 'new-done', 'old-done']);
  });

  it('is stable when positions collide, rather than reshuffling on every poll', () => {
    // The list re-renders every 5s. Two rows sharing a position must not swap places at random,
    // or the queue appears to shuffle on its own.
    const rows = [
      item({ id: 'p', lane: 'agent:a', position: 1 }),
      item({ id: 'q', lane: 'agent:a', position: 1 }),
    ];
    expect(ids(orderQueueRows(rows))).toEqual(ids(orderQueueRows(rows)));
  });
});

describe('end-of-lane detection', () => {
  it('reports first/last WITHIN the lane, so the arrows can be disabled', () => {
    // Without this the arrows look identical at the ends and clicking does nothing — a no-op
    // is correct behaviour, but an inert control is indistinguishable from a broken one.
    const all = [
      item({ id: 'a1', lane: 'agent:a', position: 1 }),
      item({ id: 'a2', lane: 'agent:a', position: 2 }),
      item({ id: 'b1', lane: 'repo:/x', position: 1 }),
    ];
    expect(lanePosition(all, 'a1')).toEqual({ isFirst: true, isLast: false });
    expect(lanePosition(all, 'a2')).toEqual({ isFirst: false, isLast: true });
    // Alone in its lane: both ends at once, so neither arrow can do anything.
    expect(lanePosition(all, 'b1')).toEqual({ isFirst: true, isLast: true });
  });

  it('ignores finished rows when deciding the ends', () => {
    // A completed row is not in the running order, so it must not make a live row look
    // "not last" and leave an arrow enabled that cannot move anything.
    const all = [
      item({ id: 'live', lane: 'agent:a', position: 1 }),
      item({ id: 'done', lane: 'agent:a', position: 2, status: 'done' }),
    ];
    expect(lanePosition(all, 'live')).toEqual({ isFirst: true, isLast: true });
  });
});
