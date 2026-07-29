/**
 * Did this turn end by asking the human something?
 *
 * Only `AskUserQuestion` ever marked a cartridge as waiting (agent/hooks/permission-proxy.py).
 * An agent that just ends its message with "which approach do you prefer?" fires no hook at
 * all, so the question never reached the phone and the cartridge sat looking idle. Worse,
 * the eventual reply was then treated as a brand-new task: standard re-injected, objective
 * overwritten, gate disarmed mid-edit.
 *
 * This is a heuristic and it is kept deliberately tight, because the failure modes are not
 * symmetric. Missing a question leaves things exactly as they were before. A FALSE positive
 * parks a live cartridge in `waiting` on your grid, which is a lie about the fleet.
 *
 * Rules: only the FINAL non-empty line counts (a rhetorical "why does this matter?" in the
 * middle of an explanation is not an ask), it must end in a question mark, it must not be
 * inside a code fence, and it must be short enough to actually be a question rather than a
 * paragraph that happens to trail off interrogatively.
 */

/** Longer than this and it is prose, not a question you could answer from a phone. */
const MAX_QUESTION_CHARS = 400;

/** Shorter than this and it is punctuation noise, not a question. */
const MIN_QUESTION_CHARS = 5;

/** Trailing/leading markdown emphasis and list markers to strip for display. */
const MARKDOWN_EDGES = /^[\s>*_`#-]+|[\s*_`]+$/g;

export function detectTrailingQuestion(text: string | null | undefined): string | null {
  if (!text || typeof text !== 'string') return null;

  const lines = text.split('\n');

  // An UNCLOSED fence means everything after it is code; a closed one is already behind us.
  // Counting fences is enough to know whether the tail sits inside a block.
  const fenceCount = lines.filter((l) => l.trim().startsWith('```')).length;
  if (fenceCount % 2 !== 0) return null;

  // Walk back to the last line with content, skipping a trailing code fence entirely.
  let idx = lines.length - 1;
  while (idx >= 0 && !lines[idx].trim()) idx -= 1;
  if (idx < 0) return null;

  // If the message ends with a fenced block, the question (if any) is inside it — ignore.
  if (lines[idx].trim().startsWith('```')) return null;

  // Strip markdown BEFORE testing for the question mark. A bolded question ends in `*`, not
  // `?`, so checking first silently ignored every emphasised ask — which is exactly how a
  // human writes the question they most want answered.
  const question = lines[idx].trim().replace(MARKDOWN_EDGES, '').trim();

  if (!question.endsWith('?')) return null;
  if (question.length < MIN_QUESTION_CHARS || question.length > MAX_QUESTION_CHARS) return null;

  return question;
}
