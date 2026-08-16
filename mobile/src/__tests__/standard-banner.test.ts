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

const EXPECTED_BUILD = 36;

describe('iOS build number', () => {
  const pbxproj = readFileSync(
    path.resolve(__dirname, '../../ios/NeonCore.xcodeproj/project.pbxproj'),
    'utf8',
  );

  it('is set to the new build in EVERY configuration', () => {
    const found = [...pbxproj.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1]);
    expect(found.length).toBeGreaterThanOrEqual(2); // Debug + Release at minimum
    const wrong = found.filter((v) => v !== String(EXPECTED_BUILD));
    expect(wrong, `configs left on an old build number: ${wrong.join(', ')}`).toEqual([]);
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
