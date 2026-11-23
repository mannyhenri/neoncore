/**
 * BUG TRIAGE — storage: sources (a Jira site + its projects + where their code lives), issues (one
 * state machine each), the audit log, and the global switches (pause, daily cap).
 */
import { randomUUID } from 'crypto';
import db from '../../db.js';
import { getIO } from '../../ws.js';
import {
  DEFAULT_LIMITS, DEFAULT_PROTECTED_PATHS, ISSUE_STATES, STAGES, TriageError,
  type IssueState, type Stage, type TriageIssue, type TriageLimits, type TriageSource,
} from './types.js';

export const nowIso = () => new Date().toISOString();
const json = <T>(s: unknown, fallback: T): T => { try { return s ? JSON.parse(String(s)) as T : fallback; } catch { return fallback; } };
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

// ── sources ───────────────────────────────────────────────────────────────────────────────

function toSource(r: Record<string, unknown>): TriageSource {
  return {
    id: String(r.id), name: String(r.name), jiraBaseUrl: String(r.jira_base_url ?? ''),
    authEnv: { email: '', token: '', ...json(r.auth_env, {}) },
    projects: json(r.projects, []), issueTypes: json(r.issue_types, ['Bug']), repoFor: json(r.repo_for, {}),
    reporters: r.reporters === 'external' ? 'external' : 'internal', transitions: Number(r.transitions) === 1,
    transitionNames: json(r.transition_names, {}), protectedPaths: json(r.protected_paths, DEFAULT_PROTECTED_PATHS),
    limits: { ...DEFAULT_LIMITS, ...json<Partial<TriageLimits>>(r.limits, {}) }, testCommand: String(r.test_command ?? 'npm test'),
    pollSeconds: Number(r.poll_seconds ?? 60), webhookSecretEnv: String(r.webhook_secret_env ?? ''),
    triageAgentId: String(r.triage_agent_id ?? ''), codeAgentType: String(r.code_agent_type ?? 'claude'),
    createIssues: Number(r.create_issues) === 1, enabled: Number(r.enabled ?? 1) === 1,
    lastPolledAt: (r.last_polled_at as string | null) ?? null, serviceAccountId: String(r.service_account_id ?? ''),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function normaliseSource(body: Record<string, unknown>, prev?: TriageSource): Omit<TriageSource, 'id' | 'createdAt' | 'updatedAt' | 'lastPolledAt' | 'serviceAccountId'> {
  const pick = (k: keyof TriageSource, f: unknown): unknown => (body[k] !== undefined ? body[k] : prev ? prev[k] : f);
  const name = String(pick('name', '') ?? '').trim();
  if (!name) throw new TriageError('a source needs a name');
  const jiraBaseUrl = String(pick('jiraBaseUrl', '') ?? '').trim().replace(/\/+$/, '');
  if (jiraBaseUrl) { try { const u = new URL(jiraBaseUrl); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { throw new TriageError(`"${jiraBaseUrl}" is not an http(s) URL`); } }
  const authIn = (pick('authEnv', {}) ?? {}) as Record<string, unknown>;
  const authEnv = { email: String(authIn.email ?? '').trim(), token: String(authIn.token ?? '').trim() };
  for (const n of [authEnv.email, authEnv.token]) if (n && !ENV_NAME.test(n)) throw new TriageError('authEnv must name ENVIRONMENT VARIABLES (like JIRA_EMAIL), never the values');
  const webhookSecretEnv = String(pick('webhookSecretEnv', '') ?? '').trim();
  if (webhookSecretEnv && !ENV_NAME.test(webhookSecretEnv)) throw new TriageError('webhookSecretEnv must name an ENVIRONMENT VARIABLE');
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const repoIn = (pick('repoFor', {}) ?? {}) as Record<string, unknown>;
  const repoFor: Record<string, string> = {};
  for (const [k, v] of Object.entries(repoIn)) if (String(v ?? '').trim()) repoFor[k.trim().toUpperCase()] = String(v).trim();
  const lim = { ...DEFAULT_LIMITS, ...((pick('limits', {}) ?? {}) as Partial<TriageLimits>) };
  const limits: TriageLimits = {
    maxFiles: Math.max(1, Number(lim.maxFiles) || DEFAULT_LIMITS.maxFiles),
    maxLines: Math.max(1, Number(lim.maxLines) || DEFAULT_LIMITS.maxLines),
    minutesPerIssue: Math.max(1, Number(lim.minutesPerIssue) || DEFAULT_LIMITS.minutesPerIssue),
    dispatchesPerIssue: Math.max(1, Number(lim.dispatchesPerIssue) || DEFAULT_LIMITS.dispatchesPerIssue),
    reviewRounds: Math.max(0, Number(lim.reviewRounds ?? DEFAULT_LIMITS.reviewRounds)),
  };
  return {
    name, jiraBaseUrl, authEnv,
    projects: list(pick('projects', [])).map((p) => p.toUpperCase()), issueTypes: list(pick('issueTypes', ['Bug'])),
    repoFor, reporters: pick('reporters', 'internal') === 'external' ? 'external' : 'internal',
    transitions: pick('transitions', false) === true,
    transitionNames: (pick('transitionNames', {}) ?? {}) as TriageSource['transitionNames'],
    protectedPaths: body.protectedPaths !== undefined ? list(body.protectedPaths) : prev ? prev.protectedPaths : DEFAULT_PROTECTED_PATHS,
    limits, testCommand: String(pick('testCommand', 'npm test') ?? 'npm test').trim() || 'npm test',
    pollSeconds: Math.min(3600, Math.max(15, Number(pick('pollSeconds', 60)) || 60)), webhookSecretEnv,
    triageAgentId: String(pick('triageAgentId', '') ?? ''), codeAgentType: String(pick('codeAgentType', 'claude') ?? 'claude') || 'claude',
    createIssues: pick('createIssues', false) === true, enabled: pick('enabled', true) !== false,
  };
}

export function listSources(): TriageSource[] {
  return (db.prepare('SELECT * FROM triage_sources ORDER BY created_at').all() as Record<string, unknown>[]).map(toSource);
}
export function getSource(id: string): TriageSource | null {
  const r = db.prepare('SELECT * FROM triage_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toSource(r) : null;
}
export function createSource(body: Record<string, unknown>): TriageSource {
  const s = normaliseSource(body);
  const id = randomUUID(); const now = nowIso();
  db.prepare(`INSERT INTO triage_sources (id, name, jira_base_url, auth_env, projects, issue_types, repo_for, reporters, transitions, transition_names,
      protected_paths, limits, test_command, poll_seconds, webhook_secret_env, triage_agent_id, code_agent_type, create_issues, enabled, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, s.name, s.jiraBaseUrl, JSON.stringify(s.authEnv), JSON.stringify(s.projects), JSON.stringify(s.issueTypes), JSON.stringify(s.repoFor),
    s.reporters, s.transitions ? 1 : 0, JSON.stringify(s.transitionNames), JSON.stringify(s.protectedPaths), JSON.stringify(s.limits), s.testCommand,
    s.pollSeconds, s.webhookSecretEnv, s.triageAgentId, s.codeAgentType, s.createIssues ? 1 : 0, s.enabled ? 1 : 0, now, now);
  return getSource(id)!;
}
export function updateSource(id: string, body: Record<string, unknown>): TriageSource {
  const prev = getSource(id);
  if (!prev) throw new TriageError('source not found', 404);
  const s = normaliseSource(body, prev);
  db.prepare(`UPDATE triage_sources SET name=?, jira_base_url=?, auth_env=?, projects=?, issue_types=?, repo_for=?, reporters=?, transitions=?, transition_names=?,
      protected_paths=?, limits=?, test_command=?, poll_seconds=?, webhook_secret_env=?, triage_agent_id=?, code_agent_type=?, create_issues=?, enabled=?, updated_at=? WHERE id=?`).run(
    s.name, s.jiraBaseUrl, JSON.stringify(s.authEnv), JSON.stringify(s.projects), JSON.stringify(s.issueTypes), JSON.stringify(s.repoFor),
    s.reporters, s.transitions ? 1 : 0, JSON.stringify(s.transitionNames), JSON.stringify(s.protectedPaths), JSON.stringify(s.limits), s.testCommand,
    s.pollSeconds, s.webhookSecretEnv, s.triageAgentId, s.codeAgentType, s.createIssues ? 1 : 0, s.enabled ? 1 : 0, nowIso(), id);
  return getSource(id)!;
}
export function deleteSource(id: string): void {
  if (!getSource(id)) throw new TriageError('source not found', 404);
  db.prepare('DELETE FROM triage_sources WHERE id = ?').run(id);
}
export function markPolled(id: string, at: string, serviceAccountId?: string): void {
  db.prepare('UPDATE triage_sources SET last_polled_at = ?, service_account_id = COALESCE(?, service_account_id) WHERE id = ?').run(at, serviceAccountId ?? null, id);
}

// ── issues ────────────────────────────────────────────────────────────────────────────────

function toIssue(r: Record<string, unknown>): TriageIssue {
  return {
    id: String(r.id), sourceId: String(r.source_id), origin: r.origin === 'qa' ? 'qa' : 'jira', issueKey: String(r.issue_key),
    projectKey: String(r.project_key ?? ''), summary: String(r.summary ?? ''), description: String(r.description ?? ''),
    reporterId: String(r.reporter_id ?? ''), reporterName: String(r.reporter_name ?? ''), jiraCreatedAt: (r.jira_created_at as string | null) ?? null,
    stage: String(r.stage) as Stage, state: String(r.state) as IssueState, outcome: String(r.outcome ?? ''),
    repoPath: String(r.repo_path ?? ''), worktreePath: String(r.worktree_path ?? ''), branch: String(r.branch ?? ''), baseBranch: String(r.base_branch ?? ''),
    repro: json(r.repro, {}), findings: json(r.findings, {}),
    prUrl: String(r.pr_url ?? ''), prMergeCommit: String(r.pr_merge_commit ?? ''), reviewRounds: Number(r.review_rounds ?? 0),
    heldMessage: String(r.held_message ?? ''), questionsAt: (r.questions_at as string | null) ?? null, reopened: Number(r.reopened) === 1,
    firstCommentAt: (r.first_comment_at as string | null) ?? null, fixedAt: (r.fixed_at as string | null) ?? null, releasedAt: (r.released_at as string | null) ?? null,
    startedAt: (r.started_at as string | null) ?? null, dispatches: Number(r.dispatches ?? 0), agentMinutes: Number(r.agent_minutes ?? 0),
    lastCheckedAt: (r.last_checked_at as string | null) ?? null, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function getIssue(id: string): TriageIssue | null {
  const r = db.prepare('SELECT * FROM triage_issues WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toIssue(r) : null;
}
export function findIssue(sourceId: string, key: string): TriageIssue | null {
  const r = db.prepare('SELECT * FROM triage_issues WHERE source_id = ? AND issue_key = ?').get(sourceId, key) as Record<string, unknown> | undefined;
  return r ? toIssue(r) : null;
}
export function listIssues(filter: { sourceId?: string; state?: string } = {}): TriageIssue[] {
  const where: string[] = []; const args: string[] = [];
  if (filter.sourceId) { where.push('source_id = ?'); args.push(filter.sourceId); }
  if (filter.state) { where.push('state = ?'); args.push(filter.state); }
  return (db.prepare(`SELECT * FROM triage_issues ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`).all(...args) as Record<string, unknown>[]).map(toIssue);
}

export function createIssue(input: {
  sourceId: string; origin?: 'jira' | 'qa'; issueKey: string; projectKey: string; summary: string; description: string;
  reporterId: string; reporterName: string; jiraCreatedAt?: string | null;
}): TriageIssue {
  const id = randomUUID(); const now = nowIso();
  db.prepare(`INSERT INTO triage_issues (id, source_id, origin, issue_key, project_key, summary, description, reporter_id, reporter_name, jira_created_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.sourceId, input.origin ?? 'jira', input.issueKey, input.projectKey, input.summary.slice(0, 500),
    input.description.slice(0, 20000), input.reporterId, input.reporterName, input.jiraCreatedAt ?? null, now, now);
  const issue = getIssue(id)!;
  emitIssue(issue);
  return issue;
}

const COLUMN: Record<string, string> = {
  stage: 'stage', state: 'state', outcome: 'outcome', repoPath: 'repo_path', worktreePath: 'worktree_path', branch: 'branch', baseBranch: 'base_branch',
  prUrl: 'pr_url', prMergeCommit: 'pr_merge_commit', reviewRounds: 'review_rounds', heldMessage: 'held_message', questionsAt: 'questions_at',
  firstCommentAt: 'first_comment_at', fixedAt: 'fixed_at', releasedAt: 'released_at', startedAt: 'started_at', dispatches: 'dispatches',
  agentMinutes: 'agent_minutes', lastCheckedAt: 'last_checked_at', description: 'description', summary: 'summary',
};
export function updateIssue(id: string, patch: Partial<TriageIssue>): TriageIssue {
  const sets: string[] = []; const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'reopened') { sets.push('reopened = ?'); args.push(v ? 1 : 0); continue; }
    if (k === 'repro' || k === 'findings') { sets.push(`${k} = ?`); args.push(JSON.stringify(v ?? {})); continue; }
    const col = COLUMN[k];
    if (col) { sets.push(`${col} = ?`); args.push(v ?? null); }
  }
  if (patch.stage && !(STAGES as readonly string[]).includes(patch.stage)) throw new Error(`unknown stage ${patch.stage}`);
  if (patch.state && !(ISSUE_STATES as readonly string[]).includes(patch.state)) throw new Error(`unknown state ${patch.state}`);
  sets.push('updated_at = ?'); args.push(nowIso());
  db.prepare(`UPDATE triage_issues SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  const issue = getIssue(id)!;
  emitIssue(issue);
  return issue;
}

/** Merge what a stage learned into the issue's findings (the hand-over carries all of it). */
export function addFindings(id: string, stage: string, data: unknown): void {
  const issue = getIssue(id);
  if (!issue) return;
  updateIssue(id, { findings: { ...issue.findings, [stage]: data } });
}

function emitIssue(issue: TriageIssue): void {
  try { getIO().emit('triage_issue_updated', issue); } catch { /* no socket server in some tests */ }
}

// ── the audit log ─────────────────────────────────────────────────────────────────────────

export const EVENT_KINDS = ['stage', 'decision', 'dispatch', 'submission', 'check', 'message', 'label', 'transition', 'pr', 'error', 'budget', 'human'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export interface TriageEvent { id: string; issueId: string; at: string; kind: EventKind; stage: string; summary: string; detail: unknown; costMinutes: number }

export function logEvent(issueId: string, kind: EventKind, summary: string, detail: unknown = {}, opts: { stage?: string; costMinutes?: number } = {}): TriageEvent {
  const issue = getIssue(issueId);
  const ev: TriageEvent = { id: randomUUID(), issueId, at: nowIso(), kind, stage: opts.stage ?? issue?.stage ?? '', summary, detail, costMinutes: opts.costMinutes ?? 0 };
  db.prepare('INSERT INTO triage_events (id, issue_id, at, kind, stage, summary, detail, cost_minutes) VALUES (?,?,?,?,?,?,?,?)')
    .run(ev.id, issueId, ev.at, kind, ev.stage, summary.slice(0, 2000), JSON.stringify(detail ?? {}), ev.costMinutes);
  try { getIO().emit('triage_event_added', ev); } catch { /* no socket server */ }
  return ev;
}
export function eventsOf(issueId: string): TriageEvent[] {
  return (db.prepare('SELECT * FROM triage_events WHERE issue_id = ? ORDER BY at, rowid').all(issueId) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), issueId: String(r.issue_id), at: String(r.at), kind: String(r.kind) as EventKind, stage: String(r.stage ?? ''),
    summary: String(r.summary), detail: json(r.detail, {}), costMinutes: Number(r.cost_minutes ?? 0),
  }));
}

// ── the switches ──────────────────────────────────────────────────────────────────────────

export interface TriageSettings { paused: boolean; dailyDispatchCap: number; updatedAt: string }
export function getSettings(): TriageSettings {
  const r = db.prepare('SELECT * FROM triage_settings WHERE id = 1').get() as Record<string, unknown> | undefined;
  return { paused: Number(r?.paused) === 1, dailyDispatchCap: Number(r?.daily_dispatch_cap ?? 100), updatedAt: String(r?.updated_at ?? '') };
}
export function updateSettings(body: Record<string, unknown>): TriageSettings {
  const cur = getSettings();
  const paused = body.paused !== undefined ? body.paused === true : cur.paused;
  const cap = body.dailyDispatchCap !== undefined ? Math.max(0, Math.floor(Number(body.dailyDispatchCap) || 0)) : cur.dailyDispatchCap;
  db.prepare('INSERT OR REPLACE INTO triage_settings (id, paused, daily_dispatch_cap, updated_at) VALUES (1, ?, ?, ?)').run(paused ? 1 : 0, cap, nowIso());
  return getSettings();
}
