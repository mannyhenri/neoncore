/**
 * How many times a step must be dispatched, read from what an earlier step found.
 *
 * REPORTED: "wouldn't it make more sense to identify the number of tasks, pass that integer into
 * the workflow as the number of times it repeats so it guarantees all the tasks will be covered?"
 *
 * Yes, and this is that. Before it, a template that had to cover twelve tasks asked ONE step to
 * loop twelve times inside its own prompt. The engine dispatched it once; everything after the
 * first task rested on an agent obeying a long instruction for hours. An agent that did three and
 * reported done ended the step and the run moved on. Nothing counted, so nothing noticed.
 *
 * The engine already re-dispatches a step `loopCount` times. The only thing missing was letting
 * that number come from DATA rather than from a constant written when the template was authored,
 * because the author cannot know how many tasks are in an epic they have never seen.
 *
 * ── WHY A MISSING NUMBER FALLS BACK RATHER THAN GUESSING ───────────────────────────────
 * Every failure to read the count resolves to the STATIC loopCount. Looping once when there were
 * twelve tasks is the bug being fixed; looping an arbitrary number because a regex missed is the
 * obvious over-correction, and it sends an agent to do work nobody described. A wrong count is
 * worse than a small one, so absence means "behave as before" and the run is short rather than
 * wild.
 */

/** Nothing legitimately needs more dispatches than this, and a runaway count is expensive. */
export const MAX_LOOP_CEILING = 40;

export interface LoopConfig {
  loopCount?: number;
  /** Where to read the real count: the dependency's NAME, and a pattern with one capture group. */
  loopCountFrom?: { step: string; pattern: string; max?: number };
  /** Text in a dispatch's result that means the work ran out — stop looping. */
  loopUntil?: string;
}

/**
 * `depResults` is dependency step NAME → its result. Name rather than id because a template
 * author writes the name; ids are generated per seed and unknowable at authoring time.
 */
export function resolveLoopCount(config: LoopConfig, depResults: Record<string, string>): number {
  const staticCount = clamp(config.loopCount ?? 1);
  const from = config.loopCountFrom;
  if (!from?.step || !from?.pattern) return staticCount;

  const source = depResults[from.step];
  if (!source) return staticCount;

  let match: RegExpMatchArray | null = null;
  try {
    match = source.match(new RegExp(from.pattern));
  } catch {
    return staticCount;   // a bad pattern is an authoring error, not a reason to loop wildly
  }
  if (!match || match[1] === undefined) return staticCount;

  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed < 1) return staticCount;

  return clamp(parsed, from.max);
}

function clamp(n: number, max = MAX_LOOP_CEILING): number {
  const ceiling = Math.min(max || MAX_LOOP_CEILING, MAX_LOOP_CEILING);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), ceiling);
}

/**
 * Stop before the count is exhausted, because a guaranteed count guarantees COVERAGE, not that
 * there is that much work. If the tasks run out at 9 of 12, three further dispatches would send
 * an agent to do nothing — and "do nothing" is the instruction most likely to be interpreted
 * creatively.
 *
 * Matched case-insensitively: an agent that shouts the sentinel still means it.
 */
export function shouldStopLooping(result: string, config: LoopConfig): boolean {
  const sentinel = (config.loopUntil || '').trim();
  if (!sentinel) return false;
  return (result || '').toLowerCase().includes(sentinel.toLowerCase());
}
