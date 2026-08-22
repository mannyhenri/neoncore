/**
 * A launch pinned to a cartridge that no longer exists must be refused at the door.
 *
 * WHAT HAPPENED. "New Feature" (run 9bdca436, 2026-08-19) was launched against gridlight. Step 1
 * "Research" died 11 seconds later with:
 *
 *     Command not delivered: agent 6b382c3d-b4a8-42d5-a735-c3f16005efc7 not found
 *
 * All 8 steps were pinned to that id. No agent with that id exists — there are 8 registered and
 * it is none of them. The run was created, all 8 rows cloned, marked `running`, and was already
 * dead. Exactly the failure workflow-launch-assignment.test.ts was written to prevent, one case
 * short: that guard asks "is there a value in executor_id", not "is that value a real cartridge".
 *
 * WHY THIS IS THE WHOLE CLASS, NOT ONE RUN. Cartridge ids are ephemeral — a cartridge that
 * restarts registers a new id, and every run still pinned to the old one is unlaunchable. In
 * this database 26 workflows carry 156 step rows pointing at ids that are not in `agents`, and
 * 25 of those 26 are already `cancelled`. This has been happening and being cancelled by hand.
 *
 * THE SET. A launch resolves a cartridge from THREE sources — the step's `executor_id`,
 * `body.agentId` (the run-level fill), and `body.agentOverrides[stepId]` — and TWO guards
 * consume them: `unassignedStepNames` (may this run start) and `resolveWorkflowTargets` (which
 * cartridges is it about to drive). 3 x 2 = 6 resolution points, and a stale id must be caught
 * at every one. The two guards are documented as needing to agree; a stale id accepted by one
 * and rejected by the other is the same split-brain that comment warns about.
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
/** An id shaped exactly like a real cartridge id, belonging to no row in `agents`. */
function staleAgent(): string {
  return `gone-${++n}-6b382c3d-b4a8-42d5-a735-c3f16005efc7`;
}

/**
 * THE SET: a stale cartridge id reaching the launch guard through every source it can arrive by.
 * Controls (a live cartridge in the same position) are first-class members — a guard that
 * refuses everything would pass a refusal-only test.
 */
