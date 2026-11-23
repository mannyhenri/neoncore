/**
 * THE TRIAGE SECTION — set-based over its registries (docs/plans/bug-triage.md):
 *   every tab (TRIAGE_TABS) renders a loading state, an empty state and a populated state;
 *   every board column (the contract's stages, then the resting columns) renders, and every issue
 *   lands in exactly one column for every state it can be in;
 *   every art slot (TRIAGE_ART) falls back to its Night Glass stand-in when the image is missing;
 *   the source form takes the Jira login as ENV NAMES only — never a token or value field;
 *   the pause switch PUTs /api/triage/settings; Retry / Hand over / Reopen POST their endpoints.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

vi.mock('../../../hooks/useSocket', () => ({ useSocket: () => ({ connected: true }) }));

import { TriagePage, TRIAGE_TABS, type TriageTabKey } from '../TriagePage';
import { TRIAGE_ART, TRIAGE_ART_NAMES, TriageArt } from '../art';
import { TRIAGE_STAGES, TRIAGE_REST_COLUMNS, TRIAGE_COLUMN_KEYS, columnFor } from '../stages';
import { SourceSettings, blankSource } from '../SourceSettings';
import { triageApi, type TriageApi } from '../../../lib/triageApi';
import { TRIAGE_ISSUE_STATES, type TriageIssue, type TriageIssueDetail, type TriageMetrics, type TriageSource, type TriageStage } from '../types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* none */ } });

const SOURCE: TriageSource = {
  id: 's1', name: 'Demo Jira', jiraBaseUrl: 'http://localhost:4071', authEnv: { email: 'JIRA_EMAIL', token: 'JIRA_API_TOKEN' },
  projects: ['DEMO'], issueTypes: ['Bug'], repoFor: { DEMO: '/tmp/demo' }, reporters: 'internal', transitions: false,
  protectedPaths: ['**/auth/**'], limits: { maxFiles: 5, maxLines: 200, minutesPerIssue: 30, dispatchesPerIssue: 8, reviewRounds: 2 },
  pollSeconds: 60, webhookSecretEnv: '', triageAgentId: 'a1', codeAgentType: 'claude',
};
const ISSUE: TriageIssue = {
  id: 'i1', sourceId: 's1', jiraKey: 'DEMO-1', jiraUrl: 'http://localhost:4071/browse/DEMO-1', summary: 'Total is wrong on the invoice',
  reporter: 'Ana', stage: 'reproduce', state: 'working', outcome: 'plausible', labels: ['ai-triaged'], prUrl: '',
  reportedAt: '2026-11-21T10:00:00Z', updatedAt: '2026-11-21T10:05:00Z', firstResponseAt: '2026-11-21T10:01:00Z', agentMinutes: 0.42, dispatches: 3,
};
const DETAIL: TriageIssueDetail = {
  ...ISSUE,
  events: [
    { id: 'e1', issueId: 'i1', at: '2026-11-21T10:00:30Z', stage: 'intake', kind: 'stage', title: 'Queued for triage', reason: '', detail: '', template: '', agentMinutes: 0 },
    { id: 'e2', issueId: 'i1', at: '2026-11-21T10:01:00Z', stage: 'intake', kind: 'message', title: 'Report received', reason: '', detail: 'Thanks Ana — we are looking at it.', template: 'received', agentMinutes: 0 },
    { id: 'e3', issueId: 'i1', at: '2026-11-21T10:03:00Z', stage: 'reproduce', kind: 'verify', title: 'Reproduction test run', reason: '', detail: '1 failed', ok: false, template: '', agentMinutes: 0 },
    { id: 'e4', issueId: 'i1', at: '2026-11-21T10:04:00Z', stage: 'fix', kind: 'guardrail', title: 'Refused: the fix touches a protected path', reason: 'src/auth/session.ts', detail: '', template: '', agentMinutes: 0 },
  ],
  requests: [],
};
const METRICS: TriageMetrics = {
  issues: 10, triagedNoHuman: 0.8, prsOpened: 4, mergedWithoutRework: 0.75, falseNotABug: 0, firstResponseMinutes: 2, fixReleasedHours: 30, agentMinutesPerIssue: 0.9,
};
const NO_METRICS: TriageMetrics = { issues: 0, triagedNoHuman: null, prsOpened: 0, mergedWithoutRework: null, falseNotABug: null, firstResponseMinutes: null, fixReleasedHours: null, agentMinutesPerIssue: null };

