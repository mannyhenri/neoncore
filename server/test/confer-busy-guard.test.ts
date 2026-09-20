/**
 * A CONFER NEVER STARTS WHILE ANY OF ITS REPOS IS BUSY — on every path that can start one.
 *
 * Validated against the live code before this fix: a direct start and a workflow launch held
 * correctly, but (C) a confer step reached MID-RUN started on top of a working participant —
 * the launch guard is the only check a run gets — and (D) a participant idle beside a WORKING
 * cartridge in the same checkout counted as free, because "busy" was per cartridge only.
 *
 * "Busy" for a confer therefore means: a participant is busy, OR another cartridge on the same
 * machine and repo checkout is. An offline sibling is not working in the repo and does not hold.
 *
 * SET-BASED: every entry point in ENTRY_POINTS is run against every scenario in SCENARIOS, so
 * a path that forgets either half of the rule fails here rather than on a live repo.
 */
// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import conferRouter from '../src/routes/confer.ts';
import workflowsRouter from '../src/routes/workflows.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import { startConfer, resumeConfer } from '../src/lib/confer-conductor.ts';
import { tickQueue } from '../src/lib/queue-runner.ts';

installStubIO();
const ISO = () => new Date().toISOString();

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

function agent(status: string, repo: string, machine = 'mac'): string {
  const id = `cb-${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,active_queue_item_id)
              VALUES (?,?,?,?,?,'claude',?,?,?,'')`).run(id, id, machine, `/tmp/${repo}`, repo, status, ISO(), `s-${id}`);
  return id;
}
const setStatus = (id: string, status: string) =>
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
const confers = () => (db.prepare('SELECT COUNT(*) n FROM confer_sessions').get() as { n: number }).n;

let app: { base: string; close: () => void } | null = null;
async function base(): Promise<string> {
  if (app) return app.base;
  const e = express();
  e.use(express.json());
  e.use('/api/confer', conferRouter);
  e.use('/api/workflows', workflowsRouter);
  const server: Server = await new Promise((r) => { const s = e.listen(0, () => r(s)); });
  process.env.NEONCORE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = { base: process.env.NEONCORE_URL, close: () => server.close() };
  return app.base;
}
test.after(() => app?.close());

