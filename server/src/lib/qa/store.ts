/**
 * QA records: targets (apps under test), tests, runs and what they produced.
 *
 * A TARGET carries its guardrails (scope §5): the hosts it may touch, the destructive actions it
 * must not take, the ENV NAMES its credentials live in (values never stored or shown), and budgets.
 * Production is blocked: unless `productionAllowed`, the base URL's own host must be on the
 * allow-list, so a target can never point a run at a host nobody listed.
 */
import { randomBytes, randomUUID } from 'crypto';
import db from '../../db.js';
import { getIO } from '../../ws.js';
import { parseCache } from './actions.js';
import { DEFAULT_DENY, QaError, type QaAction, type RunKind, type RunStatus, type ResultStatus } from './types.js';

const nowIso = () => new Date().toISOString();
const json = <T>(s: unknown, fallback: T): T => { try { return s ? JSON.parse(String(s)) as T : fallback; } catch { return fallback; } };

// ── targets ─────────────────────────────────────────────────────────────────────────────

export interface QaTarget {
  id: string; projectId: string; name: string; baseUrl: string;
  allowHosts: string[]; denyActions: string[];
  credentialsEnv: Record<string, { user: string; pass: string }>;
  productionAllowed: boolean; budgets: { steps: number; minutes: number }; agentId: string;
  /** Accepted by the public recorder intake for this target only — never the fleet token. */
  recorderKey: string;
  createdAt: string; updatedAt: string;
}