function fakeApi(populated: boolean, overrides: Partial<TriageApi> = {}): TriageApi {
  return {
    ...triageApi,
    sources: vi.fn().mockResolvedValue([SOURCE]),
    settings: vi.fn().mockResolvedValue({ paused: false, dailyDispatchCap: 100, dispatchesToday: 7 }),
    issues: vi.fn().mockResolvedValue(populated ? [ISSUE] : []),
    issue: vi.fn().mockResolvedValue(DETAIL),
    metrics: vi.fn().mockResolvedValue(populated ? METRICS : NO_METRICS),
    ...overrides,
  } as TriageApi;
}

/** What each tab shows when it has records — one marker per tab, keyed by the registry. */
const POPULATED: Record<TriageTabKey, string> = {
  board: '[data-triage-issue="i1"]',
  issue: '[data-triage-detail="i1"]',
  messages: '[data-triage-messages="i1"]',
  metrics: '[data-triage-metric="triagedNoHuman"]',
};

async function openTab(api: TriageApi, key: TriageTabKey) {
  const utils = render(<TriagePage api={api} origin="http://localhost:4040" />);
  const label = TRIAGE_TABS.find((t) => t.key === key)!.label;
  const tab = await screen.findByRole('tab', { name: new RegExp(`^${label}`) });
  await act(async () => { fireEvent.click(tab); });
  return utils;
}

describe('every Triage tab', () => {
  it('the registry is the four views', () => {
    expect(TRIAGE_TABS.map((t) => t.key)).toEqual(['board', 'issue', 'messages', 'metrics']);
    expect(Object.keys(POPULATED).sort()).toEqual(TRIAGE_TABS.map((t) => t.key).sort());
  });

  for (const t of TRIAGE_TABS) {
    it(`${t.key}: empty state`, async () => {
      const { container } = await openTab(fakeApi(false), t.key);
      await waitFor(() => expect(container.querySelector('[data-triage-empty]')).not.toBeNull());
      expect(container.querySelector(POPULATED[t.key])).toBeNull();
    });

    it(`${t.key}: populated state`, async () => {
      const { container } = await openTab(fakeApi(true), t.key);
      await waitFor(() => expect(container.querySelector(POPULATED[t.key])).not.toBeNull());
      expect(container.querySelector('[data-triage-empty]')).toBeNull();
    });

    it(`${t.key}: loading state`, async () => {
      const never = () => new Promise<never>(() => {});
      const { container } = await openTab(fakeApi(true, { issues: never, metrics: never, issue: never } as Partial<TriageApi>), t.key);
      expect(container.querySelector('[data-triage-loading]')).not.toBeNull();
    });
  }

  it('the issue timeline shows every kind it was given, and a failed verification as failed', async () => {
    const { container } = await openTab(fakeApi(true), 'issue');
    await waitFor(() => expect(container.querySelector('[data-triage-timeline]')).not.toBeNull());
    for (const k of ['stage', 'message', 'verify', 'guardrail']) expect(container.querySelector(`[data-triage-event="${k}"]`)).not.toBeNull();
    expect(container.querySelector('[data-triage-event="verify"]')!.getAttribute('data-ok')).toBe('false');
  });
});

describe('the board', () => {
  const STAGES: readonly TriageStage[] = ['intake', 'triage', 'code_check', 'reproduce', 'fix', 'pull_request', 'follow_up'];

  it('has a column for every stage of the contract, in order, then the resting columns', () => {
    expect(TRIAGE_STAGES.map((s) => s.key)).toEqual(STAGES);
    expect(TRIAGE_COLUMN_KEYS).toEqual([...STAGES, ...TRIAGE_REST_COLUMNS.map((c) => c.key)]);
  });

  it('renders every column', async () => {
    const { container } = await openTab(fakeApi(true), 'board');
    await waitFor(() => expect(container.querySelector('[data-triage-board]')).not.toBeNull());
    for (const key of TRIAGE_COLUMN_KEYS) expect(container.querySelector(`[data-triage-column="${key}"]`), key).not.toBeNull();
  });

  for (const stage of [...STAGES, 'done' as const]) {
    for (const state of TRIAGE_ISSUE_STATES) {
      it(`a ${state} issue at ${stage} lands in exactly one known column`, () => {
        const col = columnFor({ stage, state });
        expect(TRIAGE_COLUMN_KEYS).toContain(col);
        if (state === 'waiting_reporter' || state === 'labelled' || state === 'handed_over') expect(col).toBe(state);
        else if (state === 'fixed' || state === 'released' || stage === 'done') expect(col).toBe('resolved');
        else expect(col).toBe(stage);
      });
    }
  }
});

