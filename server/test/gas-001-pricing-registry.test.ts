/**
 * GAS-001 — every current model prices at its PUBLISHED rate.
 *
 * `pricing.ts` matches a model id by case-insensitive substring against a four-entry
 * registry. That is ergonomic for unknown ids and wrong for a family that has split: one
 * `sonnet` entry now covers BOTH Claude Sonnet 5 ($2/$10) and Claude Sonnet 4.6 ($3/$15),
 * and whichever rate the entry holds, the other model is mispriced by ~50%.
 *
 * SET-BASED OVER THE REGISTRY, NOT AN EXAMPLE. The defect is one substring spanning two
 * models, so a test that priced a single id would pass the moment that id was made correct
 * while its sibling stayed wrong — a half-fix that looks finished. This iterates every
 * current model against every token class and reports EVERY mismatch in one failure, so a
 * fix that corrects input but forgets cacheRead cannot read as done.
 *
 * ── WAS A `todo` UNTIL GAS-002 ────────────────────────────────────────────────────────
 * GAS-001's acceptance was that this test FAIL before GAS-002 fixed the registry. It did —
 * measured, not assumed:
 *
 *     ✖ every current model prices at its published rate
 *       AssertionError: these model/token-class pairs do not price at their published rate:
 *         claude-sonnet-5 input:      $3/MTok,    published $2/MTok
 *         claude-sonnet-5 output:     $15/MTok,   published $10/MTok
 *         claude-sonnet-5 cacheRead:  $0.3/MTok,  published $0.2/MTok
 *         claude-sonnet-5 cacheWrite: $3.75/MTok, published $2.5/MTok
 *
 * Exactly one model, all four of its classes — the `sonnet` entry holds Sonnet 4.6's rate,
 * so Sonnet 5 is overpriced by 50% on every class.
 *
 * The epic's loop rule is that a red suite means commit nothing, so the failure was recorded
 * above and committed under `todo` — running the assertion and reporting it without wedging
 * GAS-002 through GAS-015 behind a failure that was doing its job. GAS-002 split the registry
 * (`sonnet-5` narrower than `sonnet`, longest match wins) and REMOVED the marker, which is why
 * this now guards the property for real. A todo nobody retires reads as coverage that does not
 * exist, so retiring it was part of GAS-002 rather than optional cleanup.
 *
 * HOW A RATE IS RECOVERED. `RATES` and `rateFor` are module-private; only `rowCostUsd` is
 * exported. Pricing a row of exactly 1,000,000 tokens of ONE class and zero of the others
 * returns that class's per-MTok rate exactly, since rowCostUsd divides by 1_000_000. That
 * reads the real shipped function rather than a copy of its table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowCostUsd } from '../src/lib/pricing.js';

/** The complete set: every model id this fleet can currently record, and its published USD/MTok. */
const PUBLISHED: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5':     { input: 5,  output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8':   { input: 5,  output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5':   { input: 2,  output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5':  { input: 1,  output: 5,  cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-fable-5-1':  { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
};

const MTOK = 1_000_000;

/** One class at a time, so the returned cost IS that class's rate. */
function observedRate(model: string, cls: keyof typeof PUBLISHED[string]): number {
  const row = { model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const col = { input: 'input_tokens', output: 'output_tokens',
                cacheRead: 'cache_read_tokens', cacheWrite: 'cache_creation_tokens' }[cls];
  return rowCostUsd({ ...row, [col]: MTOK });
}

test('every current model prices at its published rate', () => {
  const mismatches: string[] = [];
  for (const [model, want] of Object.entries(PUBLISHED)) {
    for (const cls of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const got = observedRate(model, cls);
      if (Math.abs(got - want[cls]) > 1e-9) {
        mismatches.push(`${model} ${cls}: $${got}/MTok, published $${want[cls]}/MTok`);
      }
    }
  }
  assert.deepEqual(
    mismatches, [],
    `these model/token-class pairs do not price at their published rate:\n  ${mismatches.join('\n  ')}`,
  );
});
