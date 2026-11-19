/**
 * CONFER → THE COMMONS TABLE.
 *
 * While a confer is running, the crew members taking part stand together at the table. One
 * that has ended (completed, failed, cancelled) gathers nobody, and neither does a "confer"
 * with fewer than two of its participants on the map — one figure at a table is not a meeting.
 */
import type { ConferSession } from '../types';

export function meetingKeys(
  confers: readonly Pick<ConferSession, 'status' | 'participantIds'>[],
  crew: readonly { key: string; agentIds: readonly string[] }[],
): string[] {
  const out = new Set<string>();
  for (const c of confers) {
    if (c.status !== 'running') continue;
    const there = crew.filter((m) => m.agentIds.some((id) => c.participantIds.includes(id)));
    if (there.length < 2) continue;
    for (const m of there) out.add(m.key);
  }
  return crew.filter((m) => out.has(m.key)).map((m) => m.key);
}
