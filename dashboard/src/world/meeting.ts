/**
 * CONFER → THE COMMONS TABLE.
 *
 * While a confer is running, the crew members taking part stand together at the table — when
 * they come from different places. Participants who all work in the SAME pod are already
 * together, so they stay in it (a project's agents are never pulled out of their pod to meet
 * each other). A confer that has ended gathers nobody, and neither does one with fewer than
 * two of its participants on the map.
 */
import type { ConferSession } from '../types';

export function meetingKeys(
  confers: readonly Pick<ConferSession, 'status' | 'participantIds'>[],
  /** `pod`: the district the member's project holds; leave it out for an agent of no project. */
  crew: readonly { key: string; agentIds: readonly string[]; pod?: string }[],
): string[] {
  const out = new Set<string>();
  for (const c of confers) {
    if (c.status !== 'running') continue;
    const there = crew.filter((m) => m.agentIds.some((id) => c.participantIds.includes(id)));
    if (there.length < 2) continue;
    // Each agent of no project counts as its own place.
    if (new Set(there.map((m) => m.pod ?? `alone:${m.key}`)).size < 2) continue;
    for (const m of there) out.add(m.key);
  }
  return crew.filter((m) => out.has(m.key)).map((m) => m.key);
}
