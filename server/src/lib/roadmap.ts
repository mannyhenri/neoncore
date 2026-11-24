/**
 * THE ROADMAP: VISION → EPICS → FEATURES, ON A TIMELINE.
 *
 * A project used to hold its features directly, sorted into four columns (Now / Next / Later /
 * Done). That is a status board, not a plan: it says nothing about WHEN, about what belongs
 * together, or about what has to come first. This adds the three things a plan needs, on top of
 * the features that already exist — it stores no second copy of a feature:
 *
 *   vision        one statement on the project: where it is going
 *   epic          a body of work under the vision (a row of the `epics` table): a name, the
 *                 outcome it delivers, a glyph, an order — and, like a feature, the date it is
 *                 due and the epics it waits on (epics.target_date, depends_on)
 *   on a feature  which epic it is in, when it starts and when it is due, and which features it
 *                 waits on (goals.epic_id, start_date, target_date, depends_on)
 *
 * Everything the chart shows is DERIVED here from those records and the feature's own state
 * (lib/project-spec.ts — the same status the Spec tab shows), so the chart cannot disagree with
 * the rest of the project:
 *
 *   planned     nothing has started
 *   under-way   its pipeline is running or paused
 *   delivered   its pipeline finished, or it was marked done
 *   late        not delivered, and its target date has passed
 *
 * A feature that waits on another is `blockedBy` it until that one is delivered; a dependency may
 * never loop (checked on write). An epic's `nextUp` is its earliest feature that can start now —
 * what "Start next" launches. An EPIC that waits on another is `blockedBy` it the same way, and
 * offers nothing to start until that one is delivered; it is `onTime` when every feature in it was
 * delivered on or before the epic's date (a commendation — lib/project-rewards.ts), and `late`
 * when the date has passed and it is not. Features imported as "what the product already does" are not plans
 * and are not on the chart.
 */
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { buildProjectSpec, epicQaOf, type EpicQa, type SpecFeature } from './project-spec.js';
import { epicQaBlock, epicQaRunSummary, cleanQaCommand, type EpicQaRunSummary } from './qa/epic-qa-store.js';

export class RoadmapError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

