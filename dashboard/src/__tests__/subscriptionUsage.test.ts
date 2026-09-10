import { describe, expect, it } from 'vitest';
import {
  mergeSubscriptionUsage, subscriptionPillLabel, SUBSCRIPTION_PROVIDERS, type ProviderUsage,
} from '../lib/subscriptionUsage';

const row = (provider: 'claude' | 'codex', overrides: Partial<ProviderUsage> = {}): ProviderUsage => ({
  provider, ceilingTokens: 11_000_000_000, tokensUsed: 2_200_000_000,
  tokensPerDay: 2_200_000_000, pctUsed: 0.2, daysRemaining: 4,
  samples: 1, confidence: 0.3, lastHitAt: '2026-09-10T12:00:00.000Z', ...overrides,
});

describe('subscription token gauge', () => {
  it('merges every provider across servers and recomputes progress', () => {
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      const merged = mergeSubscriptionUsage([
        [row(provider, { ceilingTokens: 6_000_000_000, tokensUsed: 1_000_000_000, tokensPerDay: 1_000_000_000 })],
        [row(provider, { ceilingTokens: 5_000_000_000, tokensUsed: 1_200_000_000, tokensPerDay: 1_200_000_000 })],
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0].ceilingTokens).toBe(11_000_000_000);
      expect(merged[0].pctUsed).toBeCloseTo(0.2);
      expect(merged[0].daysRemaining).toBeCloseTo(4);
    }
  });

  it('suppresses incomplete or cross-cycle fleet gauges', () => {
    const prior = row('claude', { lastHitAt: '2026-09-03T12:00:00.000Z' });
    expect(mergeSubscriptionUsage([[row('claude')], []])).toEqual([]);
    expect(mergeSubscriptionUsage([[row('claude')], [prior]])).toEqual([]);
  });

  it('counts usage from servers that had no ceiling observation of their own', () => {
    const merged = mergeSubscriptionUsage([
      [row('claude')],
      [row('claude', { ceilingTokens: 0, tokensUsed: 550_000_000, tokensPerDay: 550_000_000, samples: 0, confidence: 0 })],
    ]);
    expect(merged[0].ceilingTokens).toBe(11_000_000_000);
    expect(merged[0].tokensUsed).toBe(2_750_000_000);
    expect(merged[0].pctUsed).toBe(0.25);
    expect(merged[0].confidence).toBe(0.3);
  });

  it('pill always includes percent and projected time', () => {
    expect(subscriptionPillLabel(row('claude'))).toBe('Claude 20% · 4.0d to 100%');
    expect(subscriptionPillLabel(row('codex', { daysRemaining: null }))).toBe('Codex 20% · learning pace');
  });

});
