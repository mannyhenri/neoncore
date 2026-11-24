/**
 * EPIC QA FOR ANY PROJECT — the records and the rules (docs/plans/epic-qa-any-project.md).
 * The run itself is lib/qa/epic-acceptance.ts; this module only reads and writes the database, so
 * roadmap.ts and goal-pilot-runner.ts can ask it questions without importing the runner.
 *
 *   epic finished ──► run (in the repo) ──► passed · failed · error · no-tests
 *        │                                     │
 *        │                     Passed QA ✓ allowed only on passed / no-tests (epicQaBlock)
 *        ▼
 *   next epic's workflow stages wait until this epic passed QA (epicOrderWait)
 *
 * A run belongs to one FINISH of its epic (`for_finished_at` = the newest done_at of its features,
 * as epicQaOf computes it): a feature reopened and done again is a new finish, and needs a new run.
 */
import { randomUUID } from 'crypto';
import db from '../../db.js';
import { epicQaOf } from '../project-spec.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS epic_qa_runs (
    id TEXT PRIMARY KEY,
    epic_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    for_finished_at TEXT NOT NULL,
    status TEXT NOT NULL,
    checks TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_epic_qa_runs_epic ON epic_qa_runs(epic_id, started_at);
  CREATE TABLE IF NOT EXISTS epic_qa_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// projects.qa_command / epics.qa_command (the phase gate) are added with the epics table, in roadmap.ts.
// Epics that finished before epic QA existed are not run on their own (a project's whole history
// would fire at once) — they are run by hand. The moment it first existed is kept here.
db.prepare("INSERT OR IGNORE INTO epic_qa_meta (key, value) VALUES ('enabled_at', ?)").run(new Date().toISOString());
// A run cut off by a restart never finishes on its own.
db.prepare("UPDATE epic_qa_runs SET status = 'error', error = 'The server restarted during the run — run QA again.', finished_at = ? WHERE status = 'running'")
  .run(new Date().toISOString());

export const MAX_COMMAND_CHARS = 400;

export type EpicRunStatus = 'running' | 'passed' | 'failed' | 'error' | 'no-tests';
export const EPIC_RUN_STATUSES: readonly EpicRunStatus[] = ['running', 'passed', 'failed', 'error', 'no-tests'];

/** One thing a run checked. */
export type EpicCheckKind = 'test' | 'command' | 'qa-command' | 'tamper' | 'checklist';
export const EPIC_CHECK_KINDS: readonly EpicCheckKind[] = ['test', 'command', 'qa-command', 'tamper', 'checklist'];

export interface EpicCheck {
  kind: EpicCheckKind;
  /** The feature it belongs to ('' for the epic's QA command). */
  goalId: string;
  feature: string;
  /** AC-n ('' for the QA command and a tamper finding). */
  criterionId: string;
  text: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** The command's output (last 8000 chars), or the reason for a carried-forward checklist verdict. */
  output: string;
  durationMs: number;
}

export interface EpicQaRun {
  id: string;
  epicId: string;
  projectId: string;
  forFinishedAt: string;
  status: EpicRunStatus;
  checks: EpicCheck[];
  passing: number;
  total: number;
  summary: string;
  error: string;
  startedAt: string;
  finishedAt: string;
}

const nowIso = () => new Date().toISOString();

function hydrate(r: Record<string, unknown>): EpicQaRun {
  let checks: EpicCheck[] = [];
  try { checks = JSON.parse(String(r.checks || '[]')); } catch { /* keep [] */ }
  return {
    id: String(r.id), epicId: String(r.epic_id), projectId: String(r.project_id), forFinishedAt: String(r.for_finished_at),
    status: String(r.status) as EpicRunStatus, checks,
    passing: checks.filter((c) => c.passed).length, total: checks.length,
    summary: String(r.summary || ''), error: String(r.error || ''),
    startedAt: String(r.started_at), finishedAt: String(r.finished_at || ''),
  };
}

