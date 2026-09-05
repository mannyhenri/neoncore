import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * The work-standard banner on the phone, and the build number that ships it.
 *
 * Both halves are set-based on purpose. The banner rule is checked against EVERY value
 * `standardState` can hold rather than the one that matters, and the build number is
 * checked against EVERY build configuration in the Xcode project rather than the first
 * one found — bumping Debug and leaving Release at the old number is precisely the kind of
 * partial change that looks done, builds fine, and produces a confusing TestFlight upload.
 */

describe('iOS build number', () => {
  const pbxproj = readFileSync(
    path.resolve(__dirname, '../../ios/NeonCore.xcodeproj/project.pbxproj'),
    'utf8',
  );

  /*
   * The invariant is AGREEMENT, not a specific number.
   *
   * This used to compare every configuration against a hardcoded EXPECTED_BUILD, which meant a
   * test that fails on every legitimate release: the build number is SUPPOSED to change, so
   * pinning it makes a correct bump look like a regression. `chore(ios): bump build to 37`
   * moved both configurations together — the thing this test exists to protect — and the suite
   * went red anyway because the constant was left at 36. A test that cries wolf on every
   * release trains people to edit it reflexively, which is how the partial bump it guards
   * against would eventually sail through.
   *
   * So it now asserts what the comment above always said it was for: Debug and Release carry
   * the SAME build. The marketing-version test beside it already worked this way.
   */
  it('carries the same build in EVERY configuration', () => {
    const found = [...pbxproj.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1]);
    expect(found.length, 'no build numbers found — the pbxproj format changed').toBeGreaterThanOrEqual(2);
    expect(
      new Set(found).size,
      `configurations disagree about the build number: ${[...new Set(found)].join(', ')} — ` +
      'one was bumped and another left behind, which builds fine and uploads confusingly',
    ).toBe(1);
    expect(Number.isInteger(Number(found[0])), `build "${found[0]}" is not a number`).toBe(true);
  });

  it('keeps the marketing version untouched — this is a build bump, not a release', () => {
    const versions = [...pbxproj.matchAll(/MARKETING_VERSION = ([\d.]+);/g)].map((m) => m[1]);
    expect(new Set(versions).size, 'marketing version diverged between configs').toBe(1);
    expect(versions[0]).toBe('0.7.0');
  });
});

describe('the needs-review banner', () => {
  it('shows for exactly one state, across every value the field can take', async () => {
    const { needsStandardReview } = await import('../standardBanner');

    // The complete set of values the server can put in this field, plus the absent case
    // a federated peer on an older build produces.
    const STATES: Array<{ value: string | undefined; shows: boolean }> = [
      { value: 'needs_review', shows: true },
      { value: '', shows: false },
      { value: undefined, shows: false },
    ];

    const wrong = STATES.filter(
      (s) => needsStandardReview({ standardState: s.value } as never) !== s.shows,
    ).map((s) => JSON.stringify(s.value));

    expect(wrong, `banner decided wrongly for: ${wrong.join(', ')}`).toEqual([]);
  });

  it('never throws on a malformed or empty agent', async () => {
    const { needsStandardReview } = await import('../standardBanner');
    expect(needsStandardReview(undefined as never)).toBe(false);
    expect(needsStandardReview({} as never)).toBe(false);
  });
});

describe('the Reviewed action', () => {
  it('is exposed on the api surface', async () => {
    const { api } = await import('../api');
    expect(typeof (api as Record<string, unknown>).clearStandardReview).toBe('function');
  });
});
