/**
 * QA FOLLOWS THE FEATURE. Nobody enters a test.
 *
 *   1. A feature is being developed and has acceptance criteria (its Goal Pilot's contract).
 *   2. Those criteria ARE its QA test: one check sentence per criterion, kept in step with the
 *      criteria — written here, never by a person (`source: 'feature'`).
 *   3. Every time a workflow stage of the feature finishes, QA runs that test against the
 *      project's app (the project's QA target). The first run has the target's cartridge work out
 *      the browser actions; later runs replay them, self-repairing as any QA test does.
 *   4. The QA section reports it per feature and per project: each criterion passed / failed /
 *      not yet run, with the screenshot of what was tested.
 *
 * What it needs and cannot invent: where the app runs — a QA target for the project. Without one
 * the report says so; nothing runs.
 *
 * A feature that was already delivered when its project got a target is not run on its own (a
 * project's whole history would fire at once): it shows "not run yet" and can be run by hand.
 */
import { createHash } from 'crypto';
import db from '../../db.js';
import { pilotsForGoal, stagesOf, type GoalPilot } from '../goal-pilot.js';
import { getContract, type Criterion } from '../acceptance-contract.js';
import { createTest, updateTest, getTest, getRun, resultsOf, listTargets, type QaTarget, type QaTest, type QaRun } from './store.js';
import { startRun } from './engine.js';
import { evidenceUrl } from './report.js';
import { QaError } from './types.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS qa_feature_links (
    goal_id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    test_id TEXT NOT NULL,
    criteria_hash TEXT NOT NULL DEFAULT '',
    stages_done INTEGER NOT NULL DEFAULT 0,
    last_run_id TEXT NOT NULL DEFAULT '',
    run_hash TEXT NOT NULL DEFAULT '',      -- the criteria the last run was made of
    updated_at TEXT NOT NULL
  );
