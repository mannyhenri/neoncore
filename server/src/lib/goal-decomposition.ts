/**
 * DECOMPOSITION: goal → projects → tasks, as a proposal a person accepts item by item.
 *
 * This is the "stop me typing each task" half of what the user asked for: a goal goes in, a
 * structured set of candidate projects and tasks comes back, and accepting them creates real
 * rows instead of a document someone re-types.
 *
 * It reuses Phase 4's contract exactly — dispatch to a cartridge, submit through MCP, review,
 * accept per item — because the safety property is the same and stronger here. A draft proposes
 * TEXT for a goal that already exists; a decomposition CREATES projects and tasks, and those
 * tasks get dispatched to cartridges that do real work. Nothing may be created without a person
 * naming it.
 *
 * ── VALIDATION IS THE FEATURE, NOT A FORMALITY ─────────────────────────────────────────
 * The point of a structured format (GOAL-041) is that output can be INSERTED rather than
 * re-read by a human. That only holds if the shape is guaranteed, so everything a cartridge
 * sends goes through `normalizeProposal`, which drops what it cannot use and RECORDS what it
 * dropped. Silent truncation would read as "the model proposed exactly this", which is the
 * worst possible lie in a surface whose entire job is review.
 *
 * ── DEPENDENCIES DO SOMETHING TODAY ────────────────────────────────────────────────────
 * Two mechanisms, and it matters which is which. Accept derives each task's `priority` from its
 * dependency DEPTH, so roots SORT ahead of dependents — that is ordering, not enforcement, and
 * it is why a single cartridge draining the queue looks correctly ordered even when nothing is
 * checking. Enforcement is `lib/task-dependencies.ts`, which every path that can start a task
 * now consults, so a dependent cannot begin while its prerequisite is unfinished.
 *
 * This paragraph used to read "Nothing enforces task ordering until Phase 6." That sentence
 * outlived the gate and became the opposite of load-bearing: two readers could grep this repo
 * and reach opposite conclusions depending on which comment they hit first.
 */
import db from '../db.js';
import { randomUUID } from 'crypto';
import { autonomyBriefLine } from './goal-pm.js';
import { cloneTemplateAsRun } from './workflow-from-template.js';

/** Caps. A runaway proposal is a review surface nobody can read, which means nobody reviews it. */
export const MAX_PROJECTS = 8;
export const MAX_TASKS_PER_PROJECT = 20;

export interface ProposedTask {
  /** Stable within the proposal. Used by dependsOn and by per-item accept. */
  key: string;
  title: string;
  prompt: string;
  size: 'S' | 'M' | 'L';
  /** Keys of tasks in THIS proposal that must finish first. */
  dependsOn: string[];
  /**
   * A workflow template to RUN for this item, by name, or '' for a plain task.
   *
   * Asked for: "pick and choose what I want to do as part of the workflows". The planner had no
   * idea the templates existed, so every item was a free-form prompt and the most capable thing
   * in the system was unselectable. Validated against the live template rows, never trusted.
   */
  template: string;
}

export interface ProposedProject {
  key: string;
  name: string;
  description: string;
  primaryRepo: string;
  tasks: ProposedTask[];
}

export interface Proposal {
  projects: ProposedProject[];
}

export interface NormalizedProposal {
  proposal: Proposal;
  /** Everything dropped or altered, in words. Shown to the user; never swallowed. */
  notes: string[];
}

const SIZES = new Set(['S', 'M', 'L']);

/**
 * The templates a plan may choose from — read from the DATABASE, not from a constant.
 *
 * `STANDARD_TEMPLATE_NAMES` is what gets seeded, but a user can rename or delete one, and a
 * plan that offers a template which no longer exists produces an item that silently creates
 * nothing on acceptance. The live rows are the only honest source.
 */
export function availableTemplates(): { id: string; name: string }[] {
  return db.prepare(
    'SELECT id, name FROM workflows WHERE template_id IS NULL ORDER BY name',
  ).all() as { id: string; name: string }[];
}

