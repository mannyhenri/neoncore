/**
 * EPIC QA — a feature can be done and still not be Done on the Board: at the end of an epic its
 * work is QA'd as a whole. A feature that is done (badges, changelog, commendation — all as before)
 * sits in QA while its epic has not passed QA; "Passed QA" on the epic moves them all to Done.
 *   · the epic's QA: none (no feature) · open (a feature not done) · waiting (all done, not QA'd
 *     since the last one was) · passed
 *   · Passed QA only when every feature is done; a feature reopened or done after QA → QA again
 *   · a feature in no epic: done is Done
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import db from '../src/db.js';
import { createEpic, planFeature, chartOf } from '../src/lib/roadmap.js';
import { buildProjectSpec, epicQaOf } from '../src/lib/project-spec.js';
import roadmapRouter from '../src/routes/roadmap.js';
import { insertEpicRun, finishEpicRun, epicFinishedAt } from '../src/lib/qa/epic-qa-store.js';

let n = 0;
function project(): string {
  const id = `eq-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','/code/x','#fff',?,?)`).run(id, `QA ${n}`, '2026-01-01', '2026-01-01');
  return id;
}
function feature(projectId: string, name: string, epicId: string, doneAt = ''): string {
  const id = `eq-f-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, origin, done_at) VALUES (?,?,'',?,?,?,?,?,'planned',?)`)
    .run(id, name, doneAt ? 'achieved' : 'active', '2026-01-01', '2026-01-01', projectId, n, doneAt);
  if (epicId) planFeature(id, { epicId });
  return id;
}
const done = (id: string, at: string) => db.prepare("UPDATE goals SET status = 'achieved', done_at = ? WHERE id = ?").run(at, id);
const reopen = (id: string) => db.prepare("UPDATE goals SET status = 'active', done_at = '' WHERE id = ?").run(id);
const passQa = (epicId: string, at: string) => db.prepare('UPDATE epics SET qa_passed_at = ? WHERE id = ?').run(at, epicId);
const columns = (p: string) => Object.fromEntries(buildProjectSpec(p)!.features.map((f) => [f.name, f.column]));

test('every epic QA state × where a done feature sits on the Board', () => {
  const p = project();
  const solo = feature(p, 'Solo, done', '', '2026-11-20T10:00:00.000Z');
  const e = createEpic(p, { name: 'Phase 0' }).id;
  const a = feature(p, 'A', e, '2026-11-20T10:00:00.000Z');
  const b = feature(p, 'B', e);
  const empty = createEpic(p, { name: 'Empty' }).id;
  void solo;
  assert.equal(epicQaOf(empty), 'none');
  // open: A done, B not → A waits in QA; B where its work is.
  assert.equal(epicQaOf(e), 'open');
  assert.deepEqual(columns(p), { 'Solo, done': 'done', A: 'qa', B: 'todo' });
  // waiting: both done, not QA'd.
  done(b, '2026-11-21T10:00:00.000Z');
  assert.equal(epicQaOf(e), 'waiting');
  assert.deepEqual(columns(p), { 'Solo, done': 'done', A: 'qa', B: 'qa' });
  // passed.
  passQa(e, '2026-11-22T10:00:00.000Z');
  assert.equal(epicQaOf(e), 'passed');
  assert.deepEqual(columns(p), { 'Solo, done': 'done', A: 'done', B: 'done' });
  // A feature done after QA: QA again, the whole epic back in QA.
  const c = feature(p, 'C', e, '2026-11-23T10:00:00.000Z');
  void c;
  assert.equal(epicQaOf(e), 'waiting');
  assert.deepEqual(columns(p), { 'Solo, done': 'done', A: 'qa', B: 'qa', C: 'qa' });
  passQa(e, '2026-11-24T10:00:00.000Z');
  assert.equal(epicQaOf(e), 'passed');
  // Reopened: open again — the others wait in QA, the reopened one where its work is.
  reopen(a);
  assert.equal(epicQaOf(e), 'open');
  assert.deepEqual(columns(p), { 'Solo, done': 'done', A: 'todo', B: 'qa', C: 'qa' });
  // The feature is still done in every way but the Board's column.
  const spec = buildProjectSpec(p)!;
  assert.equal(spec.features.find((f) => f.name === 'B')!.status, 'done');
  assert.equal(spec.totals.done, 3);
  assert.equal(chartOf(p, Date.parse('2026-11-25T12:00:00Z')).epics.find((x) => x.id === e)!.qa, 'open');
});

test('Passed QA through the API: refused while a feature is not done, or with none; then Done; and it can be taken back', async () => {
  const p = project();
  const e = createEpic(p, { name: 'Phase 1' }).id;
  const a = feature(p, 'A1', e, '2026-11-20T10:00:00.000Z');
  const b = feature(p, 'B1', e);
  void a;
  const empty = createEpic(p, { name: 'Nothing in it' }).id;
  const app = express(); app.use(express.json()); app.use('/api/roadmap', roadmapRouter);
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/roadmap`;
  const put = (id: string, body: unknown) => fetch(`${base}/epics/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let r = await put(e, { qaPassed: true });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'Not yet: 1 feature of "Phase 1" is not done.');
    r = await put(empty, { qaPassed: true });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'an epic with no feature has nothing to QA');
    assert.equal((await put(e, { qaPassed: 'yes' })).status, 400);
    done(b, '2026-11-21T10:00:00.000Z');
    // Every feature done is not enough: the epic's QA run must have passed (lib/qa/epic-qa-store.ts).
    r = await put(e, { qaPassed: true });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'Not yet: QA has not run since the epic finished — run QA first.');
    finishEpicRun(insertEpicRun(e, p, epicFinishedAt(e)).id, { status: 'passed', checks: [], summary: '' });
    r = await put(e, { qaPassed: true });
    assert.equal(r.status, 200);
    const chart = await r.json();
    assert.equal(chart.epics.find((x: { id: string }) => x.id === e).qa, 'passed');
    assert.ok(chart.epics.find((x: { id: string }) => x.id === e).qaPassedAt);
    assert.deepEqual(columns(p), { A1: 'done', B1: 'done' });
    // Taken back: QA again.
    r = await put(e, { qaPassed: false });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).epics.find((x: { id: string }) => x.id === e).qa, 'waiting');
    assert.deepEqual(columns(p), { A1: 'qa', B1: 'qa' });
    // An ordinary edit leaves the QA alone.
    await put(e, { qaPassed: true });
    assert.equal((await put(e, { name: 'Phase 1 renamed' })).status, 200);
    assert.equal(epicQaOf(e), 'passed');
  } finally { server.close(); }
});
