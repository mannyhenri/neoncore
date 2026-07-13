import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Agent } from '../../types';

// ---------------------------------------------------------------------------
// Mock the api module
// ---------------------------------------------------------------------------

const mockSendCommand = vi.fn().mockResolvedValue({});

vi.mock('../../lib/api', () => ({
  api: {
    sendCommand: (...args: unknown[]) => mockSendCommand(...args),
  },
}));

// Import after mocks
import SendToCartridgeModal from '../SendToCartridgeModal';

// ---------------------------------------------------------------------------
// Test data
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
    dismissedAt: '',
    ...overrides,
  };
}

const AGENT_A = makeAgent({ id: 'agent-a', repoName: 'neoncore', agentType: 'claude' });
const AGENT_B = makeAgent({ id: 'agent-b', repoName: 'gridlight-app', agentType: 'gridlight', branch: 'feature/x' });
const AGENT_C = makeAgent({ id: 'agent-c', repoName: 'offline-project', status: 'offline' });
const ALL_AGENTS = [AGENT_A, AGENT_B, AGENT_C];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SendToCartridgeModal', () => {
  beforeEach(() => {
    mockSendCommand.mockClear();
    mockSendCommand.mockResolvedValue({});
  });

  // ─── Rendering ───────────────────────────────────

  it('renders modal with title and content', () => {
    render(
      <SendToCartridgeModal
        initialText="Hello from step 1"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Send to Cartridge')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Hello from step 1')).toBeInTheDocument();
  });

  it('shows source label when provided', () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        sourceLabel="Read — neoncore"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('From: Read — neoncore')).toBeInTheDocument();
  });

  it('does not show source label when not provided', () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText(/From:/)).not.toBeInTheDocument();
  });

  // ─── Agent filtering ────────────────────────────

  it('excludes offline agents from dropdown', () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox');
    const options = Array.from(select.querySelectorAll('option'));
    const optionTexts = options.map((o) => o.textContent);

    expect(optionTexts.some((t) => t?.includes('neoncore'))).toBe(true);
    expect(optionTexts.some((t) => t?.includes('gridlight-app'))).toBe(true);
    expect(optionTexts.some((t) => t?.includes('offline-project'))).toBe(false);
  });

  it('excludes the source agent from dropdown', () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        excludeAgentId="agent-a"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox');
    const options = Array.from(select.querySelectorAll('option'));
    const optionTexts = options.map((o) => o.textContent);

    expect(optionTexts.some((t) => t?.includes('neoncore'))).toBe(false);
    expect(optionTexts.some((t) => t?.includes('gridlight-app'))).toBe(true);
  });

  it('shows agent type labels in dropdown options', () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox');
    const options = Array.from(select.querySelectorAll('option'));

    expect(options.some((o) => o.textContent?.includes('(Claude CC)'))).toBe(true);
    expect(options.some((o) => o.textContent?.includes('(Gridlight)'))).toBe(true);
  });

  it('shows branch info in dropdown when available', () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox');
    const options = Array.from(select.querySelectorAll('option'));

    expect(options.some((o) => o.textContent?.includes('feature/x'))).toBe(true);
  });

  it('shows "No other cartridges online" when no valid targets exist', () => {
    const offlineOnly = [makeAgent({ id: 'a', status: 'offline' })];
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={offlineOnly}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('No other cartridges online')).toBeInTheDocument();
  });

  it('auto-selects first online agent', () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('agent-a');
  });

  // ─── Content editing ────────────────────────────

  it('allows editing the pre-filled content', () => {
    render(
      <SendToCartridgeModal
        initialText="original text"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByDisplayValue('original text') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'modified text with extra context' } });

    expect(textarea.value).toBe('modified text with extra context');
  });

  it('shows character count', () => {
    render(
      <SendToCartridgeModal
        initialText="hello"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/5 chars/)).toBeInTheDocument();
  });

  // ─── Memory toggle ──────────────────────────────

  it('includes memory by default (checked)', () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('allows toggling memory off', () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  // ─── Send action ────────────────────────────────

  it('calls api.sendCommand with correct args on send', async () => {
    render(
      <SendToCartridgeModal
        initialText="send this content"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      expect(mockSendCommand).toHaveBeenCalledTimes(1);
      expect(mockSendCommand).toHaveBeenCalledWith('agent-a', 'send this content', true);
    });
  });

  it('sends to the selected agent, not the first one', async () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'agent-b' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      expect(mockSendCommand).toHaveBeenCalledWith('agent-b', 'test', true);
    });
  });

  it('sends with includeMemory=false when toggled off', async () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox')); // toggle off
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      expect(mockSendCommand).toHaveBeenCalledWith('agent-a', 'test', false);
    });
  });

  it('sends the edited text, not the original', async () => {
    render(
      <SendToCartridgeModal
        initialText="original"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByDisplayValue('original');
    fireEvent.change(textarea, { target: { value: 'edited content with context' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      expect(mockSendCommand).toHaveBeenCalledWith('agent-a', 'edited content with context', true);
    });
  });

  it('trims whitespace before sending', async () => {
    render(
      <SendToCartridgeModal
        initialText="  padded text  "
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      expect(mockSendCommand).toHaveBeenCalledWith('agent-a', 'padded text', true);
    });
  });

  it('shows "Sent!" confirmation after successful send', async () => {
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      expect(screen.getByText('Sent!')).toBeInTheDocument();
    });
  });

  // ─── Validation / disabled states ───────────────

  it('disables send button when text is empty', () => {
    render(
      <SendToCartridgeModal
        initialText=""
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const sendBtn = screen.getByText('Send');
    expect(sendBtn).toBeDisabled();
  });

  it('disables send button when text is only whitespace', () => {
    render(
      <SendToCartridgeModal
        initialText="   "
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    const sendBtn = screen.getByText('Send');
    expect(sendBtn).toBeDisabled();
  });

  it('does not call api when send is disabled', () => {
    render(
      <SendToCartridgeModal
        initialText=""
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Send'));
    expect(mockSendCommand).not.toHaveBeenCalled();
  });

  // ─── Close behavior ─────────────────────────────

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when X button is clicked', () => {
    const onClose = vi.fn();
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('\u00d7')); // × character
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ─── Error handling ─────────────────────────────

  it('recovers from send failure and allows retry', async () => {
    mockSendCommand.mockRejectedValueOnce(new Error('Network error'));

    render(
      <SendToCartridgeModal
        initialText="test"
        agents={ALL_AGENTS}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Send'));

    // After failure, button should be re-enabled (not stuck on "Sending...")
    await waitFor(() => {
      expect(screen.getByText('Send')).not.toBeDisabled();
    });

    // Retry should work
    mockSendCommand.mockResolvedValueOnce({});
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      expect(mockSendCommand).toHaveBeenCalledTimes(2);
    });
  });
});

