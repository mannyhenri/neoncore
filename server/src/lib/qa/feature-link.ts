/**
 * QA FOLLOWS THE FEATURE — AND RUNS WHEN ITS EPIC IS FINISHED. Nobody enters a test.
 *
 *   1. A feature has acceptance criteria (its Goal Pilot's contract). Those criteria ARE its QA
 *      test: one check sentence per criterion, kept in step with the criteria — written here,
 *      never by a person (`source: 'feature'`).
 *   2. QA runs on the EPIC, at the END: when every feature of the epic is done, one run checks all
 *      of them together against the project's app (its QA target). Never during development —
 *      REQUESTED: "the automated QA part … should only be used on an epic … when an EPIC is
 *      finished, not 80%, not during: at the end." A feature in no epic is an epic of one: it runs
 *      when that feature is done. It used to run after every finished workflow stage of every
 *      feature, which is QA paid for again and again on half-built work.
 *   3. The first run has the target's cartridge work out the browser actions; later runs replay
 *      them, self-repairing as any QA test does.
 *   4. The QA section reports it per feature and per project: each criterion passed / failed /
 *      not yet run, with the screenshot of what was tested.
 *
 * What it needs and cannot invent: where the app runs — a QA target for the project. Without one
 * the report says so; nothing runs.
 *
 * An epic that was already finished when its project got a target is not run on its own (a
 * project's whole history would fire at once): it shows "not run yet" and can be run by hand.
 */
import { createHash } from 'crypto';
import db from '../../db.js';
import { pilotsForGoal, type GoalPilot } from '../goal-pilot.js';
import { getContract, type Criterion } from '../acceptance-contract.js';
import { createTest, updateTest, getTest, getRun, resultsOf, listTargets, type QaTarget, type QaTest, type QaRun } from './store.js';
import { startRun } from './engine.js';
import { evidenceUrl } from './report.js';
import { QaError } from './types.js';
import { sweepEpicQa } from './epic-acceptance.js';

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
// When the feature's epic last finished, as of its last run (EpicProgress.finishedAt): a run is owed
// when the epic finishes and this differs. (stages_done is no longer read: QA waits for the epic.)
if (!(db.prepare('PRAGMA table_info(qa_feature_links)').all() as { name: string }[]).some((c) => c.name === 'epic_ran_for')) {
  db.exec(`ALTER TABLE qa_feature_links ADD COLUMN epic_ran_for TEXT NOT NULL DEFAULT ''`);
}

