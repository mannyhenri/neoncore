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
 * How a count was arrived at. Stated rather than inferred, because the executor logged the
 * resolved number ONLY when it differed from the static one — so the most dangerous outcome,
 * a regex miss on a twelve-task epic resolving to the static 1, matched and logged NOTHING.
 * A silent fallback and a deliberate single dispatch looked identical in the run log.
 */
export type LoopBasis =
  | 'data'      // read out of an upstream step's output, as intended
  | 'fallback'  // the read failed; the static count stands in
  | 'clamped'   // read, but above the ceiling
  | 'static';   // no resolver configured; the author's number is authoritative

export interface LoopCountResolution {
  count: number;
  basis: LoopBasis;
  /** One line for the run log. Always non-empty — an unexplained number is what caused this. */
  note: string;
}

/**
 * `depResults` is dependency step NAME → its result. Name rather than id because a template
 * author writes the name; ids are generated per seed and unknowable at authoring time.
 */
export function explainLoopCount(
  config: LoopConfig,
  depResults: Record<string, string>,
): LoopCountResolution {
  const staticCount = clamp(config.loopCount ?? 1);
  const from = config.loopCountFrom;
  const fell = (why: string): LoopCountResolution => ({
    count: staticCount,
    basis: 'fallback',
    note: `Loop count: ${staticCount} — ${why}, falling back to the static count`,
  });

  if (!from?.step || !from?.pattern) {
    return { count: staticCount, basis: 'static', note: `Loop count: ${staticCount} (from the template)` };
  }

  const source = depResults[from.step];
  if (!source) return fell(`"${from.step}" produced no output to read`);

  let match: RegExpMatchArray | null = null;
  try {
    match = source.match(new RegExp(from.pattern));
  } catch {
    return fell(`the pattern /${from.pattern}/ is not a valid regex`);   // an authoring error, not a reason to loop wildly
  }
  if (!match || match[1] === undefined) return fell(`/${from.pattern}/ matched nothing in "${from.step}"`);

  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fell(`"${match[1]}" is not a usable count`);

  const count = clamp(parsed, from.max);
  if (count < parsed) {
    return { count, basis: 'clamped', note: `Loop count: ${count} — "${from.step}" reported ${parsed}, above the ceiling of ${count}` };
  }
  return { count, basis: 'data', note: `Loop count: ${count} — read from "${from.step}"` };
}

/** The number alone, for callers that do not report. */
export function resolveLoopCount(config: LoopConfig, depResults: Record<string, string>): number {
  return explainLoopCount(config, depResults).count;
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

/**
 * ── EXTENDING A BUDGET THE WORK OUTLIVED ────────────────────────────────────────────────
 *
 * LIVE FAILURE. `Load Epic` counted the Redo-Between-Frames epic and reported `TASKS: 10` —
 * correct at the time. The run's own first task was a probe whose verdict ADDED an eleventh
 * task, created 42 minutes after the count and slotted in as a dependency of a task in the
 * middle. The ten dispatches were spent on eleven tasks' worth of dependency order, and the
 * last one, RBF-010, was never dispatched at all. Everything downstream reported cleanly: ten
 * dispatches, ten commits, a green suite. The only trace was one line of the coverage report.
 *
 * A count sampled once is an ESTIMATE, and a first step whose job is to investigate will
 * sometimes find more work — that is the step doing what it is for, not misbehaving.
 *
 * WHY NOT SIMPLY RE-READ THE COUNT EACH PASS. Because then the loop's length is a function of
 * its own output, and a step that keeps reporting a bigger number never ends. The count stays
 * frozen. What is added is the strictly weaker thing: the loop may be extended ONE dispatch at
 * a time, and only when the last dispatch stated a positive number of tasks remaining — the
 * `[k] remaining` that the template's output contract already requires.
 *
 * Bounded four ways, because "keep going" is the instruction most expensive to get wrong:
 *   · only a count that came from DATA — a static loopCount is the author's decision, not an
 *     estimate, and must never grow behind their back
 *   · only when the budget is already spent; an unspent budget re-dispatches normally
 *   · never more than MAX_LOOP_EXTENSIONS times
 *   · never past MAX_LOOP_CEILING, which no extension may cross
 */
export const MAX_LOOP_EXTENSIONS = 10;

/**
 * How many tasks the last dispatch said were left, or null if it did not say.
 *
 * The LAST number in the output wins: an agent that reasons aloud may name several, and its
 * final word is its answer. Null rather than 0 for "did not say", because silence is not a
 * claim that the work is done — and only a positive claim extends the loop.
 */
export function remainingFrom(result: string): number | null {
  const matches = [...(result || '').matchAll(/(\d+)\s+remaining\b/gi)];
  if (matches.length === 0) return null;
  const n = Number.parseInt(matches[matches.length - 1][1], 10);
  return Number.isFinite(n) ? n : null;
}

export interface ExtendInput {
  /** What the dispatch that just finished reported. */
  result: string;
  config: LoopConfig;
  /** Which dispatch just finished, 1-based. */
  currentLoop: number;
  /** The budget as it stands, after any earlier extensions. */
  loopCount: number;
  /** How many times this step has already been extended. */
  extensions: number;
}

export function shouldExtendLoop(i: ExtendInput): boolean {
  // A static count is a decision. Only an ESTIMATE read from data may be revised.
  if (!i.config.loopCountFrom?.step || !i.config.loopCountFrom?.pattern) return false;
  // The agent said the work is finished. That claim outranks any count.
  if (shouldStopLooping(i.result, i.config)) return false;
  // A one-dispatch step is not a loop, and an unspent budget needs no help.
  if (i.loopCount <= 1 || i.currentLoop < i.loopCount) return false;
  if (i.extensions >= MAX_LOOP_EXTENSIONS) return false;
  if (i.currentLoop >= MAX_LOOP_CEILING || i.loopCount >= MAX_LOOP_CEILING) return false;

  const remaining = remainingFrom(i.result);
  return remaining !== null && remaining > 0;
}
