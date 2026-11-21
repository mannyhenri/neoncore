/**
 * THE ROADMAP: VISION → EPICS → FEATURES ON A TIMELINE (lib/roadmap.ts).
 *
 * Asked for as: "expand the project section to properly support a full roadmap planning and then
 * we can just execute." A project has one vision; under it, epics; under each epic, the features
 * the project already has, each with a date. What is checked, as sets:
 *   · every feature of the project is on the chart exactly once (in its epic, or unassigned) —
 *     except features imported as "what the product already does", which are not plans;
 *   · a feature's state comes from its records and its date: planned, under way, delivered, late;
 *   · a dependency holds a feature back until what it waits on is delivered, and can never loop;
 *   · "next up" in an epic is its earliest feature that can actually start;
 *   · removing an epic loses no feature; another project's epic cannot take this project's feature.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import {
  chartOf, setVision, createEpic, updateEpic, removeEpic, reorderEpics, planFeature, roadmapContextFor,
  RoadmapError, FEATURE_STATES,
} from '../src/lib/roadmap.js';

let n = 0;
const NOW = new Date('2026-11-20T12:00:00Z').getTime();
function project(name = 'P'): string {
  const id = `rp-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','/code/x','#fff',?,?)`)
    .run(id, name, '2026-01-01', '2026-01-01');
  return id;
}
function feature(projectId: string, name: string, over: { status?: string; target?: string; origin?: string; phase?: string } = {}): string {
  const id = `rf-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, target_date, origin)
              VALUES (?,?,'',?,?,?,?,?,?,?)`)
    .run(id, name, over.status ?? 'active', '2026-01-01', '2026-01-01', projectId, n, over.target ?? '', over.origin ?? 'planned');
  if (over.phase) {
    db.prepare(`INSERT INTO goal_pilots (id, goal_id, phase, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run(`pilot-${id}`, id, over.phase, '2026-01-01', '2026-01-01');
  }
  return id;
}
const flat = (c: NonNullable<ReturnType<typeof chartOf>>) => [...c.epics.flatMap((e) => e.features), ...c.unassigned];

test('every planned feature is on the chart exactly once; imported ones are not plans', () => {
  const p = project();
  const ids = ['a', 'b', 'c', 'd'].map((x) => feature(p, x));
  const imported = feature(p, 'already there', { status: 'achieved', origin: 'imported' });
  const e1 = createEpic(p, { name: 'Access' });
  const e2 = createEpic(p, { name: 'Planning' });
  planFeature(ids[0], { epicId: e1.id });
  planFeature(ids[1], { epicId: e2.id });
  planFeature(ids[2], { epicId: e2.id });
  const chart = chartOf(p, NOW)!;
  assert.deepEqual(chart.epics.map((e) => [e.name, e.features.map((f) => f.name)]), [['Access', ['a']], ['Planning', ['b', 'c']]]);
  assert.deepEqual(chart.unassigned.map((f) => f.name), ['d']);
  assert.deepEqual(flat(chart).map((f) => f.id).sort(), [...ids].sort());
  assert.ok(!flat(chart).some((f) => f.id === imported));
  assert.equal(chartOf('no-such-project', NOW), null);
});

test('a feature\'s state is its records and its date — every combination', () => {
  const p = project();
  const cases: [string, Parameters<typeof feature>[2], string][] = [
    ['not started, no date', {}, 'planned'],
    ['not started, date ahead', { target: '2027-01-15' }, 'planned'],
    ['not started, date today', { target: '2026-11-20' }, 'planned'],
    ['not started, date passed', { target: '2026-11-19' }, 'late'],
    ['running, date ahead', { phase: 'running', target: '2027-01-15' }, 'under-way'],
    ['running, date passed', { phase: 'running', target: '2026-10-01' }, 'late'],
    ['paused', { phase: 'paused' }, 'under-way'],
    ['pipeline finished', { phase: 'completed', target: '2026-10-01' }, 'delivered'],
    ['marked done', { status: 'achieved', target: '2026-10-01' }, 'delivered'],
    ['cancelled pipeline', { phase: 'cancelled' }, 'planned'],
  ];
  const made = cases.map(([name, over]) => feature(p, name, over));
  const chart = chartOf(p, NOW)!;
  for (const [i, [name, , want]] of cases.entries()) {
    const f = flat(chart).find((x) => x.id === made[i])!;
    assert.equal(f.state, want, name);
    assert.ok((FEATURE_STATES as readonly string[]).includes(f.state));
  }
});

test('a dependency holds a feature until what it waits on is delivered, and can never loop', () => {
  const p = project();
  const [a, b, c] = ['a', 'b', 'c'].map((x) => feature(p, x));
  planFeature(b, { dependsOn: [a] });
  planFeature(c, { dependsOn: [b] });
  let chart = chartOf(p, NOW)!;
  const of = (id: string) => flat(chart).find((f) => f.id === id)!;
  assert.deepEqual(of(b).blockedBy, [a]);
  assert.deepEqual(of(c).blockedBy, [b]);
  assert.deepEqual(of(a).blockedBy, []);
  // A loop, at any length, is refused and nothing is stored.
  for (const [who, on] of [[a, [c]], [a, [b]], [a, [a]]] as const) {
    assert.throws(() => planFeature(who, { dependsOn: [...on] }), RoadmapError, `${who} → ${on}`);
  }
  assert.deepEqual(chartOf(p, NOW)!.unassigned.find((f) => f.id === a)!.dependsOn, []);
  // Delivered: what waited on it is free.
  db.prepare("UPDATE goals SET status = 'achieved' WHERE id = ?").run(a);
  chart = chartOf(p, NOW)!;
  assert.deepEqual(of(b).blockedBy, []);
  assert.deepEqual(of(c).blockedBy, [b]);
  // A dependency on something that is not this project's feature is refused.
  const other = feature(project('other'), 'elsewhere');
  assert.throws(() => planFeature(b, { dependsOn: [other] }), RoadmapError);
  assert.throws(() => planFeature(b, { dependsOn: ['nope'] }), RoadmapError);
});

test('next up in an epic is its earliest feature that can actually start', () => {
  const p = project();
  const e = createEpic(p, { name: 'Leg' });
  const done = feature(p, 'done', { status: 'achieved', target: '2026-09-01' });
  const running = feature(p, 'running', { phase: 'running', target: '2026-11-25' });
  const blocked = feature(p, 'blocked', { target: '2026-12-01' });
  const free = feature(p, 'free', { target: '2026-12-10' });
  const undated = feature(p, 'undated');
  for (const id of [done, running, blocked, free, undated]) planFeature(id, { epicId: e.id });
  planFeature(blocked, { dependsOn: [running] });
  let epic = chartOf(p, NOW)!.epics[0];
  // Ordered along the timeline: dated first by date, then the undated ones.
  assert.deepEqual(epic.features.map((f) => f.name), ['done', 'running', 'blocked', 'free', 'undated']);
  assert.equal(epic.nextUp, free, 'the blocked one is skipped; the running one is already under way');
  assert.deepEqual([epic.progress.done, epic.progress.total], [1, 5]);
  db.prepare("UPDATE goals SET status = 'achieved' WHERE id IN (?, ?)").run(running, free);
  epic = chartOf(p, NOW)!.epics[0];
  assert.equal(epic.nextUp, blocked);
  db.prepare("UPDATE goals SET status = 'achieved' WHERE id IN (?, ?)").run(blocked, undated);
  assert.equal(chartOf(p, NOW)!.epics[0].nextUp, null);
});

test('the vision, the epics and the dates are stored as planned — and bad input is refused, not guessed', () => {
  const p = project();
  setVision(p, '  One platform from idea to outcome.  ');
  const e1 = createEpic(p, { name: ' Access ', outcome: 'the right crew', icon: 'shield' });
  const e2 = createEpic(p, { name: 'Insights' });
  const f = feature(p, 'sso');
  planFeature(f, { epicId: e2.id, targetDate: '2026-12-24', startDate: '2026-12-01' });
  updateEpic(e1.id, { name: 'Crew & Access', outcome: 'x', icon: 'rocket' });
  reorderEpics(p, [e2.id, e1.id]);
  const chart = chartOf(p, NOW)!;
  assert.equal(chart.vision, 'One platform from idea to outcome.');
  assert.deepEqual(chart.epics.map((e) => [e.name, e.icon]), [['Insights', ''], ['Crew & Access', 'rocket']]);
  const got = chart.epics[0].features[0];
  assert.deepEqual([got.targetDate, got.startDate], ['2026-12-24', '2026-12-01']);
  // The chart's window always holds today and every dated feature, on whole months.
  assert.ok(chart.range.from <= '2026-11-01' && chart.range.to >= '2026-12-31', JSON.stringify(chart.range));
  assert.match(chart.range.from, /^\d{4}-\d{2}-01$/);
  assert.equal(chart.today, '2026-11-20');

  for (const bad of ['yesterday', '2026-13-01', '2026-02-30', '20261224']) {
    assert.throws(() => planFeature(f, { targetDate: bad }), RoadmapError, bad);
  }
  assert.throws(() => planFeature(f, { startDate: '2027-01-01' }), RoadmapError, 'a start after its target');
  assert.throws(() => createEpic(p, { name: '   ' }), RoadmapError);
  assert.throws(() => createEpic('no-such-project', { name: 'x' }), RoadmapError);
  assert.throws(() => planFeature('no-such-feature', { targetDate: '' }), RoadmapError);
  // Clearing a date is allowed; an epic of ANOTHER project is not.
  planFeature(f, { targetDate: '', startDate: '' });
  const foreign = createEpic(project('other'), { name: 'theirs' });
  assert.throws(() => planFeature(f, { epicId: foreign.id }), RoadmapError);
  assert.throws(() => reorderEpics(p, [e1.id, foreign.id]), RoadmapError);
});

test('removing an epic loses no feature, and a started feature is told where it fits', () => {
  const p = project('Operating system');
  setVision(p, 'Turn ideas into outcomes.');
  const e = createEpic(p, { name: 'Delivery', outcome: 'Ship work reliably.' });
  const [a, b] = ['auto scheduling', 'release'].map((x) => feature(p, x));
  planFeature(a, { epicId: e.id });
  planFeature(b, { epicId: e.id, dependsOn: [a] });
  const ctx = roadmapContextFor(b);
  assert.match(ctx, /Turn ideas into outcomes\./);
  assert.match(ctx, /Delivery/);
  assert.match(ctx, /Ship work reliably\./);
  assert.match(ctx, /auto scheduling/, 'what it builds on is named');
  assert.equal(roadmapContextFor(feature(project('bare'), 'lonely')), '', 'no vision, no epic: nothing to say');
  removeEpic(e.id);
  const chart = chartOf(p, NOW)!;
  assert.deepEqual(chart.epics, []);
  assert.deepEqual(chart.unassigned.map((f) => f.name).sort(), ['auto scheduling', 'release']);
  assert.deepEqual(chart.unassigned.find((f) => f.id === b)!.dependsOn, [a], 'the dependency outlives the epic');
});
