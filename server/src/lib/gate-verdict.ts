/**
 * READING A GATE'S VERDICT — the one implementation.
 *
 * Two places need it and used to disagree: the executor decides PASS/FAIL from a gate's result
 * (exactly `PASS` on line 1), and the completion webhook decides whether line 1 IS a verdict, so
 * that a `next` hand-off is inserted beneath it rather than above (`/^(PASS|FAIL)\b/`). An agent
 * following WORKFLOWS.md wrote `STATUS: PASS`, which the executor read as FAIL — every gate,
 * every workflow — and which the webhook did not recognise as a verdict at all, so with a hand-off
 * the stored first line became `NEXT: …`.
 *
 * ── WHAT COUNTS AS A PASS ─────────────────────────────────────────────────────────────
 * The first non-empty line, once its LABEL and DECORATION are removed, must be exactly `PASS`:
 *
 *   label       STATUS: · Verdict: · Result: · Gate verdict -  (any case, `:` or `-`)
 *   decoration  **bold**, `code`, _emphasis_, a trailing full stop / exclamation
 *
 * Anything else on that line — "PASS: with caveats", "PASS — but two tests skipped" — is a
 * qualified pass, and a qualified pass is a FAIL. That rule predates this module and is kept on
 * purpose: it is what stops a zero-retry evidence gate from being talked past
 * (test/ce-develop-optimize-template.test.ts). Explanations belong on the following lines.
 */

const LABEL = /^(?:gate\s+)?(?:status|verdict|result)\s*[:\-–—]\s*/i;

/** The verdict line with its label and decoration removed, upper-cased. */
export function normalizeVerdictLine(line: string): string {
  let s = (line || '').trim();
  s = s.replace(/[*_`]+/g, '').trim();         // markdown emphasis / code, wherever it sits
  s = s.replace(LABEL, '').trim();
  s = s.replace(/[.!]+$/, '').trim();           // "PASS." — punctuation, not a qualification
  return s.toUpperCase();
}

/** The first non-empty line of a result — where the verdict is read from. */
export function firstLine(result: string): string {
  return (result || '').split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
}

/** A gate verdict is a PASS only when its first non-empty line is a bare (labelled) PASS. */
export function isPassingGateVerdict(result: string): boolean {
  return normalizeVerdictLine(firstLine(result)) === 'PASS';
}

/**
 * Is this line a verdict line at all — PASS or FAIL, labelled or not? Used to keep a verdict on
 * line 1 when other text (a hand-off) is added to a stored result.
 */
export function isVerdictLine(line: string): boolean {
  return /^(PASS|FAIL)\b/.test(normalizeVerdictLine(line));
}
