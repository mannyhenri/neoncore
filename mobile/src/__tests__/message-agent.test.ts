import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../types';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

const { AGENT_STATUSES, messageableAgents } = await import('../work');
const { statusColor, statusLabel } = await import('../theme');
const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', p), 'utf8');

/**
 * MESSAGE ANY AGENT FROM THE PHONE (2026-11-23: "I'd also like to be able to send a message directly
 * to an agent in the app"). The agent screen already had the prompt box and its transcript, but the
 * only way to it listed `working` agents — an idle, waiting or background one could not be reached.
 * SET: every agent status × {visible, put away} → listed (and in what order) or not.
 */
const agent = (status: Agent['status'], dismissed: boolean, name: string): Agent =>
  ({ id: `${status}-${dismissed}-${name}`, name, status, dismissedAt: dismissed ? '2026-11-23' : '' } as unknown as Agent);

describe('messageableAgents', () => {
  it('lists every status except offline, never an agent put away; waiting first, then working, background, idle', () => {
    const all = AGENT_STATUSES.flatMap((s) => [agent(s, false, 'b'), agent(s, false, 'a'), agent(s, true, 'c')]);
    const got = messageableAgents(all).map((a) => `${a.status}:${a.name}`);
    expect(got).toEqual([
      'waiting:a', 'waiting:b', 'working:a', 'working:b', 'background:a', 'background:b', 'idle:a', 'idle:b',
    ]);
  });

  it('AGENT_STATUSES is every status the app knows, including background', () => {
    expect([...AGENT_STATUSES].sort()).toEqual(['background', 'idle', 'offline', 'waiting', 'working']);
  });

  it.each([...AGENT_STATUSES])('%s has a colour and a label', (s) => {
    expect(statusColor[s]).toBeTruthy();
    expect(statusLabel[s]).toBeTruthy();
  });
});

describe('wiring', () => {
  it('In progress lists messageableAgents and opens the agent', () => {
    const src = read('src/screens/InProgressScreen.tsx');
    expect(src).toMatch(/messageableAgents\(agents\)/);
    expect(src).toMatch(/onOpenAgent\(a\)/);
    expect(src).not.toMatch(/a\.status === 'working' && !a\.dismissedAt/);
  });
  it('the agent screen sends what you type to the agent', () => {
    const src = read('src/screens/CartridgeDetailScreen.tsx');
    expect(src).toMatch(/<TextInput/);
    expect(src).toMatch(/api\.sendCommand\(/);
  });
});
