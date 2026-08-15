/**
 * "This goal reaches N cartridges" must be TRUE, not decorative.
 *
 * GOAL-001/003. The Goals area's real defect was never permissiveness — it was silence. All
 * three live projects have `goal_id = NULL`, so `goalCostUsd()` returns 0 and the goal brief
 * injects 0 characters into every dispatched prompt, and nothing anywhere says so. The user
 * decided (2026-08-13) NOT to require a goal on every project — "just in case we just need to
 * work quickly on something" — which upholds the v0.1 design principle. So the fix is to make
 * the emptiness visible instead of forbidding it.
 *
 * THE PROPERTY THAT MAKES THE NUMBER HONEST. Reach is not a second opinion about linkage; it
 * must be computed from the SAME resolution path the goal brief uses. If reach said 3 while
 * `goalForAgent()` resolved for 0 cartridges, the badge would be a more confident lie than the
 * silence it replaced. Every test below therefore cross-checks reach against `goalForAgent` /
 * `goalBriefForAgent` rather than against a hand-written expectation.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { goalReach, unassignedProjectCount } from '../src/lib/goal-reach.ts';
import { goalForAgent, goalBriefForAgent } from '../src/lib/goal-brief.ts';
import { goalCostUsd } from '../src/lib/goal-cost.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function goal(): string {
  const id = `g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, budget_usd, status,
              created_at, updated_at, acceptance_criteria, no_gos, rabbit_holes, invariants, key_results)
              VALUES (?,?,?,'',NULL,'active',?,?,?,'','','','[]')`)
    .run(id, `goal ${id}`, 'why it matters', ISO, ISO, 'When X, the system shall Y.');
  return id;
}
function project(goalId: string | null, primaryRepo = ''): string {
  const id = `p-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,?,?,'',?,'#fff',?,?)`).run(id, goalId, `proj ${id}`, primaryRepo, ISO, ISO);
  return id;
}
function cartridge(repoPath: string): string {
  const id = `a-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,'idle',?,'')`)
    .run(id, `t/${id}`, 'm', repoPath, repoPath.split('/').pop(), 'claude', ISO);
  return id;
}
function own(projectId: string, repoPath: string): void {
  db.prepare('INSERT OR IGNORE INTO project_cartridges (project_id, repo_path) VALUES (?,?)')
    .run(projectId, repoPath);
}

/** Cartridges the brief would ACTUALLY reach — the ground truth reach must match. */
function cartridgesTheBriefReaches(goalId: string): string[] {
  const all = db.prepare('SELECT id FROM agents').all() as { id: string }[];
  return all.filter((a) => goalForAgent(a.id)?.id === goalId).map((a) => a.id);
}

test('reach equals the set of cartridges the goal brief would actually reach', () => {
  // The load-bearing assertion. Any divergence means the badge is lying.
  const g = goal();
  const p = project(g);
  own(p, '/repo/one'); cartridge('/repo/one');
  own(p, '/repo/two'); cartridge('/repo/two');
  cartridge('/repo/unrelated');

  assert.equal(goalReach(g), cartridgesTheBriefReaches(g).length);
  assert.equal(goalReach(g), 2);
});

test('reach 0 PROVES the brief injects nothing — the live condition', () => {
  // This is exactly the state of the running system: projects exist, none carry a goal_id.
  const g = goal();
  project(null, '/repo/orphan');          // a project with no goal
  const a = cartridge('/repo/orphan');

  assert.equal(goalReach(g), 0);
  assert.equal(goalForAgent(a), null);
  assert.equal(goalBriefForAgent(a).length, 0,
    'reach says 0 but the brief still injects — the number would be meaningless');
});

test('EVERY ownership route counts, because the brief honours both', () => {
  // goal-brief.ts resolves via project_cartridges OR primary_repo. Reach must use the same two,
  // or a goal linked the older way would report 0 while its brief works.
  const CASES: { label: string; wire: (g: string) => string }[] = [
    {
      label: 'project_cartridges (the explicit set)',
      wire: (g) => { const p = project(g); own(p, `/r/${++n}`); return `/r/${n}`; },
    },
    {
      label: 'primary_repo (the older single-repo link)',
      wire: (g) => { const path = `/r/${++n}`; project(g, path); return path; },
    },
  ];
  const wrong: string[] = [];
  for (const c of CASES) {
    const g = goal();
    const path = c.wire(g);
    cartridge(path);
    if (goalReach(g) !== 1) wrong.push(`${c.label}: reach ${goalReach(g)}, expected 1`);
    if (goalReach(g) !== cartridgesTheBriefReaches(g).length) {
      wrong.push(`${c.label}: reach disagrees with the brief's own resolution`);
    }
  }
  assert.deepEqual(wrong, [], `reach misses an ownership route:\n  ${wrong.join('\n  ')}`);
});

test('a cartridge reachable BOTH ways is counted once', () => {
  // Otherwise a well-linked goal inflates its own reach and looks healthier than it is.
  const g = goal();
  const p = project(g, '/repo/both');
  own(p, '/repo/both');
  cartridge('/repo/both');
  assert.equal(goalReach(g), 1);
});

test('a goal with projects but no cartridges still reads 0 — the silent case', () => {
  // The exact shape that hid the problem: projects attached, so the UI looks populated, but
  // nothing resolves to a cartridge, so no prompt ever carries the goal.
  const g = goal();
  project(g);            // no primary_repo, no owned cartridges
  assert.equal(goalReach(g), 0);
});