/** The template row for a name, or null. Case-insensitive: models re-case titles constantly. */
export function templateIdForName(name: string): string | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  return availableTemplates().find((t) => t.name.toLowerCase() === want)?.id ?? null;
}

/**
 * The setup answers behind a task, formatted for dispatch.
 *
 * Resolved through `origin_decomposition_id` rather than copied onto the task, so there is one
 * copy of the context and it cannot drift from the decomposition it came from. Empty for any
 * task that did not come from a plan — an ordinary task must not gain a stray header.
 */
export function decompositionContextFor(taskId: string): string {
  const row = db.prepare(
    `SELECT d.seed FROM tasks t
       JOIN goal_decompositions d ON d.id = t.origin_decomposition_id
      WHERE t.id = ?`,
  ).get(taskId) as { seed?: string } | undefined;
  const seed = (row?.seed || '').trim();
  return seed ? `[Context given when this work was planned]\n${seed}` : '';
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Coerce whatever a cartridge sent into a shape that can be inserted, and say what was lost.
 *
 * Deliberately lenient about EXTRA (unknown keys dropped, missing size defaulted) and strict
 * about ESSENTIAL (no name → no project; no title → no task). A model that volunteers a field
 * should not fail the whole decomposition, but a row with no title cannot become a task.
 */
export function normalizeProposal(raw: unknown): NormalizedProposal {
  const notes: string[] = [];
  const empty: NormalizedProposal = { proposal: { projects: [] }, notes };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    notes.push('the submission was not an object');
    return empty;
  }
  const rawProjects = (raw as { projects?: unknown }).projects;
  if (!Array.isArray(rawProjects)) {
    notes.push('no projects array was provided');
    return empty;
  }

  if (rawProjects.length > MAX_PROJECTS) {
    notes.push(`${rawProjects.length} projects proposed; kept the first ${MAX_PROJECTS}`);
  }

  const projectKeys = new Set<string>();
  const projects: ProposedProject[] = [];

  rawProjects.slice(0, MAX_PROJECTS).forEach((rp, pi) => {
    if (!rp || typeof rp !== 'object' || Array.isArray(rp)) {
      notes.push(`project ${pi + 1} was not an object — dropped`);
      return;
    }
    const p = rp as Record<string, unknown>;
    const name = str(p.name);
    if (!name) {
      notes.push(`project ${pi + 1} had no name — dropped`);
      return;
    }

    // Keys must be unique to address items during review; fall back to a positional one.
    let key = str(p.key) || `p${pi + 1}`;
    if (projectKeys.has(key)) {
      const fresh = `p${pi + 1}`;
      notes.push(`project key "${key}" was reused — renamed to "${fresh}"`);
      key = fresh;
    }
    projectKeys.add(key);

    const rawTasks = Array.isArray(p.tasks) ? p.tasks : [];
    if (Array.isArray(p.tasks) && p.tasks.length > MAX_TASKS_PER_PROJECT) {
      notes.push(`"${name}" proposed ${p.tasks.length} tasks; kept the first ${MAX_TASKS_PER_PROJECT}`);
    }

    const taskKeys = new Set<string>();
    const tasks: ProposedTask[] = [];
    rawTasks.slice(0, MAX_TASKS_PER_PROJECT).forEach((rt, ti) => {
      if (!rt || typeof rt !== 'object' || Array.isArray(rt)) return;
      const t = rt as Record<string, unknown>;
      const title = str(t.title);
      if (!title) {
        notes.push(`a task under "${name}" had no title — dropped`);
        return;
      }
      let tkey = str(t.key) || `${key}.t${ti + 1}`;
      if (taskKeys.has(tkey)) {
        const fresh = `${key}.t${ti + 1}`;
        notes.push(`task key "${tkey}" was reused — renamed to "${fresh}"`);
        tkey = fresh;
      }
      taskKeys.add(tkey);

      const size = str(t.size).toUpperCase();
      // A named template must resolve to a live row. An unknown one is dropped rather than
      // stored, because an item pointing at a template that does not exist creates nothing at
      // acceptance — and does it silently, which is the worst version of the failure.
      let template = str(t.template);
      if (template && !templateIdForName(template)) {
        notes.push(`"${title}" asked for the "${template}" workflow, which does not exist — it will run as a plain task`);
        template = '';
      }
      tasks.push({
        key: tkey,
        template,
        title,
        // A task with no prompt is dispatchable but useless; fall back to the title so the
        // cartridge at least receives the ask.
        prompt: str(t.prompt) || title,
        size: SIZES.has(size) ? (size as ProposedTask['size']) : 'M',
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(str).filter(Boolean) : [],
      });
    });

    projects.push({
      key,
      name,
      description: str(p.description),
      primaryRepo: str(p.primaryRepo),
      tasks,
    });
  });

  resolveDependencies(projects, notes);
  return { proposal: { projects }, notes };
}

