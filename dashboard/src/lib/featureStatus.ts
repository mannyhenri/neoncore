/**
 * Where a feature stands, in the words the feature list shows — and what the one obvious next
 * click is.
 *
 * A feature's life is its pipeline (the goal pilot): not started → scoping (the planner asks what
 * is open) → a plan to review → pick the repos → running → done. The server's phases are precise
 * and many; a list of ten features needs each row to say, in two or three words, either "nothing
 * to do" or exactly what is waiting on you. Everything here derives from `goal.pilot` (the latest
 * pilot's summary), `goal.status` and `goal.health`.
 */
import type { Goal } from '../types';

export type FeatureTone = 'idle' | 'working' | 'you' | 'bad' | 'done';

export interface FeatureStatus {
  key: 'backlog' | 'thinking' | 'questions' | 'plan' | 'repos' | 'running' | 'review' | 'paused' | 'finished' | 'done' | 'cancelled' | 'stuck';
  label: string;
  tone: FeatureTone;
  /** The button the row offers — what you would do next. */
  action: string;
  /** Is the person the one the feature is waiting on? */
  needsYou: boolean;
  /** 0–1 while stages are running, else null. */
  progress: number | null;
}

export function featureStatus(goal: Pick<Goal, 'status' | 'pilot' | 'health'> & { origin?: Goal['origin'] }): FeatureStatus {
  const p = goal.pilot ?? null;
  const progress = p && p.stagesTotal > 0 ? p.stagesDone / p.stagesTotal : null;
  if (goal.status === 'achieved') {
    return { key: 'done', label: goal.origin === 'imported' ? 'Existing — already in the product' : 'Done', tone: 'done', action: 'Open', needsYou: false, progress: null };
  }
  if (!p) return { key: 'backlog', label: 'Not started', tone: 'idle', action: 'Start', needsYou: false, progress: null };
  switch (p.phase) {
    case 'scoping':
    case 'planning':
      return p.plannerFailed
        ? { key: 'stuck', label: 'Planner didn’t answer', tone: 'bad', action: 'Fix', needsYou: true, progress: null }
        : { key: 'thinking', label: p.phase === 'planning' ? 'Choosing workflows…' : 'Scoping…', tone: 'working', action: 'Open', needsYou: false, progress: null };
    case 'clarifying':
      return { key: 'questions', label: 'Questions for you', tone: 'you', action: 'Answer', needsYou: true, progress: null };
    case 'proposed':
      return { key: 'plan', label: 'Plan ready to review', tone: 'you', action: 'Review plan', needsYou: true, progress: null };
    case 'staffing':
      return { key: 'repos', label: 'Pick repos & start', tone: 'you', action: 'Start run', needsYou: true, progress: null };
    case 'running':
      if (p.awaitingReview) return { key: 'review', label: 'Needs your review', tone: 'you', action: 'Review', needsYou: true, progress };
      if (goal.health) return { key: 'review', label: 'Waiting on you', tone: 'you', action: 'Open', needsYou: true, progress };
      return { key: 'running', label: `Running · ${p.stagesDone}/${p.stagesTotal}`, tone: 'working', action: 'Open', needsYou: false, progress };
    case 'paused':
      return { key: 'paused', label: 'Paused — needs you', tone: 'bad', action: 'Resolve', needsYou: true, progress };
    case 'completed':
      return { key: 'finished', label: 'Finished — check report', tone: 'you', action: 'Review', needsYou: true, progress: 1 };
    case 'cancelled':
      return { key: 'cancelled', label: 'Cancelled', tone: 'idle', action: 'Restart', needsYou: false, progress: null };
    default:
      return { key: 'backlog', label: 'Not started', tone: 'idle', action: 'Start', needsYou: false, progress: null };
  }
}

export const TONE_PILL: Record<FeatureTone, string> = {
  idle: 'bg-white/[0.04] border-white/10 text-gray-300',
  working: 'bg-neon-500/15 border-neon-500/50 text-neon-200',
  you: 'bg-ember-500/15 border-ember-500/50 text-ember-300',
  bad: 'bg-red-500/15 border-red-400/50 text-red-200',
  done: 'bg-emerald-500/15 border-emerald-400/45 text-emerald-200',
};

export const TONE_DOT: Record<FeatureTone, string> = {
  idle: 'bg-gray-500',
  working: 'bg-neon-500 shadow-[0_0_8px_#5AAEFF] animate-pulse',
  you: 'bg-ember-500 shadow-[0_0_8px_#FF8A3D]',
  bad: 'bg-red-400 shadow-[0_0_8px_#FF6B6B]',
  done: 'bg-emerald-400 shadow-[0_0_8px_#4ADE80]',
};

/** The feature to pick up next: the first on the list that has not been started. */
export function nextUp<T extends Pick<Goal, 'status' | 'pilot' | 'health'>>(features: T[]): T | undefined {
  return features.find((f) => featureStatus(f).key === 'backlog');
}

/** Is any feature of the list in flight (scoping, planning or running)? */
export function anyInFlight(features: Pick<Goal, 'status' | 'pilot' | 'health'>[]): boolean {
  return features.some((f) => !['backlog', 'done', 'cancelled'].includes(featureStatus(f).key));
}
