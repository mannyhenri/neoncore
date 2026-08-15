/**
 * DECOMPOSITION: NOTHING BECOMES REAL WITHOUT A PERSON NAMING IT.
 *
 * Phase 5. A goal-intent draft (Phase 4) proposes text; a decomposition proposes PROJECTS AND
 * TASKS, and accepted tasks get dispatched to cartridges that change repositories. So the
 * never-auto-apply invariant carries more weight here, not less, and it is tested the same way:
 * as a negative, swept set-based over every operation that is not an explicit accept.
 *
 * The second theme is that VALIDATION IS THE FEATURE. The whole point of a structured format is
 * that output can be inserted rather than re-read by a human, which only holds if the shape is
 * guaranteed. Everything a cartridge sends is normalized, and anything dropped is RECORDED —
 * silent truncation would present a mangled proposal as the model's actual plan, in a surface
 * whose only job is review.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { STANDARD_TEMPLATE_NAMES } from '../src/db.js';
import {
  MAX_PROJECTS, MAX_TASKS_PER_PROJECT, normalizeProposal, dependencyDepths,
  templateIdForName, decompositionContextFor,
  createDecomposition, getDecomposition, submitDecomposition, failDecomposition,
  acceptDecomposition, revertDecomposition, buildDecompositionPrompt, DecompositionError,
} from '../src/lib/goal-decomposition.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function goal(): string {
  const id = `g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, budget_usd, status,
              created_at, updated_at, acceptance_criteria, no_gos, rabbit_holes, invariants, key_results)
              VALUES (?,?,'','',NULL,'active',?,?,'','Do not add another vector database.','','','[]')`)
    .run(id, `goal ${id}`, ISO, ISO);
  return id;
}
/**
 * Counts SCOPED TO ONE GOAL. The whole file shares a database, so an unscoped `COUNT(*)`
 * silently folds in rows every earlier test created — which made four assertions here compare
 * against another test's work before this was fixed.
 */
const counts = (goalId: string) => ({
  projects: (db.prepare('SELECT COUNT(*) AS n FROM projects WHERE goal_id = ?').get(goalId) as { n: number }).n,
  tasks: (db.prepare(
    'SELECT COUNT(*) AS n FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE goal_id = ?)',
  ).get(goalId) as { n: number }).n,
});
/** Tasks belonging to one goal, in queue order. */
const tasksOf = (goalId: string) => db.prepare(
  `SELECT title, priority, depends_on FROM tasks
    WHERE project_id IN (SELECT id FROM projects WHERE goal_id = ?)
    ORDER BY priority DESC`,
).all(goalId) as { title: string; priority: number; depends_on: string }[];

const PROPOSAL = {
  projects: [
    {
      key: 'retrieval', name: 'Retrieval rewrite', description: 'Replace RAG lookup',
      primaryRepo: '/repo/neoncore',
      tasks: [
        { key: 'bench', title: 'Benchmark current context build', prompt: 'Measure p95.', size: 'S', dependsOn: [] },
        { key: 'impl', title: 'Implement direct file assembly', prompt: 'Build it.', size: 'L', dependsOn: ['bench'] },
      ],
    },
    {
      key: 'cleanup', name: 'Remove RAG plumbing', description: 'Delete the old path',
      primaryRepo: '',
      tasks: [
        { key: 'rip', title: 'Delete vector store client', prompt: 'Remove it.', size: 'M', dependsOn: ['impl'] },
      ],
    },
  ],
};
const ready = (goalId: string) => {
  const d = createDecomposition({ goalId, seed: 's', agentId: 'a1' });
  submitDecomposition(d.id, PROPOSAL);
  return getDecomposition(d.id)!;
};

// ── the negative space ────────────────────────────────────────────────────────

