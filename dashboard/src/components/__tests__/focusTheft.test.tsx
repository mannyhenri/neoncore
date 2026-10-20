import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Agent, PermissionRequest } from '../../types';

// ---------------------------------------------------------------------------
// Live agent traffic must never steal the caret from whatever the user is typing in.
// A card mounting (new agent, restored cartridge) or a question arriving used to
// focus its own input unconditionally.
// ---------------------------------------------------------------------------

vi.mock('../../lib/api', () => ({
  api: {
    getAgentTokenUsage: vi.fn().mockResolvedValue({ total: 0, costUsd: 0 }),
    openRepo: vi.fn().mockResolvedValue({}),
    recoverAgentSession: vi.fn().mockResolvedValue({}),
    dismissAgentRecovery: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../lib/sprites', () => ({
  generatePixelSprites: () => [],
}));

import { CartridgeGrid } from '../CartridgeGrid';
import { NotificationCenter } from '../NotificationCenter';

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    name: 'test-agent',
    machine: 'test-machine.local',
    repoPath: '/test/path',
    repoName: 'test-repo',
    branch: 'main',
    currentTask: '',
    status: 'working',
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

function question(id: string, agentId: string): PermissionRequest {
  return {
    id,
    agentId,
    toolName: 'AskUserQuestion',
    toolInput: '{}',
    description: 'Which approach?',
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    response: '',
  };
}

const noop = () => {};

function grid(agents: Agent[]) {
  return (
    <CartridgeGrid
      agents={agents}
      activitiesByAgent={{}}
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

function notifications(perms: PermissionRequest[], agents: Agent[]) {
  return (
    <NotificationCenter
      pendingPermissions={perms}
      stuckAlerts={[]}
      workflowNotifications={[]}
      agents={agents}
      onDecide={noop}
      onDismissStuck={noop}
      onDismissWorkflow={noop}
    />
  );
}

/** A field the user is typing into, outside every component under test. */
function userIsTypingElsewhere(): HTMLInputElement {
  const el = document.createElement('input');
  el.setAttribute('data-testid', 'user-field');
  document.body.appendChild(el);
  el.focus();
  expect(document.activeElement).toBe(el);
  return el;
}

describe('agent traffic never steals focus from the user', () => {
  let userField: HTMLInputElement;

  beforeEach(() => {
    localStorage.clear();
    userField = userIsTypingElsewhere();
  });

  afterEach(() => {
    cleanup();
    userField.remove();
  });

  it('a new cartridge mounting does not take focus', () => {
    const a = makeAgent({ id: 'a', repoName: 'repo-a' });
    const { rerender } = render(grid([a]));
    userField.focus();

    // Six agents inside one manager come and go — each new one mounts a card.
    const more = [1, 2, 3, 4, 5, 6].map((n) => makeAgent({ id: `sub-${n}`, repoName: `sub-${n}` }));
    rerender(grid([a, ...more]));

    expect(document.activeElement).toBe(userField);
  });

  it('an arriving question does not take focus', () => {
    const agents = [makeAgent({ id: 'a' })];
    const { rerender } = render(notifications([], agents));
    userField.focus();

    rerender(notifications([question('q1', 'a')], agents));
    expect(document.activeElement).toBe(userField);

    rerender(notifications([question('q1', 'a'), question('q2', 'a')], agents));
    expect(document.activeElement).toBe(userField);
  });

  it('still focuses a fresh input when the user is not typing anywhere', () => {
    userField.blur();
    const { container } = render(grid([makeAgent({ id: 'a' })]));
    expect(document.activeElement).toBe(container.querySelector('textarea'));
  });
});

// ---------------------------------------------------------------------------
// Set-based guard: every focus site in the dashboard is enumerated. Each one is either
// routed through focusIfIdle (safe to fire without a user gesture) or listed here as
// reachable ONLY behind a user gesture (a click that opened the modal/editor/reply box).
// A new unguarded site fails this test until it is classified.
// ---------------------------------------------------------------------------

const GESTURE_ONLY: Record<string, string> = {
  'components/AgentCard.tsx': 'custom-answer + reject-feedback boxes open on click',
  'components/CartridgeCard.tsx': 'custom-answer + reject-feedback boxes open on click',
  'components/NewRepoModal.tsx': 'modal opened by the user',
  'components/GoalsPage.tsx': 'path picker manual mode / create modals opened by the user',
  'components/MachineLauncher.tsx': 'launcher dropdown opened by the user',
  'components/TasksPage.tsx': 'create-task modal opened by the user',
  'components/WorkflowCanvasEditor.tsx': 'node rename after the user clicks edit',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('every focus site is gesture-gated or idle-guarded', () => {
  const root = join(__dirname, '..', '..');
  const sites = walk(root).flatMap((file) => {
    const rel = relative(root, file);
    if (rel === 'lib/focus.ts') return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ rel, line: i + 1, text: line }))
      .filter(({ text }) => /\.focus\(|autoFocus/.test(text) && !text.trim().startsWith('//'));
  });

  it('found the focus sites', () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it.each(sites.map((s) => [`${s.rel}:${s.line}`, s] as const))('%s', (_label, s) => {
    const classified = s.rel in GESTURE_ONLY || /focusIfIdle/.test(s.text);
    expect(classified, `${s.rel}:${s.line} focuses without a user gesture — use focusIfIdle`).toBe(true);
  });
});