export function getEpicRun(id: string): EpicQaRun | null {
  const r = db.prepare('SELECT * FROM epic_qa_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? hydrate(r) : null;
}

/** The newest run of the epic, whatever finish it was for. */
export function latestEpicRun(epicId: string): EpicQaRun | null {
  const r = db.prepare('SELECT * FROM epic_qa_runs WHERE epic_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(epicId) as Record<string, unknown> | undefined;
  return r ? hydrate(r) : null;
}

/**
 * When the epic last finished: the newest done_at of its features — exactly what epicQaOf compares
 * a sign-off against. '' while a feature is not done, or when it has none.
 */
export function epicFinishedAt(epicId: string): string {
  const fs = db.prepare('SELECT status, done_at, updated_at FROM goals WHERE epic_id = ?').all(epicId) as { status: string; done_at: string; updated_at: string }[];
  if (fs.length === 0 || fs.some((f) => f.status !== 'achieved')) return '';
  return fs.map((f) => f.done_at || f.updated_at || '').sort().pop() ?? '';
}

/** The newest run for the epic's CURRENT finish — null when it has not run since it last finished. */
export function currentEpicRun(epicId: string): EpicQaRun | null {
  const at = epicFinishedAt(epicId);
  if (!at) return null;
  const r = db.prepare('SELECT * FROM epic_qa_runs WHERE epic_id = ? AND for_finished_at = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(epicId, at) as Record<string, unknown> | undefined;
  return r ? hydrate(r) : null;
}

export function insertEpicRun(epicId: string, projectId: string, forFinishedAt: string): EpicQaRun {
  const id = randomUUID();
  db.prepare("INSERT INTO epic_qa_runs (id, epic_id, project_id, for_finished_at, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)")
    .run(id, epicId, projectId, forFinishedAt, nowIso());
  return getEpicRun(id)!;
}

export function finishEpicRun(id: string, patch: { status: Exclude<EpicRunStatus, 'running'>; checks: EpicCheck[]; summary: string; error?: string }): EpicQaRun {
  db.prepare('UPDATE epic_qa_runs SET status = ?, checks = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?')
    .run(patch.status, JSON.stringify(patch.checks), patch.summary, patch.error ?? '', nowIso(), id);
  return getEpicRun(id)!;
}

/** Progress while running: the checks so far. */
export function saveEpicChecks(id: string, checks: EpicCheck[]): void {
  db.prepare('UPDATE epic_qa_runs SET checks = ? WHERE id = ?').run(JSON.stringify(checks), id);
}

export function epicQaEnabledAt(): string {
  return (db.prepare("SELECT value FROM epic_qa_meta WHERE key = 'enabled_at'").get() as { value: string }).value;
}

/**
 * The command that proves the epic: its own, else the project's. '' when neither is set.
 * `{n}` is the epic's phase number, so one project command gates every phase
 * (`bash scripts/run_gates.sh {n}`): see phaseNumberOf.
 */
export function qaCommandFor(epicId: string): string {
  const r = db.prepare('SELECT e.qa_command AS own, p.qa_command AS dflt FROM epics e JOIN projects p ON p.id = e.project_id WHERE e.id = ?')
    .get(epicId) as { own: string; dflt: string } | undefined;
  const command = (r?.own || r?.dflt || '').trim();
  return command.includes('{n}') ? command.replaceAll('{n}', String(phaseNumberOf(epicId))) : command;
}

/** The first number in the epic's name ("Phase 0: Setup" → 0); else its 0-based place in the project's epic order. */
export function phaseNumberOf(epicId: string): number {
  const e = db.prepare('SELECT name, project_id FROM epics WHERE id = ?').get(epicId) as { name: string; project_id: string } | undefined;
  if (!e) return 0;
  const m = /\d+/.exec(e.name);
  if (m) return Number(m[0]);
  const order = db.prepare('SELECT id FROM epics WHERE project_id = ? ORDER BY position, created_at').all(e.project_id) as { id: string }[];
  return Math.max(0, order.findIndex((x) => x.id === epicId));
}

export function cleanQaCommand(value: unknown): string {
  const s = String(value ?? '').trim();
  if (s.length > MAX_COMMAND_CHARS) throw new Error(`a QA command is at most ${MAX_COMMAND_CHARS} characters`);
  return s;
}

/**
 * The browser QA of the epic's features (lib/qa/feature-link.ts), when the project has a target:
 * a failed or unfinished one blocks too. Null when there is none, or it passed.
 */
function browserBlock(epicId: string): string | null {
  let rows: { status: string }[] = [];
  try {
    rows = db.prepare(`SELECT r.status FROM qa_feature_links l JOIN qa_runs r ON r.id = l.last_run_id
                        JOIN goals g ON g.id = l.goal_id WHERE g.epic_id = ?`).all(epicId) as { status: string }[];
  } catch { return null; }   // no browser QA tables yet: nothing to block on
  if (rows.some((r) => r.status === 'running' || r.status === 'waiting')) return 'Browser QA is still running.';
  if (rows.some((r) => r.status === 'failed' || r.status === 'error')) return 'Browser QA failed — see the QA section.';
  return null;
}

/**
 * Why Passed QA ✓ may NOT be pressed now — null when it may. Only consulted for passing an epic;
 * taking a pass back is never blocked.
 */
export function epicQaBlock(epicId: string): string | null {
  const run = currentEpicRun(epicId);
  if (!run) return 'QA has not run since the epic finished — run QA first.';
  if (run.status === 'running') return 'QA is still running.';
  if (run.status === 'error') return `QA could not run: ${run.error || 'unknown error'} — fix that, then run QA again.`;
  if (run.status === 'failed') {
    const failing = run.checks.filter((c) => !c.passed);
    const names = failing.slice(0, 3).map((c) => [c.feature, c.criterionId || c.kind].filter(Boolean).join(' ')).join(', ');
    return `QA failed: ${run.passing} of ${run.total} passed — ${names}${failing.length > 3 ? ', …' : ''}. Fix them and run QA again.`;
  }
  return browserBlock(epicId);
}

/** What an epic carries on the roadmap: its run for the current finish, short. */
export interface EpicQaRunSummary {
  id: string;
  status: EpicRunStatus;
  passing: number;
  total: number;
  /** When it started. */
  at: string;
  finishedAt: string;
  failing: { feature: string; criterionId: string; kind: EpicCheckKind; text: string }[];
  /** Why Passed QA is not allowed — null when it is. */
  blockedReason: string | null;
}

export function epicQaRunSummary(epicId: string): EpicQaRunSummary | null {
  const run = currentEpicRun(epicId);
  if (!run) return null;
  return {
    id: run.id, status: run.status, passing: run.passing, total: run.total, at: run.startedAt, finishedAt: run.finishedAt,
    failing: run.checks.filter((c) => !c.passed).map((c) => ({ feature: c.feature, criterionId: c.criterionId, kind: c.kind, text: c.text })),
    blockedReason: epicQaBlock(epicId),
  };
}

/**
 * THE NEXT EPIC WAITS. Why a WORKFLOW stage of this feature may not launch yet — null when it may.
 * Every earlier epic of the project (lower position) that has features must have passed QA first:
 * planning ahead is fine, building ahead of an unproven phase is not (Beam run #17).
 */
export function epicOrderWait(goalId: string): string | null {
  const g = db.prepare('SELECT epic_id, project_id FROM goals WHERE id = ?').get(goalId) as { epic_id: string; project_id: string } | undefined;
  if (!g?.epic_id) return null;
  const mine = db.prepare('SELECT position FROM epics WHERE id = ?').get(g.epic_id) as { position: number } | undefined;
  if (!mine) return null;
  const earlier = db.prepare('SELECT id, name FROM epics WHERE project_id = ? AND position < ? ORDER BY position, rowid')
    .all(g.project_id, mine.position) as { id: string; name: string }[];
  for (const e of earlier) {
    const qa = epicQaOf(e.id);
    if (qa === 'none' || qa === 'passed') continue;
    return qa === 'open'
      ? `Waiting for "${e.name}" to be finished and pass QA — its features come first.`
      : `Waiting for "${e.name}" to pass QA.`;
  }
  return null;
}
