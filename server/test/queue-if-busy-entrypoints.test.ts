/**
 * EVERY entry point that starts work on a cartridge must queue behind a busy one —
 * and the queued item must actually be able to wait.
 *
 * WHY THIS SUITE EXISTS ALONGSIDE queue-if-busy.test.ts. That suite asserts each route
 * *mentions* isCartridgeBusy and queueIfBusy. routes/workflows.ts mentions both, so it was
 * green the entire time the reported bug was live: running one workflow after another
 * started the second one on top of the first. Presence of the mechanism is not correctness
 * of the mechanism, and a source-grep cannot tell them apart. These assertions are
 * BEHAVIOURAL for that reason.
 *
 * THE THREE PROPERTIES, per entry point. A half-fix satisfies one or two and still runs work
 * on a busy cartridge, so all three are asserted for every kind rather than for the kind that
 * was reported:
 *
 *   P1  the busy check consults the REAL resolved targets — the cartridges the work will
 *       actually drive, not a proxy set that happens to be empty in the common case
 *   P2  the enqueued item CARRIES those targets — the runner re-checks busyTargets(item)
 *       before dispatch, and an item with targets:[] makes that guard vacuous, so it lands
 *       on the busy cartridge anyway the moment its lane frees
 *   P3  the item lands in a lane keyed to its work — everything falling into the shared
 *       `repo:default` bucket serialises unrelated cartridges against each other while
 *       failing to serialise the one that matters
 *
 * The workflow path failed all three at once, which is why it looked like the queue was
 * simply ignored.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { guardBusy, resolveWorkflowTargets } from '../src/lib/queue-if-busy.ts';
import { listQueue, isCartridgeBusy, tickQueue } from '../src/lib/queue-runner.ts';
import { KIND_IDS } from '../src/lib/queue-kinds.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function agent(status = 'working'): string {
  const id = `ep-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,?,?,'')`)
    .run(id, `t/${id}`, 'm', '/repo/one', 'one', 'claude', status, ISO);
  return id;
}

function workflow(id: string, steps: { executor: string }[]): string {
  db.prepare(`INSERT INTO workflows (id, name, status, created_at)
              VALUES (?,?,'pending',?)`).run(id, `wf-${id}`, ISO);
  steps.forEach((s, i) => {
    db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, position_y, status, executor_type, executor_id, created_at)
                VALUES (?,?,?,?,'pending','cartridge',?,?)`)
      .run(`${id}-s${i}`, id, `step ${i}`, i, s.executor, ISO);
  });
  return id;
}

function task(id: string): string {
  db.prepare(`INSERT INTO tasks (id, title, prompt, status, priority, created_at)
              VALUES (?,?,?,'queued',0,?)`).run(id, `task ${id}`, 'do the thing', ISO);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRY. One entry per user-initiated way to put work on a cartridge.
// Derived from the routes that dispatch (commands, confer, workflows, tasks),
// cross-checked against KIND_IDS so a kind cannot be added without an entry here.
// ─────────────────────────────────────────────────────────────────────────────

interface EntryPoint {
  kind: string;
  label: string;
  /** Build the guard spec exactly as the route would, given busy cartridges. */
  spec(busy: string[]): { kind: string; targets: string[]; payload: Record<string, unknown> };
}

const ENTRY_POINTS: EntryPoint[] = [
  {
    kind: 'prompt',
    label: 'POST /api/commands/send',
    spec: (busy) => ({ kind: 'prompt', targets: busy, payload: { text: 'do the thing' } }),
  },
  {
    kind: 'confer',
    label: 'POST /api/confer/start',
    spec: (busy) => ({
      kind: 'confer',
      targets: busy,
      payload: {
        repoName: 'one', repoPath: '/repo/one',
        participantIds: busy, task: 'confer on the thing', buildRounds: 1,
      },
    }),
  },
  {
    kind: 'workflow',
    label: 'POST /api/workflows/v2/:id/start',
    spec: (busy) => ({
      kind: 'workflow',
      targets: busy,
      payload: { workflowId: 'wf-guard', repoPath: '/repo/one', startOptions: {} },
    }),
  },
  {
    kind: 'task',
    label: 'POST /api/tasks/:id/dispatch',
    spec: (busy) => ({
      kind: 'task',
      targets: busy,
      payload: { taskId: 'task-guard', agentId: busy[0] },
    }),
  },
];

test('the registry covers every queueable kind — no kind may start work unguarded', () => {
  // Both directions. A kind with no entry here is a dispatch path nobody proved queues; an
  // entry for a kind that does not exist is coverage theatre.
  const covered = ENTRY_POINTS.map((e) => e.kind).sort();
  assert.deepEqual(covered, [...KIND_IDS].sort(),
    'every queue kind needs an entry point that queues it when the cartridge is busy');
});

// ─── P1 · the busy check fires against the real targets ─────────────────────

