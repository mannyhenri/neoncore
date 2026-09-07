/**
 * A TASK DOES NOT START BEFORE ITS PREREQUISITES — ON EVERY PATH, INCLUDING THE ONE AGENTS USE.
 *
 * `lib/task-dependencies.ts` is a real gate with carefully reasoned semantics, and it was wired
 * into two of the four paths that can start a task. The two it missed were exactly the two an
 * autonomous cartridge uses: `mcp-server.ts` calls `/api/tasks/queue` for `neoncore_my_queue`
 * and `/api/tasks/:id/claim` for `neoncore_claim_task` — the pair an agent reaches for when it
 * has no instruction and is deciding what to do next.
 *
 * WHY THAT HID. With ONE agent draining the queue you would rarely see it: acceptance derives
 * `priority` from dependency DEPTH, so roots sort ahead of dependents and the order usually
 * looks enforced. With two cartridges claiming concurrently, a dependent starts while its
 * prerequisite is still `in_progress` — and then runs against a tree that does not yet contain
 * what it was written to assume. It fails looking like a bad prompt rather than a scheduling
 * bug, which is the precise failure task-dependencies.ts opens by saying it exists to prevent.
 *
 * WHY THE TEST IS SET-BASED OVER PATHS. Gating only `claim` would leave the agent seeing
 * blocked work in `my_queue`, picking it, and getting an opaque rejection — worse than the bug
 * for the tool whose whole job is "what should I do next". And a test that checks only `claim`
 * goes green the moment someone adds a fifth way to start a task. So the paths are enumerated
 * FROM THE ROUTER SOURCE and the registry is asserted to cover it.
 *
 * WHY THE DEPENDENCY STATES ARE A SET TOO. `unmetDependencies` encodes two decisions that a
 * naive `WHERE NOT EXISTS (… status != 'done')` gets half right by accident:
 *   · a FAILED prerequisite does not release its dependent — the dependent assumes an outcome
 *     that does not exist, and confident work on a false premise is worse than visible blockage;
 *   · a DELETED dependency row counts as satisfied — reverting a decomposition deletes untouched
 *     tasks, and a dangling id must not strand every dependent that survived.
 * Both are asserted, so a future rewrite into SQL cannot quietly lose either.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import tasksRouter, { releaseReadyTasks } from '../src/routes/tasks.ts';
import { readyTaskIds, taskIsReady } from '../src/lib/task-dependencies.ts';

installStubIO();

const ROOT = path.join(import.meta.dirname, '..', '..');
const SESSION = 'sess-dep-gate';
const AGENT = 'agent-dep-gate';
let base = '';
let server: Server;

function boot(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

const iso = () => new Date().toISOString();
let n = 0;

/** A queued task with an explicit dependency list. project_id stays NULL so the hard-pin
 *  (a separate rule with its own tests) cannot be mistaken for the dependency gate. */
function task(o: { status?: string; dependsOn?: string[]; priority?: number } = {}): string {
  const id = `t-dep-${++n}`;
  db.prepare(
    `INSERT INTO tasks (id, title, prompt, project_id, status, priority, created_at, depends_on)
     VALUES (?,?,?,NULL,?,?,?,?)`,
  ).run(id, `task ${id}`, 'do it', o.status ?? 'queued', o.priority ?? 0, iso(),
        JSON.stringify(o.dependsOn ?? []));
  return id;
}

// ── The registry of DEPENDENCY STATES, and what each must do ────────────────
const DEP_STATES: { label: string; make: () => string[]; ready: boolean }[] = [
  { label: 'prerequisite still in_progress', ready: false, make: () => [task({ status: 'in_progress' })] },
  { label: 'prerequisite failed', ready: false, make: () => [task({ status: 'failed' })] },
  { label: 'prerequisite cancelled', ready: false, make: () => [task({ status: 'cancelled' })] },
  { label: 'prerequisite still queued', ready: false, make: () => [task({ status: 'queued' })] },
  { label: 'prerequisite done', ready: true, make: () => [task({ status: 'done' })] },
  {
    label: 'dependency row DELETED (decomposition reverted)',
    ready: true,
    make: () => {
      const dead = task({ status: 'queued' });
      db.prepare('DELETE FROM tasks WHERE id = ?').run(dead);
      return [dead];
    },
  },
  { label: 'no dependencies at all', ready: true, make: () => [] },
];

