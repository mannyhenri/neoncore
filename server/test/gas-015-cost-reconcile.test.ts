/**
 * GAS-015 — compare what we priced against what Anthropic billed, and let the gap BE the
 * confidence figure.
 *
 * GAS-005 left `confidence` null and said why: nothing yet compared local pricing against
 * billed reality, so any number there would be invented. This is the measurement that earns
 * it. Local cost comes from lib/pricing.ts — a rate table, applied to tokens we counted
 * ourselves. Anthropic's cost report is what was actually charged. If those agree to within a
 * percent, the projection resting on them deserves to be trusted; if they diverge by forty,
 * the gauge is fiction and should say so.
 *
 * ── IT HAS NEVER RUN, AND CANNOT RUN HERE ─────────────────────────────────────────────
 * The Usage & Cost API needs an Admin credential (`sk-ant-admin…`). There is none on this
 * machine: `anthropic_api_key` is empty, no ANTHROPIC_ADMIN in the environment, no `ant` CLI.
 * Minting one is a Console action only a person can take. So every test here drives an
 * injected fetch, and the behaviour that actually matters today is the one at the bottom:
 * WITHOUT a key this returns null, confidence stays null, and the badge is unchanged. A
 * reconciliation that cannot run must not degrade into a made-up number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, adminKeyFrom, fetchReportedCostUsd } from '../src/lib/cost-reconcile.js';

test('perfect agreement is full confidence', () => {
  const r = reconcile(700, 700)!;
  assert.equal(r.deltaPct, 0);
  assert.equal(r.confidence, 1);
});

test('the confidence IS the agreement — a 20% gap is 0.8', () => {
  const r = reconcile(800, 1000)!;
  assert.ok(Math.abs(r.deltaPct - 0.2) < 1e-9);
  assert.ok(Math.abs(r.confidence - 0.8) < 1e-9);
});

test('divergence past 100% floors at zero rather than going negative', () => {
  // Priced $300 against $100 billed is a 200% gap, so 1 - delta is -1 before the floor.
  // THAT is the case the floor exists for, and it is the one to assert on.
  const over = reconcile(300, 100)!;
  assert.equal(over.confidence, 0, 'a gauge this wrong has no confidence, not negative confidence');
  assert.ok(Math.abs(over.deltaPct - 2) < 1e-9);

  // Just short of the floor, confidence is small but real — not rounded down to nothing.
  const under = reconcile(100, 5000)!;
  assert.ok(under.confidence > 0 && under.confidence < 0.05,
    `a 98% gap should read as near-zero confidence, got ${under.confidence}`);
});

test('over-reporting counts against confidence exactly as under-reporting does', () => {
  // Direction does not matter: a rate table 20% too HIGH is as untrustworthy as one 20% too low.
  assert.ok(Math.abs(reconcile(1200, 1000)!.confidence - reconcile(800, 1000)!.confidence) < 1e-9);
});

test('no spend on either side is nothing to reconcile, not perfect agreement', () => {
  assert.equal(reconcile(0, 0), null, 'two zeroes agree trivially and prove nothing');
});

test('malformed inputs never produce a confidence figure', () => {
  for (const [a, b] of [[NaN, 100], [100, NaN], [Infinity, 100], [-5, 100], [100, -5], [100, 0]] as [number, number][]) {
    assert.equal(reconcile(a, b), null, `reconcile(${a}, ${b}) must not yield a number`);
  }
});

test('NO ADMIN KEY MEANS NO RECONCILIATION — the state this fleet is in today', () => {
  for (const settings of [{}, { anthropic_api_key: '' }, { anthropic_api_key: '   ' }]) {
    assert.equal(adminKeyFrom(settings), null);
  }
  // A regular key is not an Admin key; the endpoint rejects it, so we must not try.
  assert.equal(adminKeyFrom({ anthropic_api_key: 'sk-ant-api03-abc' }), null,
    'a workspace key is not an admin credential — sending it would 401, not reconcile');
  assert.ok(adminKeyFrom({ anthropic_admin_key: 'sk-ant-admin01-abc' }));
});

test('the request is the documented one', async () => {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  await fetchReportedCostUsd({
    key: 'sk-ant-admin01-x', startIso: '2026-09-07T00:00:00Z', endIso: '2026-09-14T00:00:00Z',
    fetchImpl: async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return { ok: true, json: async () => ({ data: [] }) } as never;
    },
  });
  assert.ok(seen!.url.startsWith('https://api.anthropic.com/v1/organizations/cost_report'));
  assert.ok(seen!.url.includes('starting_at=2026-09-07T00%3A00%3A00Z') || seen!.url.includes('starting_at=2026-09-07T00:00:00Z'));
  assert.equal(seen!.headers['x-api-key'], 'sk-ant-admin01-x');
  assert.equal(seen!.headers['anthropic-version'], '2023-06-01');
});

test('costs are summed across buckets and converted from cents', async () => {
  const usd = await fetchReportedCostUsd({
    key: 'k', startIso: 'a', endIso: 'b',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      data: [{ results: [{ amount: '12345' }, { amount: '55' }] }, { results: [{ amount: '100' }] }],
    }) }) as never,
  });
  assert.ok(Math.abs(usd! - 125.00) < 1e-9, `expected $125.00 from 12500 cents, got ${usd}`);
});

test('any failure yields null and never throws — a broken report must not break the badge', async () => {
  const failures = [
    async () => { throw new Error('network down'); },
    async () => ({ ok: false, status: 401, json: async () => ({}) }) as never,
    async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) as never,
    async () => ({ ok: true, json: async () => ({ unexpected: 'shape' }) }) as never,
  ];
  for (const fetchImpl of failures) {
    assert.equal(await fetchReportedCostUsd({ key: 'k', startIso: 'a', endIso: 'b', fetchImpl: fetchImpl as never }), null);
  }
});

/**
 * The plumbing. A measured confidence is worthless if it stops at this module, and GAS-005
 * left the field null specifically for this task to fill.
 */
import { budgetProjection } from '../src/lib/projection.js';

test('a measured confidence reaches the projection', () => {
  const settings = { usage_budget_usd_weekly: '700' };
  assert.equal(budgetProjection({ costPerDay: 100, settings }).projection.confidence, null,
    'unmeasured stays null — the state today, with no Admin key');

  const out = budgetProjection({ costPerDay: 100, settings, confidence: 0.93 });
  assert.equal(out.projection.confidence, 0.93);
});

test('a confidence figure is only ever passed through, never invented', () => {
  // Guard against a future edit defaulting it to something reassuring.
  for (const c of [undefined, null]) {
    assert.equal(budgetProjection({
      costPerDay: 100, settings: { usage_budget_usd_weekly: '700' }, confidence: c as never,
    }).projection.confidence, null);
  }
});
