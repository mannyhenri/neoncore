/**
 * A launch that cannot possibly run must be refused at the door, not at step 1.
 *
 * WHAT HAPPENED. Launching CE: Full Delivery from the Goals page produced a run with 47 of 47
 * steps unassigned. The start endpoint accepted it, cloned all 47 rows, marked the run
 * `running`, and then step 1 threw "has no cartridge assigned" on dispatch. You get a run that
 * exists, looks started, and is already dead.
 *
 * THE CALLER BUG UNDERNEATH IT. `startWorkflowV2` takes the cartridge in TWO different
 * positions — `agentOverrides` (arg 2, a stepId→agentId map) and `agentId` (arg 6, the
 * run-level cartridge that fills every deferred step). GoalsPage passed the chosen cartridge as
 * `{ [templateId]: agentId }` in arg 2: a map keyed by a TEMPLATE id, which matches no step,
 * while arg 6 stayed undefined. Silently assigned nothing.
 *
 * WHY THE GUARD LIVES HERE AND NOT IN THE CALLER. Fixing GoalsPage fixes one of four launch
 * sites. A seven-positional-argument function where args 2 and 6 both mean "which agent" will
 * be miscalled again — that is a footgun, not a typo. So the invariant is enforced server-side
 * where every caller passes: if a launch would leave a step with no cartridge, refuse before
 * creating anything. The queue states the same principle for enqueue — "validation at the door,
 * while a human is watching, not at 3am when it comes up".
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { resolveWorkflowTargets } from '../src/lib/queue-if-busy.ts';
import { unassignedStepNames } from '../src/lib/workflow-launch.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function template(steps: string[]): string {
  const id = `tpl-${++n}`;
  db.prepare("INSERT INTO workflows (id, name, status, created_at) VALUES (?,?,'pending',?)")
    .run(id, `T-${id}`, ISO);
  steps.forEach((executor, i) => {
    db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, position_y, status, executor_type, executor_id, created_at)
                VALUES (?,?,?,?,'pending','cartridge',?,?)`)
      .run(`${id}-s${i}`, id, `step ${i}`, i, executor, ISO);
  });
  return id;
}
function agent(): string {
  const id = `ag-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,'idle',?,'')`).run(id, `t/${id}`, 'm', '/r', 'r', 'claude', ISO);
  return id;
}

/**
 * THE SET: every shape a launch request can take, and whether it can actually run.
 * The two "miscalled" cases are the real bug, kept as first-class members because they are
 * what a caller produces when it reaches for the wrong argument.
 */
test('EVERY launch shape is judged correctly on whether its steps can run', () => {
  const a = agent();
  const CASES: { label: string; steps: string[]; body: Record<string, unknown>; runnable: boolean }[] = [
    {
      label: 'all steps pre-pinned, no agent needed',
      steps: ['PIN', 'PIN'], body: {}, runnable: true,
    },
    {
      label: 'deferred steps + run-level agentId (the correct call)',
      steps: ['__deferred__', '__deferred__'], body: { agentId: 'AGENT' }, runnable: true,
    },
    {
      label: 'deferred steps + per-step overrides keyed by real step ids',
      steps: ['__deferred__'], body: { agentOverrides: { STEP0: 'AGENT' } }, runnable: true,
    },
    {
      label: 'deferred steps and NOTHING supplied — the reported failure',
      steps: ['__deferred__', '__deferred__'], body: {}, runnable: false,
    },
    {
      label: 'overrides keyed by TEMPLATE id — what GoalsPage actually sent',
      steps: ['__deferred__'], body: { agentOverrides: { TEMPLATE: 'AGENT' } }, runnable: false,
    },
    {
      label: 'empty-string executors, not the __deferred__ sentinel',
      steps: ['', ''], body: {}, runnable: false,
    },
    {
      label: 'partially covered — one pinned, one still deferred',
      steps: ['PIN', '__deferred__'], body: {}, runnable: false,
    },
  ];

  const wrong: string[] = [];
  for (const c of CASES) {
    const tpl = template(c.steps.map((s) => (s === 'PIN' ? a : s)));
    const body = { ...c.body };
    if (body.agentId === 'AGENT') body.agentId = a;
    if (body.agentOverrides) {
      const map = body.agentOverrides as Record<string, string>;
      const fixed: Record<string, string> = {};
      for (const [k, v] of Object.entries(map)) {
        fixed[k === 'STEP0' ? `${tpl}-s0` : k === 'TEMPLATE' ? tpl : k] = v === 'AGENT' ? a : v;
      }
      body.agentOverrides = fixed;
    }

    const unassigned = unassignedStepNames(tpl, body);
    const runnable = unassigned.length === 0;
    if (runnable !== c.runnable) {
      wrong.push(`${c.label}: expected runnable=${c.runnable}, got ${runnable} (unassigned: ${unassigned.join(', ') || 'none'})`);
    }
  }
  assert.deepEqual(wrong, [], `launch validation is wrong for:\n  ${wrong.join('\n  ')}`);
});

test('the refusal NAMES the steps that have no cartridge', () => {
  // "Launch failed" sends you to the database. The step names are what make it actionable.
  const tpl = template(['__deferred__', '__deferred__']);
  const names = unassignedStepNames(tpl, {});
  assert.equal(names.length, 2);
  assert.ok(names.every((x) => x.startsWith('step ')), `expected step names, got ${names.join(', ')}`);
});

test('assignment and the busy-check agree on who will run the work', () => {
  // resolveWorkflowTargets (the busy guard) and unassignedStepNames (the launch guard) both
  // answer "which cartridges does this run drive". Two answers would mean a run that passes
  // one gate and fails the other — so they are derived from the same three sources.
  const a = agent();
  const tpl = template(['__deferred__', '__deferred__']);
  const body = { agentId: a };
  assert.deepEqual(unassignedStepNames(tpl, body), [], 'launch guard says unrunnable');
  assert.deepEqual(resolveWorkflowTargets(tpl, body), [a], 'busy guard disagrees about the target');
});
