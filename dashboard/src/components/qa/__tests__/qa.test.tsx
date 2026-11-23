/**
 * THE QA SECTION — set-based over its registries (docs/plans/qa-section.md):
 *   every tab (QA_TABS) renders a loading state, an empty state and a populated state;
 *   every art slot (QA_ART) falls back to its Night Glass stand-in when the image is missing;
 *   every check prefix (CHECK_PREFIXES) is highlighted as a check;
 *   the target form takes credential ENV NAMES only — never a value, never a password field;
 *   Accept / Reject call the contract's endpoints.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

vi.mock('../../../hooks/useSocket', () => ({ useSocket: () => ({ connected: true }) }));

import { QaPage, QA_TABS, type QaTabKey } from '../QaPage';
import { QA_ART, QA_ART_NAMES, QaArt } from '../art';
import { CHECK_PREFIXES, isCheckSentence, parseSentences } from '../sentences';
import { SentenceList } from '../TestsTab';
import { TargetSettings, blankTarget } from '../TargetSettings';
import { qaApi, type QaApi } from '../../../lib/qaApi';
import type { QaFinding, QaJourneys, QaRepair, QaRun, QaTarget, QaTest } from '../types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* none */ } });

const TARGET: QaTarget = {
  id: 't1', projectId: '', name: 'Demo app', baseUrl: 'http://localhost:4061', allowHosts: ['localhost:4061'],
  denyActions: ['delete'], credentialsEnv: { supervisor: { user: 'QA_SUP_USER', pass: 'QA_SUP_PASS' } },
  productionAllowed: false, budgets: { steps: 60, minutes: 15 }, agentId: 'a1',
};
const TEST: QaTest = {
  id: 'x1', targetId: 't1', name: 'Supervisor submits a daily report', source: 'manual', cache: null,
  sentences: ['Log in as a supervisor.', 'Submit it.', 'Check that its status is Awaiting approval.'],
};
const RUN: QaRun = { id: 'r1', targetId: 't1', kind: 'run', testIds: ['x1'], status: 'passed_with_repair', aiCalls: 1, summary: '1 passed with repair' };
const FINDING: QaFinding = {
  id: 'f1', runId: 'r2', targetId: 't1', signature: 'sig', severity: 'high', kind: 'console-error', title: 'Reports list throws',
  detail: 'TypeError', page: '/reports', steps: ['Open Reports'], sentences: ['Open the reports list.', 'Check that no error is shown.'],
  status: 'open', seenCount: 3,
};
const REPAIR: QaRepair = {
  id: 'p1', runId: 'r1', testId: 'x1', testName: TEST.name, stepIndex: 1, sentence: 'Submit it.', status: 'pending',
  before: [{ do: 'click', target: { role: 'button', name: 'Submit' } }],
  after: [{ do: 'click', target: { role: 'button', name: 'Send for approval' } }],
};
const JOURNEYS: QaJourneys = {
  journeys: [{ sig: 'j1', steps: ['/login', 'click Sign in', '/reports'], count: 7, covered: false }],
  coverage: { covered: 0, total: 1 }, sessions: 10,
};

/** A fake API with every list either empty or populated. */
function fakeApi(populated: boolean, overrides: Partial<QaApi> = {}): QaApi {
  return {
    ...qaApi,
    targets: vi.fn().mockResolvedValue([TARGET]),
    tests: vi.fn().mockResolvedValue(populated ? [TEST] : []),
    runs: vi.fn().mockResolvedValue(populated ? [RUN] : []),
    run: vi.fn().mockResolvedValue({ ...RUN, results: [], repairs: [], findings: [] }),
    findings: vi.fn().mockResolvedValue(populated ? [FINDING] : []),
    repairs: vi.fn().mockResolvedValue(populated ? [REPAIR] : []),
    journeys: vi.fn().mockResolvedValue(populated ? JOURNEYS : { journeys: [], coverage: { covered: 0, total: 0 }, sessions: 0 }),
    acceptRepair: vi.fn().mockResolvedValue({}),
    rejectRepair: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as QaApi;
}

/** What each tab shows when it has records — one marker per tab, keyed by the registry. */
const POPULATED: Record<QaTabKey, string> = {
  tests: '[data-qa-test="x1"]',
  runs: '[data-qa-run="r1"]',
  findings: '[data-qa-finding="f1"]',
  repairs: '[data-qa-repair="p1"]',
  journeys: '[data-qa-journey="j1"]',
};

async function openTab(api: QaApi, key: QaTabKey) {
  const utils = render(<QaPage api={api} origin="http://localhost:4040" />);
  const label = QA_TABS.find((t) => t.key === key)!.label;
  const tab = await screen.findByRole('tab', { name: new RegExp(`^${label}`) });
  await act(async () => { fireEvent.click(tab); });
  return utils;
}

describe('every QA tab', () => {
  it('the registry is the five modules\' views', () => {
    expect(QA_TABS.map((t) => t.key)).toEqual(['tests', 'runs', 'findings', 'repairs', 'journeys']);
    expect(Object.keys(POPULATED).sort()).toEqual(QA_TABS.map((t) => t.key).sort());
  });

  for (const t of QA_TABS) {
    it(`${t.key}: empty state`, async () => {
      const { container } = await openTab(fakeApi(false), t.key);
      await waitFor(() => expect(container.querySelector('[data-qa-empty]')).not.toBeNull());
      expect(container.querySelector(POPULATED[t.key])).toBeNull();
    });

    it(`${t.key}: populated state`, async () => {
      const { container } = await openTab(fakeApi(true), t.key);
      await waitFor(() => expect(container.querySelector(POPULATED[t.key])).not.toBeNull());
      expect(container.querySelector('[data-qa-empty]')).toBeNull();
    });

    it(`${t.key}: loading state`, async () => {
      const never = () => new Promise<never>(() => {});
      const api = fakeApi(true, { tests: never, runs: never, findings: never, repairs: never, journeys: never } as Partial<QaApi>);
      const { container } = await openTab(api, t.key);
      expect(container.querySelector('[data-qa-loading]')).not.toBeNull();
    });
  }
});

describe('every art slot', () => {
  it('QA_ART lists the slots the section uses, by file', () => {
    expect(QA_ART_NAMES.length).toBe(8);
    for (const n of QA_ART_NAMES) expect(QA_ART[n].file).toBe(`${n}.png`);
  });

  for (const name of QA_ART_NAMES) {
    it(`${name}: shows the image, then the Night Glass stand-in when it is missing`, () => {
      const { container } = render(<QaArt name={name} />);
      const img = container.querySelector('img')!;
      expect(img.getAttribute('src')).toBe(`/qa/${QA_ART[name].file}`);
      fireEvent.error(img);
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector(`[data-qa-art="${name}"][data-qa-art-fallback]`)).not.toBeNull();
      expect(screen.getByRole('img', { name: QA_ART[name].alt })).toBeTruthy();
    });
  }
});