// ---------------------------------------------------------------------------
// buildSendText tests (extracted helper from ActivityDetailModal)
// ---------------------------------------------------------------------------

// Replicate the function since it's not exported
function buildSendText(activity: { eventType: string; toolName: string; toolInput: string; toolResult: string }): string {
  const parts: string[] = [];
  if (activity.eventType === 'assistant_message') {
    parts.push(activity.toolInput || '');
  } else {
    if (activity.toolName) parts.push(`[${activity.toolName}]`);
    if (activity.toolInput) {
      const input = typeof activity.toolInput === 'string' ? activity.toolInput : JSON.stringify(activity.toolInput, null, 2);
      parts.push(input);
    }
    if (activity.toolResult && activity.toolResult !== '{}') {
      const result = typeof activity.toolResult === 'string' ? activity.toolResult : JSON.stringify(activity.toolResult, null, 2);
      parts.push('\n--- Result ---\n' + result);
    }
  }
  return parts.join('\n').trim();
}

describe('buildSendText', () => {
  it('extracts assistant message content directly', () => {
    const result = buildSendText({
      eventType: 'assistant_message',
      toolName: '',
      toolInput: 'Here is my analysis of the code...',
      toolResult: '{}',
    });

    expect(result).toBe('Here is my analysis of the code...');
  });

  it('formats tool activity with name, input, and result', () => {
    const result = buildSendText({
      eventType: 'PostToolUse',
      toolName: 'Read',
      toolInput: '/src/index.ts',
      toolResult: 'file contents here',
    });

    expect(result).toContain('[Read]');
    expect(result).toContain('/src/index.ts');
    expect(result).toContain('--- Result ---');
    expect(result).toContain('file contents here');
  });

  it('omits result section when result is empty object', () => {
    const result = buildSendText({
      eventType: 'PostToolUse',
      toolName: 'Write',
      toolInput: '/src/file.ts',
      toolResult: '{}',
    });

    expect(result).toContain('[Write]');
    expect(result).toContain('/src/file.ts');
    expect(result).not.toContain('--- Result ---');
  });

  it('omits tool name when empty', () => {
    const result = buildSendText({
      eventType: 'user_prompt',
      toolName: '',
      toolInput: 'Fix the login bug',
      toolResult: '{}',
    });

    expect(result).toBe('Fix the login bug');
    expect(result).not.toContain('[]');
  });

  it('handles empty activity gracefully', () => {
    const result = buildSendText({
      eventType: 'PostToolUse',
      toolName: '',
      toolInput: '',
      toolResult: '{}',
    });

    expect(result).toBe('');
  });

  it('handles assistant message with empty input', () => {
    const result = buildSendText({
      eventType: 'assistant_message',
      toolName: '',
      toolInput: '',
      toolResult: '{}',
    });

    expect(result).toBe('');
  });
});
