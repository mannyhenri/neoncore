/**
 * WHERE A STEP SITS ON THE CANVAS. One set of numbers, one function.
 *
 * Reported as "all the steps are close together instead of having a bit of space between each
 * one — doesn't look good." They were, and there were FOUR different opinions about it:
 *
 *   seedDefaultTemplates (db.ts)                  y += 175, typed as a literal into ~150 steps
 *   the run clone (routes/workflows.ts)           STEP_SPACING = 230
 *   withStandardGate                              positionY: 0  — every gate stacked at the top
 *   withReportStep / ensureReportStepOnTemplates   lastY + 175
 *   the canvas "auto layout" button               50 + i * 280
 *
 * A step node is 300px wide with a content-driven height, so 175 crowds and overlaps. 280 is
 * the value that was actually tuned against the rendered node — it is the one the canvas's own
 * auto-layout used — so it wins, and everything else now asks for it rather than guessing.
 *
 * NOT FIXED BY EDITING THE LITERALS. There were ~150 of them across 26 template definitions,
 * and the next template would have typed a new one. The layout is RECOMPUTED from the step
 * graph instead, so a template's authored y values no longer matter and cannot drift.
 */
import type { Database as DatabaseType } from 'better-sqlite3';

/** Vertical gap between consecutive steps. Must match the canvas auto-layout — asserted. */
export const STEP_SPACING_Y = 280;

/** Where the first step sits. Clear of the canvas toolbar without wasting a screen. */
export const STEP_START_Y = 50;

/** Single column. A stray x turns a linear workflow into a diagonal. */
export const STEP_X = 300;

interface StepRow {
  id: string;
  depends_on: string;
  position_y: number;
}

/**
 * Lay a workflow's steps out top to bottom in DEPENDENCY ORDER.
 *
 * Depth-first over each step's dependencies, which puts a step strictly below everything it
 * waits on — the property that makes the arrows readable. Parallel branches land on consecutive
 * rows rather than side by side: this is a single column by design, because a workflow here is
 * read as a sequence and the edges carry the branching.
 *
 * Idempotent. Safe to run on every seed, clone and append.
 */
export function layoutSteps(db: DatabaseType, workflowId: string): number {
  const rows = db.prepare(
    'SELECT id, depends_on, position_y FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y ASC, rowid ASC',
  ).all(workflowId) as StepRow[];
  if (rows.length === 0) return 0;

  const deps = new Map<string, string[]>();
  for (const r of rows) {
    let d: string[] = [];
    try { d = JSON.parse(r.depends_on || '[]') || []; } catch { d = []; }
    deps.set(r.id, d);
  }

  const known = new Set(rows.map((r) => r.id));
  const seen = new Set<string>();
  const order: string[] = [];

  // `visiting` breaks a dependency cycle rather than recursing forever. A cycle is a broken
  // graph, but it must still DRAW — a workflow you cannot open is worse than one drawn oddly.
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (seen.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const d of deps.get(id) ?? []) if (known.has(d)) visit(d);
    visiting.delete(id);
    seen.add(id);
    order.push(id);
  }
  // Existing order as the tiebreak, so a hand-arranged workflow keeps its shape where the
  // dependency graph does not dictate one.
  for (const r of rows) visit(r.id);

  const update = db.prepare('UPDATE workflow_steps SET position_x = ?, position_y = ? WHERE id = ?');
  const apply = db.transaction(() => {
    order.forEach((id, i) => update.run(STEP_X, STEP_START_Y + i * STEP_SPACING_Y, id));
  });
  apply();
  return order.length;
}
