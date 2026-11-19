/**
 * WHICH WORK BELONGS TO THIS GOAL. One answer, four consumers.
 *
 * Reach, cost, progress and health are four different questions about the same set. The epic
 * states the constraint as "one resolution path, three metrics"; Phase 3 makes it four, which
 * is what forced this module to exist.
 *
 * Before it, reach and cost each carried their own copy of the ownership UNION and resolved
 * repo paths by DIFFERENT rules — cost through `agentIdsForRepo` (which normalizes separators,
 * drive letters, trailing slashes and case) and reach through an exact `IN (...)` in SQL. They
 * agreed on every test only because the fixtures spelled each path one way. On a real machine
 * `/Users/x/Repo/` and `/users/x/repo` are the same cartridge, and the goal would have read
 * "reaches no cartridges" beside a non-zero spend — the same contradiction Phase 1 fixed for
 * cost, reintroduced from the other side.
 *
 * Two copies could be held together by a test. Four cannot, so the agreement is structural
 * here: every consumer calls into this file, and the tests assert the metrics agree with each
 * other rather than against hand-written numbers.
 *
 * ── TWO SCOPES, NOT ONE ────────────────────────────────────────────────────────────────
 * Reach resolves goal → projects → CARTRIDGES. Progress and health resolve goal → RUNS, because
 * completion is a property of the workflow, not of the machine that executed it. Cost is
 * attributed to a feature through its runs (goal-cost.ts) — a project's cartridges are shared by
 * all of its features, so "everything those cartridges spent" would bill every feature for all
 * the others.
 */
import db from '../db.js';
import { agentIdsForRepo } from './resolve-agent.js';

/**
 * ── PROJECT → FEATURES ─────────────────────────────────────────────────────────────────
 * A goal row is now a FEATURE of a project (goals.project_id). Two ownership routes therefore
 * exist side by side, and every function below honours both:
 *
 *   new     feature → its project (goals.project_id); its runs are tagged workflows.goal_id
 *   legacy  goal → the projects that point at it (projects.goal_id); their untagged runs
 *
 * A project now holds many features, so a run in a project is NOT automatically a run of every
 * feature in it — only the one it was launched for (workflows.goal_id). A legacy project's runs
 * count for its goal only while untagged, so a feature added to that project later never has its
 * runs counted twice.
 */

/** The project a feature belongs to, or '' for an old-style goal not filed under one. */
export function featureProjectId(goalId: string): string {
  if (!goalId) return '';
  return ((db.prepare('SELECT project_id FROM goals WHERE id = ?').get(goalId) as { project_id?: string } | undefined)?.project_id) || '';
}

/** Projects under this goal the OLD way (projects.goal_id). */
export function goalProjectIds(goalId: string): string[] {
  if (!goalId) return [];
  const rows = db.prepare('SELECT id FROM projects WHERE goal_id = ?').all(goalId) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Repos this goal's work happens in: the feature's project's repos, plus the repos of any
 * projects that point at it the old way — by BOTH ownership routes of a project.
 *
 * `project_cartridges` is the explicit multi-repo set; `primary_repo` is the older single-repo
 * link. A project can use either, and dropping one silently zeroes every metric for the goals
 * that used it — which is exactly how cost shipped billing $0 forever.
 */
export function goalRepos(goalId: string): string[] {
  if (!goalId) return [];
  const rows = db.prepare(`
    SELECT p.primary_repo AS repo FROM projects p
     WHERE (p.goal_id = ? OR p.id = (SELECT project_id FROM goals WHERE id = ?)) AND p.primary_repo != ''
    UNION
    SELECT pc.repo_path AS repo FROM project_cartridges pc
      JOIN projects p ON p.id = pc.project_id
     WHERE p.goal_id = ? OR p.id = (SELECT project_id FROM goals WHERE id = ?)
  `).all(goalId, goalId, goalId, goalId) as { repo: string }[];
  return rows.map((r) => r.repo).filter(Boolean);
}

/**
 * Distinct cartridges this goal resolves to.
 *
 * The set is over AGENT IDS, not repos: a repo reachable by both ownership routes, or spelled
 * two ways, must count and bill exactly once. `agentIdsForRepo` owns the path normalization so
 * no caller has to remember it.
 */
export function goalAgentIds(goalId: string): string[] {
  return [...new Set(goalRepos(goalId).flatMap((repo) => agentIdsForRepo(repo)))];
}

/**
 * Workflow RUNS belonging to this goal, newest first: every run launched for it (goal_id), plus
 * the untagged runs of projects that point at it the old way.
 *
 * Templates are excluded. They are definitions, not work: the live database holds 165 pending
 * steps belonging to templates alone, so counting them would peg every goal at a permanent low
 * percentage that no amount of finished work could move.
 *
 * The NULL check is explicit on purpose. Templates carry `template_id IS NULL`, not `''`, and
 * `NULL != ''` evaluates to NULL in SQL — falsy, so a bare `template_id != ''` happens to
 * exclude them for a reason that has nothing to do with intent. Spelling it out means a future
 * migration that backfills `''` cannot silently fold 20 templates into every goal's progress.
 *
 * Status is deliberately not filtered here — progress excludes cancelled runs while health only
 * considers running ones, and burying either rule in the shared scope would make one of them
 * wrong.
 */
export function goalRunIds(goalId: string): string[] {
  if (!goalId) return [];
  const projectIds = goalProjectIds(goalId);
  const legacy = projectIds.length
    ? ` OR (goal_id = '' AND project_id IN (${projectIds.map(() => '?').join(',')}))`
    : '';
  const rows = db.prepare(
    `SELECT id FROM workflows
      WHERE template_id IS NOT NULL AND template_id != ''
        AND (goal_id = ?${legacy})
      ORDER BY created_at DESC`,
  ).all(goalId, ...projectIds) as { id: string }[];
  return rows.map((r) => r.id);
}
