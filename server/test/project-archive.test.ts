/**
 * ARCHIVE A PROJECT — it leaves the map, the project list and every picker, and comes back on
 * Restore exactly as it was: nothing of it is deleted (its features, changelog, cartridges stay).
 * Not while a feature of it is under way — that work would vanish from sight mid-run.
 *   PUT /api/projects/:id { archived: true | false }
 *   GET /api/projects            → the projects in use (archived ones left out)
 *   GET /api/projects?archived=1 → the archived ones, most recently archived first
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import db from '../src/db.js';
import projectsRouter from '../src/routes/projects.js';

let n = 0;
function project(name: string): string {
  const id = `ar-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','','#fff',?,?)`).run(id, name, `2026-01-0${n}`, '2026-01-01');
  return id;
}
function feature(projectId: string, opts: { phase?: string; done?: boolean } = {}): string {
  const id = `ar-f-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, origin) VALUES (?,?,'',?,?,?,?,?,'')`)
    .run(id, `F${n}`, opts.done ? 'achieved' : 'active', '2026-01-01', '2026-01-01', projectId, n);
  if (opts.phase) db.prepare(`INSERT INTO goal_pilots (id, goal_id, phase, created_at, updated_at) VALUES (?,?,?,?,?)`).run(`pl-${id}`, id, opts.phase, '2026-11-20', '2026-11-20');
  return id;
}

test('archive, list, refuse while running, restore — over every state a project\'s features can be in', async () => {
  const app = express(); app.use(express.json()); app.use('/api/projects', projectsRouter);
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
  const put = (id: string, body: unknown) => fetch(`${base}/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const names = async (q = '') => ((await (await fetch(`${base}${q}`)).json()) as { name: string }[]).map((p) => p.name).sort();
  try {
    const quiet = project('Quiet');                                                   // no features
    const finished = project('Finished'); feature(finished, { done: true, phase: 'completed' }); feature(finished);
    const cancelled = project('Cancelled'); feature(cancelled, { phase: 'cancelled' });
    const running = project('Running'); feature(running, { phase: 'running' });
    const waiting = project('Waiting'); feature(waiting, { phase: 'paused' }); feature(waiting, { phase: 'completed' });
    assert.deepEqual(await names(), ['Cancelled', 'Finished', 'Quiet', 'Running', 'Waiting']);

    // Nothing under way: archived, and gone from the list.
    for (const id of [quiet, finished, cancelled]) {
      const r = await put(id, { archived: true });
      assert.equal(r.status, 200);
      assert.match((await r.json()).archivedAt, /^\d{4}-\d\d-\d\dT/);
    }
    assert.deepEqual(await names(), ['Running', 'Waiting']);
    assert.deepEqual(await names('?archived=1'), ['Cancelled', 'Finished', 'Quiet']);

    // Under way: refused, with the count and what to do; nothing changes.
    for (const [id, count] of [[running, 1], [waiting, 2]] as const) {
      const r = await put(id, { archived: true });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).error, `Not while ${count} feature${count === 1 ? ' is' : 's are'} under way — finish or stop ${count === 1 ? 'it' : 'them'} first.`);
    }
    assert.deepEqual(await names(), ['Running', 'Waiting']);

    // Still reachable by its id while archived, with its features; restored as it was.
    const one = await (await fetch(`${base}/${finished}`)).json();
    assert.equal(one.project.name, 'Finished');
    assert.ok(one.project.archivedAt);
    assert.equal(one.project.featureCount, 2);
    const back = await put(finished, { archived: false });
    assert.equal(back.status, 200);
    assert.equal((await back.json()).archivedAt, '');
    assert.deepEqual(await names(), ['Finished', 'Running', 'Waiting']);
    assert.deepEqual(await names('?archived=1'), ['Cancelled', 'Quiet']);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM goals WHERE project_id = ?').get(finished) as { c: number }).c, 2, 'its features were never touched');

    // Anything but a boolean is refused; an ordinary edit leaves the archive alone.
    assert.equal((await put(quiet, { archived: 'yes' })).status, 400);
    assert.equal((await put(quiet, { name: 'Quiet renamed' })).status, 200);
    assert.deepEqual(await names('?archived=1'), ['Cancelled', 'Quiet renamed']);
  } finally { server.close(); }
});
