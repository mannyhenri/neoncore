import { describe, it, expect } from 'vitest';
import {
  TASK_FILTERS, queueItemAsTask, selectTaskRows, taskActions, queueRowActions, type TaskRow,
} from '../taskView';
import type { Task, TaskStatus } from '../types';
import type { QueueItem, QueueStatus } from '@neoncore/client';

/**
 * Managing tasks on the phone the way the desk does.
 *
 * TWO REPORTED SYMPTOMS, ONE CAUSE EACH.
 *
 * "I don't always see tasks" — the web Tasks page renders TWO lists under one filter: real
 * tasks, and queue items mapped onto the task vocabulary (TasksPage.tsx `visibleQueue`).
 * Mobile called only `listTasks`. With the server holding 0 tasks and a full queue, the desk
 * showed a page of work and the phone said "No tasks." Same server, two answers.
 *
 * "I can't really start them" — mobile offered `Send` only for `queued`, and nothing else:
 * no mark-done, no mark-failed, no clear. A task that had drifted to any other status was
 * inert on the phone.
 *
 * THE SET. Two registries, iterated, never sampled:
 *  - `TaskStatus` — all 6. Every one must be REACHABLE (some filter shows it) and must carry
 *    the same verbs the desk offers for it.
 *  - `QueueStatus` — all 6. Every one must map onto the task vocabulary, because an
 *    unmapped status silently drops that row from the phone, which is the original bug.
 * An example-based test ("done tasks appear") passes on a filter set missing `cancelled`,
 * which is exactly the half-done version this prevents.
 */

const ALL_TASK_STATUSES: TaskStatus[] = ['queued', 'claimed', 'in_progress', 'done', 'failed', 'cancelled'];
const ALL_QUEUE_STATUSES: QueueStatus[] = ['queued', 'running', 'done', 'failed', 'blocked', 'cancelled'];

const task = (id: string, status: TaskStatus): Task => ({
  id, title: `task-${id}`, prompt: '', status, priority: 0,
  createdAt: '2026-08-22T10:00:00.000Z',
} as Task);

const qitem = (id: string, status: QueueStatus): QueueItem => ({
  id, kind: 'prompt', payload: { text: `queued work ${id}` }, targets: [],
  lane: 'agent:x', status, position: 1, handle: '', result: '', error: '',
  createdAt: '2026-08-22T10:00:00.000Z',
} as unknown as QueueItem);

