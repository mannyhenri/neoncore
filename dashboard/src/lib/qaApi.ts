/**
 * The QA section's API (docs/plans/qa-section.md). Its own small client rather than a method on
 * @neoncore/client: the QA routes are local to the server that serves this page.
 *
 * In demo mode it goes through the same deny-by-default transport as every other client
 * (lib/demoMode.ts), so pressing Run during a demo never reaches a real server.
 *
 * Every response is normalised: a field the server leaves out becomes its empty value, so a tab
 * renders the record it has instead of crashing on the one it does not.
 */
import { isDemoEnabled, createDemoFetch } from './demoMode';
import type {
  QaTarget, QaTest, QaRun, QaRunDetail, QaFinding, QaRepair, QaJourneys, QaResult, QaRunKind, QaFeature, QaProjectFeatures,
} from '../components/qa/types';

const BASE = '/api/qa';
const transport: typeof fetch = isDemoEnabled() ? createDemoFetch(fetch) : (...args) => fetch(...args);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await transport(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let why = `${res.status}`;
    try { const body = await res.json() as { error?: string }; if (body?.error) why = body.error; } catch { /* not JSON */ }
    throw new Error(why);
  }
  return res.json() as Promise<T>;
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });

/** Tolerates `{targets: [...]}` or a bare list. */
function list<T>(v: unknown, key: string): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>)[key])) return (v as Record<string, T[]>)[key];
  return [];
}

export function normTarget(t: Partial<QaTarget>): QaTarget {
  return {
    id: t.id ?? '', projectId: t.projectId ?? '', name: t.name ?? '', baseUrl: t.baseUrl ?? '',
    allowHosts: arr<string>(t.allowHosts), denyActions: arr<string>(t.denyActions),
    credentialsEnv: t.credentialsEnv && typeof t.credentialsEnv === 'object' ? t.credentialsEnv : {},
    productionAllowed: t.productionAllowed === true,
    budgets: { steps: t.budgets?.steps ?? 60, minutes: t.budgets?.minutes ?? 15 },
    agentId: t.agentId ?? '',
    recorderKey: t.recorderKey,
  };
}

export function normTest(t: Partial<QaTest>): QaTest {
  return {
    id: t.id ?? '', targetId: t.targetId ?? '', name: t.name ?? '', sentences: arr<string>(t.sentences),
    source: t.source === 'explorer' || t.source === 'recorder' ? t.source : 'manual',
    journeySig: t.journeySig, cache: Array.isArray(t.cache) ? t.cache : null, createdAt: t.createdAt,
  };
}

export function normRun(r: Partial<QaRun>): QaRun {
  return {
    id: r.id ?? '', targetId: r.targetId ?? '', kind: r.kind ?? 'run', testIds: arr<string>(r.testIds),
    status: r.status ?? 'queued', aiCalls: Number(r.aiCalls ?? 0) || 0,
    startedAt: r.startedAt, finishedAt: r.finishedAt, summary: r.summary, goal: r.goal,
  };
}

/**
 * A result as the server sends it: `evidence` is the runner's own output (its steps, console,
 * network and trace, with links already served by the server), `repairs` how many repairs it took.
 */
export function normResult(r: Partial<QaResult> & { repairs?: number; evidence?: unknown }): QaResult {
  const ev = (r.evidence ?? {}) as Partial<QaResult['evidence']> & { steps?: QaResult['steps'] };
  const steps = arr<QaResult['steps'][number]>(r.steps ?? ev.steps);
  const shots = arr<string>(ev.screenshots).concat(steps.map((s) => s.screenshot).filter((s): s is string => !!s));
  return {
    runId: r.runId ?? '', testId: r.testId ?? '', testName: r.testName, status: r.status ?? '',
    failedStep: r.failedStep ?? undefined, error: r.error || undefined,
    repaired: r.repaired === true || Number(r.repairs ?? 0) > 0 || r.status === 'passed_with_repair', steps,
    evidence: { screenshots: [...new Set(shots)], trace: ev.trace || undefined, console: arr<string>(ev.console), network: arr(ev.network) },
  };
}

export function normFinding(f: Partial<QaFinding>): QaFinding {
  return {
    id: f.id ?? '', runId: f.runId ?? '', targetId: f.targetId ?? '', signature: f.signature ?? '',
    severity: f.severity ?? 'low', kind: f.kind ?? '', title: f.title ?? '', detail: f.detail ?? '',
    page: f.page ?? '', steps: arr<string>(f.steps), screenshot: f.screenshot, sentences: arr<string>(f.sentences),
    reproTestId: f.reproTestId, status: f.status === 'dismissed' ? 'dismissed' : 'open', seenCount: Number(f.seenCount ?? 1) || 1,
  };
}

