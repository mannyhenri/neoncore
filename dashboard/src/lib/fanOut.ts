import type { ServerEntry } from '@neoncore/client';
import type { ServerAnswer } from './serverAnswer';

/**
 * Read from every server, and RENDER AS ANSWERS ARRIVE.
 *
 * REPORTED, twice, as two different bugs with one cause:
 *   1. "just says connecting to orchestrator" — a fan-out awaited every server, `fetch` had no
 *      deadline, and a sleeping laptop never settled. Nothing ever rendered.
 *   2. "each page load has a delay" — after the deadline landed, the same fan-out waited the
 *      full 15s for that machine before rendering anything. The first fix turned "never" into
 *      "eventually", which is better and still wrong.
 *
 * Both come from gating a render on the SLOWEST server. The local one answers in about two
 * milliseconds; waiting on a machine that is asleep to show you data you already have is a
 * choice, not a constraint. So this calls `onUpdate` after EACH server settles, with whatever
 * is known so far. The page paints on the first answer and fills in.
 *
 * `null` in an answer means that server has not reported — it is indistinguishable here from
 * "failed", and deliberately so: lib/serverAnswer.ts classifies WHY, and this layer's only job
 * is not making you wait for it.
 */
export function fanOut<T>(
  servers: ServerEntry[],
  fetchOne: (server: ServerEntry) => Promise<T>,
  onUpdate: (answers: ServerAnswer<T>[], settled: number) => void,
): void {
  const label = (s: ServerEntry) =>
    s.name || (s.url ? safeHost(s.url) : 'This machine');

  const answers: ServerAnswer<T>[] = servers.map((s) => ({ label: label(s), result: null }));

  if (servers.length === 0) {
    onUpdate(answers, 0);
    return;
  }

  let settled = 0;
  servers.forEach((server, i) => {
    fetchOne(server)
      .then((result) => { answers[i] = { label: label(server), result }; })
      .catch(() => { answers[i] = { label: label(server), result: null }; })
      .finally(() => {
        settled += 1;
        // A COPY each time: the caller stores this in React state, and handing out the same
        // array every call makes the update a no-op under identity comparison.
        onUpdate(answers.map((a) => ({ ...a })), settled);
      });
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
