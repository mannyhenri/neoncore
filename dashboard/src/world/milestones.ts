/**
 * DEADLINES, DELIVERY AND REWARDS — what the map shows for a project beyond its agents.
 * Pure, so every rule is tested without a screen.
 *
 *   deadline   an oxygen gauge in the pod drains toward the NEAREST target date among the
 *              project's features that are still open. No dated open feature, no gauge.
 *   delivery   a pennant climbs its pole as the project's planned features are delivered,
 *              and a flare goes up each time one more is.
 *   badges     the project's banner earns a badge for each step of the feature under way
 *              (FEATURE_BADGES below).
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

/**
 * BADGES — one per step of the feature process, shown on the project's banner for the feature
 * that is under way. They RESET when a new feature starts; after a delivery the full row stays
 * up until then.
 *
 *   scoped     the planner has scoped it          (past `scoping`)
 *   answered   its questions are answered         (past `clarifying`)
 *   planned    the workflows are chosen           (past `planning`)
 *   accepted   you accepted the plan              (past `proposed`)
 *   staffed    repos are picked and it is running (past `staffing`)
 *   built      its pipeline has finished          (`completed`)
 *   delivered  it is marked done                  (status `achieved`)
 */
export const FEATURE_BADGES: readonly { step: string; label: string; sprite: string }[] = [
  { step: 'scoped', label: 'Scoped', sprite: 'insignia' },
  { step: 'answered', label: 'Questions answered', sprite: 'crew-banners' },
  { step: 'planned', label: 'Planned', sprite: 'signal-tower' },
  { step: 'accepted', label: 'Plan accepted', sprite: 'light-arch' },
  { step: 'staffed', label: 'Staffed and running', sprite: 'garden' },
  { step: 'built', label: 'Built', sprite: 'medal' },
  { step: 'delivered', label: 'Delivered', sprite: 'trophy' },
];

/** Steps already passed, by where the feature's pipeline stands. */
const PASSED: Record<string, number> = { scoping: 0, clarifying: 1, planning: 2, proposed: 3, staffing: 4, running: 5, paused: 5, completed: 6 };

export type BadgeFeature = Pick<Goal, 'projectId' | 'status' | 'origin' | 'updatedAt' | 'doneAt' | 'pilot'>;

/**
 * How many badges the project's banner shows (0–7): those of the feature under way — the one
 * touched most recently, if several are — or, when none is, all seven for the last one delivered.
 */
export function badgesFor(features: readonly BadgeFeature[], projectId: string): number {
  const mine = features.filter((f) => f.projectId === projectId && f.origin !== 'imported');
  const stamp = (f: BadgeFeature) => new Date(f.updatedAt || 0).getTime() || 0;
  const underWay = mine
    .filter((f) => f.status !== 'achieved' && f.pilot && f.pilot.phase !== 'cancelled')
    .sort((a, b) => stamp(b) - stamp(a))[0];
  if (underWay) return PASSED[underWay.pilot!.phase] ?? 0;
  return mine.some((f) => f.status === 'achieved' && f.pilot) ? FEATURE_BADGES.length : 0;
}