`);

const nowIso = () => new Date().toISOString();
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Link { goalId: string; targetId: string; testId: string; criteriaHash: string; stagesDone: number; lastRunId: string; runHash: string }
const linkOf = (goalId: string): Link | null => {
  const r = db.prepare('SELECT * FROM qa_feature_links WHERE goal_id = ?').get(goalId) as Record<string, unknown> | undefined;
  return r ? { goalId, targetId: String(r.target_id), testId: String(r.test_id), criteriaHash: String(r.criteria_hash), stagesDone: Number(r.stages_done), lastRunId: String(r.last_run_id), runHash: String(r.run_hash ?? '') } : null;
};

/** The feature's pilot that counts: the newest one. */
function pilotOf(goalId: string): GoalPilot | null {
  const all = pilotsForGoal(goalId);
  return all.length ? [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[all.length - 1] : null;
}
/** The feature's acceptance criteria: the contract's once there is one, else what the plan carries. */
export function criteriaOf(goalId: string): Criterion[] {
  const pilot = pilotOf(goalId);
  if (!pilot) return [];
  const fromContract = getContract(pilot.id)?.criteria;
  const list = fromContract?.length ? fromContract : ((pilot as unknown as { criteria?: Criterion[] }).criteria ?? []);
  return Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string' && c.text.trim()) : [];
}
/** One criterion as a QA check sentence. It starts with "Verify", so its actions must assert something. */
export const sentenceFor = (c: Criterion): string => oneLine(`Verify ${c.id}: ${c.text}${c.expect ? ` Expected: ${c.expect}` : ''}`);
const hashOf = (sentences: string[]) => createHash('sha256').update(sentences.join('\n')).digest('hex').slice(0, 16);
/** Workflow stages of the feature's pipeline that have finished: the "something was built" count. */
function stagesDone(pilot: GoalPilot | null): number {
  return pilot ? stagesOf(pilot.id).filter((s) => s.kind === 'workflow' && s.status === 'completed').length : 0;
}
export const targetForProject = (projectId: string): QaTarget | null => (projectId ? listTargets().find((t) => t.projectId === projectId) ?? null : null);
const ACTIVE: ReadonlySet<string> = new Set(['running', 'waiting']);

interface GoalRow { id: string; name: string; project_id: string }
const goalRow = (goalId: string) => db.prepare('SELECT id, name, project_id FROM goals WHERE id = ?').get(goalId) as GoalRow | undefined;

/**
 * Keep the feature's QA test in step with its criteria. Null when it cannot have one yet (no
 * target for its project, or no criteria). Changed criteria change the sentences, which drops the
 * cached actions — they were worked out for the old words.
 */
export function syncFeatureTest(goalId: string): { link: Link; test: QaTest } | null {
  const goal = goalRow(goalId);
  if (!goal) return null;
  const target = targetForProject(goal.project_id);
  const criteria = criteriaOf(goalId);
  if (!target || criteria.length === 0) return null;
  const sentences = criteria.map(sentenceFor);
  const hash = hashOf(sentences);
  const name = `Feature: ${goal.name}`.slice(0, 120);
  let link = linkOf(goalId);
  let test = link ? getTest(link.testId) : null;
  if (test && test.targetId !== target.id) test = null;   // the project's target was replaced
  if (!test) {
    test = createTest({ targetId: target.id, name, sentences }, { source: 'feature' as QaTest['source'] });
    // A feature already delivered is not run on its own; one still being built starts from zero.
    const pilot = pilotOf(goalId);
    const done = link?.stagesDone ?? (pilot?.phase === 'completed' ? stagesDone(pilot) : 0);
    db.prepare(`INSERT INTO qa_feature_links (goal_id, target_id, test_id, criteria_hash, stages_done, last_run_id, updated_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(goal_id) DO UPDATE SET target_id = excluded.target_id, test_id = excluded.test_id, criteria_hash = excluded.criteria_hash, updated_at = excluded.updated_at`)
      .run(goalId, target.id, test.id, hash, done, '', nowIso());
  } else if (link!.criteriaHash !== hash || test.name !== name) {
    test = updateTest(test.id, { name, sentences });
    db.prepare('UPDATE qa_feature_links SET criteria_hash = ?, updated_at = ? WHERE goal_id = ?').run(hash, nowIso(), goalId);
  }
  link = linkOf(goalId)!;
  return { link, test };
}

/** Run the feature's QA test now. Refused, with the reason, when it cannot be. */
export function runFeatureQa(goalId: string): QaRun {
  const goal = goalRow(goalId);
  if (!goal) throw new QaError('feature not found', 404);
  if (!targetForProject(goal.project_id)) throw new QaError('this feature\'s project has no QA target — QA needs to know where the app runs');
  const synced = syncFeatureTest(goalId);
  if (!synced) throw new QaError('this feature has no acceptance criteria yet — there is nothing to test');
  const last = synced.link.lastRunId ? getRun(synced.link.lastRunId) : null;
  if (last && ACTIVE.has(last.status)) throw new QaError('QA is already running for this feature', 409);
  const run = startRun({ targetId: synced.link.targetId, kind: 'run', testIds: [synced.test.id] });
  db.prepare('UPDATE qa_feature_links SET last_run_id = ?, run_hash = ?, stages_done = ?, updated_at = ? WHERE goal_id = ?').run(run.id, synced.link.criteriaHash, stagesDone(pilotOf(goalId)), nowIso(), goalId);
  return run;
}

/**
 * One pass over every feature of every project that has a QA target: keep its test in step, and
 * run it when a workflow stage has finished since its last run. Answers the features it started.
 */
export function sweepFeatureQa(): string[] {
  const started: string[] = [];
  const projects = new Set(listTargets().map((t) => t.projectId).filter(Boolean));
  if (projects.size === 0) return started;
  const goals = db.prepare(`SELECT id, project_id FROM goals WHERE project_id != '' AND COALESCE(origin, 'planned') != 'imported'`).all() as { id: string; project_id: string }[];
  for (const g of goals) {
    if (!projects.has(g.project_id)) continue;
    try {
      const synced = syncFeatureTest(g.id);
      if (!synced) continue;
      const done = stagesDone(pilotOf(g.id));
      if (done <= synced.link.stagesDone) continue;
      const last = synced.link.lastRunId ? getRun(synced.link.lastRunId) : null;
      if (last && ACTIVE.has(last.status)) continue;
      runFeatureQa(g.id);
      started.push(g.id);
    } catch (err) {
      console.warn(`[qa] feature ${g.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
    }
  }
  return started;
}

// ── the report ────────────────────────────────────────────────────────────────

export type CriterionQa = 'passed' | 'failed' | 'running' | 'not-run';
export type FeatureQaState = 'no-target' | 'no-criteria' | 'waiting-for-build' | 'not-run' | 'running' | 'passed' | 'failed' | 'error';
export interface FeatureQa {
  goalId: string; name: string; phase: string; state: FeatureQaState;
  /** Why it is in this state, in a sentence a person can act on. */
  note: string;
  criteria: { id: string; text: string; expect: string; status: CriterionQa; error: string; screenshot: string }[];
  passed: number; total: number;
  runId: string; runAt: string; repaired: boolean; reportUrl: string;
}
export interface ProjectQa {
  projectId: string; name: string; color: string;
  target: { id: string; name: string; baseUrl: string; hasCartridge: boolean } | null;
  features: FeatureQa[];
  passed: number; total: number; featuresPassing: number;
}

