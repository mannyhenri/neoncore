/**
 * DEADLINES, DELIVERY AND REWARDS — what the map shows for a project beyond its agents.
 * Pure, so every rule is tested without a screen.
 *
 *   deadline   an oxygen gauge in the pod drains toward the NEAREST target date among the
 *              project's features that are still open. No dated open feature, no gauge.
 *   delivery   a pennant climbs its pole as the project's planned features are delivered,
 *              and a flare goes up each time one more is.
 *   rewards    the commons collects a new fixture as features are delivered across ALL
 *              projects (REWARD_STEPS). Cosmetic only, never taken away by a late date.
 */
import type { Goal } from '../types';

export type DatedFeature = Pick<Goal, 'projectId' | 'status' | 'targetDate' | 'createdAt' | 'origin'>;

export type DeadlineState = 'ok' | 'tight' | 'overdue';
export interface Deadline {
  /** The gauge frames to show: one frame, or two that alternate (the warning light blinking). */
  frames: number[];
  state: DeadlineState;
  targetDate: string;
  /** Whole days left; negative once the date has passed. */
  daysLeft: number;
}

/** Share of the time left (from the feature's creation to its date) at which the gauge steps down. */
export const GAUGE_STEPS: readonly { above: number; frames: number[]; state: DeadlineState }[] = [
  { above: 0.75, frames: [0], state: 'ok' },
  { above: 0.5, frames: [1], state: 'ok' },
  { above: 0.25, frames: [2], state: 'ok' },
  { above: 0.1, frames: [3], state: 'tight' },
  { above: 0, frames: [4, 5], state: 'tight' },
];
export const GAUGE_OVERDUE: { frames: number[]; state: DeadlineState } = { frames: [6, 7], state: 'overdue' };

const DAY_MS = 24 * 60 * 60 * 1000;

export function deadlineFor(features: readonly DatedFeature[], projectId: string, now: number): Deadline | null {
  const open = features
    .filter((f) => f.projectId === projectId && f.status === 'active' && f.origin !== 'imported' && f.targetDate)
    .map((f) => ({ target: new Date(f.targetDate!).getTime(), start: new Date(f.createdAt).getTime(), targetDate: f.targetDate! }))
    .filter((f) => Number.isFinite(f.target))
    .sort((a, b) => a.target - b.target);
  const next = open[0];
  if (!next) return null;
  const span = next.target - (Number.isFinite(next.start) ? next.start : now);
  const left = next.target - now;
  const share = left <= 0 ? 0 : span <= 0 ? 1 : Math.min(1, left / span);
  const step = left <= 0 ? GAUGE_OVERDUE : GAUGE_STEPS.find((s) => share > s.above) ?? GAUGE_OVERDUE;
  return { frames: step.frames, state: step.state, targetDate: next.targetDate, daysLeft: Math.floor(left / DAY_MS) };
}

/** How high the pennant is: 0 folded at the foot, 3 flying at the top. Null when the project plans nothing. */
export function pennantFrame(done: number, total: number): 0 | 1 | 2 | 3 | null {
  if (total <= 0) return null;
  if (done >= total) return 3;
  if (done <= 0) return 0;
  return done / total < 0.5 ? 1 : 2;
}

/** Features delivered (across every project) at which the commons earns each fixture, in order. */
export const REWARD_STEPS: readonly { at: number; reward: string }[] = [
  { at: 1, reward: 'crew-banners' },
  { at: 3, reward: 'garden' },
  { at: 6, reward: 'light-arch' },
  { at: 10, reward: 'fountain' },
  { at: 15, reward: 'signal-tower' },
  { at: 25, reward: 'statue' },
  { at: 40, reward: 'trophy' },
];

export function rewardsFor(delivered: number): string[] {
  return REWARD_STEPS.filter((s) => delivered >= s.at).map((s) => s.reward);
}
