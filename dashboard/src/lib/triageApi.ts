/**
 * The Triage section's API (docs/plans/bug-triage.md). Its own small client, like lib/qaApi.ts:
 * the triage routes are local to the server that serves this page.
 *
 * In demo mode it goes through the same deny-by-default transport as every other client
 * (lib/demoMode.ts), so pressing Retry during a demo never reaches a real server.
 *
 * Every response is normalised: a field the server leaves out becomes its empty value, so a tab
 * renders the record it has instead of crashing on the one it does not.
 */
import { isDemoEnabled, createDemoFetch } from './demoMode';
import type {
  TriageEvent, TriageIssue, TriageIssueDetail, TriageIssueState, TriageMetrics, TriageRequest,
  TriageSettings, TriageSource, TriageStage, TriageEventKind,
} from '../components/triage/types';
import { TRIAGE_EVENT_KINDS, TRIAGE_ISSUE_STATES } from '../components/triage/types';

const BASE = '/api/triage';
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
const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const share = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const post = (body?: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) });
const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });

/** Tolerates `{issues: [...]}` or a bare list. */
function list<T>(v: unknown, key: string): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>)[key])) return (v as Record<string, T[]>)[key];
  return [];
}

export const DEFAULT_LIMITS = { maxFiles: 5, maxLines: 200, minutesPerIssue: 30, dispatchesPerIssue: 8, reviewRounds: 2 };
/** The scope's protected areas: authentication, payments, migrations, CI configuration. */
export const DEFAULT_PROTECTED_PATHS = ['**/auth/**', '**/payment*/**', '**/migrations/**', '.github/workflows/**', '.gitlab-ci.yml', '.circleci/**'];

export function normSource(s: Partial<TriageSource>): TriageSource {
  const auth = (s.authEnv ?? {}) as Partial<TriageSource['authEnv']>;
  const repoFor = s.repoFor && typeof s.repoFor === 'object' ? Object.fromEntries(Object.entries(s.repoFor).map(([k, v]) => [k, str(v)])) : {};
  const l = (s.limits ?? {}) as Partial<TriageSource['limits']>;
  return {
    id: str(s.id), name: str(s.name), jiraBaseUrl: str(s.jiraBaseUrl),
    authEnv: { email: str(auth.email), token: str(auth.token) },
    projects: arr<string>(s.projects).map(str), issueTypes: s.issueTypes && s.issueTypes.length ? arr<string>(s.issueTypes).map(str) : ['Bug'],
    repoFor,
    reporters: s.reporters === 'external' ? 'external' : 'internal',
    transitions: s.transitions === true,
    protectedPaths: Array.isArray(s.protectedPaths) ? s.protectedPaths.map(str) : [...DEFAULT_PROTECTED_PATHS],
    limits: {
      maxFiles: num(l.maxFiles, DEFAULT_LIMITS.maxFiles), maxLines: num(l.maxLines, DEFAULT_LIMITS.maxLines),
      minutesPerIssue: num(l.minutesPerIssue, DEFAULT_LIMITS.minutesPerIssue),
      dispatchesPerIssue: num(l.dispatchesPerIssue, DEFAULT_LIMITS.dispatchesPerIssue),
      reviewRounds: num(l.reviewRounds, DEFAULT_LIMITS.reviewRounds),
    },
    pollSeconds: num(s.pollSeconds, 60) || 60,
    webhookSecretEnv: str(s.webhookSecretEnv),
    triageAgentId: str(s.triageAgentId),
    codeAgentType: str(s.codeAgentType) || 'claude',
  };
}

const STAGES: readonly TriageStage[] = ['intake', 'triage', 'code_check', 'reproduce', 'fix', 'pull_request', 'follow_up', 'done'];

export function normIssue(i: Partial<TriageIssue> & Record<string, unknown>): TriageIssue {
  const stage = STAGES.includes(i.stage as TriageStage) ? (i.stage as TriageStage) : 'intake';
  const state = TRIAGE_ISSUE_STATES.includes(i.state as TriageIssueState) ? (i.state as TriageIssueState) : 'queued';
  return {
    // The server's names (server/src/lib/triage/types.ts): issueKey, reporterName, jiraCreatedAt, firstCommentAt.
    id: str(i.id), sourceId: str(i.sourceId), jiraKey: str(i.jiraKey ?? i.issueKey), jiraUrl: str(i.jiraUrl),
    summary: str(i.summary), reporter: str(i.reporter ?? i.reporterName), stage, state, outcome: str(i.outcome),
    labels: arr<string>(i.labels).map(str), prUrl: str(i.prUrl),
    reportedAt: str(i.reportedAt ?? i.jiraCreatedAt ?? i.createdAt), updatedAt: str(i.updatedAt),
    firstResponseAt: str(i.firstResponseAt ?? i.firstCommentAt),
    agentMinutes: num(i.agentMinutes), dispatches: num(i.dispatches),
  };
}

