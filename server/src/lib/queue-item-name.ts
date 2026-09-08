/**
 * WHAT A QUEUED ITEM IS, IN WORDS.
 *
 * REPORTED: "Can we not list the tasks/workflows/confer with codenames/ids and the actual name
 * of the prompt and workflow used."
 *
 * Every `describe()` in the kind registry named its item by a truncated uuid or a bare count:
 *
 *   workflow 4a2f1b0c                 ← which workflow? the id is a TEMPLATE id here, and the
 *                                       one thing it cannot tell you is the template's name
 *   task 9c3e0d51
 *   confer with 3 participants        ← three of whom, about what?
 *   prompt -> 2 cartridge(s)          ← the prompt's text is right there in the payload
 *
 * These strings are what `[queue] started …` prints, which is the record consulted at 3am when a
 * lane has drained and nobody remembers what was in it. An id fragment sends you to a database
 * before you can even read your own log line.
 *
 * ── THE NAME IS LOOKED UP, NOT STORED ────────────────────────────────────────────────
 * A queue item holds ids. The name lives on the row those ids point at, and a copy taken at
 * enqueue time would be stale by the time the item runs — which for a queue is the whole point of
 * the queue. So this reads through, and degrades honestly: a workflow whose template was deleted
 * gets the id back, because at that point the id is genuinely all that is known.
 *
 * `libelleContexte` does the shortening, the same function that labels a run in the dashboard, so
 * a run named "Epic: Task by Task · GRD-3665" in the UI reads the same in the log.
 */
import db from '../db.js';
import { libelleContexte } from './context-label.js';

/**
 * The name of a workflow item's target. `workflowId` is either a TEMPLATE id (start a new run)
 * or an existing RUN id (re-run), and the payload does not say which — but it does not need to:
 * a template IS a `workflows` row, distinguished only by `run_number = 0`. One lookup answers
 * both, and the row's own shape decides whether a run number belongs in the name.
 *
 * (There is a vestigial `workflow_templates` table on older databases. No server code reads it,
 * `db.ts` does not create it, and templates have not lived there for a long time. Reading it here
 * would resurrect a source of truth the schema already abandoned.)
 */
export function workflowName(workflowId: string): string {
  if (!workflowId) return 'workflow';
  const row = db.prepare('SELECT name, run_number, context_label FROM workflows WHERE id = ?')
    .get(workflowId) as { name?: string; run_number?: number; context_label?: string } | undefined;
  // Deleted, or an id that never existed: the id IS the only truth left. Saying "workflow" alone
  // would be a label that identifies nothing, and two deleted runs would read identically.
  if (!row?.name) return `workflow ${workflowId.slice(0, 8)}`;
  const head = row.run_number ? `${row.name} #${row.run_number}` : row.name;
  return row.context_label ? `${head} · ${row.context_label}` : head;
}

/** A task's title, which is what a person called it when they wrote it down. */
export function taskName(taskId: string): string {
  if (!taskId) return 'task';
  const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title?: string } | undefined;
  return row?.title ? libelleContexte(row.title) : `task ${taskId.slice(0, 8)}`;
}

/** Cartridge names for the ids a prompt was aimed at — `repo_name` is what a person calls them. */
export function cartridgeNames(ids: string[]): string {
  if (ids.length === 0) return 'no cartridge';
  const names = ids.map((id) => {
    const row = db.prepare('SELECT repo_name, name FROM agents WHERE id = ?')
      .get(id) as { repo_name?: string; name?: string } | undefined;
    return row?.repo_name || row?.name || id.slice(0, 8);
  });
  // A prompt fanned out to nine cartridges must not produce a nine-name log line.
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}
