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

/**
 * Nothing legitimately needs more dispatches than this, and a runaway count is expensive.
 *
 * RAISED FROM 40. The ceiling is a guard against a nonsense number — a regex that caught a
 * version string, an agent that wrote a total instead of a remainder. It was never a statement
 * about how large an epic may legitimately be, but because `clamp` applies it to counts that
 * came from DATA, that is what it silently became: a 53-task Jira epic (GRD-3502) resolved to
 * 40 dispatches, and the 13 tasks past the cut were never dispatched at all. The run reported
 * 40 clean dispatches; only `Verify Coverage` could have noticed, and only if it ran.
 *
 * A real epic is bigger than a template author's intuition, so the ceiling has to sit above
 * the largest plausible one rather than in the middle of the range. The cost of a wrong count
 * is still bounded — every dispatch past the first requires the previous one to have COMPLETED
 * and reported outstanding work — so the ceiling can be generous without being unbounded.
 */
export const MAX_LOOP_CEILING = 250;

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

  /**
   * THE MARKER MUST BEGIN A LINE (LOOP-002). This was a substring match over the whole body,
   * which made every MENTION of the marker a signal. Two real runs in this database ended
   * because an agent wrote, in plain words, that it was REFUSING to signal:
   *
   *     "I am not outputting <marker>, because one task genuinely remains"
   *     "I have not emitted <marker>, because it would be false — two tasks genuinely remain"
   *
   * A third quoted its own instructions; a fourth used the phrase while explaining this bug
   * and cut its run from fifteen dispatches to six. A signal a report cannot discuss without
   * firing is not a signal.
   *
   * Begins-a-line rather than is-the-whole-line, because the template asks for the marker
   * "with a one-line tally" and agents really do write `<marker> — 17 of 22 done`. Requiring
   * exact equality would reject genuine signals and the loop would never stop early.
   *
   * The cost, deliberately taken: `DONE X · 0 remaining — <marker>.` no longer stops, because
   * the marker does not lead the line. That spends ONE extra dispatch, which finds nothing to
   * do and signals properly. A wasted dispatch is recoverable; ending a run nine tasks early
   * is not, and that asymmetry chooses the rule.
   */
  const marker = sentinel.toLowerCase();
  return (result || '')
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase().startsWith(marker));
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
export const MAX_LOOP_EXTENSIONS = 100;

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
  // An unspent budget needs no help — it will re-dispatch on its own.
  //
  // `loopCount <= 1` USED TO BE REJECTED HERE TOO, on the reasoning that a one-dispatch step is
  // not a loop. That is true of a step whose author wrote `loopCount: 1`, and this function
  // already refuses those on the line above: a static count has no `loopCountFrom` and never
  // reaches here. What it also caught, unintentionally, was the far more dangerous case — a
  // step that DOES read its count from data, whose read FAILED, and which therefore fell back
  // to 1. That is not an author's decision to dispatch once; it is a budget known to be
  // unreliable, and it is the state most in need of the rescue this function exists to provide.
  //
  // Live: `Load Epic` was force-completed by hand, so `TASKS:\s*(\d+)` matched nothing and the
  // 53-task epic fell back to a budget of 1. The single dispatch finished a task and reported
  // `52 remaining` — the exact positive signal that extends a loop — and was refused, because
  // the budget it was trying to grow was 1. One task of 53, reported as a clean run.
  if (i.currentLoop < i.loopCount) return false;
  if (i.extensions >= MAX_LOOP_EXTENSIONS) return false;
  if (i.currentLoop >= MAX_LOOP_CEILING || i.loopCount >= MAX_LOOP_CEILING) return false;

  const remaining = remainingFrom(i.result);
  return remaining !== null && remaining > 0;
}

/**
 * ── STATE THAT MUST NOT SURVIVE INTO THE NEXT DISPATCH ──────────────────────────────────
 *
 * LIVE FAILURE (GRD-3502). The stall nudge counter `_nudges` is stored on the STEP, and
 * `Work Every Task` is ONE step re-dispatched 63 times. Nothing reset it between dispatches,
 * so the six nudges `full` autonomy is allowed (lib/autonomy.ts NUDGE_POLICY) were a budget
 * for the whole EPIC rather than for one task.
 *
 * That matters because a cartridge without the completion tool finishes a task, commits, and
 * stops silently — the nudge is what wakes it to report. One nudge per task against a budget
 * of six means the run advances six times and then stalls forever, with the step still
 * `running`, the workflow still `running`, and every surface reporting health. The epic dies
 * at task 6 of 63 and says nothing.
 *
 * The nudge budget is meant to bound "how many times do we poke a cartridge that will not
 * finish THIS task" — a per-dispatch question. Carrying it across dispatches silently
 * redefines it as "how many stalls may this entire run survive", which is not a limit anyone
 * chose. Advancing the loop is the boundary, so advancing the loop clears it.
 *
 * Kept as a NAMED SET rather than an inline `delete`, so a future per-dispatch counter is
 * added in one place and the test that guards this notices it.
 */
