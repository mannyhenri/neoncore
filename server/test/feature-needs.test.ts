/**
 * NEEDS FIRST — what must be done before a feature can be marked done (lib/roadmap.ts).
 *
 * A feature needs the features it depends on, AND every epic its own epic depends on. While any of
 * that is not done the feature can be started, but NOT marked done — refused by the server however
 * it is asked (PUT /api/goals/:id is the only way a feature becomes done: the Mark done button, a
 * drag to Done on the Board, the MCP tools). Checked as sets:
 *   · the message names exactly what is missing, features then epics, in plan order;
 *   · every combination of a feature need and an epic need, met or not;
 *   · what is offered on the feature's "Needs first" panel: same project, never itself, never
 *     anything that already depends on it (directly or through a chain);
 *   · loops, self and other projects refused with a reason; deleting clears it from dependents;
 *   · a delivered pipeline whose needs are not done is not "delivered" on the chart, so an epic is
 *     never delivered before the epics it depends on;
 *   · reopening a need later does not undo a feature already marked done.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import db from '../src/db.js';
import { chartOf, createEpic, updateEpic, removeEpic, planFeature, unmetNeeds, notYetMessage, needsCandidates, assertCanBeDone, RoadmapError } from '../src/lib/roadmap.js';
import goalsRouter, { deleteFeatureCascade } from '../src/routes/goals.js';

let n = 0;
const NOW = Date.parse('2026-11-23T12:00:00Z');
function project(name = 'P'): string {
  const id = `nd-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','/code/x','#fff',?,?)`).run(id, name, '2026-01-01', '2026-01-01');
  return id;
}
function feature(projectId: string, name: string, opts: { done?: boolean; delivered?: boolean; epicId?: string } = {}): string {
  const id = `nd-f-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, target_date, origin, done_at)
              VALUES (?,?,'',?,?,?,?,?,'','planned',?)`)
    .run(id, name, opts.done ? 'achieved' : 'active', '2026-01-01', '2026-01-01', projectId, n, opts.done ? '2026-11-20T10:00:00Z' : '');
  if (opts.delivered) db.prepare(`INSERT INTO goal_pilots (id, goal_id, phase, created_at, updated_at, completed_at) VALUES (?,?,'completed',?,?,?)`).run(`pl-${id}`, id, '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z');
  if (opts.epicId) planFeature(id, { epicId: opts.epicId });
  return id;
}
const done = (id: string) => db.prepare(`UPDATE goals SET status = 'achieved', done_at = '2026-11-21T10:00:00Z' WHERE id = ?`).run(id);
const reopen = (id: string) => db.prepare(`UPDATE goals SET status = 'active', done_at = '' WHERE id = ?`).run(id);
const refused = (fn: () => void, what: RegExp) => assert.throws(fn, (e: unknown) => e instanceof RoadmapError && what.test((e as Error).message), String(what));
const stateOf = (p: string, id: string) => [...chartOf(p, NOW)!.epics.flatMap((e) => e.features), ...chartOf(p, NOW)!.unassigned].find((f) => f.id === id)!.state;

test('the message: exactly what is missing, features first then epics, joined as a person would say it', () => {
  const f = (name: string) => ({ id: name, name });
  const cases: [Parameters<typeof notYetMessage>[0], string][] = [
    [{ features: [f('Points per visit')], epics: [] }, 'Not yet: "Points per visit" must be done first.'],
    [{ features: [], epics: [f('Online ordering')] }, 'Not yet: the epic "Online ordering" must be done first.'],
    [{ features: [f('Points per visit')], epics: [f('Online ordering')] }, 'Not yet: "Points per visit" and the epic "Online ordering" must be done first.'],
    [{ features: [f('A'), f('B')], epics: [] }, 'Not yet: "A" and "B" must be done first.'],
    [{ features: [f('A'), f('B'), f('C')], epics: [f('E1'), f('E2')] }, 'Not yet: "A", "B", "C", the epic "E1" and the epic "E2" must be done first.'],
    [{ features: [], epics: [] }, ''],
  ];
  for (const [unmet, want] of cases) assert.equal(notYetMessage(unmet), want);
});

test('every combination of a feature need and an epic need, met or not: what is unmet, and whether it can be done', () => {
  for (const featureNeed of ['none', 'open', 'done'] as const) for (const epicNeed of ['none', 'open', 'done'] as const) {
    const p = project(`C-${featureNeed}-${epicNeed}`);
    const first = createEpic(p, { name: 'Online ordering' }).id;
    const firstFeature = feature(p, 'Cart', { epicId: first, done: epicNeed === 'done' });
    const mine = createEpic(p, { name: 'Loyalty', dependsOn: epicNeed === 'none' ? [] : [first] }).id;
    const need = feature(p, 'Points per visit', { done: featureNeed === 'done' });
    const f = feature(p, 'Rewards page', { epicId: mine });
    if (featureNeed !== 'none') planFeature(f, { dependsOn: [need] });
    const tag = `${featureNeed}/${epicNeed}`;
    const u = unmetNeeds(f, NOW)!;
    assert.deepEqual(u.features.map((x) => x.name), featureNeed === 'open' ? ['Points per visit'] : [], tag);
    assert.deepEqual(u.epics.map((x) => x.name), epicNeed === 'open' ? ['Online ordering'] : [], tag);
    const blocked = featureNeed === 'open' || epicNeed === 'open';
    if (blocked) refused(() => assertCanBeDone(f, NOW), /^Not yet: /);
    else assert.doesNotThrow(() => assertCanBeDone(f, NOW), tag);
    // The chart says the same: blocked by the feature, waiting on the epic.
    const cf = chartOf(p, NOW)!.epics.find((e) => e.id === mine)!.features[0];
    assert.deepEqual(cf.blockedBy, featureNeed === 'open' ? [need] : [], tag);
    assert.deepEqual(cf.waitsOnEpics, epicNeed === 'open' ? [first] : [], tag);
    void firstFeature;
  }
});

test('the server refuses "done" however it is asked — and says why; once the needs are done it goes through', async () => {
  const app = express(); app.use(express.json()); app.use('/api/goals', goalsRouter);
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/goals`;
  try {
    const p = project('Diner');
    const ordering = createEpic(p, { name: 'Online ordering' }).id;
    const cart = feature(p, 'Cart', { epicId: ordering });
    const loyalty = createEpic(p, { name: 'Loyalty', dependsOn: [ordering] }).id;
    const points = feature(p, 'Points per visit');
    const page = feature(p, 'Rewards page', { epicId: loyalty });
    planFeature(page, { dependsOn: [points] });
    // The Mark done button and a drag to Done on the Board both send this.
    for (const body of [{ status: 'achieved' }, { status: 'achieved', roadmapLane: '' }]) {
      const r = await fetch(`${base}/${page}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).error, 'Not yet: "Points per visit" and the epic "Online ordering" must be done first.');
      assert.equal((db.prepare('SELECT status FROM goals WHERE id = ?').get(page) as { status: string }).status, 'active', 'nothing changed');
    }
    // Other edits are not refused: it can still be worked on, renamed, started.
    const rename = await fetch(`${base}/${page}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Rewards page v2' }) });
    assert.equal(rename.status, 200);
    done(points); done(cart);
    const ok = await fetch(`${base}/${page}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'achieved' }) });
    assert.equal(ok.status, 200);
    // Reopening a need later does not undo it.
    reopen(points);
    assert.equal((db.prepare('SELECT status FROM goals WHERE id = ?').get(page) as { status: string }).status, 'achieved');
    assert.equal(stateOf(p, page), 'delivered');
  } finally { server.close(); }
});

test('the Needs first panel offers: the same project, never itself, never anything that already depends on it — however far down the chain', () => {
  const p = project(); const other = project('Other');
  const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map((x) => feature(p, x));
  feature(other, 'Elsewhere');
  // b needs a, c needs b, d needs c: everything downstream of a.
  planFeature(b, { dependsOn: [a] }); planFeature(c, { dependsOn: [b] }); planFeature(d, { dependsOn: [c] });
  const offered = (id: string) => needsCandidates(id).map((x) => x.name).sort();
  assert.deepEqual(offered(a), ['E'], 'b, c, d all depend on a (directly or through the chain)');
  assert.deepEqual(offered(b), ['A', 'E']);
  assert.deepEqual(offered(d), ['A', 'B', 'C', 'E']);
  assert.deepEqual(offered(e), ['A', 'B', 'C', 'D']);
  // And what is offered can be taken without a loop, every one of them.
  for (const id of [a, b, c, d, e]) for (const cand of needsCandidates(id)) {
    assert.doesNotThrow(() => planFeature(id, { dependsOn: [cand.id] }), `${id} → ${cand.name}`);
    planFeature(id, { dependsOn: id === b ? [a] : id === c ? [b] : id === d ? [c] : [] });
  }
});

test('refused, with a reason: itself, a loop (every back-edge of a chain), another project', () => {
  const p = project(); const other = project('Other');
  const chain = ['A', 'B', 'C', 'D'].map((x) => feature(p, x));
  const foreign = feature(other, 'Elsewhere');
  for (let i = 1; i < chain.length; i++) planFeature(chain[i], { dependsOn: [chain[i - 1]] });
  for (const id of chain) refused(() => planFeature(id, { dependsOn: [id] }), /cannot depend on itself/);
  for (let i = 0; i < chain.length; i++) for (let j = i + 1; j < chain.length; j++) refused(() => planFeature(chain[i], { dependsOn: [chain[j]] }), /circle/);
  refused(() => planFeature(chain[0], { dependsOn: [foreign] }), /same project/);
});

test('deleting a feature or an epic clears it from everything that was waiting on it', () => {
  const p = project();
  const need = feature(p, 'Need');
  const waiting = ['W1', 'W2'].map((x) => feature(p, x));
  for (const w of waiting) planFeature(w, { dependsOn: [need] });
  deleteFeatureCascade(need);
  for (const w of waiting) {
    assert.deepEqual(JSON.parse((db.prepare('SELECT depends_on FROM goals WHERE id = ?').get(w) as { depends_on: string }).depends_on), [], w);
    assert.doesNotThrow(() => assertCanBeDone(w, NOW));
  }
  const e1 = createEpic(p, { name: 'E1' }).id; feature(p, 'In E1', { epicId: e1 });
  const e2 = createEpic(p, { name: 'E2', dependsOn: [e1] }).id; const f2 = feature(p, 'In E2', { epicId: e2 });
  refused(() => assertCanBeDone(f2, NOW), /the epic "E1"/);
  removeEpic(e1);
  assert.doesNotThrow(() => assertCanBeDone(f2, NOW));
});

test('a pipeline that delivered while its needs are open is not "delivered" — so an epic is never delivered before the epics it needs', () => {
  const p = project();
  const first = createEpic(p, { name: 'First' }).id;
  const cart = feature(p, 'Cart', { epicId: first });
  const second = createEpic(p, { name: 'Second', dependsOn: [first] }).id;
  const early = feature(p, 'Early', { epicId: second, delivered: true });
  const chart = () => chartOf(p, NOW)!;
  assert.equal(stateOf(p, early), 'under-way', 'its pipeline finished, but what it needs is not done');
  assert.equal(chart().epics.find((e) => e.id === second)!.deliveredAt, null);
  done(cart);
  assert.equal(stateOf(p, early), 'delivered');
  assert.ok(chart().epics.find((e) => e.id === second)!.deliveredAt);
  // A feature need behaves the same, and a chain settles all the way down.
  const p2 = project();
  const [x, y, z] = ['X', 'Y', 'Z'].map((nm, i) => feature(p2, nm, { delivered: i > 0 }));
  planFeature(y, { dependsOn: [x] }); planFeature(z, { dependsOn: [y] });
  assert.deepEqual([x, y, z].map((id) => stateOf(p2, id)), ['planned', 'under-way', 'under-way']);
  done(x);
  assert.deepEqual([x, y, z].map((id) => stateOf(p2, id)), ['delivered', 'delivered', 'delivered']);
  void updateEpic;
});