test('P1 — EVERY entry point queues when its target cartridge is busy', () => {
  const leaked: string[] = [];
  for (const e of ENTRY_POINTS) {
    // Confer needs two participants; give every kind two so the fixture is uniform.
    const busy = [agent('working'), agent('working')];
    assert.ok(busy.every(isCartridgeBusy), 'fixture agents must be busy');

    const out = guardBusy(e.spec(busy) as never);
    if (!('queued' in out) || out.queued !== true) {
      leaked.push(`${e.label} started work on a busy cartridge instead of queueing (${JSON.stringify(out)})`);
    }
  }
  assert.deepEqual(leaked, [], `these entry points interrupt busy cartridges:\n  ${leaked.join('\n  ')}`);
});

test('P1 — EVERY entry point runs immediately when nothing is busy', () => {
  // The other direction matters as much: a guard that always queues turns every start into a
  // wait and looks, from the outside, exactly like the queue being stuck.
  const stalled: string[] = [];
  for (const e of ENTRY_POINTS) {
    const free = [agent('idle'), agent('idle')];
    const out = guardBusy(e.spec(free) as never);
    if ('queued' in out && out.queued === true) {
      stalled.push(`${e.label} queued work against idle cartridges`);
    }
  }
  assert.deepEqual(stalled, [], `these entry points queue when they should run:\n  ${stalled.join('\n  ')}`);
});

// ─── P2 · the queued item carries its targets ───────────────────────────────

test('P2 — EVERY queued item carries the cartridges it will drive', () => {
  // queue-runner.busyTargets(item) re-checks before dispatch. With targets:[] that guard
  // returns nothing, so the item dispatches onto a cartridge that is still working — the
  // queue "worked" and the collision happened anyway. This is the assertion that catches it.
  const empty: string[] = [];
  for (const e of ENTRY_POINTS) {
    const busy = [agent('working'), agent('working')];
    const out = guardBusy(e.spec(busy) as never);
    if (!('item' in out) || !out.item) { empty.push(`${e.label} did not queue at all`); continue; }
    const item = listQueue().find((i) => i.id === out.item.id)!;
    if (item.targets.length === 0) {
      empty.push(`${e.label} enqueued with targets:[] — the runner's pre-dispatch guard is vacuous`);
    }
    for (const b of busy) {
      if (!item.targets.includes(b)) empty.push(`${e.label} dropped target ${b} from the queued item`);
    }
  }
  assert.deepEqual(empty, [], `these items cannot wait for their cartridge:\n  ${empty.join('\n  ')}`);
});

// ─── P3 · the lane is specific to the work ──────────────────────────────────

test('P3 — no entry point lands in the shared repo:default lane', () => {
  // `repo:default` is the fallback when the payload carries no repoPath. Everything landing
  // there is serialised against unrelated work while NOT being serialised against the
  // cartridge it targets — the worst of both.
  const shared: string[] = [];
  for (const e of ENTRY_POINTS) {
    const busy = [agent('working'), agent('working')];
    const out = guardBusy(e.spec(busy) as never);
    if (!('item' in out) || !out.item) continue;
    const item = listQueue().find((i) => i.id === out.item.id)!;
    if (item.lane === 'repo:default') {
      shared.push(`${e.label} fell back to the global repo:default lane`);
    }
  }
  assert.deepEqual(shared, [], `these items share one global lane:\n  ${shared.join('\n  ')}`);
});

// ─── The specific defect: how a workflow resolves its cartridges ────────────

test('workflow targets include the cartridge chosen AT LAUNCH, not just pinned steps', () => {
  // THE REPORTED BUG. The old check read only step rows with a concrete executor_id. A
  // TEMPLATE's steps are '__deferred__' until launch — the cartridge comes from the run
  // modal as body.agentId — so the busy set was empty for the single most common path and
  // the workflow started regardless of what the cartridge was doing.
  const a = agent('working');
  const b = agent('working');

  const CASES: { label: string; wf: string; body: Record<string, unknown>; want: string[] }[] = [
    {
      label: 'steps pinned to a cartridge',
      wf: workflow('wf-pinned', [{ executor: a }, { executor: a }]),
      body: {},
      want: [a],
    },
    {
      label: 'deferred steps + agent chosen at launch',
      wf: workflow('wf-deferred', [{ executor: '__deferred__' }, { executor: '' }]),
      body: { agentId: b },
      want: [b],
    },
    {
      label: 'per-step overrides from the run modal',
      wf: workflow('wf-override', [{ executor: '__deferred__' }]),
      body: { agentOverrides: { 'wf-override-s0': b } },
      want: [b],
    },
    {
      label: 'pinned steps AND a launch agent for the deferred ones',
      wf: workflow('wf-mixed', [{ executor: a }, { executor: '__deferred__' }]),
      body: { agentId: b },
      want: [a, b],
    },
  ];

  const wrong: string[] = [];
  for (const c of CASES) {
    const got = resolveWorkflowTargets(c.wf, c.body).sort();
    if (JSON.stringify(got) !== JSON.stringify([...c.want].sort())) {
      wrong.push(`${c.label}: expected [${c.want}] got [${got}]`);
    }
  }
  assert.deepEqual(wrong, [], `workflow target resolution is wrong for:\n  ${wrong.join('\n  ')}`);
});

