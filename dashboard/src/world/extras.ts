/**
 * THE REST OF THE MAP — what else the records say about a crew member.
 *
 *   Queue lane → what is waiting at the agent's work site
 *   Token burn → the energy bar on the agent's panel
 *
 * Pure derivations (the polling lives in useCrewExtras.ts). Nothing here is decoration: a
 * count is a count of queue rows, and a bar is a real ratio (docs/DESIGN.md: meters never
 * invent progress).
 */
import type { Agent, QueueItem, QueueLane, QueueStatus } from '../types';
import type { CrewMember } from './crew';

export const QUEUE_STATUSES = ['queued', 'running', 'done', 'failed', 'blocked', 'cancelled'] as const satisfies readonly QueueStatus[];
/** The statuses that mean "still waiting its turn". Running work is the agent's current task, not the queue. */
export const WAITING_STATUSES: readonly QueueStatus[] = ['queued'];

/**
 * The queue lanes a crew member drains. The server names a lane `agent:<id>` for work sent to
 * one cartridge and `repo:<path>` for work sent to a repo (server/src/lib/queue-runner.ts).
 */
export function lanesFor(member: Pick<CrewMember, 'agentIds'>, agents: readonly Pick<Agent, 'id' | 'repoPath'>[]): string[] {
  const lanes = new Set<string>();
  for (const id of member.agentIds) {
    lanes.add(`agent:${id}`);
    const repo = agents.find((a) => a.id === id)?.repoPath;
    if (repo) lanes.add(`repo:${repo}`);
  }
  return [...lanes];
}

export interface CrewQueue {
  /** Items waiting their turn in this member's lanes (parked items are not waiting). */
  waiting: number;
  /** Why the lane is stopped, or '' when it is draining. */
  halted: string;
}

export function queueFor(
  member: Pick<CrewMember, 'agentIds'>,
  agents: readonly Pick<Agent, 'id' | 'repoPath'>[],
  view: { items: readonly QueueItem[]; lanes: readonly QueueLane[] },
): CrewQueue {
  const mine = new Set(lanesFor(member, agents));
  const waiting = view.items.filter((i) => mine.has(i.lane) && WAITING_STATUSES.includes(i.status) && !i.paused).length;
  const stopped = view.lanes.find((l) => mine.has(l.lane) && (l.haltedReason || l.paused));
  return { waiting, halted: stopped ? stopped.haltedReason || 'paused' : '' };
}

export interface CrewBurn {
  tokensPerHour: number;
  /** 0–1: this member's burn against the hungriest member on site. 0 when nobody is burning. */
  share: number;
}

export function burnShares(tokensPerHour: ReadonlyMap<string, number>): Map<string, CrewBurn> {
  const max = Math.max(0, ...tokensPerHour.values());
  const out = new Map<string, CrewBurn>();
  for (const [key, tokens] of tokensPerHour) out.set(key, { tokensPerHour: tokens, share: max > 0 ? tokens / max : 0 });
  return out;
}

/** 4_560_000 → "4.6M", 12_300 → "12.3K" — the way the top bar writes token rates. */
export function formatRate(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}
