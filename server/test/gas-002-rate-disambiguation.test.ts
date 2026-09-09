/**
 * GAS-002 — the rate registry must distinguish models that share a family name,
 * keep working for ids it has never seen, and fall back somewhere defensible.
 *
 * GAS-001 measured the defect: one `sonnet` entry covers Claude Sonnet 5 ($2/$10) and
 * Claude Sonnet 4.6 ($3/$15), so whichever rate it holds, the sibling is 50% wrong. The fix
 * is a SPECIFICITY rule — the longest matching pattern wins — rather than exact-match, which
 * would throw away the substring ergonomics that let an unprefixed or newly-suffixed id
 * still price correctly.
 *
 * ── THE FALLBACK DECISION, WHICH THIS TASK OWNS ───────────────────────────────────────
 * Epic Open Question 4 left the unrecognised-model rate to GAS-002. Decided here: an unknown
 * model prices at NO LESS than every known model, i.e. the most expensive tier.
 *
 * The reason is the consumer, not the model. These rates divide a user's declared budget to
 * answer "how long until 100%". Pricing an unknown model CHEAPLY makes the tank look fuller
 * than it is, which is the one failure direction that matters: the gauge says three days and
 * the work stops in one. Pricing it expensively makes the gauge pessimistic, which costs a
 * user some unused headroom and nothing else. Between a silent overrun and unused headroom,
 * a budget gauge should take the headroom.
 *
 * The previous default was Opus-tier, which UNDER-prices a Fable-tier model by 2x — the
 * dangerous direction — and that is what changes here.
 *
 * This fallback is a safety net that should never fire in practice: GAS-003 adds the guard
 * asserting every model id actually present in `session_usage` resolves to a real entry, so
 * reaching the default becomes an alarm rather than a silent mispricing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowCostUsd } from '../src/lib/pricing.js';

const MTOK = 1_000_000;
const CLASSES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const COL = { input: 'input_tokens', output: 'output_tokens',
              cacheRead: 'cache_read_tokens', cacheWrite: 'cache_creation_tokens' } as const;

function rate(model: string, cls: typeof CLASSES[number]): number {
  return rowCostUsd({ model, input_tokens: 0, output_tokens: 0,
                      cache_read_tokens: 0, cache_creation_tokens: 0, [COL[cls]]: MTOK });
}
const rates = (model: string) => Object.fromEntries(CLASSES.map((c) => [c, rate(model, c)]));

/**
 * SPECIFICITY: ids where a more specific pattern must beat a less specific one that also
 * matches. Set-based — the sonnet split is the live case, but the rule is what is under test,
 * so the next family to split is covered without editing this file.
 */
test('a more specific pattern wins over a shorter one that also matches', () => {
  const wrong: string[] = [];
  const cases: [string, Record<string, number>][] = [
    ['claude-sonnet-5',   { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
    ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ];
  for (const [model, want] of cases) {
    for (const c of CLASSES) {
      if (Math.abs(rate(model, c) - want[c]) > 1e-9) {
        wrong.push(`${model} ${c}: $${rate(model, c)}, want $${want[c]}`);
      }
    }
  }
  assert.deepEqual(wrong, [], `specificity rule not applied:\n  ${wrong.join('\n  ')}`);
});

/**
 * ERGONOMICS: the substring match is what lets an id the table has never seen still price
 * correctly. Exact-match matching would break every one of these.
 */
test('unprefixed and unseen-suffix ids still resolve to their family', () => {
  const wrong: string[] = [];
  for (const [model, family] of [
    ['opus', 'claude-opus-5'], ['claude-opus-9-9', 'claude-opus-5'],
    ['haiku', 'claude-haiku-4-5'], ['some-vendor/claude-fable-7', 'claude-fable-5-1'],
    ['sonnet', 'claude-sonnet-4-6'],
  ] as const) {
    for (const c of CLASSES) {
      if (Math.abs(rate(model, c) - rate(family, c)) > 1e-9) {
        wrong.push(`${model} ${c}: $${rate(model, c)}, expected the ${family} rate $${rate(family, c)}`);
      }
    }
  }
  assert.deepEqual(wrong, [], `substring ergonomics lost:\n  ${wrong.join('\n  ')}`);
});

/**
 * THE FALLBACK INVARIANT, expressed as a property rather than a number so it survives any
 * future rate change: an unknown model is never cheaper than a known one on any class.
 */
test('an unrecognised model is never cheaper than any known model', () => {
  const KNOWN = ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5',
                 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5-1'];
  const UNKNOWN = ['', 'gpt-4o', 'llama-3-70b', 'some-model-we-have-never-seen'];
  const cheap: string[] = [];
  for (const u of UNKNOWN) {
    for (const k of KNOWN) {
      for (const c of CLASSES) {
        if (rate(u, c) < rate(k, c) - 1e-9) {
          cheap.push(`unknown "${u}" ${c}: $${rate(u, c)} is cheaper than ${k}'s $${rate(k, c)}`);
        }
      }
    }
  }
  assert.deepEqual(cheap, [],
    `an unknown model priced below a known one understates burn, which makes a budget gauge\n` +
    `report headroom that does not exist:\n  ${cheap.join('\n  ')}`);
});
