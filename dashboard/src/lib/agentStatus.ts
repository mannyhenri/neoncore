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
