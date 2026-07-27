import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { Agent, Activity } from '../../types';

// ---------------------------------------------------------------------------
// Mocks — CartridgeCard reaches for the API on mount and draws canvas sprites.
// Neither is under test here.
// ---------------------------------------------------------------------------

vi.mock('../../lib/api', () => ({
  api: {
    getAgentTokenUsage: vi.fn().mockResolvedValue({ total: 0, costUsd: 0 }),
    focusAgent: vi.fn().mockResolvedValue({}),
    openRepo: vi.fn().mockResolvedValue({}),
    recoverAgentSession: vi.fn().mockResolvedValue({}),
    dismissAgentRecovery: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../lib/sprites', () => ({
  generatePixelSprites: () => [],
}));

import { CartridgeGrid } from '../CartridgeGrid';

// ---------------------------------------------------------------------------
// Test data — two tools in the SAME cartridge (same machine:repoName), which is
// what makes the primary flippable.
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    name: 'test-agent',
    machine: 'test-machine.local',
    repoPath: '/test/path',
    repoName: 'test-repo',
    branch: 'main',
    currentTask: '',
    status: 'idle',
    trustMode: false,
    plansIncluded: false,
    mode: 'manual',
    agentType: 'claude',
    lastSeen: new Date().toISOString(),
    sessionId: '',
    lastMessage: '',
    pendingQuestion: '',
    recoveryStatus: '',
    interruptedAt: '',
    activeObjective: '',
    dismissedAt: '',
    ...overrides,
  };
}

function recentActivity(agentId: string): Activity {
  return {
    id: `act-${agentId}`,
    agentId,
    type: 'tool_use',
    summary: 'Read file',
    detail: '',
    timestamp: new Date().toISOString(),
  } as unknown as Activity;
}

const noop = () => {};

function renderGrid(activitiesByAgent: Record<string, Activity[]>, agents: Agent[]) {
  return (
    <CartridgeGrid
      agents={agents}
      activitiesByAgent={activitiesByAgent}
      pendingPermissions={[]}
      stuckAlerts={[]}
      onDecidePermission={noop}
      onSetMode={noop}
      onSendCommand={noop}
      onDelete={noop}
      onDismiss={noop}
      onRestore={noop}
      onDismissStuck={noop}
    />
  );
}

describe('CartridgeGrid — typed prompt survives live activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('keeps the draft in CommandInput when a sibling agent becomes the primary', () => {
    // Both idle → agent-a is primary (insertion order, equal status priority).
    const agents = [
      makeAgent({ id: 'agent-a', agentType: 'claude' }),
      makeAgent({ id: 'agent-b', agentType: 'gridlight' }),
    ];

    const { rerender, container } = render(renderGrid({}, agents));

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea, { target: { value: 'a long prompt I do not want to lose' } });
    expect(textarea.value).toBe('a long prompt I do not want to lose');

    // A log line lands for the OTHER tool in this same cartridge. That flips its
    // effective status to 'working', which outranks 'idle', so agent-b is promoted
    // to primary. Before the fix this changed the CartridgeCard key and remounted
    // the whole card, destroying CommandInput's local `text` state.
    rerender(renderGrid({ 'agent-b': [recentActivity('agent-b')] }, agents));

    const after = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(after.value).toBe('a long prompt I do not want to lose');
  });
});