/**
 * Make `dependsOn` mean something: drop what cannot be satisfied, and break cycles.
 *
 * Edges are resolved across the WHOLE proposal, not per project — a real decomposition has
 * tasks in one project waiting on another. An unresolvable or circular edge is not a cosmetic
 * problem: acceptance derives queue priority from depth, so a cycle would produce an ordering
 * that cannot exist and tasks that never sort to the front.
 */
function resolveDependencies(projects: ProposedProject[], notes: string[]): void {
  const all = new Map<string, ProposedTask>();
  for (const p of projects) for (const t of p.tasks) all.set(t.key, t);

  for (const t of all.values()) {
    const kept: string[] = [];
    for (const dep of t.dependsOn) {
      if (dep === t.key) {
        notes.push(`"${t.title}" depended on itself — removed`);
        continue;
      }
      if (!all.has(dep)) {
        notes.push(`"${t.title}" depended on "${dep}", which is not in the proposal — removed`);
        continue;
      }
      if (!kept.includes(dep)) kept.push(dep);
    }
    t.dependsOn = kept;
  }

  // Break cycles by removing the edge that closes one. Iterative rather than recursive so a
  // deeply nested proposal cannot blow the stack.
  const state = new Map<string, 0 | 1 | 2>();   // 0 unvisited, 1 on stack, 2 done
  const visit = (key: string, stack: string[]): void => {
    state.set(key, 1);
    const task = all.get(key)!;
    for (const dep of [...task.dependsOn]) {
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        notes.push(`circular dependency between "${task.title}" and "${all.get(dep)!.title}" — link removed`);
        task.dependsOn = task.dependsOn.filter((d) => d !== dep);
        continue;
      }
      if (s === 0) visit(dep, [...stack, key]);
    }
    state.set(key, 2);
  };
  for (const key of all.keys()) if ((state.get(key) ?? 0) === 0) visit(key, []);
}

/**
 * How deep each task sits in the dependency graph. Roots are 0.
 *
 * This is what turns a stored edge into behaviour: `priority` is derived from it at accept, so
 * the queue runs prerequisites before dependents without anything else being built.
 */
export function dependencyDepths(proposal: Proposal): Map<string, number> {
  const all = new Map<string, ProposedTask>();
  for (const p of proposal.projects) for (const t of p.tasks) all.set(t.key, t);

  const depth = new Map<string, number>();
  const compute = (key: string, seen: Set<string>): number => {
    if (depth.has(key)) return depth.get(key)!;
    const task = all.get(key);
    if (!task || seen.has(key)) return 0;
    seen.add(key);
    const d = task.dependsOn.length
      ? Math.max(...task.dependsOn.map((dep) => compute(dep, seen) + 1))
      : 0;
    depth.set(key, d);
    return d;
  };
  for (const key of all.keys()) compute(key, new Set());
  return depth;
}

// ── record ────────────────────────────────────────────────────────────────────

export interface GoalDecomposition {
  id: string;
  goalId: string;
  seed: string;
  status: 'pending' | 'ready' | 'failed';
  agentId: string;
  proposal: Proposal;
  notes: string[];
  error: string;
  createdAt: string;
  completedAt: string | null;
  /** Null until a person accepts. Nothing exists in projects/tasks before this is set. */
  acceptedAt: string | null;
  createdProjects: string[];
  createdTasks: string[];
}