describe('every art slot', () => {
  it('TRIAGE_ART lists the slots the section uses, by file', () => {
    expect(TRIAGE_ART_NAMES.length).toBe(10);
    for (const n of TRIAGE_ART_NAMES) expect(TRIAGE_ART[n].file).toBe(`${n}.png`);
    for (const s of TRIAGE_STAGES) expect(TRIAGE_ART_NAMES).toContain(s.art);
  });

  for (const name of TRIAGE_ART_NAMES) {
    it(`${name}: shows the image, then the Night Glass stand-in when it is missing`, () => {
      const { container } = render(<TriageArt name={name} />);
      const img = container.querySelector('img')!;
      expect(img.getAttribute('src')).toBe(`/triage/${TRIAGE_ART[name].file}`);
      fireEvent.error(img);
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector(`[data-triage-art="${name}"][data-triage-art-fallback]`)).not.toBeNull();
      expect(screen.getByRole('img', { name: TRIAGE_ART[name].alt })).toBeTruthy();
    });
  }
});

describe('the source form', () => {
  it('takes the Jira login as ENV NAMES only: no password field, no token or value field, names upper-cased', () => {
    const { container } = render(<SourceSettings initial={SOURCE} agents={[]} origin="http://localhost:4040" onSave={() => {}} />);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    for (const input of container.querySelectorAll('input')) {
      const label = (input.getAttribute('aria-label') ?? '').toLowerCase();
      if (/token|secret|email|password/.test(label)) {
        expect(input.hasAttribute('data-env-name'), `${label} must be a variable name`).toBe(true);
        expect(label).toMatch(/variable name$/);
      }
    }
    const token = screen.getByLabelText('Token variable name') as HTMLInputElement;
    fireEvent.change(token, { target: { value: 'jira_api_token' } });
    expect(token.value).toBe('JIRA_API_TOKEN');
  });

  it('saves defaults that only comment and label, with the scope\'s protected areas; the webhook URL is shown to copy', () => {
    const onSave = vi.fn();
    const { container } = render(<SourceSettings initial={{ ...blankSource(), name: 'Demo', jiraBaseUrl: 'https://demo.atlassian.net' }} agents={[]} origin="http://localhost:4040" onSave={onSave} />);
    expect((container.querySelector('[data-triage-transitions]') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('Save source').hasAttribute('disabled')).toBe(true); // no project yet
    fireEvent.change(screen.getByPlaceholderText('DEMO, APP'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByText('Save source'));
    const saved = onSave.mock.calls[0][0] as TriageSource;
    expect(saved.projects).toEqual(['DEMO']);
    expect(saved.transitions).toBe(false);
    expect(saved.reporters).toBe('internal');
    expect(saved.protectedPaths.join(' ')).toMatch(/auth.*payment.*migrations/);
    expect(saved.authEnv).toEqual({ email: 'JIRA_EMAIL', token: 'JIRA_API_TOKEN' });

    cleanup();
    render(<SourceSettings initial={SOURCE} agents={[]} origin="http://localhost:4040" onSave={() => {}} />);
    expect(screen.getByText('http://localhost:4040/api/triage/webhook/s1')).toBeTruthy();
  });
});

/** A fetch that answers the section's reads, and records every call. */
function fakeFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    const body = url.endsWith('/sources') ? [SOURCE]
      : url.includes('/settings') ? (method === 'PUT' ? { paused: true, dailyDispatchCap: 100 } : { paused: false, dailyDispatchCap: 100 })
      : url.includes('/issues?') ? [ISSUE]
      : /\/issues\/i1$/.test(url) ? { ...DETAIL, state: 'labelled' }
      : url.includes('/metrics') ? METRICS
      : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('the pause switch', () => {
  it('is always visible and PUTs /api/triage/settings', async () => {
    const fetchMock = fakeFetch();
    render(<TriagePage api={triageApi} origin="http://localhost:4040" />);
    const sw = await screen.findByRole('switch', { name: /Pause all bug triage/ });
    await waitFor(() => expect(sw.hasAttribute('disabled')).toBe(false));
    await act(async () => { fireEvent.click(sw); });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/triage/settings' && (i as RequestInit)?.method === 'PUT');
      expect(call, 'no PUT /api/triage/settings').toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ paused: true });
    });
    expect(await screen.findByText('Triage is PAUSED')).toBeTruthy();
  });
});