/** The server's audit kinds (server/src/lib/triage/store.ts EVENT_KINDS) → the timeline's. */
const SERVER_KIND: Record<string, TriageEventKind> = {
  submission: 'dispatch', check: 'verify', budget: 'guardrail', human: 'decision', label: 'note', transition: 'note', pr: 'note',
};
/** A server event's `detail` is an object: the message's lines, or the facts of a check. */
function detailText(d: unknown): string {
  if (typeof d === 'string') return d;
  if (!d || typeof d !== 'object') return '';
  const o = d as Record<string, unknown>;
  if (Array.isArray(o.lines)) return o.lines.map(String).join('\n');
  const rest = Object.entries(o).filter(([k]) => k !== 'moment' && k !== 'ok' && k !== 'passed');
  return rest.length ? JSON.stringify(Object.fromEntries(rest), null, 2) : '';
}
export function normEvent(e: Partial<TriageEvent> & Record<string, unknown>): TriageEvent {
  const raw = str(e.kind);
  const kind = TRIAGE_EVENT_KINDS.includes(raw as TriageEventKind) ? (raw as TriageEventKind) : SERVER_KIND[raw] ?? 'note';
  const d = (e.detail && typeof e.detail === 'object' ? e.detail : {}) as Record<string, unknown>;
  const refused = raw === 'check' && /refus|guardrail|protected|too large|test integrity/i.test(str(e.summary ?? e.title));
  const ok = typeof e.ok === 'boolean' ? e.ok : typeof d.ok === 'boolean' ? d.ok : typeof d.passed === 'boolean' ? d.passed : undefined;
  return {
    id: str(e.id), issueId: str(e.issueId), at: str(e.at ?? e.createdAt), stage: (STAGES.includes(e.stage as TriageStage) ? e.stage : '') as TriageEvent['stage'],
    kind: refused ? 'guardrail' : kind, title: str(e.title ?? e.summary), reason: str(e.reason), detail: detailText(e.detail),
    ok, template: str(e.template ?? d.moment), agentMinutes: num(e.agentMinutes ?? e.costMinutes),
  };
}

function normRequest(r: Partial<TriageRequest>): TriageRequest {
  return {
    id: str(r.id), kind: str(r.kind), status: str(r.status), agentId: str(r.agentId),
    createdAt: str(r.createdAt), completedAt: str(r.completedAt), error: str(r.error),
  };
}

export function normSettings(s: Partial<TriageSettings> | null | undefined): TriageSettings {
  return { paused: s?.paused === true, dailyDispatchCap: num(s?.dailyDispatchCap, 0), dispatchesToday: num(s?.dispatchesToday, 0) };
}

export function normMetrics(m: Partial<TriageMetrics> | null | undefined): TriageMetrics {
  const raw = (m ?? {}) as Record<string, unknown> & { triagedWithoutHumans?: number | null; minutesToFirstResponse?: number | null; minutesToRelease?: number | null };
  return {
    // The server's names (server/src/lib/triage/metrics.ts): triagedWithoutHumans, minutesToFirstResponse, minutesToRelease.
    issues: num(m?.issues), triagedNoHuman: share(m?.triagedNoHuman ?? raw.triagedWithoutHumans), prsOpened: num(m?.prsOpened),
    mergedWithoutRework: share(m?.mergedWithoutRework), falseNotABug: share(m?.falseNotABug),
    firstResponseMinutes: share(m?.firstResponseMinutes ?? raw.minutesToFirstResponse),
    fixReleasedHours: m?.fixReleasedHours !== undefined ? share(m.fixReleasedHours) : typeof raw.minutesToRelease === 'number' ? raw.minutesToRelease / 60 : null,
    agentMinutesPerIssue: share(m?.agentMinutesPerIssue),
  };
}

/** Where Jira posts its events for this source (a public deployment; locally the server polls). */
export const webhookUrl = (origin: string, sourceId: string) => `${origin}${BASE}/webhook/${encodeURIComponent(sourceId)}`;

export const triageApi = {
  sources: async () => list<Partial<TriageSource>>(await request('/sources'), 'sources').map(normSource),
  createSource: async (s: Omit<TriageSource, 'id'>) => normSource(await request<Partial<TriageSource>>('/sources', post(s))),
  updateSource: async (s: TriageSource) => normSource(await request<Partial<TriageSource>>(`/sources/${encodeURIComponent(s.id)}`, put(s))),
  pollSource: (id: string) => request<unknown>(`/sources/${encodeURIComponent(id)}/poll`, post()),

  issues: async (sourceId: string) =>
    list<Partial<TriageIssue> & Record<string, unknown>>(await request(`/issues?sourceId=${encodeURIComponent(sourceId)}`), 'issues').map(normIssue),
  issue: async (id: string): Promise<TriageIssueDetail> => {
    const r = await request<Partial<TriageIssueDetail> & Record<string, unknown>>(`/issues/${encodeURIComponent(id)}`);
    const issue = (r.issue && typeof r.issue === 'object' ? r.issue : r) as Partial<TriageIssue> & Record<string, unknown>;
    return {
      ...normIssue(issue),
      events: arr<Partial<TriageEvent> & Record<string, unknown>>(r.events).map(normEvent).sort((a, b) => a.at.localeCompare(b.at)),
      requests: arr<Partial<TriageRequest>>(r.requests).map(normRequest),
    };
  },
  retry: (id: string) => request<unknown>(`/issues/${encodeURIComponent(id)}/retry`, post()),
  handover: (id: string) => request<unknown>(`/issues/${encodeURIComponent(id)}/handover`, post()),
  reopen: (id: string) => request<unknown>(`/issues/${encodeURIComponent(id)}/reopen`, post()),

  settings: async () => normSettings(await request<Partial<TriageSettings>>('/settings')),
  updateSettings: async (s: Partial<TriageSettings>) => normSettings(await request<Partial<TriageSettings>>('/settings', put(s))),

  metrics: async (sourceId: string) => normMetrics(await request<Partial<TriageMetrics>>(`/metrics?sourceId=${encodeURIComponent(sourceId)}`)),
};

export type TriageApi = typeof triageApi;
