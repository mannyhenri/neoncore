/**
 * The goal rollups, turned into things a person reads.
 *
 * The server takes care to distinguish "nothing to measure" (`fraction: null`) from "measured,
 * and it is zero" (`fraction: 0`). That care survives exactly as far as the first component
 * that writes `progress.fraction ?? 0` — after which an unstarted goal renders as an empty bar
 * and reads as a failing one. Since the UI is where the distinction dies, the null case is
 * carried all the way into the string here, and `pct` is null rather than 0 so a caller cannot
 * draw a bar for a goal that has nothing to draw.
 */
import type { Goal, GoalHealth, AttentionReason } from '../types';

export interface ProgressView {
  /** What to show in words. Always meaningful, including when there is nothing to measure. */
  text: string;
  /** 0–100 for the bar, or null when NO bar should be drawn at all. */
  pct: number | null;
}

/**
 * Why there is nothing to measure matters, so the empty states are worded apart.
 *
 * "Every run was cancelled" is the actionable one — it means work was started and called off,
 * which a single flat "No data" would bury next to a goal nobody has touched.
 */
export function progressView(goal: Pick<Goal, 'progress' | 'runCount'>): ProgressView {
  const p = goal.progress;
  const runs = goal.runCount ?? 0;

  if (!p || p.fraction === null) {
    if (p && p.runsCounted > 0) return { text: 'Runs have no steps yet', pct: null };
    if (runs > 0) return { text: `No active runs — all ${runs} cancelled`, pct: null };
    return { text: 'No runs yet', pct: null };
  }

  // Guard the two extremes against rounding. 249/250 must not read as a finished goal, and
  // one completed step out of 300 must not read as 0 beside a visibly non-empty bar.
  const raw = p.fraction * 100;
  let pct = Math.round(raw);
  if (pct === 100 && p.completedSteps < p.totalSteps) pct = 99;
  if (pct === 0 && p.completedSteps > 0) pct = 1;

  return { text: `${p.completedSteps} of ${p.totalSteps} steps`, pct };
}

/** Plain-language names. The raw slugs are an internal vocabulary, not UI copy. */
export const HEALTH_LABEL: Record<AttentionReason, string> = {
  failed: 'A run failed',
  interrupted: 'A run was interrupted',
  decision: 'Waiting on your decision',
  'agent-waiting': 'A cartridge is asking you something',
  'manual-advance': 'Waiting for you to advance',
};

/**
 * Two tones, not five. `bad` is something broken, `ask` is something waiting on you — the
 * distinction a person acts on. Colouring all five differently would turn the rail into a
 * legend nobody has memorised.
 */
const TONE: Record<AttentionReason, 'bad' | 'ask'> = {
  failed: 'bad',
  interrupted: 'bad',
  decision: 'ask',
  'agent-waiting': 'ask',
  'manual-advance': 'ask',
};

export interface HealthView {
  label: string;
  detail: string;
  tone: 'bad' | 'ask';
  runId: string;
  runName: string;
}

/**
 * Null in, null out — deliberately.
 *
 * A goal with no runs and a goal that is running cleanly both report null, and neither should
 * get an "All good" badge: the first has no evidence for it. Absence of a warning is the only
 * honest way to say nothing needs you.
 */
export function healthView(health: GoalHealth | null | undefined): HealthView | null {
  if (!health) return null;
  const many = health.blockedRuns > 1 ? ` · ${health.blockedRuns} runs blocked` : '';
  return {
    label: `${HEALTH_LABEL[health.reason]}${many}`,
    detail: health.detail,
    tone: TONE[health.reason],
    runId: health.runId,
    runName: health.runName,
  };
}
