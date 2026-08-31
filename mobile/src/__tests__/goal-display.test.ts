import { describe, it, expect } from 'vitest';
import {
  progressLabel, progressFraction, attentionLabel, scheduleLabel,
  reachWarning, goalOrder, isLiveTask, dispatchBlockMessage,
} from '../goalDisplay';
import type { Goal, Task } from '../types';

/**
 * The rules where a wrong answer still renders as a perfectly convincing screen.
 *
 * Everything here is a distinction the SERVER went out of its way to make — three states
 * for progress, null-means-nothing-blocked for health, unset-is-not-on-time for schedule,
 * 409-is-a-question-not-a-failure for dispatch. A phone client that flattens any of them
 * looks finished and quietly lies, which is worse than a blank screen because nobody goes
 * looking for it.
 */

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1', name: 'Ship the thing', description: '', successMetric: '',
  acceptanceCriteria: '', noGos: '', rabbitHoles: '', invariants: '',
  keyResults: [], tokenBudget: null, budgetUsd: null, status: 'active',
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  ...over,
} as Goal);

describe('progress, which has three states and not two', () => {
  it('says nothing is measured when the server says there is nothing to measure', () => {
    const g = goal({ progress: { completedSteps: 0, totalSteps: 0, fraction: null, runsCounted: 0 } });
    expect(progressLabel(g)).toBe('nothing measured yet');
    expect(progressLabel(g)).not.toMatch(/0%/);
  });

  it('draws no bar at all in that case, rather than an empty one', () => {
    const g = goal({ progress: { completedSteps: 0, totalSteps: 0, fraction: null, runsCounted: 0 } });
    expect(progressFraction(g)).toBeNull();
  });

  it('distinguishes that from genuine zero progress on real runs', () => {
    const g = goal({ progress: { completedSteps: 0, totalSteps: 8, fraction: 0, runsCounted: 2 } });
    expect(progressLabel(g)).toBe('0/8 steps · 0%');
    expect(progressFraction(g)).toBe(0);
  });

  it('reports partial progress', () => {
    const g = goal({ progress: { completedSteps: 3, totalSteps: 8, fraction: 0.375, runsCounted: 2 } });
    expect(progressLabel(g)).toBe('3/8 steps · 38%');
  });

  it('treats a goal with no progress field at all as unmeasured', () => {
    expect(progressLabel(goal())).toBe('nothing measured yet');
    expect(progressFraction(goal())).toBeNull();
  });
});

describe('attention', () => {
  it('is silent when nothing is blocked', () => {
    expect(attentionLabel(goal({ health: null }))).toBeNull();
    expect(attentionLabel(goal())).toBeNull();
  });

  it('speaks plainly for one blocked run', () => {
    const g = goal({ health: { reason: 'decision', runId: 'r', runName: 'Run', stepName: 's', detail: 'd', blockedRuns: 1 } });
    expect(attentionLabel(g)).toBe('waiting on a decision');
  });

  it('counts them when a goal has stalled across several runs', () => {
    const g = goal({ health: { reason: 'failed', runId: 'r', runName: 'Run', stepName: 's', detail: 'd', blockedRuns: 3 } });
    expect(attentionLabel(g)).toBe('3 runs failed');
  });
});

describe('schedule, where absent must not read as reassurance', () => {
  it('is absent for a goal with no target date', () => {
    expect(scheduleLabel(goal())).toBeNull();
    expect(scheduleLabel(goal({ schedule: null }))).toBeNull();
  });

  it('never claims on-time for an unset target date', () => {
    const g = goal({ schedule: { targetDate: '', daysRemaining: 0, state: 'on-time', detail: '' } as never });
    expect(scheduleLabel(g)).toBeNull();
  });

  it('carries the server\'s own wording when there is a date', () => {
    const g = goal({ schedule: { targetDate: '2026-09-01', daysRemaining: -3, state: 'overdue', detail: '3 days late' } });
    expect(scheduleLabel(g)).toEqual({ text: '3 days late', state: 'overdue' });
  });
});

describe('reach', () => {
  it('warns when a goal reaches no cartridge, because it looks new and quiet instead', () => {
    expect(reachWarning(goal({ reach: 0 }))).toMatch(/not being used/);
  });
  it('stays quiet when the brief reaches something', () => {
    expect(reachWarning(goal({ reach: 3 }))).toBeNull();
  });
  it('stays quiet when the server did not say', () => {
    expect(reachWarning(goal())).toBeNull();
  });
});

describe('ordering', () => {
  it('puts what needs a person above everything else', () => {
    const blocked = goal({ id: 'blocked', health: { reason: 'failed', runId: '', runName: '', stepName: '', detail: '', blockedRuns: 1 } });
    const active = goal({ id: 'active' });
    const paused = goal({ id: 'paused', status: 'paused' });
    const achieved = goal({ id: 'achieved', status: 'achieved' });
    const sorted = [achieved, paused, active, blocked].sort(goalOrder).map((g) => g.id);
    expect(sorted).toEqual(['blocked', 'active', 'paused', 'achieved']);
  });
});

describe('live tasks', () => {
  const task = (status: Task['status']): Task => ({ status } as Task);
  it('counts every status that is still work', () => {
    expect(['queued', 'claimed', 'in_progress'].every((s) => isLiveTask(task(s as Task['status'])))).toBe(true);
  });
  it('excludes the finished ones', () => {
    expect(['done', 'failed', 'cancelled'].some((s) => isLiveTask(task(s as Task['status'])))).toBe(false);
  });
});

describe('a dispatch the dependency gate refused', () => {
  it('surfaces the server\'s reason and its override hint', () => {
    const err = {
      status: 409,
      message: '409 Conflict — {"error":"This task is blocked by an unfinished prerequisite.","blocked":true,"hint":"Finish the prerequisite, or re-send with force:true if it no longer applies."}',
    };
    const msg = dispatchBlockMessage(err);
    expect(msg).toMatch(/unfinished prerequisite/);
    expect(msg).toMatch(/force/);
  });

  it('is not mistaken for an ordinary failure', () => {
    expect(dispatchBlockMessage({ status: 404, message: 'Task not found' })).toBeNull();
    expect(dispatchBlockMessage(null)).toBeNull();
  });

  it('still says something useful when the body will not parse', () => {
    expect(dispatchBlockMessage({ status: 409, message: '409 Conflict' })).toBe('409 Conflict');
  });
});