describe('Retry / Hand over / Reopen', () => {
  for (const [action, path] of [['Retry', '/api/triage/issues/i1/retry'], ['Hand over', '/api/triage/issues/i1/handover'], ['Reopen', '/api/triage/issues/i1/reopen']] as const) {
    it(`${action} posts ${path}`, async () => {
      const fetchMock = fakeFetch();
      await openTab(triageApi, 'issue');
      const btn = await screen.findByRole('button', { name: action });
      await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false));
      await act(async () => { fireEvent.click(btn); });
      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([u]) => String(u) === path);
        expect(call, `no ${path}`).toBeTruthy();
        expect((call![1] as RequestInit).method).toBe('POST');
      });
    });
  }
});

describe('the server\'s own shapes (server/src/lib/triage) are read correctly', () => {
  // Copied from server/src/lib/triage/store.ts EVENT_KINDS — the server's audit kinds.
  const SERVER_EVENT_KINDS = ['stage', 'decision', 'dispatch', 'submission', 'check', 'message', 'label', 'transition', 'pr', 'error', 'budget', 'human'];

  it('every server event kind lands on a timeline kind, with its summary as the title', async () => {
    const { normEvent } = await import('../../../lib/triageApi');
    const { TRIAGE_EVENT_KINDS } = await import('../types');
    for (const kind of SERVER_EVENT_KINDS) {
      const e = normEvent({ id: 'e', issueId: 'i', at: '2026-11-21T10:00:00Z', kind, stage: 'fix', summary: `did ${kind}`, detail: { moment: 'received', lines: ['a', 'b'] }, costMinutes: 3 } as never);
      expect(TRIAGE_EVENT_KINDS).toContain(e.kind);
      expect(e.title).toBe(`did ${kind}`);
      expect(e.agentMinutes).toBe(3);
      expect(e.detail).toBe('a\nb');
    }
  });

  it('an issue, settings and metrics as the server sends them', async () => {
    const { normIssue, normSettings, normMetrics } = await import('../../../lib/triageApi');
    const i = normIssue({ id: '1', sourceId: 's', issueKey: 'DEMO-1', reporterName: 'Ana', jiraCreatedAt: '2026-11-21T09:00:00Z', firstCommentAt: '2026-11-21T09:01:00Z', agentMinutes: 12, dispatches: 2, jiraUrl: 'http://jira/browse/DEMO-1', stage: 'fix', state: 'working' } as never);
    expect([i.jiraKey, i.reporter, i.reportedAt, i.firstResponseAt, i.agentMinutes, i.jiraUrl]).toEqual(['DEMO-1', 'Ana', '2026-11-21T09:00:00Z', '2026-11-21T09:01:00Z', 12, 'http://jira/browse/DEMO-1']);
    expect(normSettings({ paused: true, dailyDispatchCap: 100, dispatchesToday: 7 } as never)).toEqual({ paused: true, dailyDispatchCap: 100, dispatchesToday: 7 });
    const m = normMetrics({ issues: 4, triagedWithoutHumans: 0.75, minutesToFirstResponse: 2, minutesToRelease: 180, agentMinutesPerIssue: 9, mergedWithoutRework: null, falseNotABug: 0 } as never);
    expect([m.triagedNoHuman, m.firstResponseMinutes, m.fixReleasedHours, m.agentMinutesPerIssue]).toEqual([0.75, 2, 3, 9]);
  });
});
