import { describe, it, expect } from 'vitest';
import { progressView, healthView, HEALTH_LABEL } from '../lib/goalRollup';
import type { Goal, GoalHealth } from '../types';

/**
 * THE ROLLUPS, AS A PERSON READS THEM.
 *
 * The server is careful to return `fraction: null` when a goal has nothing to measure, because
 * "0% complete" claims work started and got nowhere while "no runs yet" says nothing was ever
 * asked of it. All of that care is undone by one `fraction ?? 0` in a component — the bar
 * renders empty, and the goal looks like it is failing rather than unstarted.
 *
 * So the null case is carried all the way to the string. These tests exist because the UI is
 * where the distinction actually dies.
 */

const base = (progress: Goal['progress'], runCount = 0): Pick<Goal, 'progress' | 'runCount'> =>
  ({ progress, runCount });

describe('progress never invents a percentage', () => {
  /**
   * The set of empty states, each with its OWN wording. Collapsing them into one "No data"
   * would hide the only actionable one: runs exist, but every one was cancelled.
   */
  const EMPTY_CASES: { label: string; goal: Pick<Goal, 'progress' | 'runCount'>; says: RegExp }[] = [
    {
      label: 'no runs at all',
      goal: base({ completedSteps: 0, totalSteps: 0, fraction: null, runsCounted: 0 }, 0),
      says: /no runs yet/i,
    },
    {
      label: 'runs exist but every one was cancelled',
      goal: base({ completedSteps: 0, totalSteps: 0, fraction: null, runsCounted: 0 }, 3),
      says: /cancelled/i,
    },
    {
      label: 'a counted run that has no steps',
      goal: base({ completedSteps: 0, totalSteps: 0, fraction: null, runsCounted: 1 }, 1),
      says: /no steps/i,
    },
    {
      label: 'the server sent no progress at all (older payload)',
      goal: base(undefined, 0),
      says: /no runs yet/i,
    },
  ];

  it.each(EMPTY_CASES)('$label draws no bar', ({ goal }) => {
    expect(progressView(goal).pct).toBeNull();
  });

  it.each(EMPTY_CASES)('$label says why, in words', ({ goal, says }) => {
    expect(progressView(goal).text).toMatch(says);
  });

  it('each empty state is worded distinctly — they are different situations', () => {
    const texts = EMPTY_CASES.map((c) => progressView(c.goal).text);
    // 'no runs yet' legitimately appears twice (absent payload == no runs), so compare the
    // set of DISTINCT situations rather than requiring four unique strings.
    expect(new Set(texts).size).toBeGreaterThanOrEqual(3);
  });
});

describe('progress reports real work honestly', () => {
  it('a genuine 0% draws a bar at zero — it is not an empty state', () => {
    // The pair the whole design turns on. This goal HAS steps; none are finished.
    const v = progressView(base({ completedSteps: 0, totalSteps: 8, fraction: 0, runsCounted: 1 }, 1));
    expect(v.pct).toBe(0);
    expect(v.text).toMatch(/0 of 8/);
  });

  it('reports the counts, not just the percentage', () => {
    // "30%" of what is unanswerable; "12 of 40 steps" can be checked against the runs.
    const v = progressView(base({ completedSteps: 12, totalSteps: 40, fraction: 0.3, runsCounted: 2 }, 2));
    expect(v.pct).toBe(30);
    expect(v.text).toMatch(/12 of 40/);
  });

  it('rounds for display without ever rounding away from an extreme', () => {
    // 99.6% must not read as "100%" on a goal that still has unfinished work, and a single
    // finished step out of 300 must not read as "0%" beside a bar that is visibly non-empty.
    const nearlyDone = progressView(base({ completedSteps: 249, totalSteps: 250, fraction: 249 / 250, runsCounted: 1 }, 1));
    expect(nearlyDone.pct).toBeLessThan(100);
    const barelyStarted = progressView(base({ completedSteps: 1, totalSteps: 300, fraction: 1 / 300, runsCounted: 1 }, 1));
    expect(barelyStarted.pct).toBeGreaterThan(0);
  });

  it('100% is reachable and says so', () => {
    const v = progressView(base({ completedSteps: 5, totalSteps: 5, fraction: 1, runsCounted: 1 }, 1));
    expect(v.pct).toBe(100);
  });
});

describe('health speaks in the same vocabulary as the run badge', () => {
  const REASONS = ['failed', 'interrupted', 'decision', 'agent-waiting', 'manual-advance'] as const;

  it.each(REASONS)('%s has a human label', (reason) => {
    expect(HEALTH_LABEL[reason]).toBeTruthy();
    // Not the raw slug leaking into the UI.
    expect(HEALTH_LABEL[reason]).not.toBe(reason);
  });

  it('null health renders nothing rather than a reassuring badge', () => {
    // "All good" on a goal with no runs would be a claim the data does not support.
    expect(healthView(null)).toBeNull();
    expect(healthView(undefined)).toBeNull();
  });

  it('carries the actionable detail through, not just the category', () => {
    const h: GoalHealth = {
      reason: 'decision', runId: 'w1', runName: 'CE: Full Delivery',
      stepName: 'Pick Approach', detail: 'Which approach should we take?', blockedRuns: 1,
    };
    const v = healthView(h);
    expect(v?.detail).toBe('Which approach should we take?');
    expect(v?.runId).toBe('w1');
  });

  it('says how many runs are blocked once there is more than one', () => {
    // One blocked run is a thing to go fix; several is a goal that has stopped moving.
    const one = healthView({ reason: 'failed', runId: 'w', runName: 'r', stepName: 's', detail: 'd', blockedRuns: 1 });
    const many = healthView({ reason: 'failed', runId: 'w', runName: 'r', stepName: 's', detail: 'd', blockedRuns: 4 });
    expect(one?.label).not.toMatch(/\b4\b/);
    expect(many?.label).toMatch(/4/);
  });

  it('failure outranks a question in tone, so the UI can colour them apart', () => {
    const failed = healthView({ reason: 'failed', runId: 'w', runName: 'r', stepName: 's', detail: 'd', blockedRuns: 1 });
    const asking = healthView({ reason: 'agent-waiting', runId: 'w', runName: 'r', stepName: 's', detail: 'd', blockedRuns: 1 });
    expect(failed?.tone).toBe('bad');
    expect(asking?.tone).toBe('ask');
  });
});
