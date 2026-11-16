/**
 * ASYNC WORK THE ENGINE HAS STARTED AND NOT FINISHED — so a caller can wait for it to be quiet.
 *
 * The executor starts steps without awaiting them (a connector posts to Slack, a confer looks up
 * its participants across the fleet), and with immediate advance every one of those can schedule
 * the next pass. "Nothing is running" therefore cannot be read from the database alone: a step that
 * has just finished may not have triggered its successor YET. A caller that guessed — a few event
 * loop turns, a short timeout — saw a healthy run as stalled, or counted a poll the engine never
 * needed. Tracked here instead, and `whenQuiet()` resolves only when nothing is in flight.
 *
 * Production never waits on this; it exists for the tests and the workflow-test harness, which
 * must know exactly when the engine has done everything it will do without a poll.
 */

const inFlight = new Set<Promise<unknown>>();
const pendingFlags = new Set<() => boolean>();

/** Register async work the engine started without awaiting. Returns the same promise. */
export function trackInFlight<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  p.then(() => inFlight.delete(p), () => inFlight.delete(p));
  return p;
}

/** Something other than a promise that means "more is coming" (a scheduled executor pass). */
export function registerPending(isPending: () => boolean): void {
  pendingFlags.add(isPending);
}

function busy(): boolean {
  return inFlight.size > 0 || [...pendingFlags].some((f) => f());
}

/** Resolves once nothing tracked is in flight and nothing is scheduled — twice in a row. */
export async function whenQuiet(maxRounds = 500): Promise<void> {
  let quietRounds = 0;
  for (let i = 0; i < maxRounds && quietRounds < 2; i++) {
    await new Promise((r) => setImmediate(r));
    if (busy()) {
      quietRounds = 0;
      if (inFlight.size) await Promise.allSettled([...inFlight]);
    } else {
      quietRounds++;
    }
  }
}