export const PER_DISPATCH_KEYS = ['_nudges', '_lastNudgeAt'] as const;

/**
 * Every key a loop RUN writes onto a step's config. A re-run of the workflow must clear all of
 * them: `_resolvedLoopCount` is read from a step that is about to run again and may well count
 * differently, and a stale count silently overrides the fresh one. Contains the per-dispatch
 * set, since a key cleared between dispatches is certainly cleared between runs.
 */
export const LOOP_RUN_KEYS = [
  '_currentLoop', '_resolvedLoopCount', '_loopExtensions', '_lastLoopResult', ...PER_DISPATCH_KEYS,
] as const;

/**
 * The executor config for the next dispatch of a looped step: the loop counter advanced, the
 * previous dispatch's report carried along (see `loopDispatchHeader` for why), and every
 * per-dispatch key cleared. Everything else — the resolved budget, the extension count, the
 * prompt, the author's settings — belongs to the STEP and is carried through untouched.
 */
export function configForNextLoop(
  cfg: Record<string, unknown>,
  nextLoop: number,
  lastResult?: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...cfg, _currentLoop: nextLoop };
  if (lastResult !== undefined) next._lastLoopResult = loopResultSummary(lastResult);
  for (const key of PER_DISPATCH_KEYS) delete next[key];
  return next;
}

/** The config with no trace of any previous run's loop, for a workflow being re-run. */
export function configForRerun(cfg: Record<string, unknown>): Record<string, unknown> {
  const fresh: Record<string, unknown> = { ...cfg };
  for (const key of LOOP_RUN_KEYS) delete fresh[key];
  return fresh;
}

/**
 * ── A RE-DISPATCH MUST NOT LOOK LIKE A DUPLICATE (LOOP-003) ───────────────────────────
 *
 * LIVE FAILURE, four runs on 2026-09-10/11. The engine re-dispatches a looped step by
 * composing its prompt again, and the composition knew nothing about the loop — dispatch 1
 * and dispatch 2 of run e2dce42a were compared byte for byte and were IDENTICAL. So a
 * cartridge, in the same session, receives the exact message it just finished answering, one
 * second after its completion call returned. It read that the only way it could:
 *
 *   · "Duplicate dispatch confirmed" — re-reported `BLOCKED LFC-001 · 29 remaining` every ten
 *     seconds, and the "29 remaining" extended the budget a hundred times (run 42a34028).
 *   · Went quiet. The stall nudge eleven minutes later produced a re-report of the task it had
 *     ALREADY finished, which advanced the loop, which re-sent the same prompt, which went
 *     quiet. Eleven dispatches, no new work, "nudged 1/6" forever (run 0949fba6).
 *   · Worked all nine tasks (run 1a299cbd). The model got lucky; the engine had told it nothing.
 *
 * From the user's chair every one of these is "I started an epic and it is not continuing".
 *
 * The header states three things a duplicate never would: which dispatch this is, what the
 * previous one reported (so the cartridge can see its own last report acknowledged), and
 * that the NEXT task is wanted. Dispatch 1 gets nothing — there is nothing to distinguish it
 * from yet, and the count is not resolved until the first completion.
 */
export function loopDispatchHeader(i: {
  stepName: string;
  currentLoop: number;
  loopCount: number;
  previousResult?: string;
  loopUntil?: string;
}): string {
  if (!(i.currentLoop > 1)) return '';
  const prev = loopResultSummary(i.previousResult || '');
  const lines = [
    `[Workflow loop — dispatch ${i.currentLoop} of ${i.loopCount} for step "${i.stepName}"]`,
    `This is a NEW dispatch, not a repeat of the last one. Dispatch ${i.currentLoop - 1} has already been received and recorded`
      + (prev ? `; it reported:\n  ${prev}` : '.'),
    'Do NOT redo or re-report that work. Re-read the state of the tasks and take the NEXT outstanding one.'
      + (i.loopUntil ? ` If nothing is left, output exactly \`${i.loopUntil}\` and stop.` : ''),
  ];
  return lines.join('\n') + '\n\n';
}

