import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { staleMissingRepoAgentIds } from '../src/lib/stale-agent-cleanup.ts';
import { workflowAgentOptions, offlineOptionCount, STALE_OPTION_DAYS } from '../../dashboard/src/lib/workflow-agent-options.ts';

test('the complete cleanup matrix deletes only offline local cartridges whose repo disappeared', () => {
  const cases = [
    { id: 'local-offline-missing', status: 'offline', local: true, exists: false, stale: true },
    { id: 'local-offline-present', status: 'offline', local: true, exists: true, stale: false },
    { id: 'local-working-missing', status: 'working', local: true, exists: false, stale: false },
    { id: 'remote-offline-missing-here', status: 'offline', local: false, exists: false, stale: false },
  ] as const;

  assert.deepEqual(
    staleMissingRepoAgentIds(cases, (row) => row.local, (row) => row.exists),
    cases.filter((row) => row.stale).map((row) => row.id),
  );
});

test('workflow choices keep live and queueable offline cartridges but hide dismissed ones', () => {
  const cases = [
    { id: 'working', status: 'working', dismissedAt: '', visible: true },
    { id: 'idle', status: 'idle', dismissedAt: '', visible: true },
    { id: 'offline-valid', status: 'offline', dismissedAt: '', visible: true },
    { id: 'dismissed-live', status: 'working', dismissedAt: '2026-09-16T00:00:00Z', visible: false },
    { id: 'dismissed-offline', status: 'offline', dismissedAt: '2026-09-16T00:00:00Z', visible: false },
  ];

  assert.deepEqual(
    workflowAgentOptions(cases, { includeOffline: true }).map((row) => row.id),
    cases.filter((row) => row.visible).map((row) => row.id),
  );
});

