import type { Goal, Task, TaskStatus } from './types';

/**
 * The derivations behind the Goals and Tasks screens, kept out of the components.
 *
 * Not for tidiness — this app has no renderer in its test setup, so logic left inside a
 * .tsx cannot be asserted on at all. Every rule here is one where being subtly wrong still
 * LOOKS right on screen, which is the kind that ships.
 */

/**
 * What a goal's progress says, honouring the three states the server distinguishes.
 *
 * `fraction: null` means there is NOTHING TO MEASURE — no projects, no runs, or only
 * cancelled ones. It is emphatically not 0. Rendering it as 0% claims work started and got
 * nowhere, and the server's own type carries a comment saying this is the exact
 * "empty looks identical to populated" failure the Goals work exists to fix. A phone makes
 * it worse: the bar is the only thing big enough to read at a glance.
 */
export function progressLabel(goal: Goal): string {
  const p = goal.progress;
  if (!p || p.fraction === null) return 'nothing measured yet';
  return `${p.completedSteps}/${p.totalSteps} steps · ${Math.round(p.fraction * 100)}%`;
}

/** Bar width, or null when there is no bar to draw. Never coerce this to 0. */
export function progressFraction(goal: Goal): number | null {
  const f = goal.progress?.fraction;
  return f === null || f === undefined ? null : f;
}

/**
 * Whether this goal is asking for a person, and how loudly.
 *
 * `health` is null when nothing is blocked, so its mere presence is the signal. One
 * blocked run is a task; several is a stalled goal, and the server counts them for us.
 */
export function attentionLabel(goal: Goal): string | null {
  const h = goal.health;
  if (!h) return null;
  const what = REASON_TEXT[h.reason] ?? h.reason;
  return h.blockedRuns > 1 ? `${h.blockedRuns} runs ${what}` : what;
}

const REASON_TEXT: Record<string, string> = {
  failed: 'failed',
  interrupted: 'interrupted',
  decision: 'waiting on a decision',
  'agent-waiting': 'waiting on you',
  'manual-advance': 'needs a manual advance',
};

/**
 * The schedule line, or null when the goal has no target date.
 *
 * '' means UNSET for the PM fields, and a goal with no target date has NO schedule rather
 * than being "on time" — so absence has to stay absent instead of rendering as reassurance.
 */
export function scheduleLabel(goal: Goal): { text: string; state: string } | null {
  const s = goal.schedule;
  if (!s || !s.targetDate) return null;
  return { text: s.detail || s.state, state: s.state };
}

/**
 * A goal whose brief reaches no cartridge.
 *
 * reach 0 means the brief injects nothing and cost will stay 0 — the goal is written down
 * and doing nothing. Worth saying out loud, because it otherwise reads as "new and quiet".
 */
export function reachWarning(goal: Goal): string | null {
  if (goal.reach === undefined) return null;
  return goal.reach === 0 ? 'reaches no cartridge — this brief is not being used' : null;
}

/** Sort: the ones asking for something first, then active, then the rest. */
export function goalOrder(a: Goal, b: Goal): number {
  const rank = (g: Goal) => (g.health ? 0 : g.status === 'active' ? 1 : g.status === 'paused' ? 2 : 3);
  const d = rank(a) - rank(b);
  return d !== 0 ? d : (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
}

/** Which statuses are still live work, so a list can lead with them. */
export const LIVE_TASK_STATUSES: TaskStatus[] = ['queued', 'claimed', 'in_progress'];

export function isLiveTask(t: Task): boolean {
  return LIVE_TASK_STATUSES.includes(t.status);
}

/**
 * What to tell the user when a dispatch comes back 409.
 *
 * The dependency gate answers with `blocked` plus a `hint`, and it is overridable on
 * purpose — the user may know the prerequisite no longer applies. Swallowing that into
 * "dispatch failed" turns a decision the server deliberately handed to a person into a
 * dead end, so the hint is carried through verbatim and `force` is offered rather than
 * retried automatically.
 */
export function dispatchBlockMessage(err: unknown): string | null {
  const e = err as { status?: number; message?: string } | null;
  if (!e || e.status !== 409) return null;
  const raw = e.message ?? '';
  // The body is appended to the status line by req(); pull the server's sentence back out.
  const match = raw.match(/\{.*\}/);
  if (match) {
    try {
      const body = JSON.parse(match[0]) as { error?: string; hint?: string; blocked?: boolean };
      if (body.error || body.hint) return [body.error, body.hint].filter(Boolean).join(' ');
    } catch {
      // Fall through to the raw line — a malformed body is still better than "failed".
    }
  }
  return raw || 'This task is blocked by a prerequisite.';
}
