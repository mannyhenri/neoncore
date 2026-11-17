/**
 * WHERE A TASK-LIST RUN HAS GOT TO — the progress document and the engine's own record of it.
 *
 * Asked for as: "while it's going, where could I read the current living document that keeps
 * all of this?" Before this there was no single answer. Epic: Task by Task let its first step
 * choose where task state lived (a checklist in the epic, a results doc, or only the tracker),
 * Confer kept one only in epic mode, and the dashboard showed nothing but "Loop 8/23" lines in a
 * run log.
 *
 * Two layers, because one cannot do both jobs:
 *
 *   1. THE PROGRESS DOCUMENT — `docs/progress/<ID>.md` in the repo, written by the agents: one row
 *      per task (status, owner, commit, notes) and a running log. It is the source of truth the
 *      agents re-read before every task, it survives a cleared session or a restart, and it is
 *      in git. A step announces it with a `PROGRESS: <absolute path>` line; the run remembers the
 *      path (workflows.progress_doc) and the server serves the file when the cartridge is on
 *      this machine.
 *
 *   2. THE ENGINE'S RECORD — `run_progress`. Every loop dispatch's claim (`DONE GRD-4 · 7
 *      remaining`) and every coverage check, as the server itself saw them. A repo on another
 *      computer cannot be read from here; this can, always, and it is what the run card counts.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { agentReportOf, loopClaim } from './workflow-loop.js';
import { isLocalMachine } from './machine-locality.js';
import { COVERAGE_PATTERN } from './coverage-loop.js';
export { COVERAGE_PATTERN };

// ── Reading what the agents wrote ──────────────────────────────────────────────────────

export interface Coverage {
  done: number;
  total: number;
  /** The OUTSTANDING lines the verify step listed, as written (bounded). */
  outstanding: string[];
}


/**
 * The count, or null when the step did not say — which is NOT "complete": an unreadable count is
 * treated as work the engine cannot vouch for.
 */
