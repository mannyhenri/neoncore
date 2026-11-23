/**
 * AN EPIC HAS A DATE AND CAN WAIT ON ANOTHER EPIC (lib/roadmap.ts) — and an epic delivered on or
 * before its date is a COMMENDATION for the project, which promotes its captain
 * (lib/project-rewards.ts): Captain → General → Commander → Admiral → President.
 *
 * Checked as sets:
 *   · the date: every way to write, clear and refuse one;
 *   · the dependency: same project only, never itself, never a circle (every back-edge of a chain);
 *     removing an epic leaves nobody waiting on it;
 *   · what the chart derives for an epic, for every combination of delivered / date / when;
 *   · a waiting epic offers nothing to start until what it waits on is delivered;
 *   · the rank for 0 to 6 commendations, and what does not count as one.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { chartOf, createEpic, updateEpic, removeEpic, planFeature, RoadmapError } from '../src/lib/roadmap.js';
import { REWARD_FAMILIES, RANKS, rankFor, rewardCounts, projectRewards } from '../src/lib/project-rewards.js';

let n = 0;
const NOW = Date.parse('2026-11-22T12:00:00Z');
function project(name = 'P'): string {
  const id = `ep-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','/code/x','#fff',?,?)`).run(id, name, '2026-01-01', '2026-01-01');
  return id;
}
function feature(projectId: string, epicId: string, doneOn?: string): string {
  const id = `ep-f-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, target_date, origin, done_at)
              VALUES (?,?,'',?,?,?,?,?,'','planned',?)`)
    .run(id, `Feature ${n}`, doneOn ? 'achieved' : 'active', '2026-01-01', '2026-01-01', projectId, n, doneOn ? `${doneOn}T10:00:00Z` : '');
  planFeature(id, { epicId });
  return id;
}
const epicOf = (p: string, id: string) => chartOf(p, NOW)!.epics.find((e) => e.id === id)!;
const refused = (fn: () => void, what: RegExp) => assert.throws(fn, (e: unknown) => e instanceof RoadmapError && what.test((e as Error).message));

test('an epic\'s date: set when it is made, changed, cleared — and anything that is not a real day is refused', () => {
  const p = project();
  const made = createEpic(p, { name: 'Dated', targetDate: '2026-12-24' }).id;
  assert.equal(epicOf(p, made).targetDate, '2026-12-24');
  const plain = createEpic(p, { name: 'Undated' }).id;
  assert.equal(epicOf(p, plain).targetDate, '');
  updateEpic(plain, { targetDate: '2027-01-15' });
  assert.equal(epicOf(p, plain).targetDate, '2027-01-15');
  // Only the fields given change: renaming keeps the date, giving a date keeps the name.
  updateEpic(plain, { name: 'Renamed' });
  assert.deepEqual([epicOf(p, plain).name, epicOf(p, plain).targetDate], ['Renamed', '2027-01-15']);
  updateEpic(plain, { targetDate: '' });
  assert.equal(epicOf(p, plain).targetDate, '');
  for (const bad of ['tomorrow', '2026-13-01', '2026-02-30', '24/12/2026', '2026-1-5']) {
    refused(() => updateEpic(plain, { targetDate: bad }), /date like/);
    refused(() => createEpic(p, { name: 'X', targetDate: bad }), /date like/);
  }
  assert.equal(chartOf(p, NOW)!.epics.length, 2, 'a refused epic is not made');
  // The chart's window reaches an epic's date even when no feature has one.
  updateEpic(made, { targetDate: '2027-06-10' });
  assert.ok(chartOf(p, NOW)!.range.to >= '2027-06-30');
});

test('an epic waits on other epics of the SAME project — never itself, never in a circle; removing one leaves nobody waiting on it', () => {
  const p = project(); const other = project('Other');
  const chain = ['A', 'B', 'C', 'D'].map((name) => createEpic(p, { name }).id);
  const foreign = createEpic(other, { name: 'Foreign' }).id;
  // B waits on A, C on B, D on C.
  for (let i = 1; i < chain.length; i++) updateEpic(chain[i], { dependsOn: [chain[i - 1]] });
  assert.deepEqual(chain.map((id) => epicOf(p, id).dependsOn), [[], [chain[0]], [chain[1]], [chain[2]]]);
  // Every back-edge of the chain would close a circle: all refused, and nothing changes.
  for (let i = 0; i < chain.length; i++) for (let j = i + 1; j < chain.length; j++) {
    refused(() => updateEpic(chain[i], { dependsOn: [chain[j]] }), /circle/);
  }
  for (const id of chain) refused(() => updateEpic(id, { dependsOn: [id] }), /itself/);
  refused(() => updateEpic(chain[0], { dependsOn: [foreign] }), /same project/);
  refused(() => updateEpic(chain[0], { dependsOn: ['no-such-epic'] }), /same project/);
  refused(() => createEpic(p, { name: 'New', dependsOn: [foreign] }), /same project/);
  assert.deepEqual(chain.map((id) => epicOf(p, id).dependsOn), [[], [chain[0]], [chain[1]], [chain[2]]]);
  // Two at once, given twice: kept once each. Made already waiting: fine.
  updateEpic(chain[3], { dependsOn: [chain[2], chain[0], chain[2]] });
  assert.deepEqual(epicOf(p, chain[3]).dependsOn, [chain[2], chain[0]]);
  const late = createEpic(p, { name: 'E', dependsOn: [chain[3]] }).id;
  assert.deepEqual(epicOf(p, late).dependsOn, [chain[3]]);
  // Removing C: D and nobody else still names it.
  removeEpic(chain[2]);
  const left = chartOf(p, NOW)!.epics;
  assert.equal(left.some((e) => e.dependsOn.includes(chain[2]) || e.blockedBy.includes(chain[2])), false);
  assert.deepEqual(epicOf(p, chain[3]).dependsOn, [chain[0]]);
  updateEpic(chain[3], { dependsOn: [] });
  assert.deepEqual(epicOf(p, chain[3]).dependsOn, []);
});

test('what the chart says of an epic, for every combination of delivered, dated and when', () => {
  const p = project();
  // [name, target date, the days its features were delivered (null = not delivered)] → [delivered on, on time, late]
  const cases: [string, string, (string | null)[], string | null, boolean, boolean][] = [
    ['no features', '2026-12-01', [], null, false, false],
    ['no features, date passed', '2026-11-01', [], null, false, true],
    ['delivered before its date', '2026-11-20', ['2026-11-05', '2026-11-18'], '2026-11-18', true, false],
    ['delivered ON its date', '2026-11-18', ['2026-11-18'], '2026-11-18', true, false],
    ['delivered the day after', '2026-11-17', ['2026-11-10', '2026-11-18'], '2026-11-18', false, false],
    ['delivered, no date', '', ['2026-11-18'], '2026-11-18', false, false],
    ['one feature left, date ahead', '2026-12-01', ['2026-11-05', null], null, false, false],
    ['one feature left, date passed', '2026-11-10', ['2026-11-05', null], null, false, true],
    ['nothing delivered, no date', '', [null], null, false, false],
  ];
  const ids = cases.map(([name, target, days]) => {
    const id = createEpic(p, { name, targetDate: target }).id;
    for (const d of days) feature(p, id, d ?? undefined);
    return id;
  });
  cases.forEach(([name, , , deliveredOn, onTime, late], i) => {
    const e = epicOf(p, ids[i]);
    assert.equal(e.deliveredAt?.slice(0, 10) ?? null, deliveredOn, `${name}: delivered on`);
    assert.equal(e.onTime, onTime, `${name}: on time`);
    assert.equal(e.late, late, `${name}: late`);
  });
});

test('a waiting epic is blocked until what it waits on is delivered — and offers nothing to start while it is', () => {
  const p = project();
  const first = createEpic(p, { name: 'First' }).id;
  const second = createEpic(p, { name: 'Second', dependsOn: [first] }).id;
  const todo = feature(p, first);
  const next = feature(p, second);
  assert.deepEqual(epicOf(p, second).blockedBy, [first]);
  assert.equal(epicOf(p, second).nextUp, null, 'nothing of a blocked epic is offered');
  assert.equal(epicOf(p, first).nextUp, todo);
  db.prepare(`UPDATE goals SET status = 'achieved', done_at = '2026-11-20T10:00:00Z' WHERE id = ?`).run(todo);
  assert.deepEqual(epicOf(p, second).blockedBy, []);
  assert.equal(epicOf(p, second).nextUp, next);
  // An epic with no features is not delivered: waiting on it still blocks.
  const empty = createEpic(p, { name: 'Empty' }).id;
  updateEpic(second, { dependsOn: [first, empty] });
  assert.deepEqual(epicOf(p, second).blockedBy, [empty]);
});

test('commendations: one per epic delivered on or before its date — and the captain\'s rank for 0 to 6 of them', () => {
  assert.deepEqual(RANKS.map((r) => r.title), ['Captain', 'General', 'Commander', 'Admiral', 'President']);
  const family = REWARD_FAMILIES.find((f) => f.id === 'commend')!;
  assert.deepEqual(family.tiers, [1, 2, 3, 4], 'one medal per promotion');
  const p = project('Gridlight');
  // What does NOT count: late, undated, unfinished, empty.
  const late = createEpic(p, { name: 'Late', targetDate: '2026-11-01' }).id; feature(p, late, '2026-11-02');
  const undated = createEpic(p, { name: 'Undated' }).id; feature(p, undated, '2026-11-02');
  const open = createEpic(p, { name: 'Open', targetDate: '2026-12-30' }).id; feature(p, open, '2026-11-02'); feature(p, open);
  createEpic(p, { name: 'Empty', targetDate: '2026-12-30' });
  assert.equal(rewardCounts(p, NOW)!.commend, 0);
  assert.equal(rewardCounts(p, NOW)!.epics, 2, 'they are still epics delivered');
  for (let k = 0; k <= 6; k++) {
    if (k > 0) { const e = createEpic(p, { name: `On time ${k}`, targetDate: '2026-11-20' }).id; feature(p, e, '2026-11-19'); }
    const r = projectRewards(p, NOW)!;
    const want = Math.min(k, RANKS.length - 1);
    assert.equal(rewardCounts(p, NOW)!.commend, k, `${k} commendations`);
    assert.deepEqual([r.rank.index, r.rank.id, r.rank.title, r.rank.commendations], [want, RANKS[want].id, RANKS[want].title, k], `${k}: rank`);
    assert.deepEqual(r.rank.next, want < RANKS.length - 1 ? { title: RANKS[want + 1].title, at: want + 1 } : null, `${k}: next`);
    assert.deepEqual(rankFor(k), r.rank);
    const medals = r.families.find((f) => f.id === 'commend')!;
    assert.deepEqual(medals.tiers.map((t) => t.earned), [1, 2, 3, 4].map((t) => k >= t), `${k}: medals`);
    // Each medal names the rank it brings.
    assert.deepEqual(medals.tiers.map((t) => t.label), RANKS.slice(1).map((rank, i) => `Gridlight — ${rank.title}: ${i + 1} ${i === 0 ? 'epic' : 'epics'} delivered on or before ${i === 0 ? 'its' : 'their'} date`));
  }
  // Another project's commendations are its own.
  assert.equal(projectRewards(project('Fresh'), NOW)!.rank.title, 'Captain');
});