const NON_CREATING_OPS: { label: string; run: (goalId: string) => void }[] = [
  { label: 'createDecomposition', run: (g) => { createDecomposition({ goalId: g, seed: 'x', agentId: 'a' }); } },
  { label: 'submitDecomposition', run: (g) => { ready(g); } },
  { label: 'submitDecomposition twice', run: (g) => { const d = ready(g); submitDecomposition(d.id, PROPOSAL); } },
  { label: 'failDecomposition', run: (g) => { const d = createDecomposition({ goalId: g, seed: 'x', agentId: 'a' }); failDecomposition(d.id, 'died'); } },
  { label: 'submitting garbage', run: (g) => { const d = createDecomposition({ goalId: g, seed: 'x', agentId: 'a' }); submitDecomposition(d.id, 'nonsense'); } },
];

test('EVERY operation except an explicit accept creates no project and no task', () => {
  const wrong: string[] = [];
  for (const op of NON_CREATING_OPS) {
    const g = goal();
    const before = counts(g);
    op.run(g);
    const after = counts(g);
    if (after.projects !== before.projects || after.tasks !== before.tasks) {
      wrong.push(`${op.label}: +${after.projects - before.projects} projects, +${after.tasks - before.tasks} tasks`);
    }
  }
  assert.deepEqual(wrong, [], `these created real work with no user action:\n  ${wrong.join('\n  ')}`);
});

test('a decomposition cannot be accepted twice', () => {
  const g = goal();
  const d = ready(g);
  acceptDecomposition(d.id, { projectKeys: ['retrieval'], taskKeys: ['bench'] });
  const after = counts(g);
  assert.throws(() => acceptDecomposition(d.id, { projectKeys: ['retrieval'], taskKeys: ['bench'] }), DecompositionError);
  assert.deepEqual(counts(g), after, 'a replayed accept duplicated the work');
});

test('a pending or failed decomposition cannot be accepted', () => {
  const wrong: string[] = [];
  for (const state of ['pending', 'failed'] as const) {
    const g = goal();
    const d = createDecomposition({ goalId: g, seed: 's', agentId: 'a' });
    if (state === 'failed') failDecomposition(d.id, 'boom');
    try {
      acceptDecomposition(d.id, { projectKeys: ['retrieval'], taskKeys: [] });
      wrong.push(state);
    } catch { /* expected */ }
  }
  assert.deepEqual(wrong, []);
});

// ── accept creates exactly what was chosen ────────────────────────────────────

test('accepting one project creates that project only', () => {
  const g = goal();
  const d = ready(g);
  const r = acceptDecomposition(d.id, { projectKeys: ['retrieval'], taskKeys: ['bench', 'impl'] });

  assert.equal(r.createdProjects, 1);
  assert.equal(r.createdTasks, 2);
  const names = (db.prepare('SELECT name FROM projects WHERE goal_id = ?').all(g) as { name: string }[]).map((x) => x.name);
  assert.deepEqual(names, ['Retrieval rewrite'], 'an unselected project was created');
});

test('a task whose project was NOT accepted is skipped and reported, never orphaned', () => {
  // Creating the parent silently would produce a project the user never approved; creating the
  // task without one produces exactly the unassigned state Phase 1 exists to make visible.
  const g = goal();
  const d = ready(g);
  const r = acceptDecomposition(d.id, { projectKeys: ['retrieval'], taskKeys: ['bench', 'rip'] });

  assert.equal(r.createdTasks, 1, '"rip" belongs to a project that was not accepted');
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /rip|Delete vector store/i);
  const orphans = (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id IS NULL').get() as { n: number }).n;
  assert.equal(orphans, 0);
});

test('accepting with no projects selected creates nothing', () => {
  const g = goal();
  const d = ready(g);
  const before = counts(g);
  assert.throws(() => acceptDecomposition(d.id, { projectKeys: [], taskKeys: ['bench'] }), DecompositionError);
  assert.deepEqual(counts(g), before);
});