// ─── The runner must agree with the route about what "busy" means ───────────

test('the runner will not dispatch onto a cartridge busy with NON-queue work', () => {
  // The route calls isCartridgeBusy (status working/waiting OR holding an item). The runner's
  // pre-dispatch guard used to check only active_queue_item_id, so a cartridge working on
  // something a human started by hand read as free — and the queued item dispatched straight
  // on top of it. Two definitions of busy in one feature is one too many.
  const a = agent('working'); // working, but holding no queue item
  db.prepare("UPDATE agents SET active_queue_item_id = '' WHERE id = ?").run(a);

  const out = guardBusy({ kind: 'prompt', targets: [a], payload: { text: 'x' } } as never);
  assert.ok('item' in out && out.item, 'a busy cartridge should have queued this prompt');

  const before = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(out.item.id) as { status: string };
  assert.equal(before.status, 'queued');

  // Tick: the lane is free of other items, so only the busy-target guard can hold it back.
  tickQueue();

  const after = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(out.item.id) as { status: string };
  assert.equal(after.status, 'queued',
    'the runner dispatched onto a cartridge that is still working — busyTargets disagrees with isCartridgeBusy');
});

// ─── Epic starts: guarded WITHOUT a queue kind ──────────────────────────────

/**
 * An epic run is the fifth way to put work on a cartridge, and it is deliberately NOT a
 * queue kind. Three reasons, all from the code rather than from taste:
 *
 *   · it is vestigial — `epic_runs` has zero rows and there is no UI anywhere that starts
 *     one (the only "epic" in the dashboard is a Jira epic KEY typed into a workflow prompt)
 *   · workflows already cover it — the 'Jira Tasks Validation' and 'Jira Tasks Completion'
 *     templates run the same multi-task sequence, on the queue, with recovery
 *   · it advances by IDLE INFERENCE (idleThresholdMs: 45000), which queue-kinds.ts names
 *     explicitly as the thing the queue was built to reject
 *
 * Adding a fifth kind, a detector and four registry entries to a feature with no users, to
 * make it a first-class citizen of the machinery that replaced it, is how dead code becomes
 * permanent. So the hole is closed with the epic's OWN paused state instead: busy cartridge
 * means the run is created paused rather than dispatched, and /runs/:id/resume starts it.
 * Same guarantee — nothing lands on top of running work — at no structural cost.
 */
test('an epic start never dispatches onto a busy cartridge', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/routes/epics.ts'), 'utf8');

  assert.match(src, /isCartridgeBusy/, 'the epic start route never consults busy state');

  // POSITION, not just presence — the same property the confer suite pins. A busy check that
  // runs after the dispatch has already happened is decoration.
  const start = src.indexOf("router.post('/start'");
  assert.notEqual(start, -1, 'the epic start route has moved');
  const handler = src.slice(start, src.indexOf('router.', start + 10));
  const check = handler.indexOf('isCartridgeBusy');
  const dispatch = handler.indexOf('sendCommandToAgent');
  assert.notEqual(check, -1, 'the epic start handler does not check busy state');
  assert.notEqual(dispatch, -1, 'the epic start handler no longer dispatches — has it moved?');
  assert.ok(check < dispatch,
    'the busy check runs AFTER the first task is already dispatched, which guards nothing');
});

test('a busy epic start is PAUSED, not rejected — the work is not thrown away', async () => {
  // Rejecting would lose everything the caller assembled (task list, config, prefix). The run
  // is created and parked, exactly as `startPaused` already does, so resuming is the only
  // step left.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/routes/epics.ts'), 'utf8');
  const start = src.indexOf("router.post('/start'");
  const handler = src.slice(start, src.indexOf('router.', start + 10));
  // The parked decision must fold the busy check INTO the existing paused path, not add a
  // rejection branch: no 4xx may appear between the busy check and the dispatch.
  const check = handler.indexOf('isCartridgeBusy');
  const dispatch = handler.indexOf('sendCommandToAgent');
  assert.match(handler.slice(check, dispatch), /parked/,
    'a busy epic start must fall back to the paused path');
  assert.doesNotMatch(handler.slice(check, dispatch), /res\.status\([45]\d\d\)/,
    'a busy epic start must not reject — that discards the task list the caller assembled');
});

// ─── The queue must not re-enter its own guard ──────────────────────────────

test('the queue dispatching a workflow does NOT re-enter the busy check', async () => {
  // The workflow dispatcher POSTs to the same /start route it was queued by. If that request
  // omits queueIfBusy:false the route can enqueue a second copy of the item it is dispatching,
  // and the lane feeds itself forever.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/lib/queue-kinds.ts'), 'utf8');
  const dispatchBlock = src.slice(src.indexOf("kind: 'workflow'"), src.indexOf("kind: 'confer'"));
  assert.match(
    dispatchBlock, /queueIfBusy:\s*false/,
    'the workflow dispatcher must send queueIfBusy:false or it can re-enqueue its own dispatch',
  );
});