describe('mobile task parity: seeing the work', () => {
  it('the filter registry covers EVERY task status — none is unreachable', () => {
    const unreachable: string[] = [];
    for (const st of ALL_TASK_STATUSES) {
      const rows: TaskRow[] = ALL_TASK_STATUSES.map((s) => ({ ...queueItemAsTask(qitem(s, 'queued')), id: s, status: s, title: s, kind: 'task' } as TaskRow));
      const reachable = TASK_FILTERS.some((f) => selectTaskRows(
        ALL_TASK_STATUSES.map((s) => task(s, s)), [], f.key,
      ).some((r) => r.status === st));
      if (!reachable) unreachable.push(st);
      void rows;
    }
    expect(unreachable, `no filter can show: ${unreachable.join(', ')}`).toEqual([]);
  });

  it('EVERY queue status maps onto the task vocabulary — an unmapped one vanishes', () => {
    const bad: string[] = [];
    for (const qs of ALL_QUEUE_STATUSES) {
      const mapped = queueItemAsTask(qitem('q1', qs));
      if (!ALL_TASK_STATUSES.includes(mapped.status)) {
        bad.push(`${qs} -> ${mapped.status ?? 'undefined'}`);
      }
      if (!mapped.title) bad.push(`${qs} produced a row with no title`);
    }
    expect(bad, `queue statuses not mapped:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('queue items appear alongside tasks — the reported "No tasks" with a full queue', () => {
    const rows = selectTaskRows([], [qitem('q1', 'queued'), qitem('q2', 'running')], 'all');
    expect(rows.length, 'a full queue with zero tasks must not render as empty').toBe(2);
    expect(rows.every((r) => r.kind === 'queue')).toBe(true);
  });

  it('"all" hides nothing — every status of both kinds survives it', () => {
    const tasks = ALL_TASK_STATUSES.map((s) => task(s, s));
    const items = ALL_QUEUE_STATUSES.map((s) => qitem(s, s));
    const rows = selectTaskRows(tasks, items, 'all');
    expect(rows.length).toBe(ALL_TASK_STATUSES.length + ALL_QUEUE_STATUSES.length);
  });

  it('"active" is exactly the live set, for both kinds', () => {
    const tasks = ALL_TASK_STATUSES.map((s) => task(s, s));
    const items = ALL_QUEUE_STATUSES.map((s) => qitem(s, s));
    const rows = selectTaskRows(tasks, items, 'active');
    const statuses = [...new Set(rows.map((r) => r.status))].sort();
    expect(statuses).toEqual(['claimed', 'in_progress', 'queued']);
  });
});

describe('mobile task parity: acting on the work', () => {
  /**
   * The desk's rule, read off TasksPage.tsx: everything non-terminal can be cancelled,
   * marked done, or marked failed; a terminal row can be cleared. `queued` additionally
   * dispatches. Authoring (create/edit) is desk work and is asserted separately.
   */
  const EXPECTED: Record<TaskStatus, string[]> = {
    queued: ['dispatch', 'cancel', 'done', 'failed'],
    claimed: ['cancel', 'done', 'failed'],
    in_progress: ['cancel', 'done', 'failed'],
    done: ['clear'],
    failed: ['clear'],
    cancelled: ['clear'],
  };

  it('EVERY status offers the same verbs the desk offers', () => {
    const wrong: string[] = [];
    for (const st of ALL_TASK_STATUSES) {
      const got = [...taskActions(st)].sort();
      const want = [...EXPECTED[st]].sort();
      if (got.join(',') !== want.join(',')) {
        wrong.push(`${st}: expected [${want}] got [${got}]`);
      }
    }
    expect(wrong, `action parity broken:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('no status is a dead end — every one offers at least one action', () => {
    const dead = ALL_TASK_STATUSES.filter((s) => taskActions(s).length === 0);
    expect(dead, `inert on the phone: ${dead.join(', ')}`).toEqual([]);
  });
});

describe('mobile task parity: acting on QUEUE rows', () => {
  /** The desk's gates, read off TasksPage `QueueRow`. */
  const EXPECTED_Q: Record<QueueStatus, string[]> = {
    queued: ['start', 'cancel'],
    blocked: ['start'],
    running: ['cancel'],
    failed: ['retry', 'clear'],
    cancelled: ['retry', 'clear'],
    done: ['retry', 'clear'],   // a reported-done row that did not do the work must be re-runnable
  };

  it('EVERY queue status offers the same verbs the desk offers', () => {
    const wrong: string[] = [];
    for (const st of ALL_QUEUE_STATUSES) {
      const got = [...queueRowActions(st)].sort();
      const want = [...EXPECTED_Q[st]].sort();
      if (got.join(',') !== want.join(',')) wrong.push(`${st}: expected [${want}] got [${got}]`);
    }
    expect(wrong, `queue action parity broken:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('blocked survives the task-vocabulary mapping — it is startable, not retryable', () => {
    // `blocked` maps to the task status `failed`. If the raw status were dropped, the row
    // would offer Retry when what it needs is Start.
    const row = queueItemAsTask(qitem('q1', 'blocked'));
    expect(row.status).toBe('failed');
    expect(row.queueStatus).toBe('blocked');
    expect(queueRowActions(row.queueStatus!)).toContain('start');
  });

  it('no queue status is a dead end', () => {
    const dead = ALL_QUEUE_STATUSES.filter((s) => queueRowActions(s).length === 0);
    expect(dead, `inert on the phone: ${dead.join(', ')}`).toEqual([]);
  });
});
