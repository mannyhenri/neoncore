import { median } from './statistics.js';

export const SUBSCRIPTION_PROVIDERS = ['claude', 'codex'] as const;
export type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[number];

export interface LearnedTokenCeiling {
  tokensWeekly: number;
  samples: number;
  confidence: number;
}

export interface ProviderTokenProjection {
  provider: SubscriptionProvider;
  ceilingTokens: number;
  tokensUsed: number;
  tokensPerDay: number;
  pctUsed: number;
  daysRemaining: number | null;
  samples: number;
  confidence: number;
  lastHitAt?: string;
}

export function learnTokenCeiling(observations: number[]): LearnedTokenCeiling | null {
  const valid = observations.filter((n) => Number.isFinite(n) && n > 0);
  if (!valid.length) return null;
  const tokensWeekly = median(valid);
  const spread = (Math.max(...valid) - Math.min(...valid)) / tokensWeekly;
  const tightness = Math.max(0, 1 - spread);
  const evidence = Math.min(1, valid.length / 4);
  return {
    tokensWeekly,
    samples: valid.length,
    confidence: Math.max(0.2, Math.min(1, tightness * (0.25 + evidence * 0.75))),
  };
}

export function projectTokenCeiling(input: {
  provider: SubscriptionProvider;
  ceilingTokens: number;
  tokensUsed: number;
  tokensPerDay: number;
  samples: number;
  confidence: number;
  lastHitAt?: string;
}): ProviderTokenProjection {
  const ceiling = Number.isFinite(input.ceilingTokens) && input.ceilingTokens > 0 ? input.ceilingTokens : 0;
  const used = Number.isFinite(input.tokensUsed) && input.tokensUsed > 0 ? input.tokensUsed : 0;
  const rate = Number.isFinite(input.tokensPerDay) && input.tokensPerDay > 0 ? input.tokensPerDay : 0;
  const pctUsed = ceiling ? used / ceiling : 0;
  return {
    provider: input.provider,
    ceilingTokens: ceiling,
    tokensUsed: used,
    tokensPerDay: rate,
    pctUsed,
    daysRemaining: rate ? Math.max(0, ceiling - used) / rate : null,
    samples: input.samples,
    confidence: input.confidence,
    ...(input.lastHitAt ? { lastHitAt: input.lastHitAt } : {}),
  };
}