test('EVERY source a stale cartridge id can arrive by is refused at the door', () => {
  const CASES: { label: string; steps: string[]; body: Record<string, unknown>; runnable: boolean }[] = [
    // ── source 1: the step's own executor_id ──
    { label: 'src1 step pinned to a LIVE cartridge (control)', steps: ['PIN'], body: {}, runnable: true },
    { label: 'src1 step pinned to a STALE cartridge', steps: ['STALE'], body: {}, runnable: false },
    { label: 'src1 every step stale — the reported run', steps: ['STALE', 'STALE', 'STALE'], body: {}, runnable: false },
    { label: 'src1 one live, one stale', steps: ['PIN', 'STALE'], body: {}, runnable: false },

    // ── source 2: body.agentId, the run-level fill ──
    { label: 'src2 deferred + LIVE run-level agentId (control)', steps: ['__deferred__'], body: { agentId: 'AGENT' }, runnable: true },
    { label: 'src2 deferred + STALE run-level agentId', steps: ['__deferred__'], body: { agentId: 'STALE' }, runnable: false },

    // ── source 3: body.agentOverrides[stepId] ──
    { label: 'src3 deferred + LIVE per-step override (control)', steps: ['__deferred__'], body: { agentOverrides: { STEP0: 'AGENT' } }, runnable: true },
    { label: 'src3 deferred + STALE per-step override', steps: ['__deferred__'], body: { agentOverrides: { STEP0: 'STALE' } }, runnable: false },

    // ── a stale override must not be rescued by a live run-level fill, or vice versa ──
    { label: 'live run-level fill does NOT rescue a stale override', steps: ['__deferred__'], body: { agentId: 'AGENT', agentOverrides: { STEP0: 'STALE' } }, runnable: false },
    { label: 'live override DOES cover a step the stale run-level fill would not', steps: ['__deferred__'], body: { agentId: 'STALE', agentOverrides: { STEP0: 'AGENT' } }, runnable: true },

    // ── the run-level fill only touches '' / __deferred__ steps (routes/workflows.ts:
    // `needsExecutor = !s.executor_id || s.executor_id === '__deferred__'`), so it CANNOT
    // rescue a stale pin. An explicit per-step override overwrites unconditionally, so it can.
    { label: 'live run-level fill does NOT rescue a STALE PIN (fill skips pinned steps)', steps: ['STALE'], body: { agentId: 'AGENT' }, runnable: false },
    { label: 'live per-step override DOES rescue a stale pin (override overwrites)', steps: ['STALE'], body: { agentOverrides: { STEP0: 'AGENT' } }, runnable: true },
  ];

  const wrong: string[] = [];
  for (const c of CASES) {
    const live = agent();
    const stale = staleAgent();
    const sub = (v: string) => (v === 'AGENT' ? live : v === 'STALE' ? stale : v);
    const tpl = template(c.steps.map((s) => (s === 'PIN' ? live : s === 'STALE' ? stale : s)));

    const body: Record<string, unknown> = { ...c.body };
    if (typeof body.agentId === 'string') body.agentId = sub(body.agentId);
    if (body.agentOverrides) {
      const fixed: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.agentOverrides as Record<string, string>)) {
        fixed[k === 'STEP0' ? `${tpl}-s0` : k] = sub(v);
      }
      body.agentOverrides = fixed;
    }

    const unassigned = unassignedStepNames(tpl, body);
    const runnable = unassigned.length === 0;
    if (runnable !== c.runnable) {
      wrong.push(`${c.label}: expected runnable=${c.runnable}, got ${runnable} (blocked: ${unassigned.join(', ') || 'none'})`);
    }
  }
  assert.deepEqual(wrong, [], `stale-cartridge validation is wrong for:\n  ${wrong.join('\n  ')}`);
});

test('the busy guard never reports a cartridge that does not exist as a target', () => {
  // resolveWorkflowTargets feeds guardBusy and the queue lane. A nonexistent cartridge drives
  // nothing and can never be busy; returning it queues the run behind a ghost.
  const wrong: string[] = [];
  const live = agent();

  const pinned = template([staleAgent(), live]);
  const t1 = resolveWorkflowTargets(pinned, {});
  if (t1.length !== 1 || t1[0] !== live) wrong.push(`pinned steps -> ${JSON.stringify(t1)}, expected [${live}]`);

  const deferred = template(['__deferred__']);
  const t2 = resolveWorkflowTargets(deferred, { agentId: staleAgent() });
  if (t2.length !== 0) wrong.push(`stale run-level agentId -> ${JSON.stringify(t2)}, expected []`);

  const t3 = resolveWorkflowTargets(deferred, { agentOverrides: { [`${deferred}-s0`]: staleAgent() } });
  if (t3.length !== 0) wrong.push(`stale override -> ${JSON.stringify(t3)}, expected []`);

  assert.deepEqual(wrong, [], `busy guard returns ghost targets:\n  ${wrong.join('\n  ')}`);
});

test('the refusal NAMES the steps whose cartridge is gone', () => {
  // "Command not delivered: agent <uuid> not found" sends you to the database. The step names
  // are what make it actionable while a human is still watching.
  const tpl = template([staleAgent(), staleAgent()]);
  const names = unassignedStepNames(tpl, {});
  assert.equal(names.length, 2, `expected both steps named, got ${JSON.stringify(names)}`);
  assert.ok(names.every((x) => x.startsWith('step ')), `expected step names, got ${names.join(', ')}`);
});

test('both guards agree about a stale cartridge', () => {
  // The split-brain workflow-launch.ts warns about: one gate says start, the other says target.
  const tpl = template([staleAgent()]);
  assert.notDeepEqual(unassignedStepNames(tpl, {}), [], 'launch guard admits a dead cartridge');
  assert.deepEqual(resolveWorkflowTargets(tpl, {}), [], 'busy guard claims a dead cartridge as a target');
});
