/**
 * A prompt typed into a cartridge card that NO session is listening for must say so on the card —
 * three prompts in a row used to vanish into "pending, no-channel" while the card looked sent.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../../types';

vi.mock('../../lib/api', () => ({
  api: {
    getAgentTokenUsage: vi.fn().mockResolvedValue({ total: 0, costUsd: 0 }),
    openRepo: vi.fn().mockResolvedValue({}),
    recoverAgentSession: vi.fn().mockResolvedValue({}),
    dismissAgentRecovery: vi.fn().mockResolvedValue({}),
    getConfers: vi.fn().mockResolvedValue([]),
    getWorkflows: vi.fn().mockResolvedValue([]),
  },
}));

import { CartridgeGrid } from '../CartridgeGrid';

const agent = {
  id: 'agent-a', name: 'neoncore', machine: 'm.local', repoPath: '/code/neoncore', repoName: 'neoncore', branch: 'main',
  currentTask: '', status: 'idle', trustMode: false, memoryEnabled: true, plansIncluded: false, mode: 'manual',
  agentType: 'claude', lastSeen: new Date().toISOString(), sessionId: 'sess-123', lastMessage: '', pendingQuestion: '',
  recoveryStatus: '', interruptedAt: '', activeObjective: '', dismissedAt: '',
} as unknown as Agent;

const noop = () => {};
function grid(onSendCommand: (...a: unknown[]) => unknown) {
  return render(
    <CartridgeGrid agents={[agent]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]}
      onDecidePermission={noop} onSetMode={noop} onSendCommand={onSendCommand as never}
      onDelete={noop} onDismiss={noop} onRestore={noop} onDismissStuck={noop} />,
  );
}
function send(container: HTMLElement, text: string) {
  const ta = container.querySelector('textarea') as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.keyDown(ta, { key: 'Enter' });
}

describe('CartridgeCard — a prompt nothing is listening for', () => {
  it('says it was not delivered, with the relaunch command', async () => {
    const { container } = grid(vi.fn().mockResolvedValue({ delivered: false, transport: 'no-channel' }));
    send(container, 'fix the padding');
    expect(await screen.findByText(/Not delivered/)).toBeTruthy();
    expect(screen.getByText('cd /code/neoncore && node ~/.neoncore/relay/index.js -- --resume sess-123')).toBeTruthy();
  });

  it('stays quiet when a live session took it', async () => {
    const sendFn = vi.fn().mockResolvedValue({ delivered: true, transport: 'primary-socket' });
    const { container } = grid(sendFn);
    send(container, 'fix the padding');
    await waitFor(() => expect(sendFn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Not delivered/)).toBeNull();
  });

  it('can be dismissed', async () => {
    const { container } = grid(vi.fn().mockResolvedValue({ transport: 'no-channel' }));
    send(container, 'x');
    await screen.findByText(/Not delivered/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Not delivered/)).toBeNull();
  });
});
