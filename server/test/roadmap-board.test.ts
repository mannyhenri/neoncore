/**
 * THE BOARD — To do → In Progress → QA → Done (lib/project-spec.ts placeColumns).
 *
 * Where a feature sits follows its state unless the person put it somewhere: Done follows the
 * status (mark done / reopen); a placement (To do, In Progress, QA) wins otherwise; unplaced, a
 * planned feature is To do, a running or paused pipeline In Progress, a delivered one awaiting
 * sign-off QA. The old Now / Next / Later placements were priorities, not where the work is — a
 * feature placed with them follows its state again. Checked over every status × every stored lane,
 * through the API, and in both exports.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import db from '../src/db.js';
import { placeColumns, laneOf, buildProjectSpec, renderRoadmapMarkdown, renderRoadmapHtml, type SpecFeature, type SpecStatus } from '../src/lib/project-spec.js';
import goalsRouter from '../src/routes/goals.js';

const STATUSES: SpecStatus[] = ['existing', 'planned', 'in-progress', 'paused', 'delivered', 'done'];
const STORED = ['', 'todo', 'progress', 'qa', 'now', 'next', 'later', 'done', 'junk'];
const AUTO: Record<SpecStatus, string | null> = { existing: null, planned: 'todo', 'in-progress': 'progress', paused: 'progress', delivered: 'qa', done: 'done' };

test('every status × every stored placement lands in exactly one expected column', () => {
  const wrong: string[] = [];
  for (const status of STATUSES) for (const stored of STORED) {
    const lane = laneOf(stored);
    const [f] = placeColumns([{ status, lane, column: null, epicQa: 'none' } as unknown as SpecFeature]);
    const expected = status === 'existing' ? null : status === 'done' ? 'done' : ['todo', 'progress', 'qa'].includes(stored) ? stored : AUTO[status];
    if (f.column !== expected) wrong.push(`${status} + "${stored}" → ${f.column}, expected ${expected}`);
  }
  assert.deepEqual(wrong, []);
  // Only the three board columns are placements; everything else (old lanes, Done, junk) is automatic.
  assert.deepEqual(STORED.map(laneOf), ['', 'todo', 'progress', 'qa', '', '', '', '', '']);
});

let n = 0;
function project(): string {
  const id = `rb-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','/code/x','#fff',?,?)`).run(id, `Board ${n}`, '2026-01-01', '2026-01-01');
  return id;
}
function feature(projectId: string, name: string, opts: { done?: boolean; phase?: string; lane?: string } = {}): string {
  const id = `rb-f-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, target_date, origin, done_at, roadmap_lane)
              VALUES (?,?,'',?,?,?,?,?,'','planned',?,?)`)
    .run(id, name, opts.done ? 'achieved' : 'active', '2026-01-01', '2026-01-01', projectId, n, opts.done ? '2026-11-20T10:00:00Z' : '', opts.lane ?? '');
  if (opts.phase) db.prepare(`INSERT INTO goal_pilots (id, goal_id, phase, created_at, updated_at, completed_at) VALUES (?,?,?,?,?,?)`)
    .run(`pl-${id}`, id, opts.phase, '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z', opts.phase === 'completed' ? '2026-11-20T10:00:00Z' : null);
  return id;
}

test('a project\'s features on the board, in the exports, and moved through the API', async () => {
  const p = project();
  const ids = {
    plan: feature(p, 'Plan it'),
    build: feature(p, 'Build it', { phase: 'running' }),
    stuck: feature(p, 'Stuck', { phase: 'paused' }),
    check: feature(p, 'Check it', { phase: 'completed' }),
    shipped: feature(p, 'Shipped', { done: true }),
    oldNow: feature(p, 'Was Now but planned', { lane: 'now' }),
    oldLater: feature(p, 'Was Later but running', { lane: 'later', phase: 'running' }),
  };
  const col = () => Object.fromEntries(buildProjectSpec(p)!.features.map((f) => [f.name, f.column]));
  assert.deepEqual(col(), {
    'Plan it': 'todo', 'Build it': 'progress', Stuck: 'progress', 'Check it': 'qa', Shipped: 'done',
    'Was Now but planned': 'todo', 'Was Later but running': 'progress',
  });

  const md = renderRoadmapMarkdown(buildProjectSpec(p)!);
  assert.deepEqual(md.match(/^## .+$/gm), ['## To do', '## In Progress', '## QA', '## Done']);
  const html = renderRoadmapHtml(buildProjectSpec(p)!);
  assert.deepEqual([...html.matchAll(/<h2>([^<]+) <span>(\d+)<\/span><\/h2>/g)].map((m) => `${m[1]} ${m[2]}`), ['To do 2', 'In Progress 3', 'QA 1', 'Done 1']);

  const app = express(); app.use(express.json()); app.use('/api/goals', goalsRouter);
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/goals`;
  const put = (id: string, body: object) => fetch(`${base}/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const lane of ['qa', 'progress', 'todo'] as const) {
      assert.equal((await put(ids.plan, { roadmapLane: lane })).status, 200);
      assert.equal(col()['Plan it'], lane, `dragged to ${lane}`);
      assert.equal(((await (await fetch(`${base}/${ids.plan}`)).json()).roadmapLane), lane);
    }
    // An old client's Now / Next / Later hands it back to its state.
    assert.equal((await put(ids.check, { roadmapLane: 'now' })).status, 200);
    assert.equal(col()['Check it'], 'qa');
    assert.equal((await put(ids.plan, { roadmapLane: '' })).status, 200);
    assert.equal(col()['Plan it'], 'todo', 'back to automatic');
  } finally { server.close(); }
});
