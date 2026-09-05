/**
 * A workflow must be able to span more than one repo, each cartridge owning its own piece.
 *
 * REPORTED, as urgent: "I'd like to in workflows (like in confer) to involve more than one
 * repo/cartridge (example use the epic jira task template with two repos working together
 * owning their own piece)".
 *
 * ── WHAT WAS ALREADY TRUE, MEASURED BEFORE BUILDING ANYTHING ────────────────────────────
 * Every primitive this needs already exists and is used in production:
 *
 *   per-step executor assignment   routes/workflows.ts agentOverrides — "the escape hatch
 *                                  for the genuine cross-cartridge case"
 *   parallel dispatch              workflow-executor-v2.ts readySteps dispatches EVERY step
 *                                  whose dependencies are satisfied, not just the first
 *   join steps                     CE: Full Delivery already ships two of them
 *   per-branch loop counts         loopCountFrom reads its own pattern from a named
 *                                  dependency, so two branches can take two counts from ONE
 *                                  upstream step
 *   shared upstream output         dependencyResultsByName keys by step NAME
 *   deferred assignment            '__deferred__' asks the launcher which cartridge
 *
 * So the gap was never the engine. It is that no TEMPLATE uses them together: `Epic: Task by
 * Task` is a four-step line with one ROOT, one test command and one loop, and per-step
 * assignment on a line just moves where the single thread runs.
 *
 * Set-based over the PRIMITIVES rather than over the template's steps. A template that happens
 * to have two branches proves nothing if the branches cannot take separate counts or cannot
 * be pinned to separate cartridges — and each of those fails silently, as a run that quietly
 * does half the work on one repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';

const TEMPLATE = 'Epic: Two Repos';

interface StepRow {
  id: string; name: string; executor_id: string; executor_config: string; depends_on: string;
}

function templateSteps(): StepRow[] {
  const wf = db.prepare(
    'SELECT id FROM workflows WHERE name = ? AND template_id IS NULL',
  ).get(TEMPLATE) as { id: string } | undefined;
  if (!wf) return [];
  return db.prepare(
    'SELECT id, name, executor_id, executor_config, depends_on FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(wf.id) as StepRow[];
}

const cfg = (s: StepRow) => { try { return JSON.parse(s.executor_config || '{}'); } catch { return {}; } };
const deps = (s: StepRow) => { try { return JSON.parse(s.depends_on || '[]') as string[]; } catch { return []; } };

/** THE SET: every engine primitive a two-repo run depends on, and how to see it in a template. */
const PRIMITIVES: { key: string; why: string; holds: (steps: StepRow[]) => boolean }[] = [
  {
    key: 'deferred-assignment',
    why: 'the launcher must be asked which cartridge owns each side, or both default to one',
    holds: (s) => s.filter((x) => x.executor_id === '__deferred__').length >= 2,
  },
  {
    key: 'parallel-branches',
    why: 'two repos must progress at once; a line just moves where one thread runs',
    holds: (s) => {
      // NOT "some step has two dependents": the JOIN has two dependents by construction, so
      // that passed a mutation that made B wait on A — a line wearing a diamond's shape.
      // The two LOOP steps must have identical dependency sets and neither may depend on the
      // other, which is what "at the same time" actually means.
      const loops = s.filter((x) => cfg(x).loopCountFrom);
      if (loops.length < 2) return false;
      const [a, b] = loops;
      const da = deps(a).slice().sort().join(','), dbz = deps(b).slice().sort().join(',');
      if (da !== dbz || da === '') return false;
      return !deps(a).includes(b.id) && !deps(b).includes(a.id);
    },
  },
  {
    key: 'join-step',
    why: 'someone must check BOTH sides finished; without it a half-done run reports success',
    holds: (s) => s.some((x) => deps(x).length >= 2),
  },
  {
    key: 'per-branch-loop-count',
    why: 'each repo has its own task count — one shared number covers the wrong work',
    holds: (s) => {
      const pats = s.map((x) => cfg(x).loopCountFrom?.pattern).filter(Boolean);
      return new Set(pats).size >= 2;
    },
  },
  {
    key: 'shared-upstream-output',
    why: 'both branches read the same scoping step, which is what makes it ONE epic',
    holds: (s) => {
      const froms = s.map((x) => cfg(x).loopCountFrom?.step).filter(Boolean);
      return froms.length >= 2 && new Set(froms).size === 1;
    },
  },
  {
    key: 'per-branch-stop-sentinel',
    why: 'either side can run out of work first and must stop without stopping the other',
    holds: (s) => s.filter((x) => typeof cfg(x).loopUntil === 'string' && cfg(x).loopUntil).length >= 2,
  },
  {
    key: 'ownership-is-stated',
    why: 'two agents on one epic need a written boundary, or both edit the same task',
    // A specific, load-bearing sentence rather than any word about ownership: the loose
    // version matched leftover prose and passed a template with the boundary deleted.
    holds: (s) => s.filter((x) =>
      /never edit files in the other repo/i.test(String(cfg(x).prompt ?? ''))).length >= 2,
  },
];

test('the primitive set is enumerated, not sampled', () => {
  assert.equal(PRIMITIVES.length, 7,
    'the set of primitives a two-repo run needs changed — update it deliberately');
});

test('the multi-repo template exists', () => {
  assert.ok(templateSteps().length > 0,
    `no "${TEMPLATE}" template — per-step assignment on a linear template only moves where ` +
    'one thread runs; it does not make two repos work at once');
});

test('EVERY primitive a two-repo run needs is exercised by the template', () => {
  const steps = templateSteps();
  const missing = PRIMITIVES.filter((p) => !p.holds(steps)).map((p) => `${p.key} — ${p.why}`);
  assert.deepEqual(missing, [],
    `the template does not exercise:\n  ${missing.join('\n  ')}`);
});
