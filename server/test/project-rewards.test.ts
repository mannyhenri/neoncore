/**
 * PROJECT REWARDS are counted from the project's own records — features, epics, Triage, QA — and
 * a reward is nothing but a threshold a count has passed. Every family and every tier is checked.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import db from '../src/db.js';
import { createEpic, planFeature } from '../src/lib/roadmap.js';
import { createPilotRow, setPhase } from '../src/lib/goal-pilot.js';
import { REWARD_FAMILIES, RANKS, COMMENDATION_NAMES, FAST_FIX_MS, NEW_MAPS, rewardCounts, projectRewards, allRewards, rewardLabel, worldProgress } from '../src/lib/project-rewards.js';

let n = 0;
const NOW = Date.parse('2026-11-22T12:00:00Z');
function project(name: string, repos: string[] = [`/code/${name.toLowerCase()}`]): string {
  const id = `rw-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'',?,'#4af',?,?)`)
    .run(id, name, repos[0] ?? '', `2026-01-${String(n).padStart(2, '0')}`, '2026-01-01');
  for (const r of repos.slice(1)) db.prepare('INSERT INTO project_cartridges (project_id, repo_path) VALUES (?, ?)').run(id, r);
  return id;
}
/** A feature. `doneOn`: delivered that day. `report`: its pipeline's verdict (a pilot is made for it). */
function feature(projectId: string, opts: { doneOn?: string; target?: string; origin?: string; report?: string; epicId?: string } = {}): string {
  const id = `rw-f-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, target_date, origin, done_at)
              VALUES (?,?,'',?,?,?,?,?,?,?,?)`)
    .run(id, `Feature ${n}`, opts.doneOn ? 'achieved' : 'active', '2026-01-01', '2026-01-01', projectId, n, opts.target ?? '', opts.origin ?? 'planned', opts.doneOn ? `${opts.doneOn}T10:00:00Z` : '');
  if (opts.report) {
    const pilot = createPilotRow({ goalId: id, plannerAgentId: 'nobody', intake: { goal: 'x' } });
    setPhase(pilot.id, 'completed');
    db.prepare('UPDATE goal_pilots SET report = ? WHERE id = ?').run(JSON.stringify({ status: opts.report }), pilot.id);
  }
  if (opts.epicId) planFeature(id, { epicId: opts.epicId });
  return id;
}
function bug(repo: string, state: string, opts: { prAfterMs?: number } = {}): void {
  const id = randomUUID(); const created = '2026-11-20T10:00:00.000Z';
  db.prepare(`INSERT INTO triage_issues (id, source_id, issue_key, state, repo_path, pr_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, 'src', `BUG-${++n}`, state, repo, opts.prAfterMs !== undefined ? 'https://example.com/pr/1' : '', created, created);
  if (opts.prAfterMs !== undefined) {
    db.prepare(`INSERT INTO triage_events (id, issue_id, at, kind, stage, summary) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), id, new Date(Date.parse(created) + opts.prAfterMs).toISOString(), 'stage', 'pull_request', 'pull request opened');
  }
}
function qaRuns(projectId: string, statuses: string[], kind = 'run'): void {
  const target = randomUUID();
  db.prepare(`INSERT INTO qa_targets (id, project_id, name, base_url, created_at, updated_at) VALUES (?,?,?,?,?,?)`).run(target, projectId, 'App', 'http://localhost:1', 'x', 'x');
  for (const s of statuses) db.prepare(`INSERT INTO qa_runs (id, target_id, kind, status, created_at) VALUES (?,?,?,?,?)`).run(randomUUID(), target, kind, s, 'x');
}
/** `entries` changelog entries shipped in `version` ('' = not released). One release, however many entries. */
function release(projectId: string, version: string, entries: number): void {
  for (let k = 0; k < entries; k++) db.prepare(`INSERT INTO project_changelog (id, project_id, title, release, released_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomUUID(), projectId, `Entry ${k}`, version, version ? '2026-11-01' : null, 'x', 'x');
}
const counts = (p: string) => rewardCounts(p, NOW)!;
const family = (p: string, id: string) => projectRewards(p, NOW)!.families.find((f) => f.id === id)!;

test('the families: ten of them, each with rising thresholds and words for one and for many', () => {
  assert.deepEqual(REWARD_FAMILIES.map((f) => f.id), ['features', 'epics', 'releases', 'bugs', 'qa', 'clean', 'streak', 'ontime', 'fastfix', 'commend']);
  assert.deepEqual(REWARD_FAMILIES.find((f) => f.id === 'features')!.tiers, [1, 5, 10, 25, 50, 75, 100]);
  assert.deepEqual(REWARD_FAMILIES.find((f) => f.id === 'epics')!.tiers, [1, 5, 10, 25]);
  assert.deepEqual(REWARD_FAMILIES.find((f) => f.id === 'bugs')!.tiers, [1, 5, 10, 25, 50, 100]);
  assert.deepEqual(REWARD_FAMILIES.find((f) => f.id === 'qa')!.tiers, [5, 25, 50, 100]);
  for (const f of REWARD_FAMILIES) {
    assert.ok(f.tiers.length >= 3, f.id);
    for (let i = 1; i < f.tiers.length; i++) assert.ok(f.tiers[i] > f.tiers[i - 1], `${f.id} thresholds rise`);
    assert.notEqual(rewardLabel(f, 1), rewardLabel(f, 2).replace('2', '1'), `${f.id}: one and many are worded differently`);
  }
  assert.equal(rewardLabel(REWARD_FAMILIES[0], 1), '1 feature delivered');
  assert.equal(rewardLabel(REWARD_FAMILIES[0], 10), '10 features delivered');
});

test('a new project has earned nothing; a project that does not exist has no rewards', () => {
  const p = project('Empty');
  const r = projectRewards(p, NOW)!;
  assert.deepEqual([r.name, r.earned, r.total], ['Empty', 0, REWARD_FAMILIES.reduce((sum, f) => sum + f.tiers.length, 0)]);
  for (const f of r.families) { assert.equal(f.count, 0); assert.equal(f.next, f.tiers[0].threshold); assert.ok(f.tiers.every((t) => !t.earned)); }
  assert.equal(projectRewards('nope', NOW), null);
  assert.equal(rewardCounts('nope', NOW), null);
});

test('every tier of every family is earned exactly when its count reaches the threshold — not one before', () => {
  for (const fam of REWARD_FAMILIES) {
    for (const [i, threshold] of fam.tiers.entries()) {
      for (const count of [threshold - 1, threshold]) {
        const p = project(`T${fam.id}${threshold}x${count}`);
        const repo = `/code/t${fam.id}${threshold}x${count}`.toLowerCase();
        if (fam.id === 'features') for (let k = 0; k < count; k++) feature(p, { doneOn: '2026-10-01' });
        if (fam.id === 'epics') for (let k = 0; k < count; k++) feature(p, { doneOn: '2026-10-01', epicId: createEpic(p, { name: `E${k}` }).id });
        if (fam.id === 'releases') for (let k = 0; k < count; k++) release(p, `1.${k}.0`, 2);
        if (fam.id === 'bugs') for (let k = 0; k < count; k++) bug(repo, k % 2 ? 'fixed' : 'released');
        if (fam.id === 'qa') qaRuns(p, Array.from({ length: count }, (_, k) => ['passed', 'failed', 'passed_with_repair'][k % 3]));
        if (fam.id === 'clean' || fam.id === 'streak') for (let k = 0; k < count; k++) feature(p, { doneOn: `2026-10-${String(k + 1).padStart(2, '0')}`, report: 'SUCCESS' });
        if (fam.id === 'ontime') for (let k = 0; k < count; k++) feature(p, { doneOn: '2026-10-01', target: '2026-10-01' });
        if (fam.id === 'fastfix') for (let k = 0; k < count; k++) bug(repo, 'fixed', { prAfterMs: FAST_FIX_MS });
        if (fam.id === 'commend') for (let k = 0; k < count; k++) feature(p, { doneOn: '2026-10-01', epicId: createEpic(p, { name: `E${k}`, targetDate: '2026-10-01' }).id });
        const f = family(p, fam.id);
        assert.equal(f.count, count, `${fam.id} count for ${count}`);
        assert.equal(f.tiers[i].earned, count >= threshold, `${fam.id} tier ${threshold} at ${count}`);
        // A commendation's medal also has its own name (epic-plan.test.ts checks every one).
        assert.equal(f.tiers[i].label, `T${fam.id}${threshold}x${count} — ${fam.id === 'commend' ? `${COMMENDATION_NAMES[i]}: ` : ''}${rewardLabel(fam, threshold)}`);
        assert.equal(f.next, fam.tiers.find((t) => count < t) ?? null);
        // Lower tiers are earned with it; higher ones are not.
        f.tiers.forEach((t, k) => assert.equal(t.earned, count >= fam.tiers[k], `${fam.id}: tier ${t.threshold} at ${count}`));
      }
    }
  }
});

test('what does NOT count, for each family', () => {
  const p = project('Strict', ['/code/strict', '/code/strict-api']);
  const e = createEpic(p, { name: 'Half done' });
  const empty = createEpic(p, { name: 'Nothing in it' });
  assert.ok(empty.id);
  feature(p, { doneOn: '2026-10-02', target: '2026-10-01', report: 'PARTIAL', epicId: e.id });   // late, with gaps
  feature(p, { epicId: e.id });                                                                   // not delivered: the epic is not either
  feature(p, { doneOn: '2026-10-03', origin: 'imported' });                                       // already there: history
  feature(p, { doneOn: '2026-10-04' });                                                           // no target date, no pipeline: not "on time", not "clean"
  bug('/code/strict', 'waiting_review', { prAfterMs: 1000 });                                     // not merged yet
  bug('/code/strict', 'handed_over');
  bug('/code/somewhere-else', 'fixed', { prAfterMs: 1000 });                                      // another project's repo
  bug('/Code/Strict-API/', 'fixed', { prAfterMs: FAST_FIX_MS + 1 });                              // its own repo, written differently: counts as fixed, but not fast
  qaRuns(p, ['running', 'waiting', 'error']);                                                     // not finished
  qaRuns(p, ['completed', 'completed'], 'explore');                                               // not test runs
  release(p, '', 3);                                                                              // entries not released yet
  assert.deepEqual(counts(p), { features: 2, epics: 0, releases: 0, bugs: 1, qa: 0, clean: 0, streak: 0, ontime: 0, fastfix: 0, commend: 0 });
});

test('the streak is the LONGEST run of clean deliveries in order of delivery — a gap ends a run, it does not erase it', () => {
  const p = project('Streaky');
  const reports = ['SUCCESS', 'SUCCESS', 'SUCCESS', 'PARTIAL', 'SUCCESS', 'SUCCESS', 'FAILED', 'SUCCESS'];
  // Created out of order: what matters is when each was delivered.
  [3, 0, 7, 1, 5, 2, 6, 4].forEach((i) => feature(p, { doneOn: `2026-10-${String(i + 1).padStart(2, '0')}`, report: reports[i] }));
  const c = counts(p);
  assert.deepEqual([c.features, c.clean, c.streak], [8, 6, 3]);
  assert.deepEqual(family(p, 'streak').tiers.map((t) => t.earned), [true, false, false]);
});

test('every project is listed, oldest first, each with its own counts', () => {
  const a = project('Alpha'); const b = project('Beta');
  feature(a, { doneOn: '2026-10-01' });
  const all = allRewards(NOW);
  const ia = all.findIndex((r) => r.projectId === a); const ib = all.findIndex((r) => r.projectId === b);
  assert.ok(ia >= 0 && ib > ia);
  assert.deepEqual([all[ia].earned, all[ib].earned], [1, 0]);
});

test('a new map opens when the whole outfit has done ALL of it — every project together — and stays open', () => {
  // This file's other tests left projects behind; start the count from what is there.
  const map = () => worldProgress(NOW).maps.find((m) => m.id === 'frontier')!;
  assert.deepEqual(NEW_MAPS[0].requires, { features: 10, epics: 5, qa: 5, releases: 5, ontime: 5, bugs: 5 });
  db.exec(`DELETE FROM goals; DELETE FROM projects; DELETE FROM project_changelog; DELETE FROM triage_issues; DELETE FROM qa_runs; DELETE FROM qa_targets; DELETE FROM settings WHERE key LIKE 'world.map.%'`);
  assert.deepEqual([map().met, map().total, map().unlocked, map().unlockedAt], [0, 6, false, null]);
  assert.deepEqual(map().requirements.map((r) => [r.family, r.target, r.label]), [
    ['features', 10, '10 features delivered'], ['epics', 5, '5 epics delivered'], ['qa', 5, '5 QA runs'],
    ['releases', 5, '5 releases shipped'], ['ontime', 5, '5 features delivered on time'], ['bugs', 5, '5 bugs fixed'],
  ]);

  // Two projects share the work: neither would open the map alone.
  const a = project('North'); const b = project('South');
  const done: string[] = [];
  const step = (family: string, add: () => void, also: string[] = []) => {
    assert.equal(map().unlocked, false, `open before ${family} was met`);
    add();
    done.push(family, ...also);
    const now = map();
    assert.deepEqual(now.requirements.filter((r) => r.met).map((r) => r.family).sort(), [...done].sort(), `after ${family}`);
    assert.equal(now.met, done.length);
  };
  step('epics', () => { for (let k = 0; k < 5; k++) feature(k % 2 ? a : b, { doneOn: '2026-10-01', epicId: createEpic(k % 2 ? a : b, { name: `E${k}` }).id }); });   // 5 features too
  step('ontime', () => { for (let k = 0; k < 5; k++) feature(k < 3 ? a : b, { doneOn: '2026-10-01', target: '2026-10-05' }); }, ['features']);                      // …and that makes 10 features: met with it
  step('qa', () => { qaRuns(a, ['passed', 'failed']); qaRuns(b, ['passed', 'passed', 'passed_with_repair']); });
  step('releases', () => { release(a, '1.0.0', 2); release(a, '1.1.0', 1); release(b, '0.1.0', 1); release(b, '0.2.0', 1); release(b, '0.3.0', 4); });
  assert.equal(map().unlocked, false, 'five of six is not open');
  for (let k = 0; k < 5; k++) bug(k < 2 ? '/code/north' : '/code/south', 'fixed');
  const open = map();
  assert.deepEqual([open.met, open.unlocked, open.unlockedAt], [6, true, new Date(NOW).toISOString()]);
  assert.deepEqual(open.requirements.map((r) => r.count), [10, 5, 5, 5, 5, 5]);

  // A place that was discovered stays discovered: a count falling back later does not close it, and the date does not move.
  db.exec(`DELETE FROM triage_issues`);
  const later = worldProgress(NOW + 86_400_000).maps[0];
  assert.deepEqual([later.met, later.unlocked, later.unlockedAt], [5, true, new Date(NOW).toISOString()]);
});