test('created rows carry provenance back to the decomposition', () => {
  // GOAL-044. Without this a bad decomposition is a pile of rows nobody can attribute or undo.
  const g = goal();
  const d = ready(g);
  acceptDecomposition(d.id, { projectKeys: ['retrieval'], taskKeys: ['bench'] });

  const p = db.prepare('SELECT origin_decomposition_id, goal_id FROM projects WHERE goal_id = ?').get(g) as Record<string, string>;
  assert.equal(p.origin_decomposition_id, d.id);
  assert.equal(p.goal_id, g, 'the project must roll up to the goal, or reach and cost stay 0');
  const t = db.prepare(
    'SELECT origin_decomposition_id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE goal_id = ?)',
  ).get(g) as Record<string, string>;
  assert.equal(t.origin_decomposition_id, d.id);

  const stored = getDecomposition(d.id)!;
  assert.equal(stored.createdProjects.length, 1);
  assert.equal(stored.createdTasks.length, 1);
});

test('dependency order becomes real queue priority, not a stored decoration', () => {
  // Storing dependsOn and stopping there would be another mechanism no data flows through.
  // Depth drives priority, so prerequisites sort ahead of dependents the moment they exist.
  //
  // The tasks are declared in REVERSE dependency order on purpose. With them in natural order
  // this assertion passed even when priority was hard-coded to a constant, because SQLite
  // returned insertion order and insertion order happened to be the right answer — the test
  // could not tell sorting from luck. Now only real priority sorting produces this sequence.
  const g = goal();
  const d = createDecomposition({ goalId: g, seed: 's', agentId: 'a1' });
  submitDecomposition(d.id, {
    projects: [{
      key: 'p', name: 'P', tasks: [
        { key: 'last', title: 'Third — depends on second', dependsOn: ['mid'] },
        { key: 'mid', title: 'Second — depends on first', dependsOn: ['first'] },
        { key: 'first', title: 'First — no dependencies', dependsOn: [] },
      ],
    }],
  });
  acceptDecomposition(d.id, { projectKeys: ['p'], taskKeys: ['last', 'mid', 'first'] });

  const rows = tasksOf(g);
  assert.deepEqual(rows.map((r) => r.title), [
    'First — no dependencies',
    'Second — depends on first',
    'Third — depends on second',
  ], 'tasks do not sort into dependency order');
  // And the priorities must actually DIFFER — equal values would sort by insertion order and
  // the sequence above would be an accident of how the rows were written.
  assert.equal(new Set(rows.map((r) => r.priority)).size, 3, 'every task got the same priority');
  // Stored as the created task's ID, not the proposal key. The first version wrote the key
  // verbatim — unresolvable once the proposal is gone, so nothing at runtime could tell whether
  // a prerequisite had finished. The column looked populated and meant nothing.
  const byTitle = Object.fromEntries(
    (db.prepare(
      'SELECT id, title FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE goal_id = ?)',
    ).all(g) as { id: string; title: string }[]).map((r) => [r.title, r.id]),
  );
  assert.deepEqual(
    JSON.parse(rows[1].depends_on),
    [byTitle['First — no dependencies']],
    'the dependency was not stored as a resolvable task id',
  );
});

test('dependencies cross project boundaries in the accepted rows too', () => {
  const g = goal();
  const d = ready(g);
  acceptDecomposition(d.id, { projectKeys: ['retrieval', 'cleanup'], taskKeys: ['bench', 'impl', 'rip'] });
  const rows = tasksOf(g);
  assert.deepEqual(rows.map((r) => r.title), [
    'Benchmark current context build',
    'Implement direct file assembly',
    'Delete vector store client',      // in a different project, depends on impl
  ]);
  assert.equal(new Set(rows.map((r) => r.priority)).size, 3);
  // Cross-project dependencies must survive the key→id rewrite too.
  const ids = new Set((db.prepare(
    'SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE goal_id = ?)',
  ).all(g) as { id: string }[]).map((r) => r.id));
  const deps = JSON.parse(rows[2].depends_on) as string[];
  assert.equal(deps.length, 1);
  assert.ok(ids.has(deps[0]), 'a cross-project dependency did not resolve to a real task id');
});

// ── validation ────────────────────────────────────────────────────────────────

test('a project with no name is dropped, and the drop is reported', () => {
  const { proposal, notes } = normalizeProposal({
    projects: [{ name: '', tasks: [] }, { name: 'Real', tasks: [] }],
  });
  assert.equal(proposal.projects.length, 1);
  assert.ok(notes.some((x) => /no name/i.test(x)), 'a silent drop presents a mangled plan as the model output');
});