function rowTo(row: Record<string, unknown>): GoalDecomposition {
  const parse = <T>(s: unknown, fb: T): T => {
    try { return JSON.parse((s as string) || ''); } catch { return fb; }
  };
  return {
    id: row.id as string,
    goalId: row.goal_id as string,
    seed: (row.seed as string) || '',
    status: ((row.status as string) || 'pending') as GoalDecomposition['status'],
    agentId: (row.agent_id as string) || '',
    proposal: parse<Proposal>(row.proposal, { projects: [] }),
    notes: parse<string[]>(row.notes, []),
    error: (row.error as string) || '',
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string) ?? null,
    acceptedAt: (row.accepted_at as string) ?? null,
    createdProjects: parse<string[]>(row.created_projects, []),
    createdTasks: parse<string[]>(row.created_tasks, []),
  };
}

export function createDecomposition(input: { goalId: string; seed: string; agentId: string }): GoalDecomposition {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO goal_decompositions (id, goal_id, seed, status, agent_id, proposal, notes, error, created_at)
     VALUES (?,?,?,'pending',?,'{}','[]','',?)`,
  ).run(id, input.goalId, input.seed, input.agentId, new Date().toISOString());
  return getDecomposition(id)!;
}

export function getDecomposition(id: string): GoalDecomposition | null {
  const row = db.prepare('SELECT * FROM goal_decompositions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowTo(row) : null;
}

export function decompositionsForGoal(goalId: string): GoalDecomposition[] {
  const rows = db.prepare('SELECT * FROM goal_decompositions WHERE goal_id = ? ORDER BY created_at DESC')
    .all(goalId) as Record<string, unknown>[];
  return rows.map(rowTo);
}

/** Store what a cartridge produced. Creates nothing. */
export function submitDecomposition(id: string, raw: unknown): GoalDecomposition | null {
  const existing = getDecomposition(id);
  if (!existing) return null;
  const { proposal, notes } = normalizeProposal(raw);
  const usable = proposal.projects.length > 0;
  db.prepare(
    `UPDATE goal_decompositions SET status = ?, proposal = ?, notes = ?, error = ?, completed_at = ? WHERE id = ?`,
  ).run(
    usable ? 'ready' : 'failed',
    JSON.stringify(proposal),
    JSON.stringify(notes),
    usable ? '' : 'the proposal contained no usable projects',
    new Date().toISOString(),
    id,
  );
  return getDecomposition(id);
}

export function failDecomposition(id: string, error: string): void {
  db.prepare(`UPDATE goal_decompositions SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
    .run(error, new Date().toISOString(), id);
}

export class DecompositionError extends Error {}

/** The setup answers, headed so an agent knows what they are and where they came from. */
function contextFromSeed(seed: string): string {
  const s = (seed || '').trim();
  return s ? `## Context given when this work was planned\n\n${s}` : '';
}

export interface AcceptSelection {
  /** Project keys to create. */
  projectKeys: string[];
  /** Task keys to create. A task whose project was not accepted is skipped. */
  taskKeys: string[];
}

export interface AcceptResult {
  decomposition: GoalDecomposition;
  createdProjects: number;
  createdTasks: number;
  /** Template-backed items, launched as real workflow runs rather than stored as inert tasks. */
  createdRuns: number;
  skipped: string[];
}

/**
 * THE ONLY path from a proposal to real rows, and it requires a person naming each item.
 *
 * A task cannot be created without its project — accepting one would produce work attached to
 * nothing, which is the unassigned state Phase 1 exists to make visible. Rather than silently
 * creating the parent, those tasks are SKIPPED and reported.
 */
