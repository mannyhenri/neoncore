/**
 * ADX-006, dashboard half — the modal must stop saying "Sent!" for a dispatch
 * that went nowhere.
 *
 * `api.sendCommand` has ALWAYS returned the Command, carrying `delivered`, and
 * this modal has always thrown the whole response away: `await api.sendCommand(...)`
 * with nothing on the left, then `setSent(true)` unconditionally. So a prompt
 * aimed at a cartridge with nothing listening reported success in green, and the
 * operator learned it had failed only when the work never happened. That is the
 * same class of lie the epic exists to remove one layer down, and it is why
 * "the dashboard renders it" is a real change rather than a label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Agent } from '../../types';

const mockSendCommand = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { sendCommand: (...args: unknown[]) => mockSendCommand(...args) },
}));

import SendToCartridgeModal from '../SendToCartridgeModal';

function makeAgent(id: string): Agent {
  return {
    id, name: 'test-agent', machine: 'test-machine.local', repoPath: '/test/path',
    repoName: 'test-repo', branch: 'main', currentTask: '', status: 'idle',
    trustMode: false, plansIncluded: false, mode: 'manual', agentType: 'claude',
    lastSeen: new Date().toISOString(), sessionId: 's1', lastMessage: '',
    pendingQuestion: '',
  } as Agent;
}

async function send(result: unknown) {
  mockSendCommand.mockResolvedValue(result);
  render(
    <SendToCartridgeModal initialText="do the thing" agents={[makeAgent('a1')]} onClose={() => {}} />,
  );
  /* A target must be chosen — handleSend returns early while targetAgentId is ''. */
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a1' } });
  fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
}

describe('the modal reports WHICH transport carried the dispatch', () => {
  beforeEach(() => { mockSendCommand.mockReset(); });

  it('names the transport when one carried it', async () => {
    await send({ id: 'c1', delivered: true, transport: 'primary-socket' });
    await waitFor(() => expect(screen.getByText(/primary-socket/i)).toBeTruthy());
  });

  it('does NOT claim success when nothing was listening', async () => {
    /*
     * The case that made this worth building: "Sent!" in green for a command row
     * that stays pending forever because no channel exists.
     */
    await send({ id: 'c2', delivered: false, transport: 'no-channel' });
    await waitFor(() => expect(screen.queryByText(/^Sent!$/)).toBeNull());
    expect(screen.getByText(/nothing was listening|not delivered|no channel/i)).toBeTruthy();
  });

  it('says an inbox hand-over is pending rather than delivered', async () => {
    /*
     * The inbox resolves asynchronously, so delivered=false here means "handed
     * over, answer pending" — a different thing from no-channel, and the only
     * way to tell them apart is the transport name.
     */
    await send({ id: 'c3', delivered: false, transport: 'inbox-socket' });
    await waitFor(() => expect(screen.getByText(/inbox/i)).toBeTruthy());
    expect(screen.queryByText(/nothing was listening/i)).toBeNull();
    /*
     * Matching /inbox/ alone is NOT enough, and a mutation proved it: deleting
     * the inbox case falls through to "Sent via inbox-socket", which contains
     * the word and still CLAIMS delivery for something only handed over. The
     * label must say pending and must not read as sent.
     */
    expect(screen.getByText(/pending/i)).toBeTruthy();
    expect(screen.queryByText(/^Sent/i)).toBeNull();
  });

  it('still reports something when the server returns no transport at all', async () => {
    /* An older server, or a forwarded dispatch: absent must not render "undefined". */
    await send({ id: 'c4', delivered: true });
    await waitFor(() => expect(screen.getByText(/sent/i)).toBeTruthy());
    expect(screen.queryByText(/undefined/i)).toBeNull();
  });
});