export const DEFAULT_BUDGETS = { steps: 200, minutes: 15 };
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function toTarget(r: Record<string, unknown>): QaTarget {
  return {
    id: String(r.id), projectId: String(r.project_id ?? ''), name: String(r.name), baseUrl: String(r.base_url),
    allowHosts: json(r.allow_hosts, []), denyActions: json(r.deny_actions, []),
    credentialsEnv: json(r.credentials_env, {}), productionAllowed: Number(r.production_allowed) === 1,
    budgets: { ...DEFAULT_BUDGETS, ...json(r.budgets, {}) }, agentId: String(r.agent_id ?? ''),
    recorderKey: String(r.recorder_key ?? ''),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

/** The host of a URL, or a QaError. Only http(s). */
export function hostOf(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new QaError(`"${url}" is not a URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new QaError('the base URL must be http or https');
  return u.host.toLowerCase();
}

/** Is `host` (host[:port]) covered by an allow-list entry? An entry without a port allows every port. */
export function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  const bare = h.replace(/:\d+$/, '');
  return allowHosts.some((e) => { const x = e.trim().toLowerCase(); return x === h || (!x.includes(':') && x === bare); });
}

function normaliseTargetInput(body: Record<string, unknown>, prev?: QaTarget): Omit<QaTarget, 'id' | 'recorderKey' | 'createdAt' | 'updatedAt'> {
  const pick = <K extends keyof QaTarget>(k: K, fallback: QaTarget[K]): unknown => (body[k] !== undefined ? body[k] : prev ? prev[k] : fallback);
  const name = String(pick('name', '') ?? '').trim();
  if (!name) throw new QaError('a target needs a name');
  const baseUrl = String(pick('baseUrl', '') ?? '').trim().replace(/\/+$/, '');
  const host = hostOf(baseUrl);
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const allowHosts = list(pick('allowHosts', []));
  if (allowHosts.length === 0) allowHosts.push(host);
  const productionAllowed = pick('productionAllowed', false) === true;
  if (!productionAllowed && !hostAllowed(host, allowHosts)) {
    throw new QaError(`the base URL's host ${host} is not on the allow-list (${allowHosts.join(', ')}) — add it, or the run would touch a host nobody listed`);
  }
  const deny = list(pick('denyActions', DEFAULT_DENY));
  const creds = pick('credentialsEnv', {}) as Record<string, { user?: string; pass?: string }>;
  const credentialsEnv: QaTarget['credentialsEnv'] = {};
  for (const [role, c] of Object.entries(creds && typeof creds === 'object' ? creds : {})) {
    const user = String(c?.user ?? '').trim(); const pass = String(c?.pass ?? '').trim();
    for (const n of [user, pass]) if (!ENV_NAME.test(n)) throw new QaError(`credentials for "${role}" must name ENVIRONMENT VARIABLES (like QA_USER), not values`);
    credentialsEnv[role] = { user, pass };
  }
  const b = (pick('budgets', DEFAULT_BUDGETS) ?? {}) as Partial<QaTarget['budgets']>;
  const budgets = {
    steps: Math.min(2000, Math.max(1, Number(b.steps) || DEFAULT_BUDGETS.steps)),
    minutes: Math.min(240, Math.max(1, Number(b.minutes) || DEFAULT_BUDGETS.minutes)),
  };
  return {
    projectId: String(pick('projectId', '') ?? ''), name, baseUrl, allowHosts, denyActions: deny.length ? deny : [...DEFAULT_DENY],
    credentialsEnv, productionAllowed, budgets, agentId: String(pick('agentId', '') ?? ''),
  };
}

export function listTargets(): QaTarget[] {
  return (db.prepare('SELECT * FROM qa_targets ORDER BY created_at').all() as Record<string, unknown>[]).map(toTarget);
}
export function getTarget(id: string): QaTarget | null {
  const r = db.prepare('SELECT * FROM qa_targets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toTarget(r) : null;
}
export function createTarget(body: Record<string, unknown>): QaTarget {
  const t = normaliseTargetInput(body);
  const id = randomUUID(); const now = nowIso();
  db.prepare(`INSERT INTO qa_targets (id, project_id, name, base_url, allow_hosts, deny_actions, credentials_env, production_allowed, budgets, agent_id, recorder_key, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, t.projectId, t.name, t.baseUrl, JSON.stringify(t.allowHosts), JSON.stringify(t.denyActions), JSON.stringify(t.credentialsEnv),
      t.productionAllowed ? 1 : 0, JSON.stringify(t.budgets), t.agentId, randomBytes(24).toString('hex'), now, now);
  return getTarget(id)!;
}
export function updateTarget(id: string, body: Record<string, unknown>): QaTarget {
  const prev = getTarget(id);
  if (!prev) throw new QaError('target not found', 404);
  const t = normaliseTargetInput(body, prev);
  db.prepare(`UPDATE qa_targets SET project_id=?, name=?, base_url=?, allow_hosts=?, deny_actions=?, credentials_env=?, production_allowed=?, budgets=?, agent_id=?, updated_at=? WHERE id=?`)
    .run(t.projectId, t.name, t.baseUrl, JSON.stringify(t.allowHosts), JSON.stringify(t.denyActions), JSON.stringify(t.credentialsEnv),
      t.productionAllowed ? 1 : 0, JSON.stringify(t.budgets), t.agentId, nowIso(), id);
  return getTarget(id)!;
}
export function deleteTarget(id: string): void {
  if (!getTarget(id)) throw new QaError('target not found', 404);
  const tx = db.transaction(() => {
    const runs = (db.prepare('SELECT id FROM qa_runs WHERE target_id = ?').all(id) as { id: string }[]).map((r) => r.id);
    for (const r of runs) {
      db.prepare('DELETE FROM qa_results WHERE run_id = ?').run(r);
      db.prepare('DELETE FROM qa_repairs WHERE run_id = ?').run(r);
      db.prepare('DELETE FROM qa_requests WHERE run_id = ?').run(r);
    }
    for (const t of ['qa_runs', 'qa_tests', 'qa_findings', 'qa_sessions']) db.prepare(`DELETE FROM ${t} WHERE target_id = ?`).run(id);
    db.prepare('DELETE FROM qa_targets WHERE id = ?').run(id);
  });
  tx();
}

// ── tests ───────────────────────────────────────────────────────────────────────────────

export interface QaTest {
  id: string; targetId: string; name: string; sentences: string[]; cache: QaAction[][] | null;
  source: 'manual' | 'explorer' | 'recorder' | 'feature'; journeySig: string; findingId: string; needsAttention: boolean;
  createdAt: string; updatedAt: string;
}

function toTest(r: Record<string, unknown>): QaTest {
  return {
    id: String(r.id), targetId: String(r.target_id), name: String(r.name), sentences: json(r.sentences, []),
    cache: r.cache ? json<QaAction[][] | null>(r.cache, null) : null, source: String(r.source) as QaTest['source'],
    journeySig: String(r.journey_sig ?? ''), findingId: String(r.finding_id ?? ''), needsAttention: Number(r.needs_attention) === 1,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

/** Sentences from an array, or from text with one sentence per line (numbering stripped). */
export function parseSentences(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/\n+/) : [];
  const out = raw.map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  if (out.length === 0) throw new QaError('a test needs at least one sentence');
  if (out.length > 50) throw new QaError('a test has at most 50 sentences');
  return out;
}

export function listTests(targetId?: string): QaTest[] {
  const rows = targetId
    ? db.prepare('SELECT * FROM qa_tests WHERE target_id = ? ORDER BY created_at').all(targetId)
    : db.prepare('SELECT * FROM qa_tests ORDER BY created_at').all();
  return (rows as Record<string, unknown>[]).map(toTest);
}
export function getTest(id: string): QaTest | null {
  const r = db.prepare('SELECT * FROM qa_tests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toTest(r) : null;
}
export function createTest(body: Record<string, unknown>, extra: Partial<Pick<QaTest, 'source' | 'journeySig' | 'findingId'>> = {}): QaTest {
  const targetId = String(body.targetId ?? '');
  if (!getTarget(targetId)) throw new QaError('target not found', 404);
  const sentences = parseSentences(body.sentences);
  const name = String(body.name ?? '').trim() || sentences[0].slice(0, 80);
  const cache = body.cache !== undefined && body.cache !== null ? parseCache(body.cache, sentences) : null;
  const id = randomUUID(); const now = nowIso();
  db.prepare(`INSERT INTO qa_tests (id, target_id, name, sentences, cache, source, journey_sig, finding_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, targetId, name, JSON.stringify(sentences), cache ? JSON.stringify(cache) : '', extra.source ?? 'manual', extra.journeySig ?? '', extra.findingId ?? '', now, now);
  return getTest(id)!;
}
export function updateTest(id: string, body: Record<string, unknown>): QaTest {
  const prev = getTest(id);
  if (!prev) throw new QaError('test not found', 404);
  const sentences = body.sentences !== undefined ? parseSentences(body.sentences) : prev.sentences;
  const name = body.name !== undefined ? String(body.name).trim() || prev.name : prev.name;
  // Changing the words invalidates the cached actions: they were worked out for the old ones.
  const changed = JSON.stringify(sentences) !== JSON.stringify(prev.sentences);
  const cache = body.cache !== undefined ? (body.cache === null ? null : parseCache(body.cache, sentences)) : changed ? null : prev.cache;
  db.prepare('UPDATE qa_tests SET name=?, sentences=?, cache=?, needs_attention=?, updated_at=? WHERE id=?')
    .run(name, JSON.stringify(sentences), cache ? JSON.stringify(cache) : '', changed ? 0 : prev.needsAttention ? 1 : 0, nowIso(), id);
  return getTest(id)!;
}
export function setTestCache(id: string, cache: QaAction[][] | null, needsAttention = false): void {
  db.prepare('UPDATE qa_tests SET cache=?, needs_attention=?, updated_at=? WHERE id=?').run(cache ? JSON.stringify(cache) : '', needsAttention ? 1 : 0, nowIso(), id);
}
export function deleteTest(id: string): void {
  if (!getTest(id)) throw new QaError('test not found', 404);
  db.prepare('DELETE FROM qa_tests WHERE id = ?').run(id);
}

// ── runs, results ───────────────────────────────────────────────────────────────────────

export interface QaRun {
  id: string; targetId: string; kind: RunKind; testIds: string[]; goal: string; status: RunStatus;
  agentId: string; aiCalls: number; summary: string; error: string; createdAt: string; finishedAt: string | null;
}
export interface QaResult {
  id: string; runId: string; testId: string; position: number; status: ResultStatus;
  failedStep: number | null; error: string; evidence: Record<string, unknown>; repairs: number;
}

function toRun(r: Record<string, unknown>): QaRun {
  return {
    id: String(r.id), targetId: String(r.target_id), kind: String(r.kind) as RunKind, testIds: json(r.test_ids, []),
    goal: String(r.goal ?? ''), status: String(r.status) as RunStatus, agentId: String(r.agent_id ?? ''),
    aiCalls: Number(r.ai_calls ?? 0), summary: String(r.summary ?? ''), error: String(r.error ?? ''),
    createdAt: String(r.created_at), finishedAt: (r.finished_at as string | null) ?? null,
  };
}
function toResult(r: Record<string, unknown>): QaResult {
  return {
    id: String(r.id), runId: String(r.run_id), testId: String(r.test_id), position: Number(r.position),
    status: String(r.status) as ResultStatus, failedStep: (r.failed_step as number | null) ?? null,
    error: String(r.error ?? ''), evidence: json(r.evidence, {}), repairs: Number(r.repairs ?? 0),
  };
}

export function insertRun(targetId: string, kind: RunKind, testIds: string[], goal: string, agentId: string): QaRun {
  const id = randomUUID();
  db.prepare(`INSERT INTO qa_runs (id, target_id, kind, test_ids, goal, status, agent_id, created_at) VALUES (?,?,?,?,?, 'running', ?, ?)`)
    .run(id, targetId, kind, JSON.stringify(testIds), goal, agentId, nowIso());
  testIds.forEach((t, i) => db.prepare(`INSERT INTO qa_results (id, run_id, test_id, position) VALUES (?,?,?,?)`).run(randomUUID(), id, t, i));
  return getRun(id)!;
}
export function getRun(id: string): QaRun | null {
  const r = db.prepare('SELECT * FROM qa_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toRun(r) : null;
}
export function listRuns(targetId?: string, limit = 100): QaRun[] {
  const rows = targetId
    ? db.prepare('SELECT * FROM qa_runs WHERE target_id = ? ORDER BY created_at DESC LIMIT ?').all(targetId, limit)
    : db.prepare('SELECT * FROM qa_runs ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as Record<string, unknown>[]).map(toRun);
}
export function updateRun(id: string, patch: Partial<Pick<QaRun, 'status' | 'summary' | 'error' | 'finishedAt'>> & { addAiCall?: boolean }): void {
  const cur = getRun(id);
  if (!cur) return;
  db.prepare('UPDATE qa_runs SET status=?, summary=?, error=?, finished_at=?, ai_calls=? WHERE id=?').run(
    patch.status ?? cur.status, patch.summary ?? cur.summary, patch.error ?? cur.error,
    patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt, cur.aiCalls + (patch.addAiCall ? 1 : 0), id);
  emitRun(id);
}
export function resultsOf(runId: string): QaResult[] {
  return (db.prepare('SELECT * FROM qa_results WHERE run_id = ? ORDER BY position').all(runId) as Record<string, unknown>[]).map(toResult);
}
export function getResult(id: string): QaResult | null {
  const r = db.prepare('SELECT * FROM qa_results WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toResult(r) : null;
}
export function updateResult(id: string, patch: Partial<Pick<QaResult, 'status' | 'failedStep' | 'error' | 'evidence'>> & { addRepair?: boolean }): void {
  const cur = getResult(id);
  if (!cur) return;
  db.prepare('UPDATE qa_results SET status=?, failed_step=?, error=?, evidence=?, repairs=? WHERE id=?').run(
    patch.status ?? cur.status, patch.failedStep !== undefined ? patch.failedStep : cur.failedStep, patch.error ?? cur.error,
    JSON.stringify(patch.evidence ?? cur.evidence), cur.repairs + (patch.addRepair ? 1 : 0), id);
}

export function emitRun(runId: string): void {
  try { getIO().emit('qa_run_updated', getRun(runId)); } catch { /* no socket server */ }
}
export function emitEvent(event: 'qa_finding_added' | 'qa_repair_added', payload: unknown): void {
  try { getIO().emit(event, payload); } catch { /* no socket server */ }
}

// ── repairs ─────────────────────────────────────────────────────────────────────────────

export interface QaRepair {
  id: string; runId: string; testId: string; sentenceIndex: number; sentence: string;
  before: QaAction[]; after: QaAction[]; status: 'pending' | 'accepted' | 'rejected'; createdAt: string; decidedAt: string | null;
}
function toRepair(r: Record<string, unknown>): QaRepair {
  return {
    id: String(r.id), runId: String(r.run_id), testId: String(r.test_id), sentenceIndex: Number(r.sentence_index),
    sentence: String(r.sentence), before: json(r.before, []), after: json(r.after, []),
    status: String(r.status) as QaRepair['status'], createdAt: String(r.created_at), decidedAt: (r.decided_at as string | null) ?? null,
  };
}
export function insertRepair(runId: string, testId: string, sentenceIndex: number, sentence: string, before: QaAction[], after: QaAction[], prevCache: QaAction[][]): QaRepair {
  const id = randomUUID();
  db.prepare(`INSERT INTO qa_repairs (id, run_id, test_id, sentence_index, sentence, before, after, prev_cache, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, runId, testId, sentenceIndex, sentence, JSON.stringify(before), JSON.stringify(after), JSON.stringify(prevCache), nowIso());
  const r = getRepair(id)!;
  emitEvent('qa_repair_added', r);
  return r;
}
export function getRepair(id: string): QaRepair | null {
  const r = db.prepare('SELECT * FROM qa_repairs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toRepair(r) : null;
}
export function listRepairs(opts: { status?: string; runId?: string; targetId?: string } = {}): QaRepair[] {
  const where: string[] = []; const args: unknown[] = [];
  if (opts.status) { where.push('r.status = ?'); args.push(opts.status); }
  if (opts.runId) { where.push('r.run_id = ?'); args.push(opts.runId); }
  if (opts.targetId) { where.push('t.target_id = ?'); args.push(opts.targetId); }
  const sql = `SELECT r.* FROM qa_repairs r LEFT JOIN qa_tests t ON t.id = r.test_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC`;
  return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(toRepair);
}
/** Accept keeps the repaired cache. Reject restores the cache from before the repair and flags the test. */
export function decideRepair(id: string, decision: 'accepted' | 'rejected'): QaRepair {
  const r = getRepair(id);
  if (!r) throw new QaError('repair not found', 404);
  if (r.status !== 'pending') throw new QaError(`this repair was already ${r.status}`, 409);
  if (decision === 'rejected') {
    const prev = db.prepare('SELECT prev_cache FROM qa_repairs WHERE id = ?').get(id) as { prev_cache: string };
    setTestCache(r.testId, json<QaAction[][] | null>(prev.prev_cache, null), true);
  }
  db.prepare('UPDATE qa_repairs SET status = ?, decided_at = ? WHERE id = ?').run(decision, nowIso(), id);
  return getRepair(id)!;
}
