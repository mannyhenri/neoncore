import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GoalPilot } from '../types';

/**
 * REQUESTED: at the end of a feature on its own branch, "automatically create PR and ask me to merge
 * (and then delete the worktree)". The card asks: Merge… → confirm (says what goes) → one call that
 * merges every PR and cleans up. Once cleaned up it says so and offers nothing more.
 */
const mocks = vi.hoisted(() => ({ merge: vi.fn(), open: vi.fn(), cleanup: vi.fn() }));
vi.mock('../lib/api', () => {
  const client = { mergeFeaturePrs: mocks.merge, openFeaturePrs: mocks.open, cleanupFeatureWorkspace: mocks.cleanup };
  return { api: client, apiFor: () => client };
});
import { WorkspaceCard } from '../components/GoalPilotPanel';

const repo = (name: string, state: string | null, removed = false) => ({
  repoPath: `/code/${name}`, worktreePath: `/code/${name}-feature-x`, agentType: 'claude', base: 'main',
  pr: state ? { url: `https://example.test/${name}/pull/1`, number: 1, state } : null, error: '', removed,
});
const pilot = (repos: ReturnType<typeof repo>[], extra = {}) => ({ id: 'p1', workspace: { branch: 'feature/x', repos, prsAt: '2026-11-22T10:00:00Z', ...extra } }) as unknown as GoalPilot;

describe('the feature workspace card — merge at the end', () => {
  it('asks to merge every open PR, confirms what goes, and merges them in one call', async () => {
    const act = vi.fn((fn: () => Promise<unknown>) => { void fn(); });
    mocks.merge.mockResolvedValue({});
    render(<WorkspaceCard pilot={pilot([repo('alpha', 'open'), repo('beta', 'open')])} busy={false} act={act} />);
    expect(screen.getByText(/2 PRs ready — merged when you mark the feature done/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Merge 2 PRs…' }));
    expect(screen.getByText(/none if any one cannot be/)).toBeInTheDocument();
    expect(mocks.merge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Merge into main & clean up/ }));
    await waitFor(() => expect(mocks.merge).toHaveBeenCalledWith('p1'));
  });

  it('"Not yet" backs out without merging', () => {
    render(<WorkspaceCard pilot={pilot([repo('alpha', 'open')])} busy={false} act={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Merge…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(screen.getByRole('button', { name: 'Merge…' })).toBeInTheDocument();
  });

  it('once merged and cleaned up it says so and offers nothing more', () => {
    render(<WorkspaceCard pilot={pilot([repo('alpha', 'merged', true)], { mergedAt: 'x', cleanedAt: 'y' })} busy={false} act={vi.fn()} />);
    expect(screen.getByText(/merged — worktrees, branch and cartridges removed/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