/**
 * THE DROPDOWN POLICY, AS A COMPLETE MATRIX.
 *
 * Reported as "the dropdown shows a lot of projects and duplicates". Measured on the live
 * database: 34 options, 24 of them offline (oldest 7.5 days), and one pair — "gl-dev · codex"
 * — rendering as two visually identical rows because the same checkout had registered twice
 * under two different hostnames ("Mannys-Mac-Pro.local" and a Codex sandbox reporting "local").
 *
 * Three rules, and the third is the one that needs care:
 *   1. dismissed is hidden          (existing)
 *   2. offline is OFFERED but aged out after STALE_OPTION_DAYS — hiding offline outright made
 *      launching onto a sleeping cartridge impossible, which is why it is offered at all; a
 *      cartridge nobody has touched in days is not one you are about to launch onto.
 *   3. same repoPath + engine collapses to the liveliest row — EXCEPT when more than one of
 *      them is live. An absolute path plus an engine identifies a checkout, so an offline row
 *      beside a live one is a stale predecessor from a restart. But two machines really can
 *      hold the same absolute path (WorkflowCanvasEditor.tsx says exactly this), and if both
 *      are live they are two real cartridges on two disks — collapsing those would silently
 *      send a run's files to the wrong box.
 *
 * Every row of the matrix is asserted, not a sample, because each rule's failure looks like
 * the others: too many rows, or the wrong row kept.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-18T00:00:00Z');
const ago = (d: number) => new Date(NOW - d * DAY).toISOString();

test('the dropdown policy matrix: what is offered, what is aged out, what collapses', () => {
  const cases = [
    // dismissed — hidden regardless of how alive it looks
    { id: 'dismissed', status: 'working', dismissedAt: ago(0), repoPath: '/a', agentType: 'claude', machine: 'mac', lastSeen: ago(0), kept: false },
    // live rows are always kept
    { id: 'live-recent', status: 'working', dismissedAt: '', repoPath: '/b', agentType: 'claude', machine: 'mac', lastSeen: ago(0), kept: true },
    { id: 'live-idle', status: 'idle', dismissedAt: '', repoPath: '/c', agentType: 'claude', machine: 'mac', lastSeen: ago(0), kept: true },
    // a LIVE row is never aged out, however long since its last event
    { id: 'live-but-quiet', status: 'working', dismissedAt: '', repoPath: '/d', agentType: 'claude', machine: 'mac', lastSeen: ago(30), kept: true },
    // offline inside the window — still queueable, still offered
    { id: 'offline-fresh', status: 'offline', dismissedAt: '', repoPath: '/e', agentType: 'claude', machine: 'mac', lastSeen: ago(1), kept: true },
    // offline past the window — aged out
    { id: 'offline-stale', status: 'offline', dismissedAt: '', repoPath: '/f', agentType: 'claude', machine: 'mac', lastSeen: ago(9), kept: false },
    // the reported duplicate: same checkout, same engine, two hostnames, one live
    { id: 'dupe-live', status: 'working', dismissedAt: '', repoPath: '/g', agentType: 'codex', machine: 'Mannys-Mac-Pro.local', lastSeen: ago(0), kept: true },
    { id: 'dupe-stale-host', status: 'offline', dismissedAt: '', repoPath: '/g', agentType: 'codex', machine: 'local', lastSeen: ago(0.4), kept: false },
    // two machines genuinely holding the same path, BOTH live — never collapsed
    { id: 'twin-here', status: 'working', dismissedAt: '', repoPath: '/h', agentType: 'claude', machine: 'mac-pro', lastSeen: ago(0), kept: true },
    { id: 'twin-there', status: 'idle', dismissedAt: '', repoPath: '/h', agentType: 'claude', machine: 'macbook', lastSeen: ago(0), kept: true },
    // same path, different ENGINE — two real cartridges, never collapsed
    { id: 'engine-claude', status: 'working', dismissedAt: '', repoPath: '/i', agentType: 'claude', machine: 'mac', lastSeen: ago(0), kept: true },
    { id: 'engine-codex', status: 'working', dismissedAt: '', repoPath: '/i', agentType: 'codex', machine: 'mac', lastSeen: ago(0), kept: true },
    // all offline for one checkout — the newest survives, the rest collapse
    { id: 'all-offline-newest', status: 'offline', dismissedAt: '', repoPath: '/j', agentType: 'claude', machine: 'mac', lastSeen: ago(1), kept: true },
    { id: 'all-offline-older', status: 'offline', dismissedAt: '', repoPath: '/j', agentType: 'claude', machine: 'mac', lastSeen: ago(2), kept: false },
  ];

  // MEMBERSHIP is what the matrix decides; ORDER is the separate live-first rule below, so
  // this compares sorted ids rather than baking the sort into every expectation.
  // includeOffline: this matrix is about WHICH rows survive the policy, not about the
  // live-only default, which has its own tests below.
  const kept = workflowAgentOptions(cases, { now: NOW, includeOffline: true }).map((r) => r.id);
  const expected = cases.filter((c) => c.kept).map((c) => c.id);
  assert.deepEqual([...kept].sort(), [...expected].sort(),
    'the dropdown policy does not match the matrix');
  assert.equal(kept.length, expected.length, 'a row was kept twice or dropped silently');

  // And the live rows genuinely lead — no offline row may appear before a live one.
  const firstOffline = kept.findIndex((id) => !cases.find((c) => c.id === id)!.status.match(/working|idle|waiting/));
  const lastLive = kept.reduce((last, id, i) =>
    cases.find((c) => c.id === id)!.status.match(/working|idle|waiting/) ? i : last, -1);
  assert.ok(firstOffline === -1 || firstOffline > lastLive, 'an offline cartridge was listed above a live one');
});

test('live cartridges lead — a dropdown that buries them is the complaint', () => {
  const rows = workflowAgentOptions([
    { id: 'off', status: 'offline', dismissedAt: '', repoPath: '/x', agentType: 'claude', machine: 'mac', lastSeen: ago(1) },
    { id: 'live', status: 'working', dismissedAt: '', repoPath: '/y', agentType: 'claude', machine: 'mac', lastSeen: ago(2) },
  ], { now: NOW, includeOffline: true });
  assert.deepEqual(rows.map((r) => r.id), ['live', 'off']);
});

test('the age-out window is one named constant, not a number typed into two files', () => {
  assert.equal(typeof STALE_OPTION_DAYS, 'number');
  assert.ok(STALE_OPTION_DAYS > 0 && STALE_OPTION_DAYS <= 14, 'implausible window');
});

test('a row missing lastSeen is kept, not silently aged out', () => {
  // Hand-inserted fixtures and rows predating the column have no timestamp. Treating a blank
  // as "infinitely old" would delete them from every dropdown with no way to tell why.
  const rows = workflowAgentOptions(
    [{ id: 'no-timestamp', status: 'offline', dismissedAt: '', repoPath: '/z', agentType: 'claude', machine: 'mac' }],
    { now: NOW, includeOffline: true },
  );
  assert.deepEqual(rows.map((r) => r.id), ['no-timestamp']);
});

/**
 * THE DROPDOWN MATCHES THE APP: LIVE CARTRIDGES ONLY, BY DEFAULT.
 *
 * "before we would see only the live repos (what we see on the app), shouldn't have more."
 * The app header counts `status !== 'offline'` (App.tsx:102) and showed 10 while the launch
 * dropdown offered 21 — two different answers to "which cartridges do I have".
 *
 * THIS RE-OPENS A CLOSED BUG, SO IT IS FENCED. Hiding offline cartridges was tried and
 * reverted on 2026-08-15 (894144d): a disconnected cartridge SILENTLY vanished from the
 * dropdown, launching onto it became impossible with no explanation, and it was reported as
 * the workflow "not sending". The word that matters in that account is *silently*. Offline
 * cartridges are now absent from the default list but never unreachable:
 *
 *   · `includeOffline` reveals them, behind a control that states how many there are, so the
 *     option is visible rather than missing.
 *   · `keepIds` pins anything already assigned into the list unconditionally. A step pinned to
 *     a sleeping cartridge MUST still render its own name — otherwise the <select> falls back
 *     to blank and the next save silently unassigns the step, which is the same class of bug
 *     wearing different clothes.
 */