describe('check sentences', () => {
  for (const prefix of CHECK_PREFIXES) {
    it(`"${prefix} …" is a check, numbered or not, any case, and is highlighted`, () => {
      for (const s of [`${prefix} that the status is Approved.`, `3. ${prefix.toLowerCase()} the list shows 2 rows`]) {
        expect(isCheckSentence(s)).toBe(true);
      }
      const { container } = render(<SentenceList sentences={['Log in.', `${prefix} that it worked.`]} />);
      const items = container.querySelectorAll('li');
      expect(items[0].hasAttribute('data-qa-check')).toBe(false);
      expect(items[1].hasAttribute('data-qa-check')).toBe(true);
    });
  }

  it('an action sentence that merely mentions a check word is not a check', () => {
    expect(isCheckSentence('Click the Verify button.')).toBe(false);
    expect(isCheckSentence('Checkout the cart.')).toBe(false);
  });

  it('numbering and blank lines are stripped from the editor', () => {
    expect(parseSentences('1. Log in.\n\n2) Submit it.\n  Check it.  ')).toEqual(['Log in.', 'Submit it.', 'Check it.']);
  });
});

describe('the target form', () => {
  it('takes credential ENV NAMES only: no password field, no value field, names upper-cased', () => {
    const { container } = render(<TargetSettings initial={TARGET} agents={[]} onSave={() => {}} />);
    fireEvent.click(screen.getByText('+ Add a login'));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    const credInputs = [...container.querySelectorAll('[data-qa-credential] input')];
    expect(credInputs.length).toBeGreaterThan(0);
    for (const input of credInputs) {
      const label = input.getAttribute('aria-label') ?? '';
      expect(label === 'Role' || (input.hasAttribute('data-env-name') && /variable name$/.test(label))).toBe(true);
    }
    const userVar = container.querySelectorAll<HTMLInputElement>('[data-env-name]')[0];
    fireEvent.change(userVar, { target: { value: 'qa_sup_user' } });
    expect(userVar.value).toBe('QA_SUP_USER');
  });

  it('saves the env names and always allows the base URL\'s host; production stays off by default', async () => {
    const onSave = vi.fn();
    render(<TargetSettings initial={{ ...blankTarget(), name: 'Demo', baseUrl: 'http://localhost:4061' }} agents={[]} onSave={onSave} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByText('Save target'));
    const saved = onSave.mock.calls[0][0] as QaTarget;
    expect(saved.allowHosts).toContain('localhost:4061');
    expect(saved.productionAllowed).toBe(false);
    expect(JSON.stringify(saved)).not.toMatch(/password|secret/i);
  });
});

describe('Accept / Reject', () => {
  for (const [action, path] of [['Accept', '/api/qa/repairs/p1/accept'], ['Reject', '/api/qa/repairs/p1/reject']] as const) {
    it(`${action} posts ${path}`, async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        const body = url.includes('/targets') ? [TARGET]
          : url.includes('/repairs?') ? [REPAIR]
          : url.includes('/journeys') ? JOURNEYS
          : url.includes('/repairs/') ? { ok: true } : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      await openTab(qaApi, 'repairs');
      const btn = await screen.findByRole('button', { name: action });
      await act(async () => { fireEvent.click(btn); });
      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([u]) => String(u) === path);
        expect(call, `no ${path}`).toBeTruthy();
        expect((call![1] as RequestInit).method).toBe('POST');
      });
    });
  }
});
