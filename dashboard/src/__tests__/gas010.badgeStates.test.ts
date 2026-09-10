/**
 * GAS-010 — what the badge shows when it cannot show a projection.
 *
 * GAS-009 made the number inseparable from its basis. This decides the cases where there is
 * no number, and there are three of them with different right answers:
 *
 *   NO BUDGET      the projection is unknowable, but the user can fix that — so prompt.
 *   PARTIAL FLEET  a rate summed from some servers is LOWER than the truth, so a projection
 *                  built on it reports MORE headroom than exists. That is the failure
 *                  direction that hurts: the gauge says four days and the work stops in one.
 *                  Suppressed, not shown with a caveat, because a caveat under a confident
 *                  number is read as decoration.
 *   CONFLICT       servers disagree on the budget. A budget exists, so "set a budget" would be
 *                  wrong advice; the projection is unsound, so a figure would be a lie.
 *                  Silence plus the problem the merge already reports.
 *
 * The structural guard at the bottom is the one that matters most over time: it asserts the
 * component cannot reach past this function to the raw numbers. GAS-009's fused string makes a
 * bare figure unrenderable only for as long as nobody renders projection.daysRemaining
 * directly, and that is a source-level property, not a runtime one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectionSlot } from '../lib/burnRate';
import type { FleetBurnRate, ServerProjection } from '../lib/burnRate';

const HERE = dirname(fileURLToPath(import.meta.url));

const fleet = (o: Partial<FleetBurnRate>): FleetBurnRate => ({
  tokensPerDay: 240, tokensPerHour: 10, costPerDay: 100, samples: 10,
  budget: { usd: 700, basis: 'budget' },
  projection: { daysRemaining: 3, pctConsumed: 0.4, basis: 'budget', confidence: null } as ServerProjection,
  problems: [], serversReporting: 2, serversAsked: 2,
  ...o,
} as unknown as FleetBurnRate);

describe('GAS-010 badge states', () => {
  it('a healthy fleet with a budget shows the projection', () => {
    const slot = projectionSlot(fleet({}));
    expect(slot?.kind).toBe('projection');
    expect(slot?.text).toBe('3.0d left · budget');
  });

  it('NO BUDGET prompts the user to set one, rather than showing nothing at all', () => {
    const slot = projectionSlot(fleet({
      budget: { usd: null, basis: 'budget' },
      projection: { daysRemaining: null, pctConsumed: null, basis: 'unknown', confidence: null },
    }));
    expect(slot?.kind).toBe('prompt');
    expect(slot?.text).toMatch(/set a budget/i);
  });

  it('A PARTIAL FLEET suppresses the projection — a low rate overstates headroom', () => {
    const slot = projectionSlot(fleet({
      problems: [{ label: 'studio', reason: 'unreachable' }],
    }));
    expect(slot).toBeNull();
  });

  it('a partial fleet with NO budget does not prompt either — one problem at a time', () => {
    const slot = projectionSlot(fleet({
      budget: { usd: null, basis: 'budget' },
      projection: { daysRemaining: null, pctConsumed: null, basis: 'unknown', confidence: null },
      problems: [{ label: 'studio', reason: 'outdated' }],
    }));
    expect(slot).toBeNull();
  });

  it('CONFLICTING budgets show neither a figure nor the prompt', () => {
    const slot = projectionSlot(fleet({
      budget: { usd: null, basis: 'budget' },
      projection: { daysRemaining: null, pctConsumed: null, basis: 'unknown', confidence: null },
      problems: [{ label: 'a', reason: 'budget-conflict' }, { label: 'b', reason: 'budget-conflict' }],
    }));
    expect(slot).toBeNull();
  });

  it('a measured ceiling still says which it is', () => {
    const slot = projectionSlot(fleet({
      budget: { usd: 700, basis: 'measured' },
      projection: { daysRemaining: 3, pctConsumed: 0.4, basis: 'measured', confidence: null },
    }));
    expect(slot?.text).toBe('3.0d left · measured');
  });

  /** THE INVARIANT, at source level: the component may not reach past this function. */
  it('BurnRate.tsx never renders a projection number directly', () => {
    const src = readFileSync(resolve(HERE, '../components/BurnRate.tsx'), 'utf8');
    const RAW_FIELDS = [
      'projection.daysRemaining', 'projection?.daysRemaining',
      'projection.pctConsumed', 'projection?.pctConsumed',
      'budget.usd', 'budget?.usd',
    ];
    // A raw figure may appear in the tooltip prose, which explains the claim — never in the
    // rendered markup, where it would be a number standing on its own.
    const markup = src.slice(src.indexOf('<span'));
    const inMarkup = RAW_FIELDS.filter((needle) => markup.includes(needle));
    expect(inMarkup, `these bypass projectionSlot and can render a number without its basis: ${inMarkup.join(', ')}`).toEqual([]);
  });

  it('the header pill contains only token rates and subscription time, not cost per day', () => {
    const src = readFileSync(resolve(HERE, '../components/BurnRate.tsx'), 'utf8');
    expect(src).toContain('tok/day');
    expect(src).toContain('tok/hr');
    expect(src).toContain('subscriptionPillLabel(subscription)');
    expect(src).not.toContain('{money(rate.costPerDay)}');
  });
});
