/**
 * GAS-014 — price fast mode at what it actually costs.
 *
 * Opus fast mode bills $10/$50 per MTok against standard $5/$25. `session_usage` had no
 * `speed` column, so every fast-mode turn was priced at HALF its true cost. That understates
 * burn, which overstates headroom, which is the one failure direction this whole epic treats
 * as dangerous: the gauge says four days and the work stops in two.
 *
 * ── FAST IS NEVER CHEAPER, AND THAT IS THE PROPERTY WORTH ASSERTING ───────────────────
 * The exact cache multipliers for fast mode are not published the way input and output are, so
 * the table derives them on the same 0.1x / 1.25x convention it uses everywhere else. That is
 * an inference, and it is recorded as one. What is NOT an inference is the direction: fast
 * mode costs more, so no model/class pair may price lower under `fast` than under standard.
 * Asserted over the whole registry rather than at the two ids that have a fast variant today.
 *
 * ── EVERY EXISTING CALLER MUST BE UNAFFECTED ──────────────────────────────────────────
 * rowCostUsd is called from burn-rate.ts, usage-series.ts, goal-cost.ts and limit-events.ts,
 * none of which know about speed. A row with no speed is a STANDARD row and must price exactly
 * as it did before this task, or every historical figure in the product silently moves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowCostUsd } from '../src/lib/pricing.js';

const MTOK = 1_000_000;
const CLASSES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const COL = { input: 'input_tokens', output: 'output_tokens',
              cacheRead: 'cache_read_tokens', cacheWrite: 'cache_creation_tokens' } as const;

const rate = (model: string, cls: typeof CLASSES[number], speed?: string) =>
  rowCostUsd({ model, speed, input_tokens: 0, output_tokens: 0,
               cache_read_tokens: 0, cache_creation_tokens: 0, [COL[cls]]: MTOK } as never);

const MODELS = ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6',
                'claude-haiku-4-5', 'claude-fable-5-1'];

test('Opus fast mode prices at its published rate, not the standard one', () => {
  assert.equal(rate('claude-opus-5', 'input', 'fast'), 10, 'fast input is $10/MTok, not $5');
  assert.equal(rate('claude-opus-5', 'output', 'fast'), 50, 'fast output is $50/MTok, not $25');
  assert.equal(rate('claude-opus-4-8', 'input', 'fast'), 10);
});

test('a row with NO speed prices exactly as it always did', () => {
  const wrong: string[] = [];
  for (const [model, want] of [
    ['claude-opus-5', 5], ['claude-opus-4-8', 5], ['claude-sonnet-5', 2],
    ['claude-sonnet-4-6', 3], ['claude-haiku-4-5', 1], ['claude-fable-5-1', 10],
  ] as [string, number][]) {
    for (const speed of [undefined, '', 'standard']) {
      const got = rate(model, 'input', speed);
      if (got !== want) wrong.push(`${model} speed=${JSON.stringify(speed)}: $${got}, want $${want}`);
    }
  }
  assert.deepEqual(wrong, [],
    `historical rows would silently reprice — every caller of rowCostUsd omits speed:\n  ${wrong.join('\n  ')}`);
});

/** THE INVARIANT: fast may cost more, never less. Over the whole registry, not two ids. */
test('no model or token class is CHEAPER under fast than under standard', () => {
  const cheaper: string[] = [];
  for (const model of MODELS) {
    for (const cls of CLASSES) {
      const std = rate(model, cls);
      const fast = rate(model, cls, 'fast');
      if (fast < std - 1e-9) cheaper.push(`${model} ${cls}: fast $${fast} < standard $${std}`);
    }
  }
  assert.deepEqual(cheaper, [],
    `fast mode priced below standard understates burn, which overstates headroom:\n  ${cheaper.join('\n  ')}`);
});

test('a model with no fast variant falls back to its standard rate, not to a guess', () => {
  // Fast mode exists on Opus only. Inventing a fast Haiku rate would be exactly the kind of
  // fabricated number this epic refuses elsewhere.
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-fable-5-1']) {
    for (const cls of CLASSES) {
      assert.equal(rate(model, cls, 'fast'), rate(model, cls),
        `${model} has no published fast rate; ${cls} must not be invented`);
    }
  }
});

test('an unrecognised speed value is treated as standard, never as an error', () => {
  for (const speed of ['FAST', 'turbo', 'null', '  ']) {
    assert.equal(rate('claude-opus-5', 'input', speed), 5,
      `"${speed}" is not the documented fast marker and must not silently double the bill`);
  }
});

/** End to end: a fast turn must cost double through the SAME path the badge uses. */
import { computeBurnRate } from '../src/lib/burn-rate.js';

test('the fleet burn rate charges a fast turn at the fast rate', () => {
  const at = new Date().toISOString();
  const row = (speed: string) => ({
    input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    model: 'claude-opus-5', speed, recorded_at: at,
  });
  const standard = computeBurnRate([row('')], 24);
  const fast = computeBurnRate([row('fast')], 24);
  assert.equal(standard.costUsd, 5, 'a standard MTok of Opus input is $5');
  assert.equal(fast.costUsd, 10, 'the same MTok in fast mode is $10 — it was being billed as $5');
  assert.equal(fast.costUsd, standard.costUsd * 2);
});