const post = async (path: string, body: unknown) =>
  fetch((await base()) + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * A world with two participants in two repos. `a` shares its checkout with `sib`.
 * Each scenario sets who is busy; each entry point reports whether the confer STARTED.
 */
interface World { a: string; b: string; sib: string }
const world = (): World => {
  const repo = `repo-${randomUUID().slice(0, 6)}`;
  return { a: agent('idle', repo), b: agent('idle', `other-${repo}`), sib: agent('idle', repo) };
};

const SCENARIOS: { name: string; arrange: (w: World) => void; expectStart: boolean }[] = [
  { name: 'all idle', arrange: () => {}, expectStart: true },
  { name: 'a participant is working', arrange: (w) => setStatus(w.b, 'working'), expectStart: false },
  { name: 'a participant holds another queue item', arrange: (w) =>
      db.prepare("UPDATE agents SET active_queue_item_id = 'someone-else' WHERE id = ?").run(w.b), expectStart: false },
  { name: 'a sibling in a participant\'s repo is working', arrange: (w) => setStatus(w.sib, 'working'), expectStart: false },
  { name: 'a sibling holds a queue item', arrange: (w) =>
      db.prepare("UPDATE agents SET active_queue_item_id = 'someone-else' WHERE id = ?").run(w.sib), expectStart: false },
  { name: 'a sibling on ANOTHER machine is working (different checkout)', arrange: (w) => {
      db.prepare("UPDATE agents SET machine = 'other-mac' WHERE id = ?").run(w.sib); setStatus(w.sib, 'working');
    }, expectStart: true },
  { name: 'a sibling is offline', arrange: (w) => setStatus(w.sib, 'offline'), expectStart: true },
];

// ── The entry points: every way a confer can start ─────────────────────────────────────

const ENTRY_POINTS: {
  name: string;
  started: (w: World) => Promise<boolean>;
  /** Scenarios where this entry point deliberately differs from the rule, and why. */
  exceptions?: Record<string, { expectStart: boolean; why: string }>;
}[] = [
  {
    name: 'POST /api/confer/start',
    started: async (w) => {
      const res = await post('/api/confer/start', { participantIds: [w.a, w.b], task: 'x' });
      assert.ok(res.status === 200 || res.status === 202, `unexpected ${res.status}`);
      return res.status === 200;
    },
  },
  {
    name: 'workflow launch with a confer roster',
    started: async (w) => {
      const tpl = randomUUID();
      db.prepare(`INSERT INTO workflows (id,name,status,created_at) VALUES (?, 'cb-tpl', 'pending', ?)`).run(tpl, ISO());
      db.prepare(`INSERT INTO workflow_steps (id,workflow_id,name,position_y,status,executor_type,executor_id,executor_config,depends_on,created_at)
                  VALUES (?,?, 'work', 0, 'pending', 'claude-code', '__deferred__', '{"prompt":"x"}', '[]', ?)`)
        .run(randomUUID(), tpl, ISO());
      const res = await post(`/api/workflows/v2/${tpl}/start`, { conferAllSteps: [w.a, w.b] });
      assert.ok(res.status === 200 || res.status === 202, `unexpected ${res.status}: ${await res.clone().text()}`);
      return res.status !== 202;
    },
  },
  {
    // Queued while a participant was busy; by dispatch time only the scenario's condition
    // holds. The runner's own re-check must apply the same rule the route did.
    name: 'queued confer, re-checked at dispatch',
    started: async (w) => {
      const blocker = agent('working', `blk-${randomUUID().slice(0, 6)}`);
      const res = await post('/api/confer/start', { participantIds: [w.a, w.b, blocker], task: 'x' });
      assert.equal(res.status, 202, 'setup: the confer should have queued behind the blocker');
      const { item } = await res.json() as { item: { id: string } };
      setStatus(blocker, 'idle');
      tickQueue();
      const s = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(item.id) as { status: string };
      return s.status !== 'queued';
    },
  },
  {
    name: 'confer step reached mid-run',
    started: async (w) => {
      const run = randomUUID(), s1 = randomUUID(), s2 = randomUUID();
      db.prepare(`INSERT INTO workflows (id,name,status,created_at,template_id,run_number,started_at)
                  VALUES (?, 'cb-run', 'running', ?, 'tpl', 1, ?)`).run(run, ISO(), ISO());
      db.prepare(`INSERT INTO workflow_steps (id,workflow_id,name,position_y,status,executor_type,executor_id,executor_config,depends_on,created_at,completed_at,result)
                  VALUES (?,?, 'earlier', 0, 'completed', 'claude-code', ?, '{}', '[]', ?, ?, 'done')`).run(s1, run, w.a, ISO(), ISO());
      db.prepare(`INSERT INTO workflow_steps (id,workflow_id,name,position_y,status,executor_type,executor_id,executor_config,depends_on,auto_advance,created_at)
                  VALUES (?,?, 'confer', 1, 'pending', 'confer', '', ?, ?, 1, ?)`)
        .run(s2, run, JSON.stringify({ conferAgentIds: [w.a, w.b], prompt: 'together' }), JSON.stringify([s1]), ISO());
      const before = confers();
      tickWorkflowsOnce();
      for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 10));
      const started = confers() > before;
      if (!started) {
        const st = db.prepare('SELECT status FROM workflow_steps WHERE id = ?').get(s2) as { status: string };
        assert.equal(st.status, 'pending', 'a held confer step must wait as pending, not fail');
      }
      db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(run); // keep later ticks quiet
      return started;
    },
  },
  {
    name: 'resume of a failed confer',
    exceptions: {
      'a participant is working': {
        expectStart: true,
        why: 'participants come back working on THIS confer — see resumeConfer and confer-liveness-recovery.test.ts',
      },
    },
    started: async (w) => {
      // Build it while everyone is idle, then fail it, then apply the scenario.
      const saved = db.prepare('SELECT id, status, machine, active_queue_item_id FROM agents WHERE id IN (?,?,?)').all(w.a, w.b, w.sib) as
        { id: string; status: string; machine: string; active_queue_item_id: string }[];
      db.prepare("UPDATE agents SET status = 'idle', machine = 'mac', active_queue_item_id = '' WHERE id IN (?,?,?)").run(w.a, w.b, w.sib);
      const session = startConfer({ repoName: 'r', repoPath: '/tmp/r', participantIds: [w.a, w.b], task: 'x' } as never);
      // Failed mid-milestone: the state a resume exists for (the first milestone active, nobody done).
      db.prepare("UPDATE confer_sessions SET status = 'failed', current_milestone = 0 WHERE id = ?").run(session.id);
      db.prepare("UPDATE confer_milestones SET status = CASE idx WHEN 0 THEN 'active' ELSE 'pending' END, done_ids = '[]' WHERE session_id = ?")
        .run(session.id);
      for (const r of saved) {
        db.prepare('UPDATE agents SET status = ?, machine = ?, active_queue_item_id = ? WHERE id = ?')
          .run(r.status, r.machine, r.active_queue_item_id, r.id);
      }
      const out = await resumeConfer(session.id);
      return out.ok;
    },
  },
];