test('a task with no title is dropped and reported', () => {
  const { proposal, notes } = normalizeProposal({
    projects: [{ name: 'P', tasks: [{ title: '' }, { title: 'Real task' }] }],
  });
  assert.equal(proposal.projects[0].tasks.length, 1);
  assert.ok(notes.some((x) => /no title/i.test(x)));
});

test('caps are enforced AND reported — silent truncation reads as completeness', () => {
  const { proposal, notes } = normalizeProposal({
    projects: Array.from({ length: MAX_PROJECTS + 3 }, (_, i) => ({
      name: `P${i}`,
      tasks: Array.from({ length: MAX_TASKS_PER_PROJECT + 5 }, (_, j) => ({ title: `T${j}` })),
    })),
  });
  assert.equal(proposal.projects.length, MAX_PROJECTS);
  assert.equal(proposal.projects[0].tasks.length, MAX_TASKS_PER_PROJECT);
  assert.ok(notes.some((x) => x.includes(`${MAX_PROJECTS + 3} projects`)), 'the project cap was silent');
  assert.ok(notes.some((x) => /kept the first/.test(x) && /tasks/.test(x)), 'the task cap was silent');
});

/** The set of dependency edges that cannot be honoured. Each would mis-order real work. */
const BAD_EDGES: { label: string; tasks: unknown[]; expect: RegExp }[] = [
  {
    label: 'a dependency on a task that does not exist',
    tasks: [{ key: 'a', title: 'A', dependsOn: ['ghost'] }],
    expect: /not in the proposal/i,
  },
  {
    label: 'a task depending on itself',
    tasks: [{ key: 'a', title: 'A', dependsOn: ['a'] }],
    expect: /itself/i,
  },
  {
    label: 'a two-task cycle',
    tasks: [{ key: 'a', title: 'A', dependsOn: ['b'] }, { key: 'b', title: 'B', dependsOn: ['a'] }],
    expect: /circular/i,
  },
];

