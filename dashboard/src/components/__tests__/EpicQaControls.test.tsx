import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { EpicQaRunSummary, EpicQaRunStatus } from '../../types';

/**
 * EPIC QA ON THE EPIC: the run's state, why Passed QA is refused, and a way to run it.
 *
 * REQUESTED: "a failed run blocks Passed QA". The server refuses it (setEpicQa → 409); the button
 * must say so before you press it — the reason in words, not only a tooltip. SET-BASED over every
 * run status × every epic QA state, and over every surface that offers Passed QA.
 */
const mocks = vi.hoisted(() => ({ runEpicQa: vi.fn(), getEpicQa: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { runEpicQa: mocks.runEpicQa, getEpicQa: mocks.getEpicQa } }));

import { EpicQaControls, epicQaChip, passQaBlock } from '../EpicQaControls';

const STATUSES: (EpicQaRunStatus | null)[] = [null, 'running', 'passed', 'failed', 'error', 'no-tests'];
const QA_STATES = ['none', 'open', 'waiting', 'passed'] as const;
const run = (status: EpicQaRunStatus): EpicQaRunSummary => ({
  id: 'r1', status, passing: status === 'failed' ? 17 : 19, total: 19, at: '2026-11-23T22:00:00Z', finishedAt: '',
  failing: status === 'failed' ? [{ feature: 'Core data types', criterionId: 'AC-2', kind: 'test', text: 'Row ids are monotonic' }] : [],
  blockedReason: status === 'passed' || status === 'no-tests' ? null : status === 'running' ? 'QA is still running' : `QA ${status}: 17 of 19`,
});
const CHIP: Record<string, RegExp> = {
  null: /QA not run yet/, running: /QA running/, passed: /QA passed 19\/19/, failed: /QA failed 17\/19/,
  error: /QA could not run/, 'no-tests': /No tests to run/,
};

beforeEach(() => {
  mocks.runEpicQa.mockReset().mockResolvedValue({});
  mocks.getEpicQa.mockReset().mockResolvedValue({ run: null, current: null });
});

describe('every run status × epic QA state', () => {
  const cases = STATUSES.flatMap((s) => QA_STATES.map((q) => [String(s), q, s] as const));

  it.each(cases)('run %s, epic %s', (_name, qa, status) => {
    const summary = status ? run(status) : null;
    render(<EpicQaControls epicId="e1" epicName="Phase 0" qa={qa} run={summary} onPassQa={vi.fn()} />);
    const pass = screen.queryByRole('button', { name: /Passed QA/ });
    if (qa !== 'waiting') {
      // Nothing to sign off: no button. A passed epic says so; an open one is still being built.
      expect(pass).toBeNull();
      if (qa === 'passed') expect(screen.getByText(/✓ QA passed/)).toBeTruthy();
      return;
    }
    expect(screen.getByText(CHIP[String(status)])).toBeTruthy();
    const block = passQaBlock(summary);
    expect(pass).toBeTruthy();
    expect((pass as HTMLButtonElement).disabled).toBe(block !== null);
    if (block) expect(screen.getByText(block)).toBeTruthy();
    expect(!!screen.queryByRole('button', { name: /Run QA/ })).toBe(status !== 'running');
  });
});

describe('the rules', () => {
  it('only a passed or no-tests run allows Passed QA', () => {
    for (const s of STATUSES) {
      const allowed = s === 'passed' || s === 'no-tests';
      expect(passQaBlock(s ? run(s) : null) === null).toBe(allowed);
    }
  });
  it.each(STATUSES)('%s has a chip', (s) => {
    expect(epicQaChip(s ? run(s) : null).text).toMatch(CHIP[String(s)]);
  });
});

describe('actions', () => {
  it('a failed run lists what failed', () => {
    render(<EpicQaControls epicId="e1" epicName="Phase 0" qa="waiting" run={run('failed')} onPassQa={vi.fn()} />);
    expect(screen.getByText(/Core data types · AC-2 · Row ids are monotonic/)).toBeTruthy();
  });
  it('Run QA again starts a run and refreshes', async () => {
    const changed = vi.fn();
    render(<EpicQaControls epicId="e1" epicName="Phase 0" qa="waiting" run={run('failed')} onPassQa={vi.fn()} onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run QA again' }));
    await waitFor(() => expect(mocks.runEpicQa).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });
  it('Passed QA calls through when allowed', () => {
    const pass = vi.fn();
    render(<EpicQaControls epicId="e1" epicName="Phase 0" qa="waiting" run={run('passed')} onPassQa={pass} />);
    fireEvent.click(screen.getByRole('button', { name: /Passed QA/ }));
    expect(pass).toHaveBeenCalled();
  });
  it('fetches the run itself when the surface does not have it', async () => {
    mocks.getEpicQa.mockResolvedValue({ run: null, current: run('failed') });
    render(<EpicQaControls epicId="e1" epicName="Phase 0" qa="waiting" onPassQa={vi.fn()} />);
    expect(await screen.findByText(/QA failed 17\/19/)).toBeTruthy();
    expect(mocks.getEpicQa).toHaveBeenCalledWith('e1');
  });
});

describe('every surface offering Passed QA goes through EpicQaControls', () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  it.each(['world/roadmap/EpicCards.tsx', 'components/ProjectHub.tsx'])('%s', (file) => {
    const src = readFileSync(resolve(SRC, file), 'utf8');
    expect(src).toMatch(/<EpicQaControls\b/);
    expect(src).not.toMatch(/>Passed QA ✓</);
  });
});
