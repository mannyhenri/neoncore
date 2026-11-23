/**
 * Plain-language tests: one sentence per line. A sentence is a CHECK when it starts with one of
 * CHECK_PREFIXES (docs/plans/qa-section.md, `isCheckSentence`) — the server enforces that a
 * repair never changes what a check checks, so the editor shows which sentences those are.
 */
export const CHECK_PREFIXES = ['Check', 'Verify', 'Ensure', 'Confirm', 'Expect', 'Assert'] as const;

const CHECK_RE = new RegExp(`^\\s*(?:\\d+[.)]\\s*)?(?:${CHECK_PREFIXES.join('|')})\\b`, 'i');

export function isCheckSentence(sentence: string): boolean {
  return CHECK_RE.test(sentence);
}

/** The textarea's lines → sentences: blank lines dropped, a leading "1." / "2)" numbering removed. */
export function parseSentences(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter((l) => l.length > 0);
}
