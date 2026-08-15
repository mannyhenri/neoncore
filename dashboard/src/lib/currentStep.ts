/**
 * Which step should the canvas open on?
 *
 * CE: Full Delivery is 47 steps and ~6800px tall, so `fitView` on mount zooms out far enough
 * to fit the entire graph and every open started with a hunt for where the run actually is.
 * A centring effect already existed but was gated on `isExecuting` AND on the running step
 * CHANGING — so it did nothing for a paused, failed, finished, or not-yet-started run.
 *
 * "The step that matters" is deliberately not `find(running)`. A run that broke needs the step
 * that broke it; a run that has not started needs the one about to go. The order below is that
 * priority, most-urgent first.
 */

export interface FocusableStep {
  id: string;
  name: string;
  status: string;
  recoveryStatus?: string;
}

/** Explicitly not where the work is — skipped steps never win focus. */
const INERT = new Set(['skipped', 'cancelled']);

function needsAttention(s: FocusableStep): boolean {
  return s.status === 'failed' || s.recoveryStatus === 'interrupted';
}

/**
 * The step to centre on, or null when there is nothing meaningful to focus — an empty graph
 * or a template being authored, where fitting the whole view is the right default and picking
 * a target would fight the author.
 *
 * Order is preserved from the input (which the caller supplies in layout order), so the same
 * steps always resolve to the same target: the canvas re-renders on every poll, and a focus
 * target that drifted between identical renders would drag the viewport under the cursor.
 */
export function pickFocusStep(steps: FocusableStep[]): FocusableStep | null {
  if (steps.length === 0) return null;
  const live = steps.filter((s) => !INERT.has(s.status));
  if (live.length === 0) return null;

  // 1. Something is wrong — that is why the canvas was opened.
  const broken = live.find(needsAttention);
  if (broken) return broken;

  // 2. The live edge of the work.
  const running = live.find((s) => s.status === 'running');
  if (running) return running;

  // 3. Nothing running: what is about to go.
  const next = live.find((s) => s.status === 'pending');
  if (next) return next;

  // 4. Finished run — the interesting end is where it stopped.
  const completed = live.filter((s) => s.status === 'completed');
  return completed.length > 0 ? completed[completed.length - 1] : null;
}
