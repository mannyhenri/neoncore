/**
 * A BLOCKED CLAIM HANDS BACK THE PREREQUISITE, IT DOES NOT JUST SAY NO.
 *
 * REPORTED, and the distinction is the whole feature: "I want it to switch to the prerequisite
 * if there is one." Gating the claim stopped the wrong task from starting, which is necessary
 * and not sufficient. An autonomous cartridge that asks for GLW-042 and receives a 409 has
 * learned only that it may not work; it still has to work out WHAT to work instead, and the one
 * component that already knows the answer — the dependency graph — just declined to say.
 *
 * So `claim` on a blocked task now resolves the prerequisite and claims THAT, reporting the
 * substitution. The agent asked "what do I do", and gets a task rather than a refusal.
 *
 * ── DEEPEST, NOT NEAREST ───────────────────────────────────────────────────────────────
 * A → B → C, claim C: handing back B is still blocked and the agent bounces again, once per
 * level. The walk therefore descends to the deepest unmet prerequisite that is actually
 * startable, so one claim yields one runnable task however deep the chain.
 *
 * ── WHEN IT STILL REFUSES, AND WHY EACH ────────────────────────────────────────────────
 * Substitution is only honest when the prerequisite is something THIS agent may start:
 *   · already in_progress or claimed elsewhere → someone is on it; two cartridges on one task
 *     is worse than waiting, so refuse and NAME who holds it.
 *   · failed → the whole point of the gate is that work must not build on an outcome that does
 *     not exist. Redirecting into a failure would launder it.
 *   · cancelled → a human decision; reversing it automatically overrides the human.
 *   · pinned to a project this agent does not serve → the hard-pin is a separate rule and
 *     substitution must not become a way around it.
 * Each refusal names the prerequisite, so even a refusal answers "what is this waiting on".
 *
 * Set-based over prerequisite STATES × claimability, because the interesting failures are all
 * in the states, and a test that only proves the happy substitution would let every refusal
 * case regress into either a hang or an illegal claim.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import tasksRouter from '../src/routes/tasks.ts';
import { nextTaskToward } from '../src/lib/task-dependencies.ts';

installStubIO();

const SESSION = 'sess-redirect';
const AGENT = 'agent-redirect';
const OTHER = 'agent-other';
let base = '';
let server: Server;
const iso = () => new Date().toISOString();
let n = 0;

function boot(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  return new Promise((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      r();
    });
  });
}

function task(o: {
  status?: string; dependsOn?: string[]; assigned?: string | null; projectId?: string | null;
} = {}): string {
  const id = `rt-${++n}`;
  db.prepare(
    `INSERT INTO tasks (id, title, prompt, project_id, status, assigned_agent_id, priority, created_at, depends_on)
     VALUES (?,?,?,?,?,?,0,?,?)`,
  ).run(id, `task ${id}`, 'work', o.projectId ?? null, o.status ?? 'queued',
        o.assigned ?? null, iso(), JSON.stringify(o.dependsOn ?? []));
  return id;
}

async function claim(taskId: string) {
  const r = await fetch(`${base}/api/tasks/${taskId}/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION }),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

test('boot', async () => {
  for (const [id, session, repo] of [[AGENT, SESSION, '/r/mine'], [OTHER, 'sess-other', '/r/theirs']]) {
    db.prepare(
      `INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, session_id, pending_question)
       VALUES (?,?,?,?,?,?,?,?,?,'')`,
    ).run(id, `m/${id}`, 'm', repo, 'r', 'claude', 'idle', iso(), session);
  }
  await boot();
  assert.ok(base);
});

// ── THE SET: every prerequisite shape, and what the agent must be handed ────
interface Case {
  label: string;
  build: () => { want: string; substitute: string | null };
}

const CASES: Case[] = [
  {
    label: 'prerequisite queued and free → SWITCH to it',
    build: () => {
      const pre = task();
      return { want: task({ dependsOn: [pre] }), substitute: pre };
    },
  },
  {
    label: 'chain A←B←C, claim C → switch to A, the DEEPEST startable one',
    build: () => {
      const a = task();
      const b = task({ dependsOn: [a] });
      return { want: task({ dependsOn: [b] }), substitute: a };
    },
  },
  {
    label: 'two unmet prerequisites, one startable → switch to the startable one',
    build: () => {
      const busy = task({ status: 'in_progress', assigned: OTHER });
      const free = task();
      return { want: task({ dependsOn: [busy, free] }), substitute: free };
    },
  },
  {
    label: 'prerequisite already in_progress elsewhere → REFUSE, nobody doubles up',
    build: () => {
      const pre = task({ status: 'in_progress', assigned: OTHER });
      return { want: task({ dependsOn: [pre] }), substitute: null };
    },
  },
  {
    label: 'prerequisite claimed by another agent → REFUSE',
    build: () => {
      const pre = task({ status: 'claimed', assigned: OTHER });
      return { want: task({ dependsOn: [pre] }), substitute: null };
    },
  },
  {
    label: 'prerequisite failed → REFUSE, never launder a failure into a redirect',
    build: () => {
      const pre = task({ status: 'failed' });
      return { want: task({ dependsOn: [pre] }), substitute: null };
    },
  },
  {
    label: 'prerequisite cancelled → REFUSE, that was a human decision',
    build: () => {
      const pre = task({ status: 'cancelled' });
      return { want: task({ dependsOn: [pre] }), substitute: null };
    },
  },
  {
    label: 'prerequisite pinned to a project this agent does not serve → REFUSE',
    build: () => {
      const pid = `proj-${++n}`;
      db.prepare('INSERT INTO projects (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run(pid, 'theirs', '', iso(), iso());
      db.prepare('INSERT INTO project_cartridges (project_id, repo_path) VALUES (?,?)').run(pid, '/r/theirs');
      const pre = task({ projectId: pid });
      return { want: task({ dependsOn: [pre] }), substitute: null };
    },
  },
  {
    label: 'a cycle must terminate rather than hang',
    build: () => {
      const x = task();
      const y = task({ dependsOn: [x] });
      db.prepare('UPDATE tasks SET depends_on = ? WHERE id = ?').run(JSON.stringify([y]), x);
      return { want: task({ dependsOn: [y] }), substitute: null };
    },
  },
];

test('nextTaskToward resolves EVERY prerequisite shape correctly', () => {
  const wrong: string[] = [];
  for (const c of CASES) {
    const { want, substitute } = c.build();
    const got = nextTaskToward(want, AGENT);
    if ((got?.id ?? null) !== substitute) {
      wrong.push(`${c.label}: got ${got?.id ?? 'null'}, expected ${substitute ?? 'null'}`);
    }
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('claiming a blocked task HANDS BACK the prerequisite, claimed and ready to run', async () => {
  const pre = task();
  const dependent = task({ dependsOn: [pre] });

  const { status, body } = await claim(dependent);
  assert.equal(status, 200, `expected a task back, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.id, pre, 'the agent was handed the wrong task');
  assert.equal(body.substitutedFor, dependent,
    'the substitution must be reported, or the agent cannot tell it got something else');
  assert.equal(body.status, 'claimed', 'the substitute must actually be claimed, not just named');
  assert.equal(body.assignedAgentId, AGENT);

  // And the task it originally asked for is untouched — still queued for later.
  const orig = db.prepare('SELECT status, assigned_agent_id FROM tasks WHERE id = ?').get(dependent) as
    { status: string; assigned_agent_id: string | null };
  assert.equal(orig.status, 'queued');
  assert.equal(orig.assigned_agent_id, null);
});

test('when nothing can be substituted it still REFUSES, and names the prerequisite', async () => {
  const pre = task({ status: 'in_progress', assigned: OTHER });
  const dependent = task({ dependsOn: [pre] });
  const { status, body } = await claim(dependent);
  assert.equal(status, 409);
  assert.equal(body.blocked, true);
  assert.match(String(body.error), /waiting on/,
    'even a refusal must answer "what is this waiting on"');
});

test('an unblocked claim is completely unaffected', async () => {
  const free = task();
  const { status, body } = await claim(free);
  assert.equal(status, 200);
  assert.equal(body.id, free);
  assert.equal(body.substitutedFor, undefined,
    'a normal claim must not grow a substitution field');
});

test.after(() => { server?.close(); });
