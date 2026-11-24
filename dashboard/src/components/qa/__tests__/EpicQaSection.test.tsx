import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { EpicQaCheckKind, EpicQaRun } from '../../../types';

/**
 * THE QA SECTION SHOWS EPIC QA — for every project, web UI or not.
 *
 * An epic's QA run (server lib/qa/epic-acceptance.ts) re-runs every feature's locked tests and the
 * project's QA command. A failure is only actionable if you can see which check failed, its command
 * and its output. SET-BASED over every check kind the server records.
 */
const calls = vi.hoisted(() => ({ getGoalProjects: vi.fn(), getRoadmap: vi.fn(), getEpicQa: vi.fn(), runEpicQa: vi.fn() }));
vi.mock('../../../lib/api', () => ({ api: calls }));

import { EpicQaSection } from '../EpicQaSection';

const KINDS: EpicQaCheckKind[] = ['test', 'command', 'qa-command', 'tamper', 'checklist'];
const RUN: EpicQaRun = {
  id: 'r1', epicId: 'e0', projectId: 'p1', forFinishedAt: '', status: 'failed', passing: 4, total: 5, summary: '', error: '',
  startedAt: '2026-11-23T22:00:00Z', finishedAt: '2026-11-23T22:04:00Z',
  checks: KINDS.map((kind, i) => ({
    kind, goalId: 'g1', feature: `Feature ${kind}`, criterionId: `AC-${i + 1}`, text: `criterion ${kind}`,
    command: `cmd-${kind}`, passed: kind !== 'test', exitCode: kind === 'test' ? 1 : 0, timedOut: false,
    output: `output of ${kind}`, durationMs: 100,
  })),
};
const SUMMARY = { id: 'r1', status: 'failed', passing: 4, total: 5, at: RUN.startedAt, finishedAt: RUN.finishedAt, failing: [], blockedReason: 'QA failed' };

beforeEach(() => {
  calls.getGoalProjects.mockReset().mockResolvedValue([{ id: 'p1', name: 'FacetDB' }, { id: 'p2', name: 'Beam' }, { id: 'p3', name: 'Nothing finished' }]);
  calls.getRoadmap.mockReset().mockImplementation(async (id: string) => ({
    project: { id, name: id }, vision: '', unassigned: [], range: { from: '', to: '' },
    epics: id === 'p3'
      ? [{ id: 'e9', name: 'Phase 0', qa: 'open', qaRun: null }]
      : [{ id: id === 'p1' ? 'e0' : 'e1', name: 'Phase 0: Setup', qa: 'waiting', qaRun: id === 'p1' ? SUMMARY : null }],
  }));
  calls.getEpicQa.mockReset().mockResolvedValue({ run: RUN, current: SUMMARY });
});

describe('Epic QA in the QA section', () => {
  it('lists every project with a finished epic, and only those', async () => {
    render(<EpicQaSection />);
    expect(await screen.findByText('FacetDB')).toBeTruthy();
    expect(screen.getByText('Beam')).toBeTruthy();
    expect(screen.queryByText('Nothing finished')).toBeNull();
    expect(screen.getByText(/QA failed 4\/5/)).toBeTruthy();
    expect(screen.getByText(/QA not run yet/)).toBeTruthy();
  });

  it.each(KINDS)('the %s check shows its kind, feature, criterion, command, result and output', async (kind) => {
    render(<EpicQaSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Checks · Phase 0: Setup/ }));
    const row = await screen.findByTestId(`epic-qa-check-AC-${KINDS.indexOf(kind) + 1}`);
    const r = within(row);
    expect(r.getByText(new RegExp(`Feature ${kind}`))).toBeTruthy();
    expect(r.getByText(`cmd-${kind}`)).toBeTruthy();
    expect(r.getByText(kind === 'test' ? /fail/i : /pass/i)).toBeTruthy();
    expect(r.getByText(`output of ${kind}`)).toBeTruthy();
  });
});
