/**
 * "A workflow run just reached a terminal status" — for anything that has to react to it.
 *
 * A listener registry rather than a direct call, because the thing reacting (the Goal Pilot
 * runner, which starts the next stage) itself launches runs through workflow-from-template →
 * the executor. A direct import from the executor would close that cycle. The executor and the
 * cancel path only EMIT; they know nothing about who listens.
 *
 * Listeners run synchronously inside the executor's tick, so a listener that does real work
 * must defer it (setImmediate) — see goal-pilot-runner.ts. A throwing listener is logged and
 * never allowed to break run completion, which is the thing that called it.
 */
export type RunFinishedListener = (runId: string, status: string) => void;

const listeners = new Set<RunFinishedListener>();

export function onRunFinished(listener: RunFinishedListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitRunFinished(runId: string, status: string): void {
  for (const l of listeners) {
    try { l(runId, status); } catch (err) { console.error('[run-events] listener threw:', err); }
  }
}

/**
 * "A run just stopped to wait for a person" — a step finished and is held for manual advance.
 *
 * The attention notifier listens: it both TELLS the person and, when the run's autonomy allows,
 * RELEASES the hold. It used to find out only on its 60-second sweep, so a run the person had
 * explicitly allowed to advance on its own still sat for up to a minute at every held step.
 */
export type RunHeldListener = (runId: string) => void;
const heldListeners = new Set<RunHeldListener>();

export function onRunHeld(listener: RunHeldListener): () => void {
  heldListeners.add(listener);
  return () => { heldListeners.delete(listener); };
}

export function emitRunHeld(runId: string): void {
  for (const l of heldListeners) {
    try { l(runId); } catch (err) { console.error('[run-events] held listener threw:', err); }
  }
}
