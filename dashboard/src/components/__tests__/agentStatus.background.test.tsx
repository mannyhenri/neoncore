import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Agent } from '../../types';

/**
 * EVERY AGENT STATUS IS SHOWN, COUNTED AND FILTERED — including `background`.
 *
 * `background` (the turn ended, but work the cartridge started is still running) was added on the
 * server. Every place that keys on a status must handle it, or a 10-minute suite reads as an idle
 * agent — the gap it exists to close. SET-BASED over AGENT_STATUSES, which the build ties to the
 * client's `Agent['status']`, so a status added later fails here until every surface has it.
 */
vi.mock('../../lib/api', () => ({
  api: {
    getAgentTokenUsage: vi.fn().mockResolvedValue({ total: 0, costUsd: 0 }),
    getConfers: vi.fn().mockResolvedValue([]),
    getWorkflows: vi.fn().mockResolvedValue([]),
    getFinalAnswer: vi.fn(),
  },
}));

import { CartridgeGrid } from '../CartridgeGrid';
import { AGENT_STATUSES, AGENT_STATUS_LABEL, statusBucket, backgroundLines } from '../../lib/agentStatus';
import { buildCrew, crewCounts } from '../../world/crew';

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
function agent(id: string, status: Agent['status'], over: Partial<Agent> = {}): Agent {
  return {
    id, name: id, machine: 'm.local', repoPath: `/code/${id}`, repoName: id, branch: 'main',
    currentTask: '', status, trustMode: false, memoryEnabled: true, plansIncluded: false, mode: 'manual',
    agentType: 'claude', lastSeen: iso(0), sessionId: `s-${id}`, lastMessage: '', pendingQuestion: '',
    recoveryStatus: '', interruptedAt: '', activeObjective: '', dismissedAt: '',
    ...(status === 'background' ? { background: [{ taskId: 't1', kind: 'monitor', description: 'final G1 suite', startedAt: iso(12 * 60_000), deadlineAt: iso(-18 * 60_000) }] } : {}),
    ...over,
  } as unknown as Agent;
}
const noop = () => {};
const grid = (agents: Agent[], extra: Record<string, unknown> = {}) => (
  <CartridgeGrid agents={agents} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]}
    onDecidePermission={noop} onSetMode={noop} onSendCommand={vi.fn() as never}
    onDelete={noop} onDismiss={noop} onRestore={noop} onDismissStuck={noop} {...extra} />
);
const LIVE = AGENT_STATUSES.filter((s) => s !== 'offline');

describe('every agent status', () => {
  it.each(AGENT_STATUSES)('%s has a label', (s) => {
    expect(AGENT_STATUS_LABEL[s]).toBeTruthy();
  });

  it.each(LIVE)('%s renders a card that shows its label', (s) => {
    const { container } = render(grid([agent(`a-${s}`, s)]));
    expect(within(container).getAllByText(AGENT_STATUS_LABEL[s]).length).toBeGreaterThan(0);
  });

  it.each(LIVE)('%s is counted in its bucket, and the counts add up', (s) => {
    let counts: Record<string, number> = {};
    render(grid(LIVE.map((x) => agent(`a-${x}`, x)), { onStatusCounts: (c: Record<string, number>) => { counts = c; } }));
    expect(counts.all).toBe(LIVE.length);
    expect(counts.working + counts.waiting + counts.idle).toBe(LIVE.length);
    expect(counts[statusBucket(s)]).toBeGreaterThan(0);
  });

  it.each(LIVE)('%s shows under the filter for its bucket', (s) => {
    render(grid(LIVE.map((x) => agent(`a-${x}`, x)), { statusFilter: statusBucket(s) }));
    expect(screen.getAllByText(`a-${s}`).length).toBeGreaterThan(0);
  });

  it.each(LIVE)('%s is on site in the scene, in a real crew bucket', (s) => {
    const crew = buildCrew({ agents: [agent(`a-${s}`, s)], activitiesByAgent: {}, pendingPermissions: [], stuckAlerts: [], now: NOW });
    expect(crew).toHaveLength(1);
    expect(crew[0].status).toBe(statusBucket(s));
    const counts = crewCounts(crew);
    expect(Object.values(counts).every(Number.isFinite)).toBe(true);
    expect(counts.working + counts.waiting + counts.idle).toBe(1);
  });
});

describe('background work is spelled out', () => {
  it('a background agent counts as active, never idle', () => {
    expect(statusBucket('background')).toBe('working');
  });

  it('says what is running and for how long', () => {
    expect(backgroundLines(agent('b', 'background'), NOW)).toEqual(['final G1 suite · 12 min (up to 30)']);
    expect(backgroundLines(agent('w', 'working'), NOW)).toEqual([]);
  });

  it('the card shows the running task', () => {
    render(grid([agent('b', 'background')]));
    expect(screen.getByText(/Running in background: final G1 suite · 12 min \(up to 30\)/)).toBeTruthy();
  });
});

describe('every surface that shows a cartridge or its running step says it is running in the background', () => {
  // The agent card (and the world crew card, which renders it), the crew label over a figure, a
  // feature's running pipeline stage, and the canvas step inspector.
  const SURFACES: [string, RegExp][] = [
    ['components/CartridgeCard.tsx', /<BackgroundWork\b/],
    ['world/WorldScene.tsx', /backgroundLines\(member\.agent/],
    ['components/GoalPilotPanel.tsx', /stage\.status === 'running' && <BackgroundWork\b/],
    ['components/WorkflowCanvasEditor.tsx', /step\.status === 'running' && <BackgroundWork\b/],
  ];
  it.each(SURFACES)('%s', async (file, pattern) => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..', file), 'utf8');
    expect(src).toMatch(pattern);
  });
});