export function parseCoverage(result: string): Coverage | null {
  const report = agentReportOf(result || '');
  const m = report.match(new RegExp(COVERAGE_PATTERN, 'i'));
  if (!m) return null;
  const done = Number.parseInt(m[1], 10);
  const total = Number.parseInt(m[2], 10);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total < 0) return null;

  // The OUTSTANDING block: the bullet lines after a line that starts with OUTSTANDING.
  const lines = report.split(/\r?\n/);
  const outstanding: string[] = [];
  const at = lines.findIndex((l) => /^\s*[#*_`]*\s*OUTSTANDING\b/i.test(l));
  if (at !== -1) {
    for (const raw of lines.slice(at + 1)) {
      const l = raw.trim();
      if (!l || l.startsWith('```')) { if (outstanding.length) break; continue; }
      if (!/^[-*•]\s+/.test(l)) { if (outstanding.length) break; continue; }
      outstanding.push(l.replace(/^[-*•]\s+/, '').slice(0, 240));
      if (outstanding.length >= 40) break;
    }
  }
  return { done, total, outstanding };
}

/** A `PROGRESS: <absolute path>` line, or null. */
export function parseProgressDoc(result: string): string | null {
  const m = (result || '').match(/^[ \t>*_`-]*PROGRESS:\s*`?([^\s`]+\.md)`?\s*$/im);
  return m ? m[1] : null;
}

// ── Recording ──────────────────────────────────────────────────────────────────────────

export type CoverageAction = 'complete' | 'loop-back' | 'held' | 'accepted' | 'continued';

interface StepRef { id: string; name: string; workflowId: string }

function insert(row: {
  workflowId: string; stepId?: string; stepName?: string; kind: 'task' | 'coverage';
  taskId?: string; verdict: string; remaining?: number | null; done?: number | null; total?: number | null; detail?: string;
}): void {
  db.prepare(
    `INSERT INTO run_progress (id, workflow_id, step_id, step_name, kind, task_id, verdict, remaining, done, total, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), row.workflowId, row.stepId ?? '', row.stepName ?? '', row.kind, row.taskId ?? '', row.verdict,
    row.remaining ?? null, row.done ?? null, row.total ?? null, (row.detail ?? '').slice(0, 2000), new Date().toISOString());
}

/** One loop dispatch's claim, if it made one. Called for every dispatch of a looped step. */
export function recordDispatch(step: StepRef, result: string): void {
  const claim = loopClaim(result);
  if (!claim) return;
  insert({ workflowId: step.workflowId, stepId: step.id, stepName: step.name, kind: 'task',
    taskId: claim.taskId, verdict: claim.verdict, remaining: claim.remaining });
}

export function recordCoverage(step: StepRef, action: CoverageAction, c: Coverage | null, detail = ''): void {
  insert({ workflowId: step.workflowId, stepId: step.id, stepName: step.name, kind: 'coverage',
    verdict: action, done: c?.done ?? null, total: c?.total ?? null,
    detail: detail || (c?.outstanding.length ? c.outstanding.join('\n') : '') });
}

/**
 * Remember the progress document a step named, the first time one does (or when it moves).
 * Stored with the cartridge that wrote it, because that is whose disk the path is on.
 */
export function noteProgressDoc(workflowId: string, agentId: string, result: string): void {
  const docPath = parseProgressDoc(result);
  if (!docPath || !path.isAbsolute(docPath)) return;
  const current = db.prepare('SELECT progress_doc FROM workflows WHERE id = ?').get(workflowId) as { progress_doc?: string } | undefined;
  const next = JSON.stringify({ path: docPath, agentId });
  if (current?.progress_doc !== next) db.prepare('UPDATE workflows SET progress_doc = ? WHERE id = ?').run(next, workflowId);
}

// ── Reading it back ────────────────────────────────────────────────────────────────────

export interface ProgressEvent {
  at: string;
  stepName: string;
  kind: 'task' | 'coverage';
  taskId: string;
  verdict: string;
  remaining: number | null;
  done: number | null;
  total: number | null;
  detail: string;
}

export interface ProgressSummary {
  /** Tasks done, and the total — from the latest coverage check, else estimated from claims. */
  done: number;
  total: number | null;
  blocked: number;
  /** Where the number came from: a coverage check (exact) or the dispatch claims (estimate). */
  basis: 'coverage' | 'claims';
  /** The progress document, when the run has named one. */
  docPath: string;
  updatedAt: string;
}

function docOf(workflowId: string): { path: string; agentId: string } | null {
  const row = db.prepare('SELECT progress_doc FROM workflows WHERE id = ?').get(workflowId) as { progress_doc?: string } | undefined;
  try {
    const v = JSON.parse(row?.progress_doc || '');
    return v && typeof v.path === 'string' ? { path: v.path, agentId: String(v.agentId || '') } : null;
  } catch { return null; }
}

export function progressEvents(workflowId: string): ProgressEvent[] {
  return (db.prepare(
    `SELECT created_at, step_name, kind, task_id, verdict, remaining, done, total, detail
       FROM run_progress WHERE workflow_id = ? ORDER BY created_at ASC, rowid ASC`,
  ).all(workflowId) as Record<string, unknown>[]).map((r) => ({
    at: r.created_at as string,
    stepName: r.step_name as string,
    kind: r.kind as 'task' | 'coverage',
    taskId: r.task_id as string,
    verdict: r.verdict as string,
    remaining: r.remaining as number | null,
    done: r.done as number | null,
    total: r.total as number | null,
    detail: r.detail as string,
  }));
}

/** The run card's one line. Null for a run that has recorded no progress and named no document. */
export function progressSummary(workflowId: string): ProgressSummary | null {
  const events = progressEvents(workflowId);
  const doc = docOf(workflowId);
  if (events.length === 0 && !doc) return null;

  const lastCoverage = [...events].reverse().find((e) => e.kind === 'coverage' && e.total !== null);
  const claims = events.filter((e) => e.kind === 'task');
  // A task's LATEST claim is its state: BLOCKED then DONE on a retry is done.
  const latest = new Map<string, string>();
  for (const c of claims) latest.set(c.taskId, c.verdict);
  const blocked = [...latest.values()].filter((v) => v === 'BLOCKED').length;
  const updatedAt = events.length ? events[events.length - 1].at : '';

  if (lastCoverage && (!claims.length || lastCoverage.at >= claims[claims.length - 1].at)) {
    return { done: lastCoverage.done ?? 0, total: lastCoverage.total, blocked, basis: 'coverage', docPath: doc?.path ?? '', updatedAt };
  }
  const done = [...latest.values()].filter((v) => v === 'DONE').length;
  const remaining = claims.length ? claims[claims.length - 1].remaining : null;
  // The last claim's "k remaining" is re-counted from the state doc and includes blocked tasks,
  // so the estimate is what is done plus what that claim said was left.
  return { done, total: remaining === null ? null : done + remaining, blocked, basis: 'claims', docPath: doc?.path ?? '', updatedAt };
}

export interface ProgressDocView {
  path: string;
  /** The document's text, when the server can read it. */
  content: string | null;
  /** Why it could not be read, in words a person can act on. */
  unavailable: string;
}

/**
 * The progress document's text — ONLY a `.md` file under a `docs/progress/` directory inside the
 * repo of a cartridge that worked on this run, on this machine. The path comes from an agent's
 * output, so it is never trusted as a path to read: anything else is refused, not served.
 */
export function readProgressDoc(workflowId: string): ProgressDocView | null {
  const doc = docOf(workflowId);
  if (!doc) return null;
  const resolved = path.resolve(doc.path);
  if (!resolved.endsWith('.md') || !resolved.split(path.sep).join('/').includes('/docs/progress/')) {
    return { path: doc.path, content: null, unavailable: 'The run named a progress document outside docs/progress/ — it is not served.' };
  }

  const ids = new Set<string>([doc.agentId]);
  for (const r of db.prepare('SELECT executor_id, executor_config FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as
    { executor_id: string; executor_config: string }[]) {
    if (r.executor_id) ids.add(r.executor_id);
    try {
      const cfg = JSON.parse(r.executor_config || '{}');
      for (const id of Array.isArray(cfg.conferAgentIds) ? cfg.conferAgentIds : []) if (typeof id === 'string') ids.add(id);
    } catch { /* ignore */ }
  }
  let remote = '';
  for (const id of ids) {
    const a = db.prepare('SELECT repo_path, machine FROM agents WHERE id = ?').get(id) as { repo_path?: string; machine?: string } | undefined;
    const repo = (a?.repo_path || '').trim();
    if (!repo) continue;
    const root = path.resolve(repo) + path.sep;
    if (!resolved.startsWith(root)) continue;
    if (!isLocalMachine(a?.machine)) { remote = a?.machine || 'another machine'; continue; }
    try {
      return { path: doc.path, content: fs.readFileSync(resolved, 'utf8').slice(0, 200_000), unavailable: '' };
    } catch {
      return { path: doc.path, content: null, unavailable: 'The document does not exist yet — the run has not written it.' };
    }
  }
  return {
    path: doc.path,
    content: null,
    unavailable: remote
      ? `The document is on ${remote}, which this server cannot read. Open it there, or in the repo once it is pushed.`
      : 'The document is not inside the repo of any cartridge on this run — it is not served.',
  };
}
