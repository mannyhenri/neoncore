/**
 * EXECUTION: ORDERING IS ENFORCED, AND BUDGET IS SEEN EVERYWHERE.
 *
 * Phase 6, minus Jira (the user chose local-only, so GOAL-051/052/053 are not built).
 *
 * ── WHY A GATE AND NOT JUST PRIORITY ───────────────────────────────────────────────────
 * Phase 5 derived queue `priority` from dependency depth, which makes prerequisites SORT first.
 * Sorting is not enforcement: priority decides what a free cartridge picks up NEXT, so a second
 * idle cartridge — or one click of "Send to agent" — starts a dependent whose prerequisite has
 * not run. The dependent then works against a codebase missing what it was written to assume,
 * and fails looking like a bad prompt rather than a scheduling bug.
 *
 * ── WHY BUDGET MOVED ───────────────────────────────────────────────────────────────────
 * The cap was consulted in exactly one place, the heartbeat scheduler. Every other dispatch
 * path — manual launch, queued task, confer turn, workflow step, dashboard prompt — ignored it
 * entirely. The check belongs at the funnel all nine call sites inherit from.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  dependencyIds, unmetDependencies, taskIsReady, blockedReason, readyTaskIds,
} from '../src/lib/task-dependencies.ts';
import {
  BUDGET_WARN_RATIO, budgetStateFor, shouldAlert, goalBudgetStatus, noteBudgetOnDispatch,
} from '../src/lib/goal-budget.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function goal(budgetUsd: number | null = null): string {
  const id = `g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, budget_usd, status,
              created_at, updated_at, acceptance_criteria, no_gos, rabbit_holes, invariants, key_results)
              VALUES (?,?,'','',?,'active',?,?,'','','','','[]')`)
    .run(id, `goal ${id}`, budgetUsd, ISO, ISO);
  return id;
}
function project(goalId: string | null, repo = ''): string {
  const id = `p-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,?,?,'',?,'#fff',?,?)`).run(id, goalId, `proj ${id}`, repo, ISO, ISO);
  return id;
}
function task(projectId: string | null, status = 'queued', dependsOn: string[] = [], priority = 0): string {
  const id = `t-${++n}`;
  db.prepare(`INSERT INTO tasks (id, title, prompt, project_id, status, priority, created_at, depends_on)
              VALUES (?,?,'',?,?,?,?,?)`)
    .run(id, `task ${id}`, projectId, status, priority, ISO, JSON.stringify(dependsOn));
  return id;
}
function cartridge(repoPath: string): string {
  const id = `a-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,'m',?,?,'claude','idle',?,'')`).run(id, `t/${id}`, repoPath, repoPath, ISO);
  return id;
}
function spend(agentId: string, inputTokens: number): void {
  db.prepare(`INSERT INTO session_usage (id, agent_id, session_id, model, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, recorded_at) VALUES (?,?,?,?,?,0,0,0,?)`)
    .run(`u-${++n}`, agentId, `s-${n}`, 'claude-sonnet-4-6', inputTokens, ISO);
}

// ── the gate ──────────────────────────────────────────────────────────────────

test('a task with no dependencies is ready', () => {
  const p = project(goal());
  assert.equal(taskIsReady(task(p)), true);
  assert.equal(blockedReason(task(p)), null);
});

/**
 * THE SET OF PREREQUISITE STATES. Only 'done' releases a dependent. Every other state is a
 * different reason to wait, and treating any of them as "finished" starts work on a premise
 * that does not hold.
 */
const PREREQ_STATES: { status: string; releases: boolean; why: string }[] = [
  { status: 'done', releases: true, why: 'the outcome exists' },
  { status: 'queued', releases: false, why: 'has not started' },
  { status: 'claimed', releases: false, why: 'started but produced nothing yet' },
  { status: 'in_progress', releases: false, why: 'still running' },
  { status: 'failed', releases: false, why: 'the dependent would build on an outcome that does not exist' },
  { status: 'cancelled', releases: false, why: 'deliberately not done' },
];

test('EVERY prerequisite state gates correctly — only done releases', () => {
  const wrong: string[] = [];
  for (const c of PREREQ_STATES) {
    const p = project(goal());
    const prereq = task(p, c.status);
    const dependent = task(p, 'queued', [prereq]);
    if (taskIsReady(dependent) !== c.releases) {
      wrong.push(`prerequisite ${c.status}: ready=${taskIsReady(dependent)}, expected ${c.releases} (${c.why})`);
    }
  }
  assert.deepEqual(wrong, [], `the gate misreads a prerequisite state:\n  ${wrong.join('\n  ')}`);
});

test('a failed prerequisite says WHY, not just "blocked"', () => {
  // "Blocked" sends someone hunting. Naming the failure is what makes it actionable.
  const p = project(goal());
  const prereq = task(p, 'failed');
  const reason = blockedReason(task(p, 'queued', [prereq]));
  assert.match(reason!, /failed/);
  assert.match(reason!, /does not exist/);
});

