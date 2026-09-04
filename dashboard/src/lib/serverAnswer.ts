/**
 * What a fleet read got back from each server, and why a server is missing from the total.
 *
 * REPORTED: "both servers are reachable, why am I still seeing the warning". The banner said
 * "a server is unreachable, or is running a build without this endpoint" while the header said
 * 2/2 servers in green, so the two disagreed on screen and the first clause was the wrong one.
 *
 * The distinction is real and worth naming, because the remedies are opposite. A server that
 * did not answer needs looking at. A server that answered with an older shape needs a DEPLOY —
 * and it will keep answering HTTP 200 while it does, because a route added below
 * `/activity/:agentId` is not a 404 on the old build: it returns that handler's empty array.
 * "Reachable" and "has the endpoint" are different questions and the UI must not conflate them.
 */

export interface ServerAnswer<T> {
  /** How to name this server to a person — its host, or "This machine". */
  label: string;
  /** null when the request failed outright. */
  result: T | null;
}

export type Outcome = 'ok' | 'unreachable' | 'outdated';

export interface Problem {
  label: string;
  reason: Exclude<Outcome, 'ok'>;
}

/** One sentence per failure kind, in the words that tell you what to DO about it. */
export const REASON_TEXT: Record<Exclude<Outcome, 'ok'>, string> = {
  unreachable: 'did not respond',
  outdated: 'is running an older build without this endpoint — deploy and restart it',
};

/**
 * `usable` is passed in rather than inferred: only the caller knows what a well-formed answer
 * for its own endpoint looks like, and "truthy" is not it — the old build's `[]` is truthy.
 */
export function classify<T>(answer: ServerAnswer<T>, usable: (r: T) => boolean): Outcome {
  if (answer.result == null) return 'unreachable';
  return usable(answer.result) ? 'ok' : 'outdated';
}

export function problemsIn<T>(answers: ServerAnswer<T>[], usable: (r: T) => boolean): Problem[] {
  return answers
    .map((a) => ({ label: a.label, reason: classify(a, usable) }))
    .filter((p): p is Problem => p.reason !== 'ok');
}

/** "studio.local did not respond" / "two servers are running an older build…" */
export function describeProblems(problems: Problem[]): string {
  return problems
    .map((p) => `${p.label} ${REASON_TEXT[p.reason]}`)
    .join('; ');
}
