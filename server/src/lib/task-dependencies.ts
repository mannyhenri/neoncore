/**
 * A TASK DOES NOT RUN BEFORE ITS PREREQUISITES.
 *
 * Phase 5 stored `depends_on` and derived queue `priority` from dependency depth, which makes
 * prerequisites SORT first. Sorting is not enforcement: priority only decides what a free
 * cartridge picks up next, so two idle cartridges — or one manual "Send to agent" — happily
 * start a task whose prerequisite has not begun. The dependent then runs against a codebase
 * that does not yet have what it was written to assume, and fails in a way that looks like a
 * bad prompt rather than a scheduling bug.
 *
 * This module is the gate. It is deliberately separate from the queue so EVERY entry point
 * consults the same rule; a check living inside the runner would leave the manual button as an
 * unguarded back door, which is exactly how the busy-guard was bypassed before it was moved to
 * a shared helper.
 *
 * ── EVERY, AND WHY THAT WORD IS NOW LOAD-BEARING ───────────────────────────────────────
 * This header used to say "BOTH entry points — the queue runner and the manual dispatch
 * route". That was true of two of the FOUR paths that can start a task, and the two it left
 * out were the pull path an autonomous cartridge uses: `GET /api/tasks/queue` behind
 * `neoncore_my_queue`, and `POST /api/tasks/:id/claim` behind `neoncore_claim_task`. A reader
 * who trusted the sentence — as one did — concluded ordering was enforced without checking the
 * callers. The four are now:
 *   · POST /:id/dispatch      → blockedReason(), overridable with force (a person may know better)
 *   · releaseReadyTasks()     → readyTaskIds()
 *   · GET  /queue             → filtered through taskIsReady(), unclaimed rows only
 *   · POST /:id/claim         → blockedReason(), NOT overridable
 * `POST /:id/start` is deliberately not gated: it requires the caller to already own the task,
 * so it sits downstream of all four, and gating it would also veto a deliberate force-dispatch.
 * server/test/task-dependency-gate.test.ts enumerates the router and fails on a fifth path.
 *
 * ── WHY 'done' AND NOT 'not failed' ────────────────────────────────────────────────────
 * A failed prerequisite does NOT release its dependent. The dependent was written assuming the
 * prerequisite's outcome exists; running it after a failure produces confident work on a false
 * premise, which is worse than a task sitting visibly blocked. Cancelled is treated the same
 * way, with one exception noted in `blockedReason`: cancellation is a human decision, so the
 * dependent is reported as blocked-by-choice rather than blocked-by-failure.
 */
import db from '../db.js';

export interface Dependency {
  id: string;
  title: string;
  status: string;
}

/** Task ids this task waits on. Ids, not proposal keys — see acceptDecomposition. */
export function dependencyIds(taskId: string): string[] {
  const row = db.prepare('SELECT depends_on FROM tasks WHERE id = ?').get(taskId) as
    { depends_on?: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.depends_on || '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Prerequisites that are not finished.
 *
 * A dependency whose row has been DELETED is treated as satisfied, not as a permanent block.
 * Reverting a decomposition deletes untouched tasks, and a dangling id must not strand every
 * dependent that survived.
 */
export function unmetDependencies(taskId: string): Dependency[] {
  const ids = dependencyIds(taskId);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, title, status FROM tasks WHERE id IN (${placeholders})`,
  ).all(...ids) as Dependency[];
  return rows.filter((r) => r.status !== 'done');
}

export function taskIsReady(taskId: string): boolean {
  return unmetDependencies(taskId).length === 0;
}

/** One line for the UI and for the 409 a manual dispatch gets. Null when the task is ready. */
export function blockedReason(taskId: string): string | null {
  const unmet = unmetDependencies(taskId);
  if (unmet.length === 0) return null;

  const failed = unmet.filter((d) => d.status === 'failed');
  if (failed.length) {
    return `waiting on "${failed[0].title}", which failed — running this now would build on an outcome that does not exist`;
  }
  const cancelled = unmet.filter((d) => d.status === 'cancelled');
  if (cancelled.length && cancelled.length === unmet.length) {
    return `waiting on "${cancelled[0].title}", which was cancelled — cancel this too, or clear its dependency`;
  }
  const first = unmet[0];
  return unmet.length === 1
    ? `waiting on "${first.title}" (${first.status})`
    : `waiting on ${unmet.length} tasks, starting with "${first.title}" (${first.status})`;
}

/**
 * Queued tasks that are now free to run, best-first.
 *
 * Ordered by the same `priority` acceptance derived from dependency depth, so when several
 * unblock at once the shallower ones go first — which keeps a long chain moving rather than
 * starting every leaf and leaving the trunk for last.
 */
export function readyTaskIds(projectIds?: string[]): string[] {
  const scoped = projectIds?.length
    ? `AND project_id IN (${projectIds.map(() => '?').join(',')})`
    : '';
  const rows = db.prepare(
    `SELECT id FROM tasks WHERE status = 'queued' ${scoped} ORDER BY priority DESC, created_at ASC`,
  ).all(...(projectIds ?? [])) as { id: string }[];
  return rows.filter((r) => taskIsReady(r.id)).map((r) => r.id);
}