test('unassigned projects are countable, since they are now allowed', () => {
  // The user chose to keep project-without-a-goal legal. That makes counting them the whole
  // mechanism by which the choice stays visible rather than silently accumulating.
  const before = unassignedProjectCount();
  project(null);
  project(null);
  project(goal());
  assert.equal(unassignedProjectCount(), before + 2);
});

test('reach ignores cartridge liveness — it measures linkage, not who is awake', () => {
  // A goal still "reaches" an offline cartridge: the brief will carry to it the moment it is
  // dispatched to. Conflating the two would make reach flicker with cartridge status.
  const g = goal();
  const p = project(g);
  own(p, '/repo/sleepy');
  const a = cartridge('/repo/sleepy');
  db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(a);
  assert.equal(goalReach(g), 1);
});

/**
 * THE THIRD CONSUMER. Reach, the brief and COST all answer "which cartridges belong to this
 * goal", and all three must answer identically — the epic states this as a constraint: one
 * resolution path, three metrics.
 *
 * Found live the moment linkage was switched on: a goal read "reaches 2 cartridges" and
 * "$0.00 spent", permanently, because `goalCostUsd` consulted only `projects.primary_repo`
 * while the project owned its cartridge through `project_cartridges`. Cost was structurally
 * unable to move. That is worse than the silence this work replaced — two numbers on one card
 * confidently contradicting each other.
 */
test('cost bills exactly the cartridges reach counts — no third opinion', () => {
  const g = goal();
  const p = project(g);                     // owns via project_cartridges, primary_repo empty
  own(p, '/repo/billed');
  const a = cartridge('/repo/billed');
  db.prepare(`INSERT INTO session_usage (id, agent_id, session_id, model, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, recorded_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`u-${++n}`, a, 's1', 'claude-sonnet-4-6', 100000, 50000, 0, 0, ISO);

  assert.equal(goalReach(g), 1, 'setup: the cartridge should be reachable');
  assert.ok(goalCostUsd(g) > 0,
    'reach counts this cartridge but cost bills nothing — the two disagree, so one of them lies');
});

/**
 * THE AGREEMENT IS STRUCTURAL, NOT COINCIDENTAL.
 *
 * Reach and cost agreed on every case above — but for the wrong reason. `goalCostUsd` resolved
 * repos through `agentIdsForRepo`, which NORMALIZES (`\`→`/`, `C:/`→`/c/`, trailing slash
 * stripped, lowercased). `goalReach` did its own `a.repo_path IN (...)` in SQL, which is exact
 * string equality. Two different answers to the same question, kept in agreement only by test
 * data that happened to spell every path identically.
 *
 * Phase 3 is what makes this urgent rather than theoretical: progress and health become the
 * third and fourth consumers of "which work belongs to this goal", and four hand-written copies
 * of one resolution cannot be kept in sync by assertion. So the paths merge into `goal-scope.ts`
 * and this test pins the property that forced it.
 */
test('reach and cost resolve paths the SAME way — not two spellings of one repo', () => {
  const g = goal();
  // The project records the path as the user typed it; the cartridge registered its own
  // normalized form. Real: macOS is case-insensitive and trailing slashes come and go.
  // `base` is captured ONCE — the helpers bump `n` themselves, so re-reading it after a
  // helper call silently hands the two rows different paths (which is how this test first
  // passed its own key assertion vacuously, with both sides missing).
  const base = `/Repo/Cased-${++n}`;
  project(g, `${base}/`);
  const a = cartridge(base.toLowerCase());
  db.prepare(`INSERT INTO session_usage (id, agent_id, session_id, model, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, recorded_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`u-${++n}`, a, 's5', 'claude-sonnet-4-6', 100000, 50000, 0, 0, ISO);

  assert.equal(
    goalReach(g) > 0, goalCostUsd(g) > 0,
    'reach and cost disagree about whether this cartridge belongs to the goal — they are ' +
    'resolving the repo path by different rules',
  );
  assert.equal(goalReach(g), 1, 'reach missed a cartridge whose path differs only by normalization');
});

test('cost still counts the OLDER primary_repo route', () => {
  // The fix must widen the query, not swap one route for the other.
  const g = goal();
  const path = `/repo/legacy-${++n}`;
  project(g, path);
  const a = cartridge(path);
  db.prepare(`INSERT INTO session_usage (id, agent_id, session_id, model, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, recorded_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`u-${++n}`, a, 's2', 'claude-sonnet-4-6', 100000, 50000, 0, 0, ISO);
  assert.ok(goalCostUsd(g) > 0, 'the older primary_repo linkage stopped billing');
});

test('a cartridge owned BOTH ways is billed once, not twice', () => {
  const g = goal();
  const path = `/repo/dual-${++n}`;
  const p = project(g, path);
  own(p, path);
  const a = cartridge(path);
  db.prepare(`INSERT INTO session_usage (id, agent_id, session_id, model, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, recorded_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`u-${++n}`, a, 's3', 'claude-sonnet-4-6', 100000, 50000, 0, 0, ISO);

  const single = goalCostUsd(g);
  const g2 = goal();
  const path2 = `/repo/single-${++n}`;
  project(g2, path2);
  const a2 = cartridge(path2);
  db.prepare(`INSERT INTO session_usage (id, agent_id, session_id, model, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, recorded_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`u-${++n}`, a2, 's4', 'claude-sonnet-4-6', 100000, 50000, 0, 0, ISO);

  assert.equal(single.toFixed(6), goalCostUsd(g2).toFixed(6),
    'the same usage billed differently depending on how ownership was recorded');
});
