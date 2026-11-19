import { describe, it, expect } from 'vitest';
import type { Agent, QueueItem, QueueLane, QueueStatus } from '../../types';
import { QUEUE_STATUSES, WAITING_STATUSES, lanesFor, queueFor, burnShares, formatRate } from '../extras';
import type { CrewMember } from '../crew';

/**
 * THE REST OF THE MAP: queue lanes and token burn, per crew member.
 *
 *   Queue lane → what is waiting at the agent's work site
 *   Token burn → the energy bar on the agent's panel
 *
 * Both come straight from the records (docs/DESIGN.md: meters never invent progress), so the
 * tests are set-based over every queue status and every member of a crew: a status counted
 * that should not be, or an agent silently left without its lane, fails here.
 */
const member = (key: string, agentIds: string[]): CrewMember => ({ key, agentIds } as CrewMember);
const agent = (id: string, repoPath: string): Agent => ({ id, repoPath } as Agent);
const item = (over: Partial<QueueItem>): QueueItem => ({
  id: Math.random().toString(36).slice(2), kind: 'prompt', payload: {}, targets: [], lane: '', status: 'queued',
  position: 1, handle: '', result: '', ...over,
} as QueueItem);

describe('queue lanes', () => {
  const agents = [agent('a1', '/r/one'), agent('a2', '/r/one'), agent('b1', '/r/two')];
  const m = member('m:one', ['a1', 'a2']);

  it('a crew member owns the lane of every agent in it, and its repo lane', () => {
    expect(lanesFor(m, agents).sort()).toEqual(['agent:a1', 'agent:a2', 'repo:/r/one']);
    expect(lanesFor(member('m:two', ['b1']), agents).sort()).toEqual(['agent:b1', 'repo:/r/two']);
  });

  it('only work that is actually waiting counts — checked for every queue status', () => {
    const all: QueueStatus[] = ['queued', 'running', 'done', 'failed', 'blocked', 'cancelled'];
    expect([...QUEUE_STATUSES].sort()).toEqual([...all].sort());
    for (const status of QUEUE_STATUSES) {
      const q = queueFor(m, agents, { items: [item({ lane: 'agent:a1', status })], lanes: [] });
      expect(q.waiting, status).toBe(WAITING_STATUSES.includes(status) ? 1 : 0);
    }
    expect([...WAITING_STATUSES]).toEqual(['queued']);
  });

  it('counts across all of the member\'s lanes, skips parked items and other agents\' work', () => {
    const items = [
      item({ lane: 'agent:a1' }), item({ lane: 'agent:a2' }), item({ lane: 'repo:/r/one' }),
      item({ lane: 'agent:a1', paused: true }),
      item({ lane: 'agent:b1' }), item({ lane: 'repo:/r/two' }), item({ lane: 'repo:default' }),
    ];
    expect(queueFor(m, agents, { items, lanes: [] }).waiting).toBe(3);
    expect(queueFor(member('m:two', ['b1']), agents, { items, lanes: [] }).waiting).toBe(2);
    expect(queueFor(member('m:none', ['zz']), agents, { items, lanes: [] }).waiting).toBe(0);
  });

  it('a halted or paused lane is reported with its reason', () => {
    const lanes: QueueLane[] = [
      { lane: 'agent:a2', paused: false, haltedReason: 'step 3 failed' },
      { lane: 'agent:b1', paused: true, haltedReason: '' },
    ];
    expect(queueFor(m, agents, { items: [], lanes }).halted).toBe('step 3 failed');
    expect(queueFor(member('m:two', ['b1']), agents, { items: [], lanes }).halted).toBe('paused');
    expect(queueFor(m, agents, { items: [], lanes: [] }).halted).toBe('');
  });
});

describe('token burn', () => {
  it('every crew member gets a share, measured against the hungriest agent on site', () => {
    const shares = burnShares(new Map([['a', 4_000_000], ['b', 1_000_000], ['c', 0]]));
    expect([...shares.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(shares.get('a')).toEqual({ tokensPerHour: 4_000_000, share: 1 });
    expect(shares.get('b')!.share).toBeCloseTo(0.25);
    expect(shares.get('c')).toEqual({ tokensPerHour: 0, share: 0 });
  });

  it('nobody burning means no bar for anybody — never a full bar by division', () => {
    for (const s of burnShares(new Map([['a', 0], ['b', 0]])).values()) expect(s.share).toBe(0);
    expect(burnShares(new Map()).size).toBe(0);
  });

  it('rates read the way the top bar writes them', () => {
    expect(formatRate(0)).toBe('0');
    expect(formatRate(950)).toBe('950');
    expect(formatRate(12_300)).toBe('12.3K');
    expect(formatRate(4_560_000)).toBe('4.6M');
  });
});