test('EVERY unsatisfiable dependency is removed and named', () => {
  const wrong: string[] = [];
  for (const c of BAD_EDGES) {
    const { proposal, notes } = normalizeProposal({ projects: [{ name: 'P', tasks: c.tasks }] });
    const edges = proposal.projects[0].tasks.flatMap((t) => t.dependsOn);
    // Whatever survives must point at a real task, and never form a loop.
    const keys = new Set(proposal.projects[0].tasks.map((t) => t.key));
    if (edges.some((e) => !keys.has(e))) wrong.push(`${c.label}: a dangling edge survived`);
    if (!notes.some((x) => c.expect.test(x))) wrong.push(`${c.label}: removed silently`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('a cycle cannot survive to produce an impossible ordering', () => {
  const { proposal } = normalizeProposal({
    projects: [{ name: 'P', tasks: [
      { key: 'a', title: 'A', dependsOn: ['c'] },
      { key: 'b', title: 'B', dependsOn: ['a'] },
      { key: 'c', title: 'C', dependsOn: ['b'] },
    ] }],
  });
  const depths = dependencyDepths(proposal);
  // Every task resolves to a finite depth — a surviving cycle would not terminate or would
  // leave tasks unordered at the front of the queue.
  assert.equal(depths.size, 3);
  for (const [, d] of depths) assert.ok(Number.isFinite(d) && d >= 0);
});

test('dependencies resolve ACROSS projects — a real decomposition needs that', () => {
  const { proposal, notes } = normalizeProposal({
    projects: [
      { key: 'p1', name: 'One', tasks: [{ key: 'base', title: 'Base' }] },
      { key: 'p2', name: 'Two', tasks: [{ key: 'dep', title: 'Dep', dependsOn: ['base'] }] },
    ],
  });
  assert.deepEqual(proposal.projects[1].tasks[0].dependsOn, ['base']);
  assert.equal(notes.length, 0, 'a valid cross-project edge was reported as a problem');
});

test('duplicate keys are renamed, not collapsed — items must stay individually addressable', () => {
  // Two items sharing a key means accepting one accepts both, which breaks per-item review.
  const { proposal } = normalizeProposal({
    projects: [{ key: 'p', name: 'P', tasks: [
      { key: 'same', title: 'First' }, { key: 'same', title: 'Second' },
    ] }],
  });
  const keys = proposal.projects[0].tasks.map((t) => t.key);
  assert.equal(new Set(keys).size, 2, 'two tasks share one key');
  assert.equal(proposal.projects[0].tasks.length, 2, 'a task was dropped instead of renamed');
});

test('missing optional fields get usable defaults', () => {
  const { proposal } = normalizeProposal({ projects: [{ name: 'P', tasks: [{ title: 'Just a title' }] }] });
  const t = proposal.projects[0].tasks[0];
  assert.equal(t.size, 'M');
  assert.equal(t.prompt, 'Just a title', 'a task with no prompt would dispatch an empty instruction');
  assert.deepEqual(t.dependsOn, []);
});

test('junk submissions fail the decomposition rather than storing an empty plan', () => {
  const wrong: string[] = [];
  for (const junk of [null, 'a string', 42, [], {}, { projects: 'not an array' }, { projects: [] }]) {
    const g = goal();
    const d = createDecomposition({ goalId: g, seed: 's', agentId: 'a' });
    const after = submitDecomposition(d.id, junk);
    if (after?.status !== 'failed') wrong.push(`${JSON.stringify(junk)} → ${after?.status}`);
  }
  assert.deepEqual(wrong, [], `junk stored as a ready plan:\n  ${wrong.join('\n  ')}`);
});

// ── revert ────────────────────────────────────────────────────────────────────

test('revert removes untouched work', () => {
  const g = goal();
  const d = ready(g);
  acceptDecomposition(d.id, { projectKeys: ['retrieval'], taskKeys: ['bench', 'impl'] });
  const r = revertDecomposition(d.id);

  assert.equal(r.deletedTasks, 2);
  assert.equal(r.deletedProjects, 1);
  assert.deepEqual(counts(g), { projects: 0, tasks: 0 });
});

test('revert NEVER deletes work that has started, and says what it kept', () => {
  // A claimed task is a record of real work. Deleting it to tidy up a bad decomposition would
  // destroy the evidence of what a cartridge actually did.
  const g = goal();
  const d = ready(g);
  acceptDecomposition(d.id, { projectKeys: ['retrieval'], taskKeys: ['bench', 'impl'] });
  const started = (db.prepare(
    'SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE goal_id = ?) LIMIT 1',
  ).get(g) as { id: string }).id;
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(started);

  const r = revertDecomposition(d.id);
  assert.equal(r.deletedTasks, 1);
  assert.equal(r.deletedProjects, 0, 'the project still holds live work');
  assert.ok(r.kept.length >= 2, 'a partial revert reported as total would be a lie');
  assert.equal(counts(g).tasks, 1);
});

test('revert refuses a decomposition that was never accepted', () => {
  const g = goal();
  const d = ready(g);
  assert.throws(() => revertDecomposition(d.id), DecompositionError);
});

test('revert leaves cartridge links from OTHER sources alone', () => {
  // project_cartridges has no foreign key, so a project delete that skips it orphans rows —
  // the exact bug found in Phase 1's cleanup.
  const g = goal();
  const d = ready(g);
  acceptDecomposition(d.id, { projectKeys: ['retrieval'], taskKeys: [] });
  const pid = getDecomposition(d.id)!.createdProjects[0];
  db.prepare('INSERT INTO project_cartridges (project_id, repo_path) VALUES (?,?)').run(pid, '/repo/x');

  revertDecomposition(d.id);
  const orphans = (db.prepare(
    'SELECT COUNT(*) AS n FROM project_cartridges pc LEFT JOIN projects p ON p.id = pc.project_id WHERE p.id IS NULL',
  ).get() as { n: number }).n;
  assert.equal(orphans, 0, 'reverting orphaned a cartridge mapping');
});

// ── prompt ────────────────────────────────────────────────────────────────────

test('the prompt carries the goal\'s boundaries, not just its name', () => {
  // no-gos and rabbit holes are the goal's explicit limits. A decomposition that never sees
  // them proposes exactly the work the user already ruled out.
  const g = goal();
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(g) as Record<string, unknown>;
  const p = buildDecompositionPrompt('d-1', 'seed', row);
  assert.match(p, /Do not add another vector database/);
  assert.match(p, /No-gos/);
});

test('the prompt demands structure, names the tool, and forbids self-creation', () => {
  const g = goal();
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(g) as Record<string, unknown>;
  const p = buildDecompositionPrompt('d-99', '', row);
  for (const required of ['dependsOn', 'primaryRepo', 'size', 'd-99', 'neoncore_submit_goal_decomposition']) {
    assert.ok(p.includes(required), `the prompt never mentions ${required}`);
  }
  assert.match(p, /creates nothing|Do not create projects or tasks yourself/i);
});

/**
 * THE PLANNER MUST SEE EVERYTHING THE GOAL COMMITS TO.
 *
 * The registry is `buildGoalBrief`'s sections — the established answer to "what must an agent
 * know about this goal". Decomposition is the highest-leverage read of a goal in the system
 * (every task it proposes gets dispatched), so it cannot see LESS than a working agent does.
 *
 * ── AND THE BRIEF CANNOT COVER FOR IT ──────────────────────────────────────────────────
 * `sendCommandToAgent` injects `goalBriefForAgent(agentId)`, which resolves the goal from the
 * CARTRIDGE's repo through project_cartridges/primary_repo. A goal being decomposed has no
 * projects yet — that is the entire reason you are decomposing it — so reach is 0 and no brief
 * is injected. This prompt is the only carrier, which is why the gap mattered: key results,
 * appetite, target date and autonomy reached working agents and never reached the planner.
 */
const BRIEF_FIELDS: { column: string; label: string; sample: string; value: unknown }[] = [
  { column: 'description',         label: 'why now',             sample: 'Trials stall at import.', value: 'Trials stall at import.' },
  { column: 'acceptance_criteria', label: 'acceptance criteria', sample: 'shall name the field at fault', value: 'When import fails, the system shall name the field at fault.' },
  { column: 'invariants',          label: 'invariants',          sample: 'existing sessions must survive', value: 'existing sessions must survive' },
  { column: 'no_gos',              label: 'no-gos',              sample: 'another vector database', value: 'Do not add another vector database.' },
  { column: 'rabbit_holes',        label: 'rabbit holes',        sample: 'tuning RAG parameters', value: 'tuning RAG parameters — already tried' },
  { column: 'key_results',         label: 'key results',         sample: 'p95 context build', value: JSON.stringify([{ metric: 'p95 context build', baseline: '1.9s', target: '400ms' }]) },
  { column: 'budget_usd',          label: 'appetite',            sample: '250', value: 250 },
  { column: 'target_date',         label: 'target date',         sample: '2026-09-30', value: '2026-09-30' },
  { column: 'autonomy',            label: 'autonomy',            sample: 'Supervised', value: 'supervised' },
];

test('EVERY goal commitment the brief carries also reaches the planner', () => {
  const g = goal();
  for (const f of BRIEF_FIELDS) {
    db.prepare(`UPDATE goals SET ${f.column} = ? WHERE id = ?`).run(f.value as never, g);
  }
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(g) as Record<string, unknown>;
  const prompt = buildDecompositionPrompt('d-1', '', row);

  const missing = BRIEF_FIELDS.filter((f) => !prompt.includes(f.sample)).map((f) => f.label);
  assert.deepEqual(missing, [],
    `the planner never sees these, so every task it proposes is scoped without them:\n  ${missing.join('\n  ')}`);
});

/**
 * AN EMPTY GOAL MUST BE ANNOUNCED, NOT SILENTLY OMITTED.
 *
 * Today the intent block is dropped when every field is blank, so the cartridge receives a
 * title and a request for a plan — and produces one, because that is what it was asked for.
 * A decomposition invented from a name is the most expensive kind of confabulation here: each
 * fabricated task becomes a real dispatch. Silence is what makes it look like a normal request.
 */
test('a goal with NO intent says so, and forbids inventing one', () => {
  // A genuinely bare goal. The shared `goal()` helper seeds a no-go, so using it here meant
  // the empty branch never ran and this assertion was testing the populated path.
  const g = `bare-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, budget_usd, status,
              created_at, updated_at, acceptance_criteria, no_gos, rabbit_holes, invariants, key_results)
              VALUES (?,?,'','',NULL,'active',?,?,'','','','','[]')`)
    .run(g, 'Interlag Version 1.2 Fixes', ISO, ISO);
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(g) as Record<string, unknown>;
  const prompt = buildDecompositionPrompt('d-1', '', row);

  assert.match(prompt, /states no intent|no stated intent/i,
    'the prompt hides that the goal is empty — the cartridge cannot know to push back');
  assert.match(prompt, /do not invent|say so/i,
    'nothing tells the cartridge to refuse rather than fabricate a plan from a title');
});

test('a populated goal does NOT carry the empty-goal warning', () => {
  const g = goal();
  db.prepare("UPDATE goals SET description = 'A real reason this matters.' WHERE id = ?").run(g);
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(g) as Record<string, unknown>;
  assert.ok(!/states no intent/i.test(buildDecompositionPrompt('d-1', '', row)),
    'a goal with intent was reported as empty');
});

/**
 * PICK FROM THE WORKFLOWS, AND FEED THE SETUP ANSWERS THROUGH.
 *
 * Asked for directly: "couldn't I pick and choose what I want to do as part of the workflows,
 * and then my answers as part of setting up a project is feed as context?"
 *
 * Two halves, both previously missing:
 *
 *  A. The planner had no idea the 20 workflow templates existed, so every proposed item was a
 *     free-form prompt. "Run Deep Research here, Bug Hunter there" was unexpressible — the most
 *     valuable thing in the system could not be selected.
 *  B. The seed — the answers typed during setup — was used to BUILD the prompt and then thrown
 *     away. It never reached the work it produced, so the agent doing the task never saw the
 *     context the person gave when asking for it.
 *
 * Set-based over `STANDARD_TEMPLATE_NAMES` because a half-fix here is invisible: offering
 * fifteen of twenty templates, or accepting a name that no longer resolves to a row, looks
 * completely correct until the one template you wanted is the one that silently vanished.
 */
test('EVERY seeded template is offered to the planner by name', () => {
  const g = goal();
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(g) as Record<string, unknown>;
  const prompt = buildDecompositionPrompt('d-1', '', row);
  const missing = STANDARD_TEMPLATE_NAMES.filter((n) => !prompt.includes(n));
  assert.deepEqual(missing, [],
    `the planner cannot choose these — it does not know they exist:\n  ${missing.join('\n  ')}`);
});

test('EVERY seeded template survives validation and resolves to a real run', () => {
  const wrong: string[] = [];
  for (const name of STANDARD_TEMPLATE_NAMES) {
    const { proposal, notes } = normalizeProposal({
      projects: [{ key: 'p', name: 'P', tasks: [{ key: 't', title: `Run ${name}`, template: name }] }],
    });
    const task = proposal.projects[0]?.tasks[0];
    if (task?.template !== name) {
      wrong.push(`${name}: dropped by validation (${notes.join('; ') || 'no reason given'})`);
      continue;
    }
    if (!templateIdForName(name)) wrong.push(`${name}: accepted but resolves to no template row`);
  }
  assert.deepEqual(wrong, [], `templates the plan cannot actually use:\n  ${wrong.join('\n  ')}`);
});

test('a template name that does not exist is dropped and named', () => {
  // Otherwise accepting the plan silently creates nothing for that item.
  const { proposal, notes } = normalizeProposal({
    projects: [{ key: 'p', name: 'P', tasks: [{ key: 't', title: 'X', template: 'Totally Made Up Workflow' }] }],
  });
  assert.equal(proposal.projects[0].tasks[0].template, '', 'an unknown template survived');
  assert.ok(notes.some((x) => /Totally Made Up Workflow/.test(x)), 'the drop was silent');
});

test('accepting a template-tagged item LAUNCHES a run, not an inert task', () => {
  // Storing the choice and creating a plain task would be another mechanism no data flows
  // through — the failure this repo keeps repeating.
  const g = goal();
  const d = createDecomposition({ goalId: g, seed: 'the setup answers', agentId: 'a1' });
  submitDecomposition(d.id, {
    projects: [{ key: 'p', name: 'P', tasks: [
      { key: 'wf', title: 'Investigate the PDF bug', template: 'Bug Investigation' },
      { key: 'plain', title: 'A normal task', prompt: 'do the thing' },
    ] }],
  });
  const r = acceptDecomposition(d.id, { projectKeys: ['p'], taskKeys: ['wf', 'plain'] });

  assert.equal(r.createdTasks, 1, 'the template item should not also become a plain task');
  assert.equal(r.createdRuns, 1, 'the template item did not become a workflow run');
  const pid = getDecomposition(d.id)!.createdProjects[0];
  const run = db.prepare(
    "SELECT name, project_id, initial_context FROM workflows WHERE project_id = ? AND template_id IS NOT NULL",
  ).get(pid) as { name: string; project_id: string; initial_context: string } | undefined;
  assert.ok(run, 'no run was created against the project');
  assert.equal(run!.name, 'Bug Investigation');
});

/**
 * THE ANSWERS REACH THE WORK — every route the work can take.
 *
 * A decomposition produces two kinds of thing, and the setup context has to survive into both.
 * Carrying it into runs but not tasks (or the reverse) is the half-fix.
 */
test('EVERY kind of accepted work carries the setup answers as context', () => {
  const SEED = 'Ground everything in the 1.2 release notes and the failing PDF export tests.';
  const g = goal();
  const d = createDecomposition({ goalId: g, seed: SEED, agentId: 'a1' });
  submitDecomposition(d.id, {
    projects: [{ key: 'p', name: 'P', tasks: [
      { key: 'wf', title: 'Investigate', template: 'Bug Investigation' },
      { key: 'plain', title: 'Fix the label', prompt: 'Rename the field.' },
    ] }],
  });
  acceptDecomposition(d.id, { projectKeys: ['p'], taskKeys: ['wf', 'plain'] });
  const pid = getDecomposition(d.id)!.createdProjects[0];

  const missing: string[] = [];
  const run = db.prepare(
    "SELECT initial_context FROM workflows WHERE project_id = ? AND template_id IS NOT NULL",
  ).get(pid) as { initial_context: string } | undefined;
  if (!run?.initial_context.includes(SEED)) missing.push('workflow run initial_context');

  const task = db.prepare('SELECT id FROM tasks WHERE project_id = ?').get(pid) as { id: string } | undefined;
  if (!task) missing.push('task was not created at all');
  else if (!decompositionContextFor(task.id).includes(SEED)) missing.push('task dispatch context');

  assert.deepEqual(missing, [],
    `the answers given during setup never reach:\n  ${missing.join('\n  ')}`);
});

test('a task from no decomposition has no context to carry', () => {
  // The lookup must be silent for ordinary tasks, not attach an empty header to everything.
  db.prepare(`INSERT INTO tasks (id, title, prompt, project_id, status, priority, created_at)
              VALUES ('plain-1','t','p',NULL,'queued',0,?)`).run(ISO);
  assert.equal(decompositionContextFor('plain-1'), '');
  assert.equal(decompositionContextFor('does-not-exist'), '');
});

test('the prompt tells the cartridge to read the repo before planning', () => {
  // A decomposition invented from goal text alone names files that do not exist, and every
  // task built on it wastes a cartridge run.
  const g = goal();
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(g) as Record<string, unknown>;
  assert.match(buildDecompositionPrompt('d-1', '', row), /read enough of the repository/i);
});