function featureReport(goal: GoalRow, target: QaTarget | null): FeatureQa | null {
  const pilot = pilotOf(goal.id);
  const criteria = criteriaOf(goal.id);
  // A feature nobody has started on, with nothing to test, is not QA's business yet.
  if (!pilot && criteria.length === 0) return null;
  const base: FeatureQa = {
    goalId: goal.id, name: goal.name, phase: pilot?.phase ?? '', state: 'not-run', note: '',
    criteria: criteria.map((c) => ({ id: c.id, text: c.text, expect: c.expect ?? '', status: 'not-run' as CriterionQa, error: '', screenshot: '' })),
    passed: 0, total: criteria.length, runId: '', runAt: '', repaired: false, reportUrl: '',
  };
  if (criteria.length === 0) return { ...base, state: 'no-criteria', note: 'No acceptance criteria yet — they are written when the feature is scoped.' };
  if (!target) return { ...base, state: 'no-target', note: 'QA does not know where this project\'s app runs. Add a QA target for the project.' };
  const link = linkOf(goal.id);
  const run = link?.lastRunId ? getRun(link.lastRunId) : null;
  if (!run) {
    const built = stagesDone(pilot);
    return built === 0
      ? { ...base, state: 'waiting-for-build', note: 'Runs by itself as soon as the first workflow stage of this feature finishes.' }
      : { ...base, state: 'not-run', note: 'Delivered before QA was set up for this project — not run yet.' };
  }
  const result = resultsOf(run.id).find((r) => r.testId === link!.testId) ?? null;
  const steps = ((result?.evidence as { steps?: { index: number; status: string; error?: string; screenshot?: string }[] } | undefined)?.steps) ?? [];
  // The run's steps are the criteria only while the words are the same ones it ran.
  const current = link!.runHash === hashOf(criteria.map(sentenceFor));
  const working = ACTIVE.has(run.status) || ['pending', 'authoring', 'repairing'].includes(result?.status ?? 'pending');
  const rows = base.criteria.map((c, i) => {
    const st = current ? steps.find((s) => s.index === i) ?? steps[i] : undefined;
    const status: CriterionQa = st?.status === 'passed' ? 'passed' : st?.status === 'failed' ? 'failed' : working ? 'running' : 'not-run';
    return { ...c, status, error: st?.error ?? '', screenshot: evidenceUrl(run.id, st?.screenshot) };
  });
  const passed = rows.filter((r) => r.status === 'passed').length;
  const state: FeatureQaState = working ? 'running' : run.status === 'error' ? 'error' : !current ? 'not-run'
    : result?.status === 'passed' || result?.status === 'passed_with_repair' ? 'passed' : 'failed';
  const note = working ? (result?.status === 'authoring' ? 'The target\'s cartridge is working out how to test each criterion in the browser.' : result?.status === 'repairing' ? 'A step changed in the app — the cartridge is repairing it.' : 'Testing in the browser.')
    : state === 'error' ? run.error || 'The run could not finish.'
      : !current ? 'The criteria changed since the last run — it runs again after the next stage.'
        : state === 'failed' ? (result?.error || `${rows.length - passed} of ${rows.length} criteria did not pass.`) : '';
  return {
    ...base, criteria: rows, passed, state, note, runId: run.id, runAt: run.finishedAt ?? run.createdAt,
    repaired: result?.status === 'passed_with_repair', reportUrl: `/api/qa/runs/${run.id}/report.html`,
  };
}

/** QA per project and per feature — what the QA section shows first. */
export function featureQaReport(): ProjectQa[] {
  const projects = db.prepare('SELECT id, name, color FROM projects ORDER BY name').all() as { id: string; name: string; color: string }[];
  const out: ProjectQa[] = [];
  for (const p of projects) {
    const target = targetForProject(p.id);
    const goals = db.prepare(`SELECT id, name, project_id FROM goals WHERE project_id = ? AND COALESCE(origin, 'planned') != 'imported' ORDER BY position, created_at`).all(p.id) as GoalRow[];
    const features = goals.map((g) => featureReport(g, target)).filter((f): f is FeatureQa => !!f);
    if (features.length === 0 && !target) continue;
    out.push({
      projectId: p.id, name: p.name, color: p.color,
      target: target ? { id: target.id, name: target.name, baseUrl: target.baseUrl, hasCartridge: !!target.agentId } : null,
      features, passed: features.reduce((n, f) => n + f.passed, 0), total: features.reduce((n, f) => n + f.total, 0),
      featuresPassing: features.filter((f) => f.state === 'passed').length,
    });
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
/** The sweep runs while the server does (never under test, where a test calls it itself). */
export function startFeatureQa(intervalMs = 15_000): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => { try { sweepFeatureQa(); } catch (err) { console.error('[qa] feature sweep failed:', err); } }, intervalMs);
  timer.unref?.();
}