for (const entry of ENTRY_POINTS) {
  for (const sc of SCENARIOS) {
    const expected = entry.exceptions?.[sc.name]?.expectStart ?? sc.expectStart;
    test(`${entry.name} — ${sc.name} → ${expected ? 'starts' : 'held'}`, async () => {
      const w = world();
      sc.arrange(w);
      assert.equal(await entry.started(w), expected);
    });
  }
}

test('a mid-run confer is NOT held by its own run\'s queue stamp', async () => {
  // A run dispatched from the queue stamps its cartridges with its queue item for the whole run.
  // Counting that stamp as busy would make every queued run's confer step wait forever.
  const w = world();
  const run = randomUUID(), s1 = randomUUID(), s2 = randomUUID(), item = randomUUID();
  db.prepare(`INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position, handle, created_at, started_at)
              VALUES (?, 'workflow', '{}', ?, ?, 'running', 1, ?, ?, ?)`)
    .run(item, JSON.stringify([w.a, w.b]), `repo:own-${item}`, run, ISO(), ISO());
  db.prepare('UPDATE agents SET active_queue_item_id = ? WHERE id IN (?, ?)').run(item, w.a, w.b);
  db.prepare(`INSERT INTO workflows (id,name,status,created_at,template_id,run_number,started_at)
              VALUES (?, 'cb-own', 'running', ?, 'tpl', 1, ?)`).run(run, ISO(), ISO());
  db.prepare(`INSERT INTO workflow_steps (id,workflow_id,name,position_y,status,executor_type,executor_id,executor_config,depends_on,created_at,completed_at,result)
              VALUES (?,?, 'earlier', 0, 'completed', 'claude-code', ?, '{}', '[]', ?, ?, 'done')`).run(s1, run, w.a, ISO(), ISO());
  db.prepare(`INSERT INTO workflow_steps (id,workflow_id,name,position_y,status,executor_type,executor_id,executor_config,depends_on,auto_advance,created_at)
              VALUES (?,?, 'confer', 1, 'pending', 'confer', '', ?, ?, 1, ?)`)
    .run(s2, run, JSON.stringify({ conferAgentIds: [w.a, w.b], prompt: 'together' }), JSON.stringify([s1]), ISO());
  const before = confers();
  tickWorkflowsOnce();
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 10));
  db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(run);
  assert.equal(confers(), before + 1, 'the run\'s own queue stamp blocked its confer step');
});
