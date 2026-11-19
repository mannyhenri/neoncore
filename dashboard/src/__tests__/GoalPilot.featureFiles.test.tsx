import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

/**
 * REQUESTED: "when we create a new feature, there should be an opportunity somewhere to add files,
 * could we add this in the scoping somewhere".
 *
 * The intake form takes files and sends them WITH the request that starts scoping (so the
 * planner's first prompt carries them); the pipeline panel keeps a card to add or remove more.
 */
const mocks = vi.hoisted(() => ({
  createGoalPilot: vi.fn(async (_d: unknown) => ({ pilot: {}, goalId: 'g1', queued: false, error: null })),
  getFeatureFiles: vi.fn(async () => [{ id: 'f1', goalId: 'g1', name: 'mockup.png', mimeType: 'image/png', size: 2048, createdAt: '' }]),
  removeFeatureFile: vi.fn(async () => undefined),
  addFeatureFiles: vi.fn(),
}));
vi.mock('../lib/api', () => {
  const client = {
    getGoalPilotMeta: vi.fn(async () => ({
      intakeQuestions: [{ key: 'goal', label: 'What is the feature?', kind: 'text', required: true, help: '' }],
      involvementLevels: [], defaultVerify: {},
    })),
    ...mocks,
  };
  return { api: client, apiFor: () => client };
});

import { GoalPilotIntake, FeatureFilesCard } from '../components/GoalPilotPanel';

// jsdom has no object URLs; the picker makes one for an image preview.
Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} });

const agents = [{ id: 'a1', name: 'box/repo', repoPath: '/r', repoName: 'repo', agentType: 'claude', status: 'idle', mode: 'auto' }] as unknown as Agent[];

describe('feature files in scoping', () => {
  it('the intake form sends the picked files with the request that starts scoping', async () => {
    const { container } = render(<GoalPilotIntake agents={agents} preferRepos={['/r']} onCreated={() => {}} onCancel={() => {}} />);
    await screen.findByText('What is the feature?');
    fireEvent.change(container.querySelector('input[type="text"]')!, { target: { value: 'Import invoices' } });
    const file = new File(['PNGDATA'], 'mockup.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await screen.findByText('mockup.png');
    fireEvent.click(screen.getByRole('button', { name: /start scoping/i }));
    await waitFor(() => expect(mocks.createGoalPilot).toHaveBeenCalled());
    const sent = mocks.createGoalPilot.mock.calls[0][0] as { files?: { name: string; dataBase64: string }[] };
    expect(sent.files?.map((f) => f.name)).toEqual(['mockup.png']);
    expect(atob(sent.files![0].dataBase64)).toBe('PNGDATA');
  });

  it('the files card lists the feature\'s files and removes one', async () => {
    render(<FeatureFilesCard goalId="g1" />);
    await screen.findByText('mockup.png');
    fireEvent.click(screen.getByRole('button', { name: 'Remove mockup.png' }));
    await waitFor(() => expect(mocks.removeFeatureFile).toHaveBeenCalledWith('g1', 'f1'));
    await waitFor(() => expect(screen.queryByText('mockup.png')).toBeNull());
  });
});
