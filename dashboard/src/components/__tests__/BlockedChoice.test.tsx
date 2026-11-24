import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * A STEP BLOCKED ON A PERSON IS ANSWERED WHEREVER THE RUN IS.
 *
 * A step can report `blocked: "<what you must do>"` (server: holdStepBlocked). The run then holds
 * instead of failing — but only if the person can see the ask and release it. The tasks-still-open
 * hold already has that on every surface that shows a run; a blocked step needs the same set, so
 * this iterates every file that renders the coverage choice and requires the blocked one beside it.
 */
const mocks = vi.hoisted(() => ({ resolveBlockedStep: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { resolveBlockedStep: mocks.resolveBlockedStep } }));

import { BlockedChoice } from '../RunProgress';
import { HEALTH_LABEL } from '../../lib/goalRollup';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SURFACES = ['components/RunProgress.tsx', 'components/GoalPilotPanel.tsx', 'components/WorkflowCanvasEditor.tsx'];

describe('every surface with the coverage choice has the blocked choice', () => {
  it.each(SURFACES)('%s', (file) => {
    const src = readFileSync(resolve(SRC, file), 'utf8');
    const coverage = (src.match(/<CoverageChoice\b/g) ?? []).length;
    const blocked = (src.match(/<BlockedChoice\b/g) ?? []).length;
    expect(coverage).toBeGreaterThan(0);
    expect(blocked).toBe(coverage);
  });

  it('the run card shows the strip for a blocked run even with no progress document', () => {
    const src = readFileSync(resolve(SRC, 'components/RunProgress.tsx'), 'utf8');
    expect(src).toMatch(/blocked-on-person/);
  });

  it('the reason has a plain-language label', () => {
    expect(HEALTH_LABEL['blocked-on-person']).toMatch(/needs you/i);
  });
});

describe('BlockedChoice', () => {
  beforeEach(() => { mocks.resolveBlockedStep.mockReset().mockResolvedValue({}); });

  it('shows what the person must do', () => {
    render(<BlockedChoice workflowId="w1" stepId="s1" ask="Run scripts/run_gates.sh 0 with sudo" />);
    expect(screen.getByText(/Needs you: Run scripts\/run_gates.sh 0 with sudo/)).toBeTruthy();
  });

  it('continues with the note', async () => {
    const done = vi.fn();
    render(<BlockedChoice workflowId="w1" stepId="s1" ask="Do X" onDone={done} />);
    fireEvent.change(screen.getByLabelText('Note for the agent (optional)'), { target: { value: 'done, gate passed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done — continue' }));
    await waitFor(() => expect(mocks.resolveBlockedStep).toHaveBeenCalledWith('w1', 's1', 'continue', 'done, gate passed'));
    expect(done).toHaveBeenCalled();
  });

  it('stops the run only on a second, confirming click', async () => {
    render(<BlockedChoice workflowId="w1" stepId="s1" ask="Do X" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop the run' }));
    expect(mocks.resolveBlockedStep).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, stop it' }));
    await waitFor(() => expect(mocks.resolveBlockedStep).toHaveBeenCalledWith('w1', 's1', 'stop', undefined));
  });

  it('says what went wrong', async () => {
    mocks.resolveBlockedStep.mockRejectedValue(new Error('step is not blocked'));
    render(<BlockedChoice workflowId="w1" stepId="s1" ask="Do X" />);
    fireEvent.click(screen.getByRole('button', { name: 'Done — continue' }));
    expect(await screen.findByText('step is not blocked')).toBeTruthy();
  });
});
