import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/isolated-db.js';
import db from '../src/db.js';
import {
  SUBSCRIPTION_PROVIDERS,
  learnTokenCeiling,
  projectTokenCeiling,
} from '../src/lib/token-ceiling.js';

test('every subscription provider supports the complete calibration lifecycle', () => {
  assert.deepEqual(SUBSCRIPTION_PROVIDERS, ['claude', 'codex']);
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    assert.equal(learnTokenCeiling([]), null, `${provider}: no invented ceiling`);

    const first = learnTokenCeiling([11_000_000_000])!;
    assert.equal(first.tokensWeekly, 11_000_000_000, `${provider}: first mark works immediately`);
    assert.equal(first.samples, 1);
    assert.ok(first.confidence > 0 && first.confidence < 0.5, `${provider}: first mark is low confidence`);

    const learned = learnTokenCeiling([10_800_000_000, 11_000_000_000, 11_200_000_000])!;
    assert.equal(learned.tokensWeekly, 11_000_000_000, `${provider}: median resists noise`);
    assert.ok(learned.confidence > first.confidence, `${provider}: repeated marks improve confidence`);

    const projected = projectTokenCeiling({
      provider, ceilingTokens: learned.tokensWeekly, tokensUsed: 2_200_000_000,
      tokensPerDay: 2_200_000_000, samples: learned.samples, confidence: learned.confidence,
    });
    assert.equal(projected.pctUsed, 0.2, `${provider}: progress is 20%`);
    assert.equal(projected.daysRemaining, 4, `${provider}: 8.8B left at 2.2B/day`);
  }
});

test('projection edge states never emit negative, NaN, or Infinity', () => {
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    for (const tokensPerDay of [0, -1, NaN, 1_000_000]) {
      const out = projectTokenCeiling({
        provider, ceilingTokens: 100, tokensUsed: 120, tokensPerDay,
        samples: 1, confidence: 0.3,
      });
      assert.equal(out.pctUsed, 1.2);
      assert.ok(out.daysRemaining === null || (Number.isFinite(out.daysRemaining) && out.daysRemaining >= 0));
    }
  }
});

test('calibration persistence covers every registered provider', () => {
  const columns = db.prepare('PRAGMA table_info(token_limit_calibrations)').all() as { name: string }[];
  assert.deepEqual(columns.map((column) => column.name),
    ['id', 'provider', 'hit_at', 'weekly_tokens', 'created_at']);
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    db.prepare(`INSERT INTO token_limit_calibrations (id, provider, hit_at, weekly_tokens, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(provider, provider, new Date().toISOString(), 11_000_000_000, new Date().toISOString());
  }
  const saved = db.prepare('SELECT provider FROM token_limit_calibrations ORDER BY provider').all() as { provider: string }[];
  assert.deepEqual(saved.map((row) => row.provider), [...SUBSCRIPTION_PROVIDERS].sort());
});
