/**
 * QA PER FEATURE AND PER PROJECT — the report: progress bars, every criterion's result, the
 * screenshot of what was tested, and what is missing said in place. Nothing is entered here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FeatureQa, FEATURE_STATE } from '../FeatureQa';
import type { QaApi } from '../../../lib/qaApi';
import type { QaCriterionStatus, QaFeature, QaFeatureState, QaProjectFeatures } from '../types';

const crit = (id: string, status: QaCriterionStatus, over: Partial<QaFeature['criteria'][number]> = {}) => ({ id, text: `Criterion ${id}`, expect: `What ${id} expects`, status, error: '', screenshot: '', ...over });
const feature = (goalId: string, state: QaFeatureState, criteria: QaFeature['criteria'], over: Partial<QaFeature> = {}): QaFeature => ({
  goalId, name: `Feature ${goalId}`, phase: 'running', state, note: '', criteria, passed: criteria.filter((c) => c.status === 'passed').length, total: criteria.length,
  runId: '', runAt: '', repaired: false, reportUrl: '', ...over,
});
const project = (projectId: string, features: QaFeature[], target: QaProjectFeatures['target'] = { id: 't1', name: 'App', baseUrl: 'http://localhost:4061', hasCartridge: true }): QaProjectFeatures => ({
  projectId, name: `Project ${projectId}`, color: '#4af', target, features,
  passed: features.reduce((n, f) => n + f.passed, 0), total: features.reduce((n, f) => n + f.total, 0), featuresPassing: features.filter((f) => f.state === 'passed').length,
});
const apiOf = (projects: () => QaProjectFeatures[], runFeature = vi.fn(() => Promise.resolve({}))) => ({ features: vi.fn(() => Promise.resolve(projects())), runFeature } as unknown as QaApi & { features: ReturnType<typeof vi.fn>; runFeature: ReturnType<typeof vi.fn> });
const q = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const all = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];
const shown = () => waitFor(() => expect(q('[data-qa-features]')).not.toBeNull());

afterEach(() => cleanup());

describe('QA follows the feature', () => {
  it('every feature state has its own words, and only a feature with a test can be run by hand', async () => {
    const states = Object.keys(FEATURE_STATE) as QaFeatureState[];
    expect(states.sort()).toEqual(['error', 'failed', 'no-criteria', 'no-target', 'not-run', 'passed', 'running', 'waiting-for-build']);
    const api = apiOf(() => [project('p1', states.map((s) => feature(s, s, s === 'no-criteria' ? [] : [crit('AC-1', s === 'passed' ? 'passed' : 'not-run')])))]);
    render(<FeatureQa api={api} />); await shown();
    for (const s of states) {
      const row = q(`[data-qa-feature="${s}"]`)!;
      expect(row.getAttribute('data-state')).toBe(s);
      expect(q('[data-qa-feature-state]', row)!.textContent).toBe(FEATURE_STATE[s].label);
      expect(!!q('[data-qa-feature-run]', row), s).toBe(!['no-target', 'no-criteria', 'running'].includes(s));
    }
    expect(new Set(states.map((s) => FEATURE_STATE[s].label)).size).toBe(states.length);
  });

  it('a project shows its criteria passing over all its features, with a bar; each feature its own count, bar, criteria and screenshots', async () => {
    const api = apiOf(() => [project('p1', [
      feature('g1', 'passed', [crit('AC-1', 'passed', { screenshot: '/api/qa/evidence/r1/step-0.png' }), crit('AC-2', 'passed', { screenshot: '/api/qa/evidence/r1/step-1.png' })], { runId: 'r1', runAt: '2026-11-21T12:00:00Z', reportUrl: '/api/qa/runs/r1/report.html' }),
      feature('g2', 'failed', [crit('AC-1', 'passed', { screenshot: '/api/qa/evidence/r2/step-0.png' }), crit('AC-2', 'failed', { error: 'expected Total to equal 19.75', screenshot: '/api/qa/evidence/r2/step-1.png' }), crit('AC-3', 'not-run')], { runId: 'r2', note: '1 of 3 criteria did not pass.', reportUrl: '/api/qa/runs/r2/report.html' }),
    ])]);
    render(<FeatureQa api={api} />); await shown();
    const p = q('[data-qa-project="p1"]')!;
    expect(q('[data-qa-project-count]', p)!.textContent).toBe('3/5 criteria · 1 of 2 features passing');
    const bars = all('[data-qa-bar]', p);
    expect(bars).toHaveLength(3);                     // the project's, and one per feature
    expect([bars[0].getAttribute('aria-valuenow'), bars[0].getAttribute('aria-valuemax')]).toEqual(['3', '5']);
    expect((bars[0].children[0] as HTMLElement).style.width).toBe('60%');
    expect((bars[0].children[1] as HTMLElement).style.width).toBe('20%');   // what failed is shown too

    // The failing feature is open by itself: every criterion with its result, the reason, and what was on screen.
    const g2 = q('[data-qa-feature="g2"]')!;
    expect(q('[data-qa-feature-count]', g2)!.textContent).toBe('1/3');
    expect(all('[data-qa-criterion]', g2).map((c) => [c.getAttribute('data-qa-criterion'), c.getAttribute('data-status')])).toEqual([['AC-1', 'passed'], ['AC-2', 'failed'], ['AC-3', 'not-run']]);
    expect(q('[data-qa-criterion="AC-2"]', g2)!.textContent).toContain('expected Total to equal 19.75');
    expect(q('[data-qa-criterion="AC-2"]', g2)!.textContent).toContain('Expected: What AC-2 expects');
    const shots = all('[data-qa-shot]', g2);
    expect(shots.map((a) => a.getAttribute('href'))).toEqual(['/api/qa/evidence/r2/step-0.png', '/api/qa/evidence/r2/step-1.png']);
    expect(shots.map((a) => a.querySelector('img')!.getAttribute('src'))).toEqual(['/api/qa/evidence/r2/step-0.png', '/api/qa/evidence/r2/step-1.png']);
    expect(shots[1].querySelector('img')!.getAttribute('alt')).toMatch(/AC-2/);
    expect(g2.querySelector('a[href="/api/qa/runs/r2/report.html"]')).not.toBeNull();
    // The passing one is folded until asked for; then its screenshots are there too.
    const g1 = q('[data-qa-feature="g1"]')!;
    expect(all('[data-qa-criterion]', g1)).toHaveLength(0);
    fireEvent.click(q('button[aria-expanded]', g1)!);
    expect(all('[data-qa-shot]', g1)).toHaveLength(2);
    expect(q('[data-qa-feature-note]', g1)!.textContent).toMatch(/last run/);
  });

  it('what QA cannot work out is said in place: no target for the project, a target with no cartridge, nothing being developed', async () => {
    const onAddTarget = vi.fn();
    const api = apiOf(() => [
      project('p1', [feature('g1', 'no-target', [crit('AC-1', 'not-run')], { note: 'QA does not know where this project\'s app runs. Add a QA target for the project.' })], null),
      project('p2', [feature('g2', 'waiting-for-build', [crit('AC-1', 'not-run')])], { id: 't2', name: 'App', baseUrl: 'http://localhost:5000', hasCartridge: false }),
      project('p3', []),
    ]);
    render(<FeatureQa api={api} onAddTarget={onAddTarget} />); await shown();
    expect(all('[data-qa-project]').map((p) => p.getAttribute('data-qa-project'))).toEqual(['p1', 'p2']);   // a project with nothing in development is not listed
    expect(q('[data-qa-no-target]', q('[data-qa-project="p1"]')!)).not.toBeNull();
    fireEvent.click(q('[data-qa-add-target]')!);
    expect(onAddTarget).toHaveBeenCalledTimes(1);
    expect(q('[data-qa-add-target]', q('[data-qa-project="p2"]')!)).toBeNull();
    expect(q('[data-qa-no-cartridge]', q('[data-qa-project="p2"]')!)).not.toBeNull();
    cleanup();
    render(<FeatureQa api={apiOf(() => [])} />); await shown();
    expect(q('[data-qa-features-empty]')!.textContent).toMatch(/No feature is being developed yet/);
  });

  it('it keeps itself current: read again while something is being tested, and when the server says a run moved; "Run again" runs that feature', async () => {
    let state: QaFeatureState = 'running';
    const api = apiOf(() => [project('p1', [feature('g1', state, [crit('AC-1', state === 'running' ? 'running' : 'passed')], { runId: 'r1' })])]);
    const view = render(<FeatureQa api={api} pollMs={15} />); await shown();
    expect(q('[data-qa-feature="g1"]')!.getAttribute('data-state')).toBe('running');
    state = 'passed';
    await waitFor(() => expect(q('[data-qa-feature="g1"]')!.getAttribute('data-state')).toBe('passed'));
    // Nothing running: it stops asking by itself…
    const calls = api.features.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(api.features.mock.calls.length).toBe(calls);
    // …until the server says a run moved.
    view.rerender(<FeatureQa api={api} pollMs={15} tick={1} />);
    await waitFor(() => expect(api.features.mock.calls.length).toBe(calls + 1));
    fireEvent.click(q('[data-qa-feature-run]')!);
    await waitFor(() => expect(api.runFeature).toHaveBeenCalledWith('g1'));
    await waitFor(() => expect(api.features.mock.calls.length).toBe(calls + 2));
  });

  it('a run that is refused is said, and the report stays', async () => {
    const api = apiOf(() => [project('p1', [feature('g1', 'failed', [crit('AC-1', 'failed')], { runId: 'r1' })])], vi.fn(() => Promise.reject(new Error('QA is already running for this feature'))));
    render(<FeatureQa api={api} />); await shown();
    fireEvent.click(q('[data-qa-feature-run]')!);
    await waitFor(() => expect(document.body.textContent).toContain('QA is already running for this feature'));
    expect(q('[data-qa-feature="g1"]')).not.toBeNull();
  });
});
