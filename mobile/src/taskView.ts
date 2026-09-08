import type { Task, TaskStatus } from './types';
// Type-only, like api.ts: Metro erases these, and runtime imports from the workspace
// package do not resolve (see mobile/metro.config.js).
import type { QueueItem, QueueStatus } from '@neoncore/client';
import { LIVE_TASK_STATUSES } from './goalDisplay';

/**
 * What the Tasks screen shows, and what you can do to each row.
 *
 * WHY QUEUE ITEMS ARE HERE. The desk's Tasks page renders two lists under one filter — real
 * tasks, and queue items mapped onto the task vocabulary (dashboard TasksPage `visibleQueue`).
 * The phone read only `/api/tasks`, so with the server holding zero tasks and a full queue the
 * desk showed a page of work and the phone said "No tasks". Same server, two answers, and no
 * way to tell from the phone which one was lying.
 *
 * Pure and side-effect free so the parity rules can be tested against the registries directly
 * rather than through a rendered screen.
 */

/** A row on the Tasks screen: a real task, or a queue item wearing the task vocabulary. */
export interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  priority: number;
  createdAt: string;
  assignedAgentId?: string;
  error?: string;
  /** Which list it came from — the two kinds take different verbs. */
  kind: 'task' | 'queue';
  /**
   * A queue row's RAW status, kept because the task vocabulary is lossy where it matters:
   * `blocked` maps to `failed`, but a blocked row is STARTABLE and a failed row is
   * RETRYABLE. Collapsing them would put the wrong button on the row.
   */
  queueStatus?: QueueStatus;
}

export type TaskFilterKey = 'all' | 'active' | TaskStatus;

/**
 * The filters, mirroring the desk's FILTERS array plus the two statuses it omits.
 *
 * The desk can omit `cancelled` because its "All" is always one click away on a wide screen.
 * A phone list is a scroll, not a glance, so every status gets its own way in — a status with
 * no filter is a status you cannot look up, which is half of the reported bug.
 */
export const TASK_FILTERS: { key: TaskFilterKey; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'all', label: 'All' },
  { key: 'queued', label: 'Queued' },
  { key: 'claimed', label: 'Claimed' },
  { key: 'in_progress', label: 'Running' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
  { key: 'cancelled', label: 'Cancelled' },
];

/**
 * A queue item in the task vocabulary.
 *
 * EVERY QueueStatus must land on a TaskStatus. The desk's map ends in a `: 'failed'` catch-all
 * so `blocked` has a home; the same total mapping is kept here, because a status that fell
 * through would silently drop that row from the phone — the exact failure being fixed.
 */
export function queueItemAsTask(q: QueueItem): TaskRow {
  const status: TaskStatus =
    q.status === 'running' ? 'in_progress'
    : q.status === 'done' ? 'done'
    : q.status === 'queued' ? 'queued'
    : q.status === 'cancelled' ? 'cancelled'
    : 'failed'; // failed | blocked

  // Queue items carry their instruction in the payload rather than a title field. Falling back
  // to the id keeps a row identifiable instead of rendering a blank line.
  // `description` is what the server calls this item — the same words the queue panel and the
  // server log use. The payload text is the fallback for a server that predates it.
  const text = (q.description || '').trim()
    || (q.payload as { text?: string } | undefined)?.text?.trim() || '';
  return {
    id: q.id,
    title: text ? text.split('\n')[0].slice(0, 120) : q.kind,
    prompt: text,
    status,
    priority: 0,
    createdAt: q.createdAt,
    assignedAgentId: q.targets?.[0],
    error: q.error || undefined,
    kind: 'queue',
    queueStatus: q.status,
  };
}

function taskAsRow(t: Task): TaskRow {
  return {
    id: t.id, title: t.title, prompt: t.prompt || '', status: t.status,
    priority: t.priority, createdAt: t.createdAt,
    assignedAgentId: t.assignedAgentId ?? undefined, error: t.error || undefined, kind: 'task',
  };
}

/** The rows to render for one filter — tasks and queue items together, highest priority first. */
export function selectTaskRows(
  tasks: Task[],
  queueItems: QueueItem[],
  filter: TaskFilterKey,
): TaskRow[] {
  const rows = [...tasks.map(taskAsRow), ...queueItems.map(queueItemAsTask)];
  const kept = filter === 'all'
    ? rows
    : filter === 'active'
      ? rows.filter((r) => LIVE_TASK_STATUSES.includes(r.status))
      : rows.filter((r) => r.status === filter);

  return kept.sort(
    (a, b) => b.priority - a.priority
      || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** Every verb the phone offers for a status. */
export type TaskAction = 'dispatch' | 'cancel' | 'done' | 'failed' | 'clear';

/**
 * Which verbs a status gets, read off the desk's own rule: a non-terminal row can be
 * cancelled or marked done/failed, a terminal row can be cleared, and `queued` additionally
 * dispatches. Authoring — creating a task, editing its title or prompt — stays at the desk.
 */
export function taskActions(status: TaskStatus): TaskAction[] {
  const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
  if (terminal) return ['clear'];
  return status === 'queued'
    ? ['dispatch', 'cancel', 'done', 'failed']
    : ['cancel', 'done', 'failed'];
}

/** Every verb the phone offers for a queue row. */
export type QueueAction = 'start' | 'retry' | 'cancel' | 'clear';

/**
 * Which verbs a queue row gets, read off the desk's own gates (TasksPage `QueueRow`):
 *  - start   `queued` | `blocked` — blocked is included because a halted lane is one of the
 *            ways a row ends up stuck, and the same button has to reach all of them
 *  - retry   `failed` | `cancelled`
 *  - cancel  `queued` | `running` — live work
 *  - clear   terminal only; live work is never clearable
 *
 * Reordering and park/resume are deliberately absent: they arrange a LANE, which is the Queue
 * screen's job, not a decision about the row you are reading here.
 */
export function queueRowActions(status: QueueStatus): QueueAction[] {
  const out: QueueAction[] = [];
  if (status === 'queued' || status === 'blocked') out.push('start');
  if (status === 'failed' || status === 'cancelled') out.push('retry');
  if (status === 'queued' || status === 'running') out.push('cancel');
  if (status === 'done' || status === 'failed' || status === 'cancelled') out.push('clear');
  return out;
}