test('a cancelled prerequisite reads as a decision, not a breakage', () => {
  const p = project(goal());
  const prereq = task(p, 'cancelled');
  assert.match(blockedReason(task(p, 'queued', [prereq]))!, /cancelled/);
});

test('all prerequisites must be done, not just one', () => {
  const p = project(goal());
  const a = task(p, 'done');
  const b = task(p, 'queued');
  const dependent = task(p, 'queued', [a, b]);
  assert.equal(taskIsReady(dependent), false);
  assert.equal(unmetDependencies(dependent).length, 1);
});

test('a DELETED prerequisite does not strand its dependent forever', () => {
  // Reverting a decomposition deletes untouched tasks. A dangling id must read as satisfied,
  // or every surviving dependent is permanently unrunnable with no way to clear it.
  const p = project(goal());
  const prereq = task(p, 'queued');
  const dependent = task(p, 'queued', [prereq]);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(prereq);
  assert.equal(taskIsReady(dependent), true);
});

test('malformed depends_on is treated as no dependencies, not as a block', () => {
  const wrong: string[] = [];
  for (const junk of ['not json', '{"a":1}', 'null', '[1,2]', '']) {
    const p = project(goal());
    const id = task(p);
    db.prepare('UPDATE tasks SET depends_on = ? WHERE id = ?').run(junk, id);
    if (!taskIsReady(id)) wrong.push(`${JSON.stringify(junk)} blocked the task`);
    if (dependencyIds(id).some((x) => typeof x !== 'string')) wrong.push(`${junk}: non-string id survived`);
  }
  assert.deepEqual(wrong, []);
});

test('readyTaskIds returns only unblocked queued tasks, deepest-last', () => {
  const p = project(goal());
  const root = task(p, 'done');
  const mid = task(p, 'queued', [root], 0);
  const leaf = task(p, 'queued', [mid], -1);
  const running = task(p, 'in_progress');

  const ready = readyTaskIds();
  assert.ok(ready.includes(mid), 'the newly unblocked task is not ready');
  assert.ok(!ready.includes(leaf), 'a task whose prerequisite is still queued was released');
  assert.ok(!ready.includes(running), 'an in-progress task was offered again');
});

/**
 * EVERY PATH THAT FINISHES A TASK MUST RELEASE ITS DEPENDENTS.
 *
 * There are three — the owner report, the dashboard override, and the Stop-hook autocomplete —
 * and the last is the one that matters most because it fires when nobody is watching. A chain
 * that stalls silently is indistinguishable from one that finished.
 *
 * Asserted over the SOURCE because the three live behind an HTTP route, an HTTP route and a
 * hook respectively; the failure this guards is a fourth completion path being added later
 * without the release, which no runtime test of the existing three would catch.
 */
