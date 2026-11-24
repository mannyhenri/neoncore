import type { Agent, Activity } from '../types';

/** An agent that logged anything in this window counts as working, whatever it last reported. */
export const ACTIVE_WINDOW_MS = 120_000; // 2 minutes

/**
 * Effective status from the activity feed's timestamps.
 *
 * ONE definition, used by the cartridge list AND the scene. They answer the same question —
 * "is this agent on screen, and in what state" — and two copies are how the list would show
 * an agent as working while the scene shows it idle.
 */
export function effectiveAgentStatus(
  agent: Agent,
  activities: Activity[],
  now: number,
): Agent['status'] {
  if (agent.status === 'waiting') return 'waiting';
  const hasRecent = activities.some(
    (a) => now - new Date(a.timestamp).getTime() < ACTIVE_WINDOW_MS,
  );
  if (agent.status === 'offline') return hasRecent ? 'working' : 'offline';
  return hasRecent ? 'working' : agent.status;
}

/** Every status a cartridge can report. `satisfies` breaks the build if the client type grows one. */
export const AGENT_STATUSES = ['working', 'background', 'waiting', 'idle', 'offline'] as const satisfies readonly Agent['status'][];
type _Exhaustive = Exclude<Agent['status'], (typeof AGENT_STATUSES)[number]> extends never ? true : never;
const _exhaustive: _Exhaustive = true;
void _exhaustive;

export const AGENT_STATUS_LABEL: Record<Agent['status'], string> = {
  working: 'Working',
  background: 'Running in background',
  waiting: 'Waiting',
  idle: 'Idle',
  offline: 'Offline',
};

/**
 * The bucket a status counts in, wherever statuses are filtered, counted or ranked.
 *
 * `background` is ACTIVE: the cartridge's turn ended but work it started is still running (a
 * test suite under Monitor, a background shell). Counting it as idle is the gap this status
 * closes — so in the Working filter, the counts and the scene it is working.
 */
export function statusBucket(status: Agent['status']): 'working' | 'waiting' | 'idle' | 'offline' {
  return status === 'background' ? 'working' : status;
}

/** Rank for sorting: active first, then needs-you, then idle, then offline. */
export const STATUS_PRIORITY: Record<Agent['status'], number> = { working: 0, background: 0, waiting: 1, idle: 2, offline: 3 };

/** "final G1 suite · 12 min (up to 30)" — one line per open background task. */
export function backgroundLines(agent: Pick<Agent, 'status' | 'background'>, now: number): string[] {
  if (agent.status !== 'background') return [];
  const mins = (from: string, to: number) => Math.max(0, Math.round((to - new Date(from).getTime()) / 60_000));
  return (agent.background ?? []).map((t) => {
    const elapsed = mins(t.startedAt, now);
    const limit = t.deadlineAt ? Math.max(0, Math.round((new Date(t.deadlineAt).getTime() - new Date(t.startedAt).getTime()) / 60_000)) : 0;
    const desc = t.description?.trim() || `${t.kind} task`;
    return `${desc} · ${elapsed} min${limit > 0 ? ` (up to ${limit})` : ''}`;
  });
}
