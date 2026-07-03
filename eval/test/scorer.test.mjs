import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilsonLower, score, buildReport } from '../src/score.mjs';

test('wilsonLower: bounds and monotonicity', () => {
  assert.equal(wilsonLower(0, 0), 0);
  assert.equal(wilsonLower(0, 5), 0);
  assert.ok(wilsonLower(5, 5) > 0.4 && wilsonLower(5, 5) <= 1);
  // more samples at the same rate => tighter (higher) lower bound
  assert.ok(wilsonLower(20, 20) > wilsonLower(2, 2));
  // lower bound never exceeds the point estimate
  assert.ok(wilsonLower(2, 3) < 2 / 3);
});

test('score: aggregates by class and overall', () => {
  const results = [
    { id: 'a', class: 'edit', passes: 3, k: 3, passRate: 1 },
    { id: 'b', class: 'edit', passes: 1, k: 3, passRate: 1 / 3 },
    { id: 'c', class: 'bash', passes: 3, k: 3, passRate: 1 },
  ];
  const s = score(results);
  assert.equal(s.byClass.edit.pass, 4);
  assert.equal(s.byClass.edit.total, 6);
  assert.equal(s.byClass.edit.score, 4 / 6);
  assert.equal(s.byClass.bash.score, 1);
  assert.equal(s.aggregate.pass, 7);
  assert.equal(s.aggregate.total, 9);
  assert.ok(s.aggregate.lowerBound < s.aggregate.score);
});

test('buildReport: shape routing will consume', () => {
  const r = buildReport('qwen2.5-coder:7b', 'openai-compatible', [
    { id: 'a', class: 'edit', passes: 2, k: 3, passRate: 2 / 3 },
  ], '2026-07-03T00:00:00Z');
  assert.equal(r.modelId, 'qwen2.5-coder:7b');
  assert.equal(r.k, 3);
  assert.equal(r.tasks.length, 1);
  assert.ok('edit' in r.byClass);
  assert.ok(typeof r.aggregate.lowerBound === 'number');
});