test('EVERY task-completion site releases dependents', () => {
  const ROOT = path.join(import.meta.dirname, '..');
  const SITES: { file: string; marker: RegExp }[] = [
    { file: 'src/routes/tasks.ts', marker: /router\.post\('\/:id\/complete'/ },
    { file: 'src/routes/tasks.ts', marker: /router\.post\('\/:id\/done'/ },
    { file: 'src/lib/task-autocomplete.ts', marker: /status = 'done'/ },
  ];
  const missing: string[] = [];
  for (const site of SITES) {
    const src = fs.readFileSync(path.join(ROOT, site.file), 'utf8');
    const at = src.search(site.marker);
    if (at < 0) { missing.push(`${site.file}: ${site.marker} no longer exists`); continue; }
    // The release must appear within the same handler, before the next one starts.
    const nextHandler = src.slice(at + 1).search(/router\.(post|patch|delete)\(/);
    const body = src.slice(at, nextHandler > 0 ? at + 1 + nextHandler : undefined);
    if (!/releaseReadyTasks/.test(body)) missing.push(`${site.file} @ ${site.marker}`);
  }
  assert.deepEqual(missing, [],
    `these finish a task without releasing what it was blocking:\n  ${missing.join('\n  ')}`);
});

test('the manual dispatch route consults the same gate', () => {
  // A check living only in the queue runner leaves "Send to agent" as an unguarded back door —
  // exactly how the busy guard was bypassed before it moved to a shared helper.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/routes/tasks.ts'), 'utf8');
  const at = src.search(/router\.post\('\/:id\/dispatch'/);
  const body = src.slice(at, at + 2000);
  assert.match(body, /blockedReason/, 'the manual dispatch path does not check dependencies');
  assert.match(body, /force/, 'there is no deliberate override for a dependency that no longer applies');
});

test('release goes through the QUEUE, not a new dispatch path', () => {
  // The queue owns the busy guard, holds, the blocked-wait budget and the completion gate.
  // Decomposition produces tasks in bulk, so bypassing those would do the most damage here.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/routes/tasks.ts'), 'utf8');
  const at = src.search(/export function releaseReadyTasks/);
  assert.ok(at > -1, 'releaseReadyTasks does not exist');
  const body = src.slice(at, at + 1600);
  assert.match(body, /guardBusy/, 'released tasks skip the busy guard');
  assert.match(body, /queue_items/, 'nothing stops the same task being queued twice');
});

// ── budget ────────────────────────────────────────────────────────────────────

test('a goal with no cap is never over budget', () => {
  // The live condition: the one real goal has budget_usd NULL. Getting this wrong would fire a
  // warning on every dispatch in the fleet.
  assert.equal(goalBudgetStatus(goal(null)), null);
  assert.equal(goalBudgetStatus(goal(0)), null);
});

test('the thresholds are what they claim', () => {
  assert.equal(budgetStateFor(0), 'ok');
  assert.equal(budgetStateFor(BUDGET_WARN_RATIO - 0.01), 'ok');
  assert.equal(budgetStateFor(BUDGET_WARN_RATIO), 'warn');
  assert.equal(budgetStateFor(0.999), 'warn');
  assert.equal(budgetStateFor(1), 'over');
  assert.equal(budgetStateFor(4), 'over');
});

/** Only escalations alert. Recovering is silent — that is the user acting on the warning. */
const TRANSITIONS: { from: 'ok' | 'warn' | 'over'; to: 'ok' | 'warn' | 'over'; alerts: boolean }[] = [
  { from: 'ok', to: 'ok', alerts: false },
  { from: 'ok', to: 'warn', alerts: true },
  { from: 'ok', to: 'over', alerts: true },
  { from: 'warn', to: 'warn', alerts: false },
  { from: 'warn', to: 'over', alerts: true },
  { from: 'over', to: 'over', alerts: false },
  { from: 'over', to: 'warn', alerts: false },
  { from: 'warn', to: 'ok', alerts: false },
];

test('EVERY budget transition alerts exactly when it should', () => {
  const wrong: string[] = [];
  for (const t of TRANSITIONS) {
    if (shouldAlert(t.from, t.to) !== t.alerts) wrong.push(`${t.from} → ${t.to}`);
  }
  assert.deepEqual(wrong, [], `wrong alerting on: ${wrong.join(', ')}`);
});

test('the same dispatch does not warn twice', () => {
  // A warning on every dispatch is noise, and noise is how a real warning gets ignored.
  const g = goal(1);
  const p = project(g, '/repo/budget');
  const a = cartridge('/repo/budget');
  db.prepare('INSERT OR IGNORE INTO project_cartridges (project_id, repo_path) VALUES (?,?)').run(p, '/repo/budget');
  spend(a, 5_000_000);                       // comfortably over a $1 cap

  const first = noteBudgetOnDispatch(a);
  assert.ok(first, 'the first over-budget dispatch did not warn');
  assert.equal(first!.state, 'over');
  assert.equal(noteBudgetOnDispatch(a), null, 'it warned again on the next dispatch');
  assert.equal(noteBudgetOnDispatch(a), null);
});

test('crossing from warn to over alerts again — it is new information', () => {
  const g = goal(100);
  const p = project(g, '/repo/climb');
  const a = cartridge('/repo/climb');
  db.prepare('INSERT OR IGNORE INTO project_cartridges (project_id, repo_path) VALUES (?,?)').run(p, '/repo/climb');

  // Land in the warn band first, then push past the cap.
  spend(a, 30_000_000);
  const status = goalBudgetStatus(g)!;
  assert.equal(status.state, 'warn', `setup: expected warn, got ${status.state} at ratio ${status.ratio}`);
  assert.equal(noteBudgetOnDispatch(a)!.state, 'warn');
  assert.equal(noteBudgetOnDispatch(a), null, 'warn repeated');

  spend(a, 20_000_000);
  const escalated = noteBudgetOnDispatch(a);
  assert.equal(escalated?.state, 'over', 'crossing the cap after a warning did not alert');
});

test('a cartridge under no goal never warns', () => {
  assert.equal(noteBudgetOnDispatch(cartridge('/repo/unattached')), null);
});

test('budget WARNS — the funnel never refuses a dispatch', () => {
  // The user's decision. Blocking mid-session strands work someone is actively doing, and the
  // cap is an estimate of intent rather than a hard financial limit. Asserted on the funnel's
  // source: the check must not be able to return early or throw past the caller.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/lib/send-command.ts'), 'utf8');
  // The CALL site, not the import — `slice(at - 900, …)` on the import's index goes negative,
  // which JS reads as an offset from the END of the string and silently inspects the wrong file.
  const at = src.lastIndexOf('noteBudgetOnDispatch');
  assert.ok(at > -1, 'the dispatch funnel does not check budget at all');
  const around = src.slice(Math.max(0, at - 900), at + 900);
  assert.ok(!/return null;?\s*\/\/ over budget/.test(around), 'the funnel refuses over-budget work');
  assert.match(around, /try\s*\{/, 'the budget check is not wrapped — a bookkeeping fault could block a dispatch');
});

test('the heartbeat gate and the funnel read the SAME numbers', () => {
  // They behave differently on purpose — unattended blocks, attended warns — but a disagreement
  // about what "over" means would make one of them wrong.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/lib/heartbeat-scheduler.ts'), 'utf8');
  assert.match(src, /goalCostUsd/, 'the heartbeat gate computes spend some other way');
});