test('the default list is exactly the live cartridges — what the app itself counts', () => {
  const rows = [
    { id: 'live-a', status: 'working', dismissedAt: '', repoPath: '/a', agentType: 'claude', machine: 'mac', lastSeen: ago(0) },
    { id: 'live-b', status: 'idle', dismissedAt: '', repoPath: '/b', agentType: 'claude', machine: 'mac', lastSeen: ago(0) },
    { id: 'live-c', status: 'waiting', dismissedAt: '', repoPath: '/c', agentType: 'claude', machine: 'mac', lastSeen: ago(0) },
    { id: 'off-fresh', status: 'offline', dismissedAt: '', repoPath: '/d', agentType: 'claude', machine: 'mac', lastSeen: ago(1) },
    { id: 'off-stale', status: 'offline', dismissedAt: '', repoPath: '/e', agentType: 'claude', machine: 'mac', lastSeen: ago(9) },
  ];
  // The same predicate App.tsx uses for the header count.
  const appShows = rows.filter((r) => r.status !== 'offline').map((r) => r.id);
  assert.deepEqual(workflowAgentOptions(rows, { now: NOW }).map((r) => r.id), appShows);
  assert.equal(appShows.length, 3);
});

test('revealing offline brings back the queueable ones, still aged out', () => {
  const rows = [
    { id: 'live', status: 'working', dismissedAt: '', repoPath: '/a', agentType: 'claude', machine: 'mac', lastSeen: ago(0) },
    { id: 'off-fresh', status: 'offline', dismissedAt: '', repoPath: '/d', agentType: 'claude', machine: 'mac', lastSeen: ago(1) },
    { id: 'off-stale', status: 'offline', dismissedAt: '', repoPath: '/e', agentType: 'claude', machine: 'mac', lastSeen: ago(9) },
  ];
  assert.deepEqual(
    workflowAgentOptions(rows, { now: NOW, includeOffline: true }).map((r) => r.id),
    ['live', 'off-fresh'],
  );
  // And the control can say how many there are without rendering them.
  assert.equal(offlineOptionCount(rows, { now: NOW }), 1);
});

test('a cartridge already assigned to a step is ALWAYS listed, however dead', () => {
  // The bug this prevents: the <select> holds an id with no matching <option>, renders blank,
  // and the next save writes that blank back — silently unassigning the step.
  const rows = [
    { id: 'live', status: 'working', dismissedAt: '', repoPath: '/a', agentType: 'claude', machine: 'mac', lastSeen: ago(0) },
    { id: 'pinned-offline', status: 'offline', dismissedAt: '', repoPath: '/b', agentType: 'claude', machine: 'mac', lastSeen: ago(40) },
    { id: 'pinned-dismissed', status: 'offline', dismissedAt: ago(1), repoPath: '/c', agentType: 'claude', machine: 'mac', lastSeen: ago(40) },
    { id: 'irrelevant-stale', status: 'offline', dismissedAt: '', repoPath: '/d', agentType: 'claude', machine: 'mac', lastSeen: ago(40) },
  ];
  const kept = workflowAgentOptions(rows, { now: NOW, keepIds: ['pinned-offline', 'pinned-dismissed'] })
    .map((r) => r.id);
  assert.deepEqual([...kept].sort(), ['live', 'pinned-dismissed', 'pinned-offline']);
  assert.ok(!kept.includes('irrelevant-stale'), 'keepIds must not widen the list generally');
});

test('a pinned cartridge survives even when a live twin would collapse it', () => {
  // Collapsing a stale predecessor is right until it is the row a step still points at.
  const rows = [
    { id: 'live-twin', status: 'working', dismissedAt: '', repoPath: '/g', agentType: 'codex', machine: 'Mannys-Mac-Pro.local', lastSeen: ago(0) },
    { id: 'stale-twin', status: 'offline', dismissedAt: '', repoPath: '/g', agentType: 'codex', machine: 'local', lastSeen: ago(0.4) },
  ];
  assert.deepEqual(workflowAgentOptions(rows, { now: NOW }).map((r) => r.id), ['live-twin']);
  assert.deepEqual(
    [...workflowAgentOptions(rows, { now: NOW, keepIds: ['stale-twin'] }).map((r) => r.id)].sort(),
    ['live-twin', 'stale-twin'],
  );
});

test('every workflow cartridge selector uses the shared visibility policy', () => {
  const root = new URL('../../dashboard/src/components/', import.meta.url);
  const surfaces = ['WorkflowPanel.tsx', 'WorkflowCanvasEditor.tsx'];
  for (const file of surfaces) {
    const source = readFileSync(fileURLToPath(new URL(file, root)), 'utf8');
    assert.match(source, /workflowAgentOptions\(/, `${file} bypasses workflowAgentOptions`);
  }
});

test('the scheduled cleanup invokes missing-repository pruning every six hours', () => {
  const source = readFileSync(fileURLToPath(
    new URL('../src/lib/cleanup-scheduler.ts', import.meta.url),
  ), 'utf8');
  assert.match(source, /staleMissingRepoAgentIds\(/);
  assert.match(source, /setInterval\(runCleanup, SIX_HOURS_MS\)/);
});
