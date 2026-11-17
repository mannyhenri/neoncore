import { describe, expect, it } from 'vitest';
import { progressLine, coverageVerb } from '../runProgress';

const base = { blocked: 0, docPath: '', updatedAt: '' };

describe('run progress wording', () => {
  it('an exact count from a coverage check', () => {
    expect(progressLine({ ...base, done: 14, total: 23, basis: 'coverage' })).toBe('14 of 23 tasks done');
  });
  it('blocked tasks are named, not hidden in the count', () => {
    expect(progressLine({ ...base, done: 14, total: 23, blocked: 2, basis: 'coverage' })).toBe('14 of 23 tasks done · 2 blocked');
  });
  it('an estimate from dispatch claims says it is one', () => {
    expect(progressLine({ ...base, done: 5, total: 12, basis: 'claims' })).toBe('5 tasks done, about 7 left');
  });
  it('no total yet', () => {
    expect(progressLine({ ...base, done: 1, total: null, basis: 'claims' })).toBe('1 task done so far');
  });
  it.each(['complete', 'loop-back', 'held', 'continued', 'accepted'])('every coverage action has words: %s', (v) => {
    expect(coverageVerb(v)).not.toBe(v);
  });
});
