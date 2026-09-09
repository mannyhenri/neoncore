/**
 * GAS-003 — the rate registry must resolve every model id unambiguously, and no model this
 * fleet actually records may fall through to the default.
 *
 * ── WHY THIS IS NOT "NO TWO ENTRIES MAY MATCH THE SAME ID" ────────────────────────────
 * That was the obvious phrasing and it is wrong now. GAS-002 made `sonnet-5` and `sonnet`
 * BOTH match `claude-sonnet-5` deliberately — that overlap IS the mechanism that splits a
 * family, and the longest pattern wins. A guard forbidding overlap would fail on correct code
 * and would have to be deleted the first time it fired, which is worse than no guard.
 *
 * The real hazard is a TIE. If two patterns of EQUAL length both match one id, `rateFor` has
 * no basis to choose and returns whichever sits earlier in the array — silent, order-dependent
 * mispricing that survives any reordering of the table. `claude` and `opus-5` are both six
 * characters and both match `claude-opus-5`; a table that ever contains such a pair prices by
 * accident. That is what this asserts against.
 *
 * ── AND THE FALLBACK MUST STAY AN ALARM ───────────────────────────────────────────────
 * GAS-002 made the unrecognised-model rate the most expensive tier so an unknown model cannot
 * make a budget look fuller than it is. That is a safety net, not a pricing strategy: anything
 * the fleet actually records should hit a real entry. This reads the live `session_usage`
 * read-only and requires every distinct model in it to match a pattern, so the day a Sonnet or
 * Haiku cartridge registers, the table's silence becomes a test failure instead of a 5x
 * mispriced budget.
 *
 * The registry is read from SOURCE rather than imported because `RATES` is module-private and
 * widening the public API for a test would be the wrong trade — the same approach
 * migrations-reachable.test.ts takes over db.ts's migration blocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRICING = path.join(HERE, '..', 'src', 'lib', 'pricing.ts');
const LIVE_DB = path.join(HERE, '..', 'neoncore.db');

/** The complete pattern set, read out of the source rather than hand-listed. */
function patterns(): string[] {
  const src = fs.readFileSync(PRICING, 'utf8');
  const block = src.slice(src.indexOf('const RATES'), src.indexOf('];', src.indexOf('const RATES')));
  return [...block.matchAll(/match:\s*'([^']+)'/g)].map((m) => m[1]);
}

function liveModels(): string[] {
  if (!fs.existsSync(LIVE_DB)) return [];
  const db = new Database(LIVE_DB, { readonly: true });
  try {
    return (db.prepare('SELECT DISTINCT model FROM session_usage').all() as { model: string }[])
      .map((r) => (r.model || '').toLowerCase());
  } catch {
    return [];                       // table absent in a fresh database; coverage has nothing to say
  } finally {
    db.close();
  }
}

test('no model id is matched by two patterns of equal length', () => {
  const pats = patterns();
  assert.ok(pats.length >= 4, `expected the rate registry to be found, got ${pats.length}`);

  // Adversarial corpus: the ids we price today, whatever the fleet has actually recorded, and
  // shapes a future entry might collide on.
  const corpus = [...new Set([
    'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6',
    'claude-haiku-4-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-4-6',
    ...liveModels(),
  ])];

  const ties: string[] = [];
  for (const id of corpus) {
    const hits = pats.filter((p) => id.includes(p));
    if (hits.length === 0) continue;                       // coverage is the other test's job
    const longest = Math.max(...hits.map((h) => h.length));
    const winners = hits.filter((h) => h.length === longest);
    if (winners.length > 1) {
      ties.push(`${id}: ${winners.map((w) => `'${w}'`).join(' and ')} are both ${longest} chars — ` +
                `resolution depends on array order`);
    }
  }
  assert.deepEqual(ties, [],
    `these ids resolve by accident rather than by specificity:\n  ${ties.join('\n  ')}`);
});

test('every model the fleet has recorded matches a real entry, not the fallback', () => {
  const models = liveModels();
  if (models.length === 0) return;                          // no live database here; nothing to guard
  const pats = patterns();
  const uncovered = models.filter((m) => !pats.some((p) => m.includes(p)));
  assert.deepEqual(uncovered, [],
    `these models are recorded in session_usage but match no rate entry, so they price at the\n` +
    `most-expensive fallback rather than their own rate:\n  ${uncovered.map((m) => m || '(blank)').join('\n  ')}`);
});
