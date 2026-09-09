/**
 * GAS-004 — the declared weekly budget, and the one distinction the whole gauge rests on.
 *
 * ── UNSET IS NOT ZERO, AND CONFLATING THEM IS THE BUG THIS PREVENTS ───────────────────
 * GAS-005's projection returns `basis: 'unknown'` when no budget exists and a real,
 * already-exhausted projection when the budget is genuinely zero. A store that hands back
 * the number 0 for both makes those two states indistinguishable downstream, and the badge
 * then renders "0 days left" to a user who simply never set a budget — a confident number
 * with nothing behind it, which is exactly what the epic's basis rule exists to prevent.
 * So the accessor returns `null` for unset and a number for set, and never 0-as-unset.
 *
 * ── WHY VALIDATION LIVES HERE AND NOT IN THE ROUTE ────────────────────────────────────
 * PUT /api/settings is a generic key/value upsert: it accepts any string for any key and
 * writes it. That is fine for `projects_dir`, and not fine for a number a budget divides by
 * — `"banana"` would store cleanly and surface as NaN days remaining, and a negative budget
 * would render a negative countdown. The validator is a pure function so it can be tested
 * over the whole space of bad input rather than through an HTTP harness, and the route
 * becomes a thin shell that calls it.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWeeklyBudget, parseBasis, budgetFrom, validateBudgetValue, BUDGET_KEYS }
  from '../src/lib/budget.js';

test('every representation of "no budget" reads as unset, never as zero', () => {
  const wrong: string[] = [];
  for (const raw of [undefined, '', '   ', '0', '0.0', '0.00', '-0', '\t\n']) {
    const got = parseWeeklyBudget(raw);
    if (got !== null) wrong.push(`${JSON.stringify(raw)} -> ${got}, expected null`);
  }
  assert.deepEqual(wrong, [],
    `these must read as unset so the projection can say "no basis" instead of "0 days left":\n  ${wrong.join('\n  ')}`);
});

test('a real budget reads back as its number', () => {
  const wrong: string[] = [];
  for (const [raw, want] of [['100', 100], ['12.5', 12.5], [' 250 ', 250], ['1000.75', 1000.75]] as const) {
    const got = parseWeeklyBudget(raw);
    if (got !== want) wrong.push(`${JSON.stringify(raw)} -> ${got}, expected ${want}`);
  }
  assert.deepEqual(wrong, [], `budget values did not round-trip:\n  ${wrong.join('\n  ')}`);
});

test('every malformed budget is rejected, and every well-formed one accepted', () => {
  const wrong: string[] = [];
  // A value a budget gets DIVIDED by: anything that is not a finite non-negative number
  // becomes NaN days or a negative countdown downstream.
  for (const bad of ['banana', '-1', '-100.5', 'NaN', 'Infinity', '-Infinity', '1,000', '12px', '1e999']) {
    if (validateBudgetValue('usage_budget_usd_weekly', bad) === null) {
      wrong.push(`"${bad}" was accepted but is not a usable budget`);
    }
  }
  for (const ok of ['', '0', '100', '12.5', ' 250 ']) {
    const err = validateBudgetValue('usage_budget_usd_weekly', ok);
    if (err !== null) wrong.push(`"${ok}" was rejected: ${err}`);
  }
  assert.deepEqual(wrong, [], `budget validation is wrong for:\n  ${wrong.join('\n  ')}`);
});

test('basis accepts only the two states the badge can render', () => {
  const wrong: string[] = [];
  for (const ok of ['budget', 'measured', '']) {
    if (validateBudgetValue('usage_budget_basis', ok) !== null) wrong.push(`"${ok}" rejected but is valid`);
  }
  for (const bad of ['guess', 'BUDGET', 'estimated', 'true', '1']) {
    if (validateBudgetValue('usage_budget_basis', bad) === null) wrong.push(`"${bad}" accepted but is not a basis`);
  }
  // Absent or blank means the declared budget, which is the only basis GAS-002..GAS-011 build.
  if (parseBasis(undefined) !== 'budget') wrong.push(`absent basis -> ${parseBasis(undefined)}, expected 'budget'`);
  if (parseBasis('') !== 'budget') wrong.push(`blank basis -> ${parseBasis('')}, expected 'budget'`);
  if (parseBasis('measured') !== 'measured') wrong.push(`'measured' -> ${parseBasis('measured')}`);
  assert.deepEqual(wrong, [], `basis handling is wrong for:\n  ${wrong.join('\n  ')}`);
});

test('a non-budget key is left entirely alone by budget validation', () => {
  // The store holds secrets and paths beside this; validation must not touch them.
  const untouched = ['projects_dir', 'fleet_token', 'ntfy_url', 'openai_models'];
  const wrong = untouched.filter((k) => validateBudgetValue(k, 'anything at all') !== null);
  assert.deepEqual(wrong, [], `budget validation wrongly rejected unrelated keys: ${wrong.join(', ')}`);
});

test('budgetFrom assembles the pair, and the key list is the registry', () => {
  assert.deepEqual([...BUDGET_KEYS].sort(), ['usage_budget_basis', 'usage_budget_usd_weekly']);
  assert.deepEqual(budgetFrom({}), { usdWeekly: null, basis: 'budget' });
  assert.deepEqual(budgetFrom({ usage_budget_usd_weekly: '0' }), { usdWeekly: null, basis: 'budget' });
  assert.deepEqual(budgetFrom({ usage_budget_usd_weekly: '400', usage_budget_basis: 'measured' }),
                   { usdWeekly: 400, basis: 'measured' });
});