// ── schema ────────────────────────────────────────────────────────────────────
// Kept with the code that owns it, and safe to run on every start.
db.exec(`
  CREATE TABLE IF NOT EXISTS epics (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_epics_project ON epics(project_id, position);
`);
for (const [table, column, type] of [
  ['projects', 'vision', "TEXT NOT NULL DEFAULT ''"],
  ['goals', 'epic_id', "TEXT NOT NULL DEFAULT ''"],
  ['goals', 'start_date', "TEXT NOT NULL DEFAULT ''"],
  ['goals', 'depends_on', "TEXT NOT NULL DEFAULT '[]'"],
  // The gate that closes an epic (a phase's exit criterion) — written from a planning document (lib/plan-scope.ts).
  ['epics', 'done_when', "TEXT NOT NULL DEFAULT ''"],
  // EPIC QA: when the epic's work passed QA as a whole ('' = not yet). Its done features sit in the Board's QA column until then.
  ['epics', 'qa_passed_at', "TEXT NOT NULL DEFAULT ''"],
  // An epic's own date, and the epics it waits on.
  ['epics', 'target_date', "TEXT NOT NULL DEFAULT ''"],
  ['epics', 'depends_on', "TEXT NOT NULL DEFAULT '[]'"],
  // EPIC QA FOR ANY PROJECT (lib/qa/epic-acceptance.ts): the command that proves an epic as a whole
  // (a phase gate) — the project's default, and an epic's own override.
  ['projects', 'qa_command', "TEXT NOT NULL DEFAULT ''"],
  ['epics', 'qa_command', "TEXT NOT NULL DEFAULT ''"],
] as const) {
  const has = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// ── types ─────────────────────────────────────────────────────────────────────

export const FEATURE_STATES = ['planned', 'under-way', 'delivered', 'late'] as const;
export type FeatureState = (typeof FEATURE_STATES)[number];

export interface ChartFeature {
  id: string;
  name: string;
  slug: string;
  state: FeatureState;
  epicId: string;
  /** YYYY-MM-DD, or '' when it has none. */
  startDate: string;
  targetDate: string;
  /** When it was delivered or marked done. */
  completedAt: string | null;
  /** Features of this project it waits on. */
  dependsOn: string[];
  /** Those of `dependsOn` that are not delivered yet — empty means it can start. */
  blockedBy: string[];
  /** The epics its OWN epic waits on that are not delivered yet: they must be done before it can be. */
  waitsOnEpics: string[];
  summary: string;
}

export interface ChartEpic {
  id: string;
  name: string;
  outcome: string;
  /** The gate that closes it — '' when none was given. */
  doneWhen: string;
  /** Its QA as a whole (project-spec.ts epicQaOf): none · open · waiting · passed. */
  qa: EpicQa;
  /** When it passed QA ('' = not yet). */
  qaPassedAt: string;
  /** Its QA run for the current finish (lib/qa/epic-acceptance.ts) — null when it has not run since it finished. */
  qaRun: EpicQaRunSummary | null;
  /** The epic's own QA command ('' = the project's default applies). */
  qaCommand: string;
  icon: string;
  position: number;
  /** Along the timeline: dated features by date, then the undated ones in list order. */
  features: ChartFeature[];
  progress: { done: number; total: number };
  /** The earliest feature of this epic that can start now, or null — always null while the epic is blocked. */
  nextUp: string | null;
  /** YYYY-MM-DD the epic is due, or '' when it has none. */
  targetDate: string;
  /** Epics of this project it waits on. */
  dependsOn: string[];
  /** Those of `dependsOn` that are not delivered yet — empty means its features can start. */
  blockedBy: string[];
  /** When its last feature was delivered — null until every feature of it is (an epic with none is not delivered). */
  deliveredAt: string | null;
  /** Delivered on or before its date: a commendation. Never true without a date. */
  onTime: boolean;
  /** Its date has passed and it is not delivered. */
  late: boolean;
}

export interface RoadmapChart {
  project: { id: string; name: string };
  vision: string;
  epics: ChartEpic[];
  /** Features in no epic yet. */
  unassigned: ChartFeature[];
  /** The window the chart draws: whole months that hold today and every dated feature. */
  range: { from: string; to: string };
  today: string;
  totals: Record<FeatureState, number>;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A real calendar day as YYYY-MM-DD, '' for none; anything else is refused rather than guessed. */
function dateOrThrow(value: unknown, what: string): string {
  const s = String(value ?? '').trim();
  if (s === '') return '';
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && day(Date.parse(`${s}T00:00:00Z`)) === s;
  if (!ok) throw new RoadmapError(`${what} must be a date like 2026-12-24`);
  return s;
}

function parseIds(stored: unknown): string[] {
  try {
    const v = JSON.parse(String(stored || '[]'));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch { return []; }
}

function goalRow(goalId: string): Record<string, unknown> {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown> | undefined;
  if (!g) throw new RoadmapError('feature not found', 404);
  return g;
}

function epicRow(epicId: string): Record<string, unknown> {
  const e = db.prepare('SELECT * FROM epics WHERE id = ?').get(epicId) as Record<string, unknown> | undefined;
  if (!e) throw new RoadmapError('epic not found', 404);
  return e;
}

function requireProject(projectId: string): void {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new RoadmapError('project not found', 404);
}

function stateOf(f: SpecFeature, today: string): FeatureState {
  if (f.status === 'done' || f.status === 'delivered') return 'delivered';
  if (f.targetDate && f.targetDate < today) return 'late';
  return f.status === 'in-progress' || f.status === 'paused' ? 'under-way' : 'planned';
}

/** Dated features first, by date; then the rest in the project's own order. */
function alongTheTimeline(a: ChartFeature & { position: number }, b: ChartFeature & { position: number }): number {
  const ka = a.targetDate || a.completedAt?.slice(0, 10) || '';
  const kb = b.targetDate || b.completedAt?.slice(0, 10) || '';
  if (ka && kb && ka !== kb) return ka < kb ? -1 : 1;
  if (ka && !kb) return -1;
  if (!ka && kb) return 1;
  return a.position - b.position;
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
function monthEnd(d: string): string {
  const [y, m] = d.split('-').map(Number);
  return day(Date.UTC(y, m, 0));
}
function addMonths(d: string, n: number): string {
  const [y, m] = d.split('-').map(Number);
  return day(Date.UTC(y, m - 1 + n, 1));
}

// ── the chart ─────────────────────────────────────────────────────────────────

export function chartOf(projectId: string, now: number = Date.now()): RoadmapChart | null {
  const spec = buildProjectSpec(projectId);
  if (!spec) return null;
  const today = day(now);
  const rows = new Map((db.prepare('SELECT id, epic_id, start_date, depends_on FROM goals WHERE project_id = ?').all(projectId) as Record<string, unknown>[])
    .map((r) => [r.id as string, r]));
  const planned = spec.features.filter((f) => f.status !== 'existing');
  const ids = new Set(planned.map((f) => f.id));

  const features = planned.map((f) => {
    const row = rows.get(f.id) ?? {};
    return {
      id: f.id, name: f.name, slug: f.slug, state: stateOf(f, today),
      epicId: String(row.epic_id || ''), startDate: String(row.start_date || ''), targetDate: f.targetDate || '',
      completedAt: f.completedAt, dependsOn: parseIds(row.depends_on).filter((id) => ids.has(id)), blockedBy: [] as string[], waitsOnEpics: [] as string[],
      summary: f.intent.summary, position: f.position, specStatus: f.status,
    };
  });
  // NEEDS FIRST. A feature MARKED done is delivered, for good — reopening something it needed later
  // does not undo it. One whose pipeline finished is delivered only once everything it needs is: the
  // features it depends on, and every epic its own epic depends on. Settled until nothing changes,
  // so a chain of them settles all the way down.
  const epicRowsAll = db.prepare('SELECT id, depends_on FROM epics WHERE project_id = ?').all(projectId) as { id: string; depends_on: string }[];
  const knownEpics = new Set(epicRowsAll.map((e) => e.id));
  const epicNeeds = new Map(epicRowsAll.map((e) => [e.id, parseIds(e.depends_on).filter((id) => knownEpics.has(id) && id !== e.id)]));
  const delivered = new Set(features.filter((f) => f.state === 'delivered').map((f) => f.id));
  const epicDone = (id: string) => { const mine = features.filter((f) => f.epicId === id); return mine.length > 0 && mine.every((f) => delivered.has(f.id)); };
  for (let changed = true; changed;) {
    changed = false;
    for (const f of features) {
      if (!delivered.has(f.id) || f.specStatus === 'done') continue;
      const unmet = f.dependsOn.some((id) => !delivered.has(id)) || (epicNeeds.get(f.epicId) ?? []).some((id) => !epicDone(id));
      if (unmet) { delivered.delete(f.id); f.state = f.targetDate && f.targetDate < today ? 'late' : 'under-way'; f.completedAt = null; changed = true; }
    }
  }
  for (const f of features) {
    f.blockedBy = f.dependsOn.filter((id) => !delivered.has(id));
    f.waitsOnEpics = (epicNeeds.get(f.epicId) ?? []).filter((id) => !epicDone(id));
  }

  const strip = ({ position: _p, specStatus: _s, ...f }: (typeof features)[number]): ChartFeature => { void _p; void _s; return f; };
  const epicRows = db.prepare('SELECT * FROM epics WHERE project_id = ? ORDER BY position, created_at').all(projectId) as Record<string, unknown>[];
  const known = new Set(epicRows.map((e) => e.id as string));
  const epicFeatures = new Map(epicRows.map((e) => [e.id as string, features.filter((f) => f.epicId === e.id).sort(alongTheTimeline)]));
  // Delivered: it has features and every one of them is — on the day the last one was.
  const epicDelivered = new Map<string, string>();
  for (const [id, mine] of epicFeatures) {
    if (mine.length > 0 && mine.every((f) => f.state === 'delivered')) epicDelivered.set(id, mine.map((f) => f.completedAt ?? '').sort().pop() ?? '');
  }
  const epics: ChartEpic[] = epicRows.map((e) => {
    const mine = epicFeatures.get(e.id as string) ?? [];
    const targetDate = String(e.target_date || '');
    const dependsOn = parseIds(e.depends_on).filter((id) => known.has(id) && id !== e.id);
    const blockedBy = dependsOn.filter((id) => !epicDelivered.has(id));
    const deliveredAt = epicDelivered.has(e.id as string) ? epicDelivered.get(e.id as string) || null : null;
    const isDelivered = epicDelivered.has(e.id as string);
    // A blocked epic offers nothing: what it waits on comes first.
    const next = blockedBy.length > 0 ? undefined : mine.find((f) => (f.state === 'planned' || f.state === 'late') && f.blockedBy.length === 0 && f.waitsOnEpics.length === 0 && !isUnderWay(f.id));
    return {
      targetDate, dependsOn, blockedBy, deliveredAt,
      onTime: isDelivered && !!targetDate && !!deliveredAt && deliveredAt.slice(0, 10) <= targetDate,
      late: !isDelivered && !!targetDate && targetDate < today,
      id: e.id as string, name: e.name as string, outcome: (e.outcome as string) || '', doneWhen: (e.done_when as string) || '', icon: (e.icon as string) || '',
      qa: epicQaOf(e.id as string), qaPassedAt: String(e.qa_passed_at || ''),
      qaRun: epicQaRunSummary(e.id as string), qaCommand: String(e.qa_command || ''),
      position: (e.position as number) || 0,
      features: mine.map(strip),
      progress: { done: mine.filter((f) => f.state === 'delivered').length, total: mine.length },
      nextUp: next?.id ?? null,
    };
  });
  // A feature whose epic is gone is unassigned, never lost.
  const unassigned = features.filter((f) => !known.has(f.epicId)).sort(alongTheTimeline).map((f) => ({ ...strip(f), epicId: '', waitsOnEpics: [] }));

  const dates = features.flatMap((f) => [f.startDate, f.targetDate, f.completedAt?.slice(0, 10) ?? '']).concat(epics.map((e) => e.targetDate)).filter(Boolean).concat(today).sort();
  const totals = Object.fromEntries(FEATURE_STATES.map((s) => [s, features.filter((f) => f.state === s).length])) as Record<FeatureState, number>;
  return {
    project: { id: projectId, name: spec.project.name },
    vision: String((db.prepare('SELECT vision FROM projects WHERE id = ?').get(projectId) as { vision?: string } | undefined)?.vision || ''),
    epics, unassigned,
    // A month of room before the first date and two after the last, so nothing sits on the edge.
    range: { from: monthStart(addMonths(dates[0], -1)), to: monthEnd(addMonths(dates[dates.length - 1], 2)) },
    today, totals,
  };
}

/** A late feature may already be running: "next up" must not offer to start it again. */
function isUnderWay(goalId: string): boolean {
  const p = db.prepare("SELECT phase FROM goal_pilots WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1").get(goalId) as { phase?: string } | undefined;
  return !!p && !['cancelled', 'completed'].includes(String(p.phase));
}

// ── planning ──────────────────────────────────────────────────────────────────

export function setVision(projectId: string, vision: unknown): void {
  requireProject(projectId);
  db.prepare('UPDATE projects SET vision = ?, updated_at = ? WHERE id = ?').run(String(vision ?? '').trim().slice(0, 2000), nowIso(), projectId);
}

/**
 * The epics an epic waits on: of the same project, never itself, and never in a circle — from each
 * one it would wait on, you must not be able to get back to it. Checked on write, like a feature's.
 */
function epicDependsOrThrow(projectId: string, epicId: string | null, input: unknown): string[] {
  const wanted = [...new Set(Array.isArray(input) ? input.map(String).filter(Boolean) : [])];
  const all = new Map((db.prepare('SELECT id, depends_on FROM epics WHERE project_id = ?').all(projectId) as { id: string; depends_on: string }[])
    .map((r) => [r.id, parseIds(r.depends_on)]));
  for (const id of wanted) {
    if (id === epicId) throw new RoadmapError('an epic cannot wait on itself');
    if (!all.has(id)) throw new RoadmapError('an epic can only wait on another epic of the same project');
  }
  if (epicId) {
    all.set(epicId, wanted);
    const seen = new Set<string>();
    const reaches = (from: string): boolean => {
      if (from === epicId) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (all.get(from) ?? []).some(reaches);
    };
    if (wanted.some(reaches)) throw new RoadmapError('that would make the epics wait on each other in a circle');
  }
  return wanted;
}

export function createEpic(projectId: string, input: { name?: unknown; outcome?: unknown; icon?: unknown; targetDate?: unknown; dependsOn?: unknown }): { id: string } {
  requireProject(projectId);
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new RoadmapError('an epic needs a name');
  const targetDate = dateOrThrow(input.targetDate, "the epic's date");
  const dependsOn = epicDependsOrThrow(projectId, null, input.dependsOn);
  const id = uuid();
  const position = ((db.prepare('SELECT MAX(position) AS p FROM epics WHERE project_id = ?').get(projectId) as { p: number | null }).p ?? -1) + 1;
  db.prepare('INSERT INTO epics (id, project_id, name, outcome, icon, position, target_date, depends_on, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, projectId, name, String(input.outcome ?? '').trim().slice(0, 600), String(input.icon ?? '').trim().slice(0, 40), position, targetDate, JSON.stringify(dependsOn), nowIso(), nowIso());
  return { id };
}

/** Only the fields given change. A date of '' clears it; `dependsOn: []` waits on nothing. */
export function updateEpic(epicId: string, input: { name?: unknown; outcome?: unknown; icon?: unknown; targetDate?: unknown; dependsOn?: unknown; qaCommand?: unknown }): void {
  const e = epicRow(epicId);
  const name = input.name === undefined ? (e.name as string) : String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new RoadmapError('an epic needs a name');
  const targetDate = input.targetDate === undefined ? String(e.target_date || '') : dateOrThrow(input.targetDate, "the epic's date");
  const dependsOn = input.dependsOn === undefined ? parseIds(e.depends_on) : epicDependsOrThrow(String(e.project_id), epicId, input.dependsOn);
  let qaCommand = String(e.qa_command || '');
  if (input.qaCommand !== undefined) {
    try { qaCommand = cleanQaCommand(input.qaCommand); } catch (err) { throw new RoadmapError((err as Error).message); }
  }
  db.prepare('UPDATE epics SET name = ?, outcome = ?, icon = ?, target_date = ?, depends_on = ?, qa_command = ?, updated_at = ? WHERE id = ?').run(
    name,
    input.outcome === undefined ? e.outcome : String(input.outcome ?? '').trim().slice(0, 600),
    input.icon === undefined ? e.icon : String(input.icon ?? '').trim().slice(0, 40),
    targetDate, JSON.stringify(dependsOn), qaCommand,
    nowIso(), epicId,
  );
}

/**
 * PASSED QA: the epic's work, QA'd as a whole — its done features move from the Board's QA column to
 * Done. Only when every feature of it is done AND its QA run passed (or had nothing to run) —
 * lib/qa/epic-qa-store.ts epicQaBlock. False takes it back, always. Passing frees the next epic's
 * features that were waiting on it (goal-pilot-runner, epicOrderWait).
 */
export function setEpicQa(epicId: string, passed: unknown): void {
  const e = epicRow(epicId);
  if (typeof passed !== 'boolean') throw new RoadmapError('qaPassed must be true or false');
  if (passed) {
    const qa = epicQaOf(epicId);
    if (qa === 'none') throw new RoadmapError('an epic with no feature has nothing to QA');
    if (qa === 'open') {
      const left = (db.prepare("SELECT COUNT(*) AS c FROM goals WHERE epic_id = ? AND status != 'achieved'").get(epicId) as { c: number }).c;
      throw new RoadmapError(`Not yet: ${left} feature${left === 1 ? '' : 's'} of "${e.name as string}" ${left === 1 ? 'is' : 'are'} not done.`, 409);
    }
    const blocked = epicQaBlock(epicId);
    if (blocked) throw new RoadmapError(`Not yet: ${blocked}`, 409);
  }
  db.prepare('UPDATE epics SET qa_passed_at = ?, updated_at = ? WHERE id = ?').run(passed ? nowIso() : '', nowIso(), epicId);
  // Dynamic: goal-pilot-runner imports this module. Its 10 s sweep is the backstop.
  if (passed) {
    const waiting = (db.prepare("SELECT p.id FROM goal_pilots p JOIN goals g ON g.id = p.goal_id WHERE g.project_id = ? AND p.phase = 'running'")
      .all(e.project_id as string) as { id: string }[]).map((r) => r.id);
    if (waiting.length) void import('./goal-pilot-runner.js').then((m) => { for (const id of waiting) m.advancePilot(id); }).catch(() => {});
  }
}

/** Its features stay in the project, in no epic; an epic that waited on it no longer does. */
export function removeEpic(epicId: string): void {
  const e = epicRow(epicId);
  db.transaction(() => {
    db.prepare("UPDATE goals SET epic_id = '' WHERE epic_id = ?").run(epicId);
    for (const other of db.prepare('SELECT id, depends_on FROM epics WHERE project_id = ? AND id != ?').all(e.project_id as string, epicId) as { id: string; depends_on: string }[]) {
      const waits = parseIds(other.depends_on);
      if (waits.includes(epicId)) db.prepare('UPDATE epics SET depends_on = ? WHERE id = ?').run(JSON.stringify(waits.filter((id) => id !== epicId)), other.id);
    }
    db.prepare('DELETE FROM epics WHERE id = ?').run(epicId);
  })();
}

export function reorderEpics(projectId: string, ids: unknown): void {
  requireProject(projectId);
  const mine = new Set((db.prepare('SELECT id FROM epics WHERE project_id = ?').all(projectId) as { id: string }[]).map((r) => r.id));
  const order = Array.isArray(ids) ? ids.map(String) : [];
  if (order.length !== mine.size || new Set(order).size !== order.length || order.some((id) => !mine.has(id))) {
    throw new RoadmapError('the order must list every epic of this project exactly once');
  }
  db.transaction(() => order.forEach((id, i) => db.prepare('UPDATE epics SET position = ? WHERE id = ?').run(i, id)))();
}

/**
 * Plan one feature: its epic, its dates, what it waits on. Only the fields given change.
 * `epicId: ''` takes it out of its epic; a date of '' clears it.
 */
export function planFeature(goalId: string, input: { epicId?: unknown; startDate?: unknown; targetDate?: unknown; dependsOn?: unknown }): void {
  const g = goalRow(goalId);
  const projectId = String(g.project_id || '');

  let epicId = String(g.epic_id || '');
  if (input.epicId !== undefined) {
    epicId = String(input.epicId ?? '');
    if (epicId && epicRow(epicId).project_id !== projectId) throw new RoadmapError('that epic belongs to another project');
  }

  const targetDate = input.targetDate === undefined ? String(g.target_date || '') : dateOrThrow(input.targetDate, 'the target date');
  const startDate = input.startDate === undefined ? String(g.start_date || '') : dateOrThrow(input.startDate, 'the start date');
  if (startDate && targetDate && startDate > targetDate) throw new RoadmapError('a feature cannot start after its target date');

  let dependsOn = parseIds(g.depends_on);
  if (input.dependsOn !== undefined) {
    dependsOn = [...new Set(Array.isArray(input.dependsOn) ? input.dependsOn.map(String).filter(Boolean) : [])];
    const siblings = new Map((db.prepare('SELECT id, depends_on FROM goals WHERE project_id = ?').all(projectId) as { id: string; depends_on: string }[])
      .map((r) => [r.id, parseIds(r.depends_on)]));
    if (dependsOn.includes(goalId)) throw new RoadmapError('a feature cannot depend on itself');
    for (const id of dependsOn) if (!siblings.has(id)) throw new RoadmapError('a feature can only wait on another feature of the same project');
    // Acyclic, checked on write: from each thing it would wait on, can you get back to it?
    siblings.set(goalId, dependsOn);
    const seen = new Set<string>();
    const reaches = (from: string): boolean => {
      if (from === goalId) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (siblings.get(from) ?? []).some(reaches);
    };
    if (dependsOn.some(reaches)) throw new RoadmapError('that would make the features wait on each other in a circle');
  }

  db.prepare('UPDATE goals SET epic_id = ?, start_date = ?, target_date = ?, depends_on = ?, updated_at = ? WHERE id = ?')
    .run(epicId, startDate, targetDate, JSON.stringify(dependsOn), nowIso(), goalId);
}

/**
 * Where a feature fits, for the cartridges that build it: the project's vision, its epic and the
 * outcome that epic delivers, and what it builds on. '' when the project has planned none of that.
 */
export function roadmapContextFor(goalId: string): string {
  const g = db.prepare('SELECT project_id, epic_id, depends_on FROM goals WHERE id = ?').get(goalId) as Record<string, unknown> | undefined;
  if (!g) return '';
  const vision = String((db.prepare('SELECT vision FROM projects WHERE id = ?').get(g.project_id as string) as { vision?: string } | undefined)?.vision || '').trim();
  const epic = g.epic_id ? db.prepare('SELECT name, outcome, done_when FROM epics WHERE id = ?').get(g.epic_id as string) as { name: string; outcome: string; done_when: string } | undefined : undefined;
  const builtOn = parseIds(g.depends_on)
    .map((id) => (db.prepare('SELECT name FROM goals WHERE id = ?').get(id) as { name?: string } | undefined)?.name)
    .filter((x): x is string => !!x);
  const lines: string[] = [];
  if (vision) lines.push(`Vision: ${vision}`);
  if (epic) lines.push(`Epic: ${epic.name}${epic.outcome ? ` — ${epic.outcome}` : ''}${epic.done_when ? ` (done when: ${epic.done_when})` : ''}`);
  if (builtOn.length) lines.push(`Builds on (already delivered, or planned before this): ${builtOn.join('; ')}`);
  return lines.join('\n');
}

// ── needs first ───────────────────────────────────────────────────────────────

export interface Named { id: string; name: string }
export interface UnmetNeeds { features: Named[]; epics: Named[] }

/**
 * What a feature still needs before it can be marked done: the features it depends on that are not
 * done, and the epics its epic depends on that are not delivered — in plan order. null: no feature.
 */
export function unmetNeeds(goalId: string, now: number = Date.now()): UnmetNeeds | null {
  const g = db.prepare('SELECT project_id FROM goals WHERE id = ?').get(goalId) as { project_id?: string } | undefined;
  if (!g) return null;
  const chart = g.project_id ? chartOf(g.project_id, now) : null;
  const f = chart && [...chart.epics.flatMap((e) => e.features), ...chart.unassigned].find((x) => x.id === goalId);
  if (!chart || !f) return { features: [], epics: [] };
  const name = new Map([...chart.epics.flatMap((e) => e.features), ...chart.unassigned].map((x) => [x.id, x.name]));
  const epicName = new Map(chart.epics.map((e) => [e.id, e.name]));
  return {
    features: f.blockedBy.map((id) => ({ id, name: name.get(id) ?? 'another feature' })),
    epics: f.waitsOnEpics.map((id) => ({ id, name: epicName.get(id) ?? 'another epic' })),
  };
}

/** `Not yet: "Points per visit" and the epic "Online ordering" must be done first.` — '' when nothing is missing. */
export function notYetMessage(u: UnmetNeeds): string {
  const parts = [...u.features.map((f) => `"${f.name}"`), ...u.epics.map((e) => `the epic "${e.name}"`)];
  if (parts.length === 0) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Not yet: ${list} must be done first.`;
}

/** Refuse marking a feature done while anything it needs is not. */
export function assertCanBeDone(goalId: string, now: number = Date.now()): void {
  const u = unmetNeeds(goalId, now);
  const msg = u ? notYetMessage(u) : '';
  if (msg) throw new RoadmapError(msg, 409);
}

/**
 * What a feature's "Needs first" panel offers: the other features of its project (not the ones
 * imported as what the product already does), minus every feature that already depends on it —
 * directly or through a chain — since choosing one would make a loop.
 */
export function needsCandidates(goalId: string): (Named & { state: FeatureState })[] {
  const g = db.prepare('SELECT project_id FROM goals WHERE id = ?').get(goalId) as { project_id?: string } | undefined;
  if (!g?.project_id) return [];
  const chart = chartOf(g.project_id);
  if (!chart) return [];
  const all = [...chart.epics.flatMap((e) => e.features), ...chart.unassigned];
  const deps = new Map(all.map((f) => [f.id, f.dependsOn]));
  const reaches = (from: string, seen = new Set<string>()): boolean => {
    if (from === goalId) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (deps.get(from) ?? []).some((id) => reaches(id, seen));
  };
  return all.filter((f) => f.id !== goalId && !reaches(f.id)).map((f) => ({ id: f.id, name: f.name, state: f.state }));
}

/** A feature is going away: nothing waits on it any more. */
export function forgetFeature(goalId: string): void {
  const g = db.prepare('SELECT project_id FROM goals WHERE id = ?').get(goalId) as { project_id?: string } | undefined;
  if (!g) return;
  for (const r of db.prepare('SELECT id, depends_on FROM goals WHERE project_id = ? AND id != ?').all(g.project_id ?? '', goalId) as { id: string; depends_on: string }[]) {
    const ids = parseIds(r.depends_on);
    if (ids.includes(goalId)) db.prepare('UPDATE goals SET depends_on = ? WHERE id = ?').run(JSON.stringify(ids.filter((id) => id !== goalId)), r.id);
  }
}
