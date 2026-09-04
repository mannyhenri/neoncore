/**
 * The fleet burn rate: tokens/hour and tokens/day across every cartridge.
 *
 * THE GAP THIS GUARDS. `workflow_steps.tokens_in/tokens_out` is not a measurement — it is
 * `dispatched_prompt.length / 4` and `result.length / 4` (routes/workflows.ts). It never
 * sees the agentic loop inside a step, and it models no cache at all. On the CE: Full
 * Delivery run of 2026-09-01 it claimed 48,683 output tokens where session_usage recorded
 * 1,034,252 output plus 516,377,556 cache-read across 812 turns. A readout in the HEADER —
 * the first number anyone reads — cannot repeat that mistake.
 *
 * SO THIS TEST IS SET-BASED OVER THE SCHEMA, NOT OVER EXAMPLES. It parses every `*_tokens`
 * column off `session_usage` in db.ts and asserts each one moves the rate. An example-based
 * test ("100 in + 50 out over 1h is 150/h") passes with cache dropped, which is the whole
 * failure. Deriving the set from the schema also means the NEXT token class — a new cache
 * tier, a thinking-token column — fails here on the day it is added rather than silently
 * reading low forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeBurnRate, type UsageSample } from '../src/lib/burn-rate.ts';

/**
 * THE SET, read out of the schema rather than typed here by hand.
 *
 * `session_usage` is built in two places — the CREATE TABLE, and the later ALTER that added
 * the cache columns — so both are scanned. A registry that only read the CREATE would miss
 * exactly the two columns this test exists to protect.
 */
function tokenColumnsFromSchema(): string[] {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'db.ts'), 'utf8');

  const createAt = src.indexOf('CREATE TABLE IF NOT EXISTS session_usage');
  assert.ok(createAt > -1, 'db.ts no longer creates session_usage — the schema moved');
  const createBlock = src.slice(createAt, src.indexOf(');', createAt));

  const cols = new Set<string>();
  for (const m of createBlock.matchAll(/^\s*(\w*_?tokens)\s+INTEGER/gm)) cols.add(m[1]);
  for (const m of src.matchAll(/ALTER TABLE session_usage ADD COLUMN (\w+_tokens)/g)) cols.add(m[1]);

  assert.ok(cols.size >= 4, `expected >=4 token columns on session_usage, parsed ${cols.size}: ${[...cols]}`);
  return [...cols];
}

const TOKEN_COLUMNS = tokenColumnsFromSchema();

/** A zeroed row, so each case can raise exactly one column. */
function blankRow(): UsageSample {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    model: 'claude-opus-5',
    recorded_at: '2026-09-04T00:00:00.000Z',
  };
}

test('every token column on session_usage moves the burn rate', () => {
  const failures: string[] = [];

  for (const col of TOKEN_COLUMNS) {
    const row = blankRow() as unknown as Record<string, unknown>;
    row[col] = 1_000_000;

    const r = computeBurnRate([row as unknown as UsageSample], 1);

    if (r.tokensPerHour !== 1_000_000) {
      failures.push(`${col}: 1,000,000 tokens over 1h gave ${r.tokensPerHour}/h — not counted`);
    }
    if (r.costUsd <= 0) {
      failures.push(`${col}: 1,000,000 tokens priced at $${r.costUsd} — not billed`);
    }
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('the two rates are derived from one window, so they cannot disagree', () => {
  // The readout shows per-hour and per-day side by side. If they came from different
  // windows the header would contradict itself on screen.
  const rows = [{ ...blankRow(), input_tokens: 500, output_tokens: 250, cache_read_tokens: 90_000 }];

  for (const windowHours of [1, 24, 168, 720]) {
    const r = computeBurnRate(rows, windowHours);
    assert.equal(r.tokensPerDay, r.tokensPerHour * 24, `day rate diverges from hour rate at ${windowHours}h`);
    assert.equal(r.costPerDay, (r.costUsd / windowHours) * 24, `cost/day diverges at ${windowHours}h`);
    assert.equal(r.windowHours, windowHours);
  }
});

test('the total is the sum of every class, not just input+output', () => {
  // This is the `activity.ts:170` bug — `total: totalInput + totalOutput` — which is why the
  // cartridge card reads ~16.4M while the cartridge actually moved 10.07 BILLION cache tokens.
  const r = computeBurnRate([{
    ...blankRow(), input_tokens: 1, output_tokens: 2, cache_read_tokens: 4, cache_creation_tokens: 8,
  }], 1);
  assert.equal(r.tokens, 15, 'tokens must include cache read and cache creation');
});

test('no NaN and no Infinity on the empty and degenerate cases', () => {
  const finite = (r: ReturnType<typeof computeBurnRate>, label: string) => {
    for (const [k, v] of Object.entries(r)) {
      assert.ok(Number.isFinite(v as number), `${label}: ${k} was ${v}`);
    }
  };
  finite(computeBurnRate([], 168), 'no rows');
  finite(computeBurnRate([blankRow()], 0), 'zero-length window');
  finite(computeBurnRate([blankRow()], -5), 'negative window');
});

/**
 * ROUTE SHADOWING — the bug that made the first version of this endpoint return `[]`.
 *
 * `activity.ts` declares `router.get('/:agentId')`, and Express matches in declaration order,
 * so ANY literal single-segment GET declared after it is unreachable. It does not 404, which
 * is what makes it dangerous: it returns that handler's answer for an agent whose id happens
 * to be the literal — an empty array — and an empty array looks like "no data yet", not like
 * a wiring fault. `/burn-rate` shipped behind it for exactly one build.
 *
 * SET-BASED over every GET in the file, not a check for `/burn-rate`: the next literal route
 * added to this router has the identical trap waiting for it, and naming only this one would
 * let the next author rediscover it the slow way.
 */
test('no literal GET route in activity.ts is shadowed by a single-segment param route', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'routes', 'activity.ts'), 'utf8');

  // Anchored to line start: prose ABOUT a route (this file's own ordering note quotes
  // `router.get('/:agentId')`) is not a declaration, and counting it would place a phantom
  // catch-all at the top of the file and fail every route below it.
  const routes = [...src.matchAll(/^router\.get\(\s*'([^']+)'/gm)].map((m) => ({
    path: m[1],
    at: m.index ?? 0,
  }));
  assert.ok(routes.length >= 3, `parsed only ${routes.length} GET routes — the file changed shape`);

  // A catch-all: exactly one segment, and that segment is a parameter.
  const catchAlls = routes.filter((r) => /^\/:[^/]+$/.test(r.path));

  const shadowed: string[] = [];
  for (const c of catchAlls) {
    for (const r of routes) {
      const segments = r.path.replace(/^\//, '').split('/').filter(Boolean);
      const isLiteralOneSegment = segments.length === 1 && !segments[0].startsWith(':');
      if (isLiteralOneSegment && r.at > c.at) {
        shadowed.push(`GET '${r.path}' is declared after catch-all '${c.path}' — it will return that handler's result, not its own`);
      }
    }
  }

  assert.deepEqual(shadowed, [], `\n  ${shadowed.join('\n  ')}\n`);
});