// ── The registry of START PATHS: every way a queued task can begin ──────────
// `offered` = this path would let the task start (or presents it as startable).
const START_PATHS: { name: string; offered: (taskId: string) => Promise<boolean> }[] = [
  {
    name: 'POST /:id/dispatch',
    // A blocked task answers 409 with blocked:true. A ready one gets past the gate and may
    // then fail for an unrelated reason (no connected agent), which is NOT a dependency block.
    offered: async (id) => {
      const r = await fetch(`${base}/api/tasks/${id}/dispatch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (r.status !== 409) return true;
      return !(await r.json() as { blocked?: boolean }).blocked;
    },
  },
  {
    name: 'releaseReadyTasks() / readyTaskIds()',
    offered: async (id) => readyTaskIds().includes(id),
  },
  {
    name: 'GET /queue  (neoncore_my_queue)',
    offered: async (id) => {
      const r = await fetch(`${base}/api/tasks/queue?sessionId=${SESSION}`);
      const rows = await r.json() as { id: string }[];
      return Array.isArray(rows) && rows.some((t) => t.id === id);
    },
  },
  {
    name: 'POST /:id/claim  (neoncore_claim_task)',
    // `offered` means THE TASK ASKED FOR started — not merely that the request succeeded.
    // Since the redirect landed, a blocked claim answers 200 carrying a DIFFERENT task (its
    // prerequisite, claimed on the agent's behalf). Reading that as success would assert the
    // opposite of the gate: the whole point is that the task asked for did not start.
    offered: async (id) => {
      const r = await fetch(`${base}/api/tasks/${id}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION }),
      });
      const body = await r.json() as { id?: string; blocked?: boolean; substitutedFor?: string };
      if (r.ok) {
        const startedWhatIAskedFor = body.id === id && !body.substitutedFor;
        // Put everything back so one path's success cannot mask another's behaviour.
        db.prepare("UPDATE tasks SET status='queued', assigned_agent_id=NULL, claimed_at=NULL WHERE id=?")
          .run(body.id ?? id);
        return startedWhatIAskedFor;
      }
      return !body.blocked;
    },
  },
];

test('boot the real router', async () => {
  db.prepare(
    `INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, session_id, pending_question)
     VALUES (?,?,?,?,?,?,?,?,?,'')`,
  ).run(AGENT, 'm/dep', 'm', '/r/dep', 'dep', 'claude', 'idle', iso(), SESSION);
  await boot();
  assert.ok(base, 'router did not bind a port');
});

test('EVERY start path honours EVERY dependency state', async () => {
  const wrong: string[] = [];
  for (const state of DEP_STATES) {
    for (const p of START_PATHS) {
      const dependent = task({ dependsOn: state.make() });
      const offered = await p.offered(dependent);
      if (offered !== state.ready) {
        wrong.push(
          `${p.name.padEnd(34)} · ${state.label}: offered=${offered}, expected ${state.ready}`,
        );
      }
    }
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('the two decisions unmetDependencies encodes survive, stated directly', () => {
  // Restated at the unit level so a rewrite into SQL that breaks either one fails HERE with a
  // message naming the decision, not only in the matrix above with a path name.
  const failed = task({ status: 'failed' });
  assert.equal(taskIsReady(task({ dependsOn: [failed] })), false,
    'a FAILED prerequisite must not release its dependent');

  const dead = task({ status: 'queued' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(dead);
  assert.equal(taskIsReady(task({ dependsOn: [dead] })), true,
    'a DELETED dependency row counts as satisfied — reverting a decomposition must not strand survivors');
});

test('the path registry covers every route that can start a queued task', () => {
  // THE FIFTH-PATH GUARD. Enumerated from the router source, so adding a new way to start a
  // task fails here until it is either gated and listed, or exempted with a reason.
  const src = fs.readFileSync(path.join(ROOT, 'server/src/routes/tasks.ts'), 'utf8');
  const routes = [...src.matchAll(/^router\.(get|post|patch|put|delete)\('([^']+)'/gm)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);

  // Routes that cannot start queued work, each with why. A map rather than a filter so an
  // exemption is a visible decision instead of a silent omission.
  const NOT_A_START: Record<string, string> = {
    'POST /': 'creates a queued task; starting is a separate act',
    'PATCH /:id': 'edits a queued task and cannot assign an agent',
    'GET /': 'dashboard listing, not a claimable queue',
    'GET /:id': 'read',
    'POST /:id/start': 'requires assignedAgentId === caller, so it is downstream of dispatch/'
      + 'release/claim — all gated. Gating it again would also break dispatch force:true, which '
      + 'is a deliberate human override.',
    'POST /:id/complete': 'terminal',
    'POST /:id/done': 'terminal',
    'POST /:id/cancel': 'terminal',
    'DELETE /:id': 'terminal',
  };
  const COVERED = ['POST /:id/dispatch', 'GET /queue', 'POST /:id/claim'];

  const unclassified = routes.filter((r) => !COVERED.includes(r) && !(r in NOT_A_START));
  assert.deepEqual(unclassified, [],
    `these task routes are neither dependency-gated nor exempted: ${unclassified.join(', ')}. `
    + 'If one can start queued work it needs the gate; if it cannot, say so in NOT_A_START.');
});

test('a task already assigned to me stays visible in my queue even while blocked', () => {
  // The queue filter must hide UNCLAIMED blocked work, not work I already hold. Hiding a task
  // mid-flight would make an agent's own in-progress item vanish from under it.
  const dep = task({ status: 'in_progress' });
  const mine = task({ dependsOn: [dep] });
  db.prepare("UPDATE tasks SET status='in_progress', assigned_agent_id=? WHERE id=?").run(AGENT, mine);
  return fetch(`${base}/api/tasks/queue?sessionId=${SESSION}`)
    .then((r) => r.json())
    .then((rows: { id: string }[]) => {
      assert.ok(rows.some((t) => t.id === mine),
        'a task assigned to this agent disappeared from its queue because a dependency was unmet');
    });
});

test.after(() => { server?.close(); });