export function normRepair(r: Partial<QaRepair>): QaRepair {
  return {
    id: r.id ?? '', runId: r.runId ?? '', testId: r.testId ?? '', testName: r.testName,
    stepIndex: Number(r.stepIndex ?? 0) || 0, sentence: r.sentence ?? '', before: arr(r.before), after: arr(r.after),
    status: r.status ?? 'pending', createdAt: r.createdAt,
  };
}

/** Where a piece of evidence is served. A full URL or absolute path is used as it is. */
export function evidenceUrl(runId: string, file: string): string {
  if (/^(https?:|\/)/.test(file)) return file;
  return `${BASE}/evidence/${encodeURIComponent(runId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export const reportUrl = (runId: string) => `${BASE}/runs/${encodeURIComponent(runId)}/report.html`;

/** What a staging app pastes in to be recorded. */
export const recorderSnippet = (origin: string, targetId: string, key = '') =>
  `<script src="${origin}/qa/recorder.js?target=${encodeURIComponent(targetId)}&key=${encodeURIComponent(key)}" defer></script>`;

export const qaApi = {
  /** QA per project and per feature: criteria passing, and what was on screen. */
  features: async () => arr<QaProjectFeatures>(await request('/features')).map((p) => ({ ...p, features: arr<QaFeature>(p.features).map((f) => ({ ...f, criteria: arr<QaFeature['criteria'][number]>(f.criteria) })) })),
  runFeature: (goalId: string) => request<QaRun>(`/features/${encodeURIComponent(goalId)}/run`, { method: 'POST' }),
  /** The whole epic of this feature, now. */
  runEpic: (goalId: string) => request<QaRun>(`/features/${encodeURIComponent(goalId)}/run-epic`, { method: 'POST' }),
  targets: async () => list<Partial<QaTarget>>(await request('/targets'), 'targets').map(normTarget),
  createTarget: async (t: Omit<QaTarget, 'id'>) => normTarget(await request<Partial<QaTarget>>('/targets', post(t))),
  updateTarget: async (t: QaTarget) => normTarget(await request<Partial<QaTarget>>(`/targets/${encodeURIComponent(t.id)}`, put(t))),

  tests: async (targetId: string) => list<Partial<QaTest>>(await request(`/tests?targetId=${encodeURIComponent(targetId)}`), 'tests').map(normTest),
  createTest: async (t: { targetId: string; name: string; sentences: string[]; source?: QaTest['source'] }) =>
    normTest(await request<Partial<QaTest>>('/tests', post(t))),
  deleteTest: (id: string) => request<{ ok: boolean }>(`/tests/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  startRun: async (body: { targetId: string; kind: QaRunKind; testIds?: string[]; goal?: string; budgets?: { steps: number; minutes: number } }) =>
    normRun(await request<Partial<QaRun>>('/runs', post(body))),
  runs: async (targetId: string) => list<Partial<QaRun>>(await request(`/runs?targetId=${encodeURIComponent(targetId)}`), 'runs').map(normRun),
  run: async (id: string): Promise<QaRunDetail> => {
    const r = await request<Partial<QaRunDetail>>(`/runs/${encodeURIComponent(id)}`);
    return {
      ...normRun(r), results: arr<Partial<QaResult>>(r.results).map(normResult),
      repairs: arr<Partial<QaRepair>>(r.repairs).map(normRepair), findings: arr<Partial<QaFinding>>(r.findings).map(normFinding),
    };
  },

  findings: async (targetId: string) => list<Partial<QaFinding>>(await request(`/findings?targetId=${encodeURIComponent(targetId)}`), 'findings').map(normFinding),
  setFindingStatus: (id: string, status: QaFinding['status']) => request<unknown>(`/findings/${encodeURIComponent(id)}`, put({ status })),

  repairs: async (status: QaRepair['status'] = 'pending') => list<Partial<QaRepair>>(await request(`/repairs?status=${status}`), 'repairs').map(normRepair),
  acceptRepair: (id: string) => request<unknown>(`/repairs/${encodeURIComponent(id)}/accept`, { method: 'POST' }),
  rejectRepair: (id: string) => request<unknown>(`/repairs/${encodeURIComponent(id)}/reject`, { method: 'POST' }),

  journeys: async (targetId: string): Promise<QaJourneys> => {
    // The server sends {journeys:[{sig, steps, count, testId}], covered, total}.
    const j = await request<Partial<QaJourneys> & { covered?: number; total?: number }>(`/journeys?targetId=${encodeURIComponent(targetId)}`);
    const journeys = arr<QaJourneys['journeys'][number]>(j.journeys).map((x) => ({ ...x, covered: x.covered ?? !!x.testId }));
    return {
      journeys,
      coverage: j.coverage ?? { covered: j.covered ?? journeys.filter((x) => x.covered).length, total: j.total ?? journeys.length },
      sessions: Number(j.sessions ?? 0) || 0,
    };
  },
};

export type QaApi = typeof qaApi;
