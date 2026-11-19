import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import type { Agent } from '../../types';

/**
 * REQUESTED: "the final response from the agent, is there a way we could show it on the agents
 * screen, the full final answer?" The card's "Final answer" button opens the whole answer — past
 * the 500 characters `lastMessage` keeps — rendered as Markdown.
 */
const LONG = `## Done\n\n${'The fix is in. '.repeat(60)}\n\nThe very last sentence of the answer.`;
const mocks = vi.hoisted(() => ({ getFinalAnswer: vi.fn() }));
vi.mock('../../lib/api', () => ({
  api: {
    getAgentTokenUsage: vi.fn().mockResolvedValue({ total: 0, costUsd: 0 }),
    getConfers: vi.fn().mockResolvedValue([]),
    getWorkflows: vi.fn().mockResolvedValue([]),
    getFinalAnswer: mocks.getFinalAnswer,
  },
}));

import { CartridgeGrid } from '../CartridgeGrid';

const agent = {
  id: 'agent-a', name: 'neoncore', machine: 'm.local', repoPath: '/code/neoncore', repoName: 'neoncore', branch: 'main',
  currentTask: '', status: 'idle', trustMode: false, memoryEnabled: true, plansIncluded: false, mode: 'manual',
  agentType: 'claude', lastSeen: new Date().toISOString(), sessionId: 'sess-123', lastMessage: LONG.slice(0, 500), pendingQuestion: '',
  recoveryStatus: '', interruptedAt: '', activeObjective: '', dismissedAt: '',
} as unknown as Agent;
const noop = () => {};

describe('CartridgeCard — the full final answer', () => {
  it('opens the whole answer, rendered, and closes', async () => {
    mocks.getFinalAnswer.mockResolvedValue({ text: LONG, complete: true, sessionId: 'sess-123', at: new Date().toISOString() });
    render(
      <CartridgeGrid agents={[agent]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]}
        onDecidePermission={noop} onSetMode={noop} onSendCommand={vi.fn() as never}
        onDelete={noop} onDismiss={noop} onRestore={noop} onDismissStuck={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Final answer' }));
    expect(mocks.getFinalAnswer).toHaveBeenCalledWith('agent-a');
    const dialog = await screen.findByRole('dialog', { name: /neoncore — final answer/ });
    expect(await screen.findByText(/The very last sentence of the answer\./)).toBeTruthy();
    expect(dialog.querySelector('h2')?.textContent).toMatch(/final answer/);
    expect(screen.getByRole('heading', { name: 'Done' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when nothing was recorded yet', async () => {
    mocks.getFinalAnswer.mockRejectedValue(new Error('no answer recorded for this cartridge yet'));
    render(
      <CartridgeGrid agents={[agent]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]}
        onDecidePermission={noop} onSetMode={noop} onSendCommand={vi.fn() as never}
        onDelete={noop} onDismiss={noop} onRestore={noop} onDismissStuck={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Final answer' }));
    expect(await screen.findByText('No answer recorded for this cartridge yet.')).toBeTruthy();
  });
});
