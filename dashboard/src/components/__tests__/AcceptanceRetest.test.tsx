/**
 * RETEST ON A DELIVERED FEATURE — the acceptance contract of a feature that was delivered offers
 * to check it again, says exactly what that does, and offers a fix workflow only while gaps remain.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

const calls = vi.hoisted(() => ({ retest: [] as string[], fix: [] as string[], fail: '' }));
vi.mock('../../lib/api', () => ({ api: {
  retestAcceptance: (id: string) => { calls.retest.push(id); return calls.fail ? Promise.reject(new Error(calls.fail)) : Promise.resolve({}); },
  addAcceptanceFixStage: (id: string) => { calls.fix.push(id); return Promise.resolve({}); },
} }));

import { ContractCard } from '../AcceptanceContractPanel';

type Outcome = 'pass' | 'fail' | 'met' | 'not-met' | 'not-checked';
const state = (id: string, verify: 'test' | 'checklist', outcome: Outcome) => ({
  id, text: `Criterion ${id}`, expect: `What ${id} expects`, verify, outcome, test: null, last: null, lastStage: '', baseline: null, verdict: null, confirmation: null, reviewer: '',
});
const pilot = (phase: string, outcomes: [string, 'test' | 'checklist', Outcome][], over: Record<string, unknown> = {}, attention = '') => {
  const states = outcomes.map(([id, verify, outcome]) => state(id, verify, outcome));
  return {
    id: 'pilot-1', phase, attention, stages: [],
    acceptance: {
      id: 'c1', pilotId: 'pilot-1', status: 'locked', version: 1, criteria: states, states, tests: [], draftTests: [], verifications: [], amendments: [], tamper: null, checklist: null,
      activity: null, retesting: false, baselineFresh: false, request: null, waitReason: '', testNotes: '', feedback: '', baseline: null,
      passing: states.filter((s) => s.outcome === 'pass' || s.outcome === 'met').length, total: states.length, ...over,
    },
  } as never;
};
const GAPS: [string, 'test' | 'checklist', Outcome][] = [['AC-1', 'test', 'pass'], ['AC-2', 'test', 'fail'], ['AC-3', 'checklist', 'met'], ['AC-4', 'checklist', 'not-met'], ['AC-5', 'checklist', 'not-checked']];
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);

beforeEach(() => { calls.retest = []; calls.fix = []; calls.fail = ''; });
afterEach(() => cleanup());

describe('retest on a delivered feature', () => {
  it('is offered only once the feature is delivered — never while its pipeline is still working', () => {
    for (const phase of ['running', 'paused', 'cancelled', 'staffing']) {
      render(<ContractCard pilot={pilot(phase, GAPS)} onChanged={() => {}} />);
      expect(q('[data-retest]'), phase).toBeNull();
      cleanup();
    }
    render(<ContractCard pilot={pilot('completed', GAPS)} onChanged={() => {}} />);
    expect(q('[data-retest]')).not.toBeNull();
  });

  it('delivered with gaps: names every criterion that does not pass, says what a retest does, and offers both buttons', async () => {
    const onChanged = vi.fn();
    render(<ContractCard pilot={pilot('completed', GAPS)} onChanged={onChanged} />);
    const box = q('[data-retest]')!;
    expect(box.getAttribute('data-gaps')).toBe('3');
    expect(box.textContent).toContain('Delivered with 3 gaps (AC-2, AC-4, AC-5)');
    expect(box.textContent).toContain('runs the 2 locked tests again and has the 3 checklist items reviewed again for you to confirm');
    expect(box.textContent).toContain('Nothing is built');
    expect(q('[data-fix-button]')!.textContent).toBe('Create a fix workflow for 3 criteria');
    fireEvent.click(q('[data-retest-button]')!);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls.retest).toEqual(['pilot-1']);
    expect(calls.fix).toEqual([]);
    fireEvent.click(q('[data-fix-button]')!);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(calls.fix).toEqual(['pilot-1']);
    expect(calls.retest).toHaveLength(1);
  });

  it('one gap is named in the fix button; with no gap there is no fix button, only a quiet retest', () => {
    render(<ContractCard pilot={pilot('completed', [['AC-1', 'test', 'pass'], ['AC-2', 'checklist', 'not-met']])} onChanged={() => {}} />);
    expect(q('[data-fix-button]')!.textContent).toBe('Create a fix workflow for AC-2');
    expect(q('[data-retest]')!.textContent).toContain('runs the 1 locked test again and has the 1 checklist item reviewed again');
    cleanup();
    render(<ContractCard pilot={pilot('completed', [['AC-1', 'test', 'pass'], ['AC-2', 'checklist', 'met']])} onChanged={() => {}} />);
    expect(q('[data-retest]')!.getAttribute('data-gaps')).toBe('0');
    expect(q('[data-retest]')!.textContent).toContain('Every criterion passes');
    expect(q('[data-fix-button]')).toBeNull();
    expect(q('[data-retest-button]')).not.toBeNull();
  });

  it('while a retest runs both buttons wait; a retest that could not run says why; a refused one is said', async () => {
    render(<ContractCard pilot={pilot('completed', GAPS, { retesting: true })} onChanged={() => {}} />);
    expect(q<HTMLButtonElement>('[data-retest-button]')!.disabled).toBe(true);
    expect(q('[data-retest-button]')!.textContent).toBe('Retesting…');
    expect(q<HTMLButtonElement>('[data-fix-button]')!.disabled).toBe(true);
    cleanup();
    render(<ContractCard pilot={pilot('completed', GAPS, {}, 'The retest did not run: locked acceptance tests were changed since they were approved — acceptance/ac-2.check.mjs (AC-2).')} onChanged={() => {}} />);
    expect(q('[data-retest-stopped]')!.textContent).toMatch(/did not run: locked acceptance tests were changed.*ac-2\.check\.mjs/);
    calls.fail = 'a retest is already running';
    fireEvent.click(q('[data-retest-button]')!);
    await waitFor(() => expect(document.body.textContent).toContain('a retest is already running'));
  });
});