const nowIso = () => new Date().toISOString();
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Link { goalId: string; targetId: string; testId: string; criteriaHash: string; epicRanFor: string; lastRunId: string; runHash: string }
const linkOf = (goalId: string): Link | null => {
  const r = db.prepare('SELECT * FROM qa_feature_links WHERE goal_id = ?').get(goalId) as Record<string, unknown> | undefined;
  return r ? { goalId, targetId: String(r.target_id), testId: String(r.test_id), criteriaHash: String(r.criteria_hash), epicRanFor: String(r.epic_ran_for ?? ''), lastRunId: String(r.last_run_id), runHash: String(r.run_hash ?? '') } : null;
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
/**
 * The feature's epic and how far it is: its features, how many are done, and whether it is
 * FINISHED (every one done). A feature in no epic is an epic of one. `finishedAt` changes each
 * time the epic finishes anew (a feature added and done, one reopened and done again), which is
 * what tells the sweep a new run is owed.
 */
export interface EpicProgress { epicId: string; name: string; goalIds: string[]; done: number; total: number; finished: boolean; finishedAt: string }
export function epicProgressOf(goalId: string): EpicProgress {
  const g = db.prepare('SELECT id, name, epic_id, project_id FROM goals WHERE id = ?').get(goalId) as { id: string; name: string; epic_id: string | null; project_id: string } | undefined;
  if (!g) return { epicId: '', name: '', goalIds: [], done: 0, total: 0, finished: false, finishedAt: '' };
  const rows = (g.epic_id
    ? db.prepare(`SELECT id, status, done_at FROM goals WHERE epic_id = ? AND project_id = ?`).all(g.epic_id, g.project_id)
    : db.prepare('SELECT id, status, done_at FROM goals WHERE id = ?').all(goalId)) as { id: string; status: string; done_at: string | null }[];
  const epicName = g.epic_id ? ((db.prepare('SELECT name FROM epics WHERE id = ?').get(g.epic_id) as { name?: string } | undefined)?.name ?? '') : '';
  const done = rows.filter((r) => r.status === 'achieved').length;
  const finished = rows.length > 0 && done === rows.length;
  const finishedAt = finished ? rows.map((r) => r.done_at || '').sort().pop() || 'done' : '';
  return { epicId: g.epic_id || '', name: epicName, goalIds: rows.map((r) => r.id), done, total: rows.length, finished, finishedAt };
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
    // An epic already finished when QA first sees it is history: not run on its own (by hand it can be).
    const ranFor = link?.epicRanFor ?? epicProgressOf(goalId).finishedAt;
    db.prepare(`INSERT INTO qa_feature_links (goal_id, target_id, test_id, criteria_hash, epic_ran_for, last_run_id, updated_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(goal_id) DO UPDATE SET target_id = excluded.target_id, test_id = excluded.test_id, criteria_hash = excluded.criteria_hash, updated_at = excluded.updated_at`)
      .run(goalId, target.id, test.id, hash, ranFor, '', nowIso());
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
  db.prepare('UPDATE qa_feature_links SET last_run_id = ?, run_hash = ?, epic_ran_for = ?, updated_at = ? WHERE goal_id = ?').run(run.id, synced.link.criteriaHash, epicProgressOf(goalId).finishedAt, nowIso(), goalId);
  return run;
}

type Member = { id: string; s: { link: Link; test: QaTest } };
/** One run for the epic: every member's test, each link marked with this run and this finish. */
function startEpicRun(epic: EpicProgress, members: Member[]): QaRun {
  const run = startRun({ targetId: members[0].s.link.targetId, kind: 'run', testIds: members.map((m) => m.s.test.id) });
  const mark = db.prepare('UPDATE qa_feature_links SET last_run_id = ?, run_hash = ?, epic_ran_for = ?, updated_at = ? WHERE goal_id = ?');
  for (const m of members) mark.run(run.id, m.s.link.criteriaHash, epic.finishedAt, nowIso(), m.id);
  return run;
}

/**
 * Run the QA of this feature's whole epic NOW, whatever state it is in — the person's call
 * ("I can also decide to trigger one myself whenever I please"). A feature in no epic runs alone.
 * Refused, with the reason, when it cannot be.
 */
export function runEpicQa(goalId: string): QaRun {
  const goal = goalRow(goalId);
  if (!goal) throw new QaError('feature not found', 404);
  if (!targetForProject(goal.project_id)) throw new QaError('this feature\'s project has no QA target — QA needs to know where the app runs');
  const epic = epicProgressOf(goalId);
  const members = epic.goalIds.map((id) => ({ id, s: syncFeatureTest(id) })).filter((m): m is Member => !!m.s);
  if (members.length === 0) throw new QaError('no feature of this epic has acceptance criteria yet — there is nothing to test');
  if (members.some((m) => { const r = m.s.link.lastRunId ? getRun(m.s.link.lastRunId) : null; return r && ACTIVE.has(r.status); })) {
    throw new QaError('QA is already running for this epic', 409);
  }
  return startEpicRun(epic, members);
}

/**
 * One pass over every project that has a QA target: keep each feature's test in step with its
 * criteria, and when an EPIC has just FINISHED — every feature done — run all of its features'
 * tests together, once. Answers the goal ids it started a run for.
 */
export function sweepFeatureQa(): string[] {
  const started: string[] = [];
  const projects = new Set(listTargets().map((t) => t.projectId).filter(Boolean));
  if (projects.size === 0) return started;
  const goals = db.prepare(`SELECT id, project_id FROM goals WHERE project_id != '' AND COALESCE(origin, 'planned') != 'imported'`).all() as { id: string; project_id: string }[];
  const seen = new Set<string>();
  for (const g of goals) {
    if (!projects.has(g.project_id)) continue;
    try {
      const epic = epicProgressOf(g.id);
      const key = epic.epicId || g.id;
      if (seen.has(key)) continue;
      // Kept in step even while building: the test is ready the moment the epic is finished.
      const synced = syncFeatureTest(g.id);
      if (!epic.finished) continue;
      seen.add(key);
      // Every feature of the epic that has a test, and is not already checked for this finish.
      const members = epic.goalIds.map((id) => ({ id, s: id === g.id ? synced : syncFeatureTest(id) }))
        .filter((m): m is { id: string; s: NonNullable<typeof synced> } => !!m.s);
      const owed = members.filter((m) => m.s.link.epicRanFor !== epic.finishedAt);
      if (owed.length === 0) continue;
      if (members.some((m) => { const r = m.s.link.lastRunId ? getRun(m.s.link.lastRunId) : null; return r && ACTIVE.has(r.status); })) continue;
      startEpicRun(epic, members);
      started.push(...members.map((m) => m.id));
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
  /** Its epic and how far it is — QA runs when it is finished. Empty id: a feature in no epic. */
  epic: { id: string; name: string; done: number; total: number };
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
    epic: (({ epicId, name, done, total }) => ({ id: epicId, name, done, total }))(epicProgressOf(goal.id)),
  };
  if (criteria.length === 0) return { ...base, state: 'no-criteria', note: 'No acceptance criteria yet — they are written when the feature is scoped.' };
  if (!target) return { ...base, state: 'no-target', note: 'QA does not know where this project\'s app runs. Add a QA target for the project.' };
  const link = linkOf(goal.id);
  const run = link?.lastRunId ? getRun(link.lastRunId) : null;
  if (!run) {
    const epic = epicProgressOf(goal.id);
    if (!epic.finished) {
      return { ...base, state: 'waiting-for-build', note: epic.epicId
        ? `Runs when its epic${epic.name ? ` "${epic.name}"` : ''} is finished — ${epic.done} of ${epic.total} features done.`
        : 'Runs when this feature is done.' };
    }
    return { ...base, state: 'not-run', note: 'Finished before QA was set up for this project — not run yet. Run it by hand.' };
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
      : !current ? 'The criteria changed since the last run — it runs again when its epic is next finished, or run it by hand.'
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
  timer = setInterval(() => {
    try { sweepFeatureQa(); } catch (err) { console.error('[qa] feature sweep failed:', err); }
    // Epic QA for any project — the locked tests and the QA command, with or without a web UI.
    try { sweepEpicQa(); } catch (err) { console.error('[qa] epic sweep failed:', err); }
  }, intervalMs);
  timer.unref?.();
}