/** The first non-empty line of a report, bounded — the claim, not the essay. */
export function loopResultSummary(result: string): string {
  const line = (result || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || '';
  return line.length > 240 ? line.slice(0, 237) + '...' : line;
}

/**
 * What a dispatch CLAIMED, in the shape the epic templates ask for:
 * `DONE [id] · commit [hash] · [k] remaining`, `BLOCKED [id] · [k] remaining`, `SKIPPED [id] · …`.
 * The verdict must lead its line; a sentence that merely mentions a task is not a claim.
 */
export interface LoopClaim {
  verdict: 'DONE' | 'BLOCKED' | 'SKIPPED';
  taskId: string;
  remaining: number | null;
}

export function loopClaim(result: string): LoopClaim | null {
  for (const raw of (result || '').split(/\r?\n/)) {
    const m = raw.trim().match(/^(DONE|BLOCKED|SKIPPED)\b[\s:·—-]*([A-Za-z0-9][A-Za-z0-9._\/-]*)/i);
    if (!m) continue;
    return { verdict: m[1].toUpperCase() as LoopClaim['verdict'], taskId: m[2], remaining: remainingFrom(result) };
  }
  return null;
}

/**
 * Is this dispatch's report the previous dispatch's report said again? Same verdict, same task,
 * same remaining count is a cartridge that did nothing new — either it treated the dispatch as
 * a duplicate, or it is stuck on a task it cannot move. Either way another identical dispatch
 * cannot help, and with `[k] remaining` in the text it would EXTEND the budget instead of
 * spending it (run 42a34028: 100 extensions, ten seconds apart).
 *
 * A changed count with the same id is NOT a repeat: something happened, even if the id did not
 * move. Prose without a claim is never judged — silence about the shape is not evidence.
 */
export function isRepeatedClaim(previousResult: string | undefined, result: string): boolean {
  if (!previousResult) return false;
  const prev = loopClaim(previousResult);
  const cur = loopClaim(result);
  if (!prev || !cur) return false;
  return prev.verdict === cur.verdict
    && prev.taskId.toLowerCase() === cur.taskId.toLowerCase()
    && prev.remaining === cur.remaining;
}

/**
 * ── THE UPSTREAM COUNT GATE (LOOP-001) ─────────────────────────────────────────────────
 *
 * `explainLoopCount` above falls back to the static count when it cannot read a real one,
 * and documents why that is the right choice: a wrong count is worse than a small one. But
 * the fallback is only safe if somebody NOTICES. Nobody did. Ten of the twenty-seven epic
 * loops dispatched on this machine ran with a budget of 1 because their upstream step wrote
 * its counts as prose, and each reported a clean finish after one task.
 *
 * The engine already emits a `warn` on that path. A warning in a journal is not a control:
 * it is read after the run it should have stopped. So the count becomes a CONDITION OF
 * COMPLETION for the step that owes it — the same shape as the work standard refusing a
 * "done" with no verification, and for the same reason. A malformed upstream step becomes a
 * blocked step somebody fixes, instead of a silent one-of-forty.
 *
 * The obligation is derived, never hardcoded. It is not a property of a step called
 * "Load Epic"; it is a property of BEING READ FROM. `Epic: Two Repos` has two loops reading
 * TASKS_A and TASKS_B off a single upstream step, and both must be satisfied — starving one
 * loop while feeding the other is a half-fix that looks complete.
 */
export interface UpstreamCountRequirement {
  /** The step whose loop is waiting on this number — named in the error so it is actionable. */
  readerStep: string;
  pattern: string;
}

/** Every count `stepName` owes, derived from the siblings that read from it. */
export function loopCountRequirements(
  stepName: string,
  siblings: { name: string; config: LoopConfig }[],
): UpstreamCountRequirement[] {
  return siblings
    .filter((s) => s.config?.loopCountFrom?.step === stepName && !!s.config.loopCountFrom?.pattern)
    .map((s) => ({ readerStep: s.name, pattern: s.config.loopCountFrom!.pattern }));
}

/**
 * Does `result` satisfy every count owed?
 *
 * Matching is done with the SAME construction `explainLoopCount` uses — `new RegExp(pattern)`
 * against the raw result — so the gate accepts exactly what the reader accepts. A stricter
 * gate blocks work that would have run; a looser one passes a result that still falls back to
 * 1, which is the original defect wearing a badge saying it was checked.
 *
 * An unparseable pattern is an AUTHORING error and resolves to no requirement. `explainLoopCount`
 * already treats it that way, and wedging an agent behind a gate it has no way to satisfy would
 * turn a template typo into a stuck run.
 */
export function validateUpstreamCount(
  result: string,
  requirements: UpstreamCountRequirement[],
): { ok: true } | { ok: false; reason: string } {
  const missing = requirements.filter((r) => {
    try {
      return !new RegExp(r.pattern).test(result || '');
    } catch {
      return false;                       // authoring error, not the agent's problem
    }
  });
  if (missing.length === 0) return { ok: true };

  const lines = missing.map((m) => `  /${m.pattern}/ — read by "${m.readerStep}"`);
  return {
    ok: false,
    reason:
      'This step\'s output is read for a loop count and does not contain one, so the loop that ' +
      'depends on it would silently run ONCE instead of covering the work. Add the count to your ' +
      'result, in the exact shape below, then report done again:\n' + lines.join('\n'),
  };
}
