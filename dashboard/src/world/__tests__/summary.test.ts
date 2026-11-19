import { describe, it, expect, beforeEach } from 'vitest';
import { summarize, SUMMARY_MAX_LINES, SUMMARY_MAX_CHARS, messageId, loadRead, markRead, isUnread } from '../summary';

/**
 * "I'd like to have the last message summarised into 2–3 lines on top of the characters when
 * an agent is finished, and it shows until I click on it."
 *
 * Set-based over a table of the shapes a last message really takes — a work-standard report,
 * plain prose, markdown, a wall of code, nothing at all — so a summary can never come back
 * empty for a real message, longer than three lines, or full of markdown noise.
 */
const CASES: { name: string; message: string; expectLines: number | 'some'; contains?: RegExp[]; excludes?: RegExp[] }[] = [
  {
    name: 'a work-standard completion report',
    message: 'I fixed the copy for every section.\n\nDetails follow…\n\n```\nNEONCORE-DONE\nscope: 15/15 — 12 report sections + 3 attachment types\nverify: npm test -- report-copy → 15 passed, 0 failed\ndeferred: none\n```',
    expectLines: 3,
    contains: [/15\/15/, /15 passed/, /deferred: none|nothing deferred/i],
  },
  {
    name: 'a report with something deferred',
    message: 'NEONCORE-DONE\nscope: 3/4 — endpoints under /api/reports\nverify: npm test → 40 passed\ndeferred: audit-log section — needs a retention decision',
    expectLines: 3,
    contains: [/3\/4/, /audit-log/],
  },
  {
    name: 'plain prose',
    message: 'The login redirect is fixed. The bug was a stale cookie read before the session refresh. I added a regression test and it passes. Next I would look at the logout path, which has the same pattern.',
    expectLines: 'some',
    contains: [/login redirect is fixed/],
  },
  {
    name: 'markdown with headings, bullets, bold and links',
    message: '## Summary\n\n**Done.** The [rate limiter](https://example.com/x) now returns `429` with headers.\n\n- Added `X-RateLimit-Remaining`\n- Updated the docs\n',
    expectLines: 'some',
    contains: [/rate limiter now returns 429/],
    excludes: [/[#*`\[\]]|https?:/],
  },
  {
    name: 'a wall of code with one sentence after it',
    message: '```ts\nexport const a = 1;\nexport const b = 2;\n```\n\nBoth constants are exported now.',
    expectLines: 1,
    contains: [/Both constants are exported now/],
    excludes: [/export const/],
  },
  {
    name: 'one very long sentence',
    message: `Refactored ${'the module and its many callers, '.repeat(30)}and everything still passes.`,
    expectLines: 'some',
  },
  { name: 'nothing', message: '', expectLines: 0 },
  { name: 'only whitespace and a code fence', message: '   \n```\nx\n```\n', expectLines: 0 },
];

describe('summarising a finished agent\'s last message', () => {
  it.each(CASES)('$name', ({ message, expectLines, contains = [], excludes = [] }) => {
    const lines = summarize(message);
    expect(lines.length).toBeLessThanOrEqual(SUMMARY_MAX_LINES);
    if (expectLines === 'some') expect(lines.length).toBeGreaterThanOrEqual(1);
    else expect(lines).toHaveLength(expectLines);
    for (const line of lines) {
      expect(line.length, 'a line that would not fit the bubble').toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
      expect(line.trim()).toBe(line);
      expect(line).not.toBe('');
    }
    const text = lines.join('\n');
    for (const re of contains) expect(text).toMatch(re);
    for (const re of excludes) expect(text).not.toMatch(re);
  });

  it('is two to three lines at most, never more', () => {
    expect(SUMMARY_MAX_LINES).toBe(3);
  });
});

describe('shown until clicked', () => {
  beforeEach(() => localStorage.clear());

  it('a message is unread until marked, stays read across reloads, and a NEW message is unread again', () => {
    const first = messageId('s1', 'All done.');
    expect(isUnread(loadRead(), 'm:a', first)).toBe(true);
    markRead('m:a', first);
    expect(isUnread(loadRead(), 'm:a', first)).toBe(false);          // survives a reload
    expect(isUnread(loadRead(), 'm:b', first)).toBe(true);           // another agent is unaffected
    expect(isUnread(loadRead(), 'm:a', messageId('s1', 'All done, again.'))).toBe(true);
    expect(isUnread(loadRead(), 'm:a', messageId('s2', 'All done.'))).toBe(true);   // a new session
  });

  it('an agent with no message has nothing to read', () => {
    expect(isUnread(loadRead(), 'm:a', messageId('s1', ''))).toBe(false);
    expect(isUnread(loadRead(), 'm:a', messageId('s1', '   '))).toBe(false);
  });

  it('unreadable storage means "nothing read", never a crash', () => {
    localStorage.setItem('neoncore.world.read', '{oops');
    expect(loadRead().size).toBe(0);
  });
});