export function acceptDecomposition(id: string, selection: AcceptSelection): AcceptResult {
  const dec = getDecomposition(id);
  if (!dec) throw new DecompositionError('decomposition not found');
  if (dec.status !== 'ready') throw new DecompositionError(`decomposition is ${dec.status}, not ready`);
  if (dec.acceptedAt) throw new DecompositionError('decomposition has already been accepted');

  const wantProjects = new Set(selection.projectKeys);
  const wantTasks = new Set(selection.taskKeys);
  const chosenProjects = dec.proposal.projects.filter((p) => wantProjects.has(p.key));
  if (chosenProjects.length === 0) throw new DecompositionError('no projects were selected');

  const depths = dependencyDepths(dec.proposal);
  const skipped: string[] = [];

  // A task whose project was not accepted has nowhere to live.
  for (const p of dec.proposal.projects) {
    if (wantProjects.has(p.key)) continue;
    for (const t of p.tasks) {
      if (wantTasks.has(t.key)) skipped.push(`"${t.title}" — its project "${p.name}" was not accepted`);
    }
  }

  const now = new Date().toISOString();
  const projectIds: string[] = [];
  const taskIds: string[] = [];
  const runIds: string[] = [];
  /** Proposal key → created task id. What makes the stored dependencies resolvable later. */
  const idByKey = new Map<string, string>();

  const tx = db.transaction(() => {
    for (const p of chosenProjects) {
      const pid = randomUUID();
      db.prepare(
        `INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at, origin_decomposition_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(pid, dec.goalId, p.name, p.description, p.primaryRepo, '#8b5cf6', now, now, id);
      projectIds.push(pid);

      for (const t of p.tasks) {
        if (!wantTasks.has(t.key)) continue;

        /**
         * A template-backed item becomes a RUN, not a task.
         *
         * Storing the template choice on a task and creating the task anyway would be another
         * mechanism no data flows through — the failure this repo repeats. A run is the actual
         * work, and Phase 3's progress rollup already counts its steps, so it contributes to
         * the goal the moment it exists.
         *
         * The setup answers ride along in `initial_context`: they are the reason this item was
         * proposed, and the agent running step one should see them.
         */
        if (t.template) {
          const templateId = templateIdForName(t.template);
          if (templateId) {
            const runId = cloneTemplateAsRun(templateId, pid, contextFromSeed(dec.seed));
            if (runId) { runIds.push(runId); continue; }
          }
          // Resolved at validation but gone by acceptance (renamed or deleted in between).
          // Fall through to a plain task rather than dropping the item silently.
          skipped.push(`"${t.title}" wanted the "${t.template}" workflow, which no longer exists — created as a plain task instead`);
        }

        const tid = randomUUID();
        // Priority from dependency depth: roots first. Higher number = sooner, so negate the
        // depth. Priority alone only INFLUENCES order; the dependency gate enforces it.
        const priority = -(depths.get(t.key) ?? 0);
        db.prepare(
          `INSERT INTO tasks (id, title, prompt, project_id, status, priority, created_at, depends_on, origin_decomposition_id)
           VALUES (?,?,?,?,'queued',?,?,'[]',?)`,
        ).run(tid, t.title, t.prompt, pid, priority, now, id);
        taskIds.push(tid);
        idByKey.set(t.key, tid);
      }
    }

    /**
     * SECOND PASS: rewrite dependencies from proposal KEYS to task IDS.
     *
     * The first version stored the keys verbatim — `["bench"]` — which is unresolvable once
     * the proposal is gone, so nothing at runtime could tell whether a prerequisite had
     * finished. The column looked populated and meant nothing.
     *
     * A dependency on a task the user did NOT accept is dropped rather than left unsatisfiable:
     * declining to create the prerequisite is a decision that it is not required, and keeping
     * the edge would block the dependent forever with no way to clear it.
     */
    for (const p of chosenProjects) {
      for (const t of p.tasks) {
        const tid = idByKey.get(t.key);
        if (!tid) continue;
        const depIds = t.dependsOn.map((k) => idByKey.get(k)).filter((x): x is string => !!x);
        db.prepare('UPDATE tasks SET depends_on = ? WHERE id = ?').run(JSON.stringify(depIds), tid);
      }
    }

    db.prepare(
      `UPDATE goal_decompositions SET accepted_at = ?, created_projects = ?, created_tasks = ? WHERE id = ?`,
    ).run(now, JSON.stringify(projectIds), JSON.stringify(taskIds), id);
  });
  tx();

  return {
    decomposition: getDecomposition(id)!,
    createdProjects: projectIds.length,
    createdTasks: taskIds.length,
    createdRuns: runIds.length,
    skipped,
  };
}

export interface RevertResult {
  deletedTasks: number;
  deletedProjects: number;
  /** What was left alone, and why. A partial revert reported as total would be a lie. */
  kept: string[];
}

/**
 * Undo what a decomposition created — as far as is safe (GOAL-044, "reversible").
 *
 * Work that has already STARTED is never deleted: a task a cartridge has claimed or finished is
 * a record of real work, and a project holding one still has a reason to exist. Those are kept
 * and reported, so "reverted" never overstates what happened.
 */
export function revertDecomposition(id: string): RevertResult {
  const dec = getDecomposition(id);
  if (!dec) throw new DecompositionError('decomposition not found');
  if (!dec.acceptedAt) throw new DecompositionError('nothing was created from this decomposition');

  const kept: string[] = [];
  let deletedTasks = 0;
  let deletedProjects = 0;

  const tx = db.transaction(() => {
    for (const taskId of dec.createdTasks) {
      const t = db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(taskId) as
        { id: string; title: string; status: string } | undefined;
      if (!t) continue;
      if (t.status !== 'queued') {
        kept.push(`task "${t.title}" is ${t.status} — real work, left in place`);
        continue;
      }
      db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      deletedTasks++;
    }

    for (const projectId of dec.createdProjects) {
      const p = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
        { id: string; name: string } | undefined;
      if (!p) continue;
      const liveTasks = (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(projectId) as { n: number }).n;
      const runs = (db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE project_id = ?').get(projectId) as { n: number }).n;
      if (liveTasks > 0 || runs > 0) {
        kept.push(`project "${p.name}" still has ${liveTasks} task(s) and ${runs} run(s) — left in place`);
        continue;
      }
      // Same cascade the delete route uses: no FK on project_cartridges, so orphans are real.
      db.prepare('DELETE FROM project_cartridges WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      deletedProjects++;
    }
  });
  tx();

  return { deletedTasks, deletedProjects, kept };
}

/** The prompt. Asks for structure, and is explicit that nothing it returns is created. */
export function buildDecompositionPrompt(
  decompositionId: string,
  seed: string,
  goal: Record<string, unknown>,
): string {
  const field = (col: string, label: string) => {
    const v = goal[col];
    return typeof v === 'string' && v.trim() ? `- ${label}: ${v.replace(/\s+/g, ' ').slice(0, 400)}` : null;
  };
  /**
   * Everything the goal COMMITS to — the same set `buildGoalBrief` carries.
   *
   * The planner cannot see less than a working agent does: it is the highest-leverage read of a
   * goal in the system, since every task it proposes becomes a dispatch. And the brief cannot
   * cover for a gap here — `sendCommandToAgent` resolves the brief from the CARTRIDGE's repo,
   * and a goal being decomposed has no projects yet (that is why you are decomposing it), so
   * reach is 0 and no brief is injected. This prompt is the only carrier.
   *
   * Key results, appetite, target date and autonomy were missing for exactly that reason: they
   * reached working agents through the brief and were never added here.
   */
  const keyResults = (() => {
    try {
      const krs = JSON.parse((goal.key_results as string) || '[]') as
        { metric?: string; baseline?: string; target?: string; measure?: string }[];
      if (!Array.isArray(krs) || krs.length === 0) return null;
      const lines = krs
        .filter((k) => k?.metric)
        .map((k) => `  · ${k.metric}${k.baseline ? ` from ${k.baseline}` : ''}${k.target ? ` to ${k.target}` : ''}${k.measure ? ` (${k.measure})` : ''}`);
      return lines.length ? `- Key results — what the work is aimed at moving:\n${lines.join('\n')}` : null;
    } catch {
      return null;
    }
  })();

  const budget = goal.budget_usd != null
    ? `- Appetite: $${goal.budget_usd} — a constraint on the SHAPE of the plan, not just a cap. Propose work that fits it.`
    : null;
  const targetDate = String(goal.target_date || '').trim()
    ? `- Target date: ${String(goal.target_date).slice(0, 10)} — scope the plan to fit it, and say plainly if it will not.`
    : null;
  const autonomy = autonomyBriefLine(goal.autonomy);

  const intent = [
    field('description', 'Why this matters'),
    field('success_metric', 'Done when'),
    field('acceptance_criteria', 'Acceptance criteria'),
    field('invariants', 'Invariants'),
    field('no_gos', 'No-gos'),
    field('rabbit_holes', 'Rabbit holes'),
    keyResults,
    budget,
    targetDate,
    autonomy ? `- ${autonomy}` : null,
  ].filter(Boolean) as string[];

  return [
    'Break a NeonCore goal down into candidate PROJECTS and TASKS. You are planning, not building —',
    'do not write code, do not create anything, do not edit any file.',
    '',
    `GOAL: ${goal.name}`,
    ...(intent.length
      ? ['', 'INTENT (this is what the goal already commits to):', ...intent]
      : [
          '',
          // The goal is a title and nothing else. Previously the intent block was simply
          // omitted, so the request looked completely normal and the cartridge produced a
          // confident plan invented from a name — the most expensive confabulation in this
          // system, because every fabricated task becomes a real dispatch. Say it outright.
          'THIS GOAL STATES NO INTENT. It has a name and nothing else: no reason, no acceptance',
          'criteria, no no-gos, no invariants.',
          'Do NOT invent them, and do NOT pad a plan to look complete. Read the repository and',
          'propose only work you can ground in what is actually there. If the name is too vague',
          'to plan honestly, say so and propose nothing — that is the correct answer, and it is',
          'more useful than a plausible plan aimed at the wrong thing.',
        ]),
    ...(seed ? ['', 'ADDITIONAL CONTEXT FROM THE USER:', seed] : []),
    '',
    'FIRST, read enough of the repository to ground this. A decomposition invented from the goal',
    'text alone will name files and components that do not exist, and every task built on it',
    'wastes a cartridge run.',
    '',
    'PRODUCE a set of projects, each with tasks:',
    '- project: key (short slug), name, description, primaryRepo (absolute path if you know it)',
    '- task: key (short slug, unique across the whole proposal), title, prompt, size (S/M/L),',
    '  dependsOn (array of task keys that must finish first — across projects is fine),',
    '  template (OPTIONAL — the exact name of a workflow to run for this item, from the list below)',
    '',
    'AVAILABLE WORKFLOWS. Set `template` to one of these EXACT names when a multi-step workflow',
    'fits the item better than a single instruction. Accepting such an item launches that whole',
    'workflow against the project instead of creating a one-shot task, so prefer one where the',
    'work genuinely has phases — investigation, review, QA, delivery — and leave it off for',
    'anything a single focused instruction covers:',
    ...availableTemplates().map((t) => `  · ${t.name}`),
    '',
    'The `prompt` is what gets dispatched to a cartridge verbatim. Write it as an instruction to',
    'someone who has not read this conversation: what to change, where, and how it will be verified.',
    '',
    'RULES',
    `- At most ${MAX_PROJECTS} projects and ${MAX_TASKS_PER_PROJECT} tasks per project. Fewer, well-scoped items beat many vague ones.`,
    '- Every task must be independently dispatchable and end in something verifiable.',
    '- Respect the no-gos and rabbit holes above — they are the goal\'s explicit boundaries.',
    '- dependsOn must reference keys you actually defined. Unresolvable and circular links are',
    '  dropped on arrival, so a task that silently loses its ordering will run too early.',
    '- Do not invent work to fill the list. A short, honest decomposition is the better answer.',
    '',
    `SUBMIT with the MCP tool \`neoncore_submit_goal_decomposition\`, decompositionId "${decompositionId}".`,
    'This stores a PROPOSAL and creates nothing — the user reviews every project and task and',
    'chooses what becomes real. Do not create projects or tasks yourself by any other route.',
  ].join('\n');
}
