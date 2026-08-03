import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One click on "+ Launch" opens exactly one terminal.
 *
 * It opened two. A machineId comes from runner.config.json, so every runner process reading
 * that file claims the same id — an installed launchd service plus a leftover `node index.js`
 * are two daemons with one identity. Machine instructions were emitted to the Socket.IO room
 * `machine:<id>`, which BROADCASTS: both runners got the launch, both opened a terminal.
 *
 * The set this covers is every instruction the portal sends to a machine's runner — launch,
 * set-repos, scan — because all three shared the same broadcast, plus the runner-side lock
 * that stops the duplicate daemon from existing in the first place.
 */

// ws.ts → db.ts opens a database at import. Must be set before the import below.
process.env.NEONCORE_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-launch-db-')),
  'test.db',
);

const { installStubIO } = await import('./helpers/stub-io.js');
const {
  dispatchLaunchToMachine,
  dispatchSetReposToMachine,
  dispatchScanToMachine,
  isMachineOnline,
} = await import('../src/ws.ts');
const { claimMachineSocket, releaseMachineSocket, resetMachineSocketsForTests } =
  await import('../src/lib/machine-sockets.ts');
// @ts-expect-error — plain ESM JS shared with the runner, which has no type declarations.
const { acquireRunnerLock, refreshRunnerLock, lockPathFor, LOCK_STALE_MS } =
  await import('../../agent/runner/lock.js');

const MACHINE = 'machine-under-test';

/** Two runner daemons on one box: two live sockets, one machineId. */
function twoRunnersClaiming(io: ReturnType<typeof installStubIO>) {
  for (const socketId of ['sock-runner-a', 'sock-runner-b']) {
    io.connectSocket(socketId);
    claimMachineSocket(socketId, MACHINE);
  }
}

function fixture() {
  resetMachineSocketsForTests();
  const io = installStubIO();
  return io;
}

// Every instruction the portal sends a runner. Each one was a room broadcast.
const DISPATCHES: { event: string; send: () => boolean }[] = [
  {
    event: 'launch_cartridge',
    send: () => dispatchLaunchToMachine(MACHINE, {
      repoPath: '/Users/x/code/neoncore', agentType: 'claude', sessionId: 'remote-1', context: '',
    }),
  },
  { event: 'machine_set_repos', send: () => dispatchSetReposToMachine(MACHINE, [{ path: '/Users/x/code/a', name: 'a' }]) },
  { event: 'machine_scan', send: () => dispatchScanToMachine(MACHINE, '/Users/x/code') },
];

test('two runners claiming one machine receive one copy of every instruction', () => {
  for (const { event, send } of DISPATCHES) {
    const io = fixture();
    twoRunnersClaiming(io);

    assert.equal(send(), true, `${event} must dispatch while the machine is online`);

    const sent = io.emissions.filter((e) => e.event === event);
    assert.equal(sent.length, 1, `${event}: one click must produce ONE instruction, not one per daemon`);
    assert.notEqual(sent[0].room, `machine:${MACHINE}`, `${event} must not be a room broadcast`);
    assert.equal(sent[0].room, 'sock-runner-b', `${event} goes to the newest claimant`);
  }
});

test('the surviving runner still gets instructions when the primary socket dies', () => {
  const io = fixture();
  twoRunnersClaiming(io);

  // The newest claimant drops (laptop sleeps, process killed) without a clean release.
  io.killSocket('sock-runner-b');

  assert.equal(isMachineOnline(MACHINE), true, 'a machine with a live claimant is online');
  assert.equal(dispatchLaunchToMachine(MACHINE, {
    repoPath: '/Users/x/code/neoncore', agentType: 'claude', sessionId: 'remote-2', context: '',
  }), true);

  const sent = io.emissions.filter((e) => e.event === 'launch_cartridge');
  assert.equal(sent.length, 1, 'still exactly one terminal');
  assert.equal(sent[0].room, 'sock-runner-a', 'the survivor is promoted');
});

test('a machine with no live socket is offline and nothing is dispatched', () => {
  const io = fixture();
  twoRunnersClaiming(io);
  io.killSocket('sock-runner-a');
  io.killSocket('sock-runner-b');

  assert.equal(isMachineOnline(MACHINE), false);
  for (const { event, send } of DISPATCHES) {
    assert.equal(send(), false, `${event} must refuse an offline machine`);
    assert.equal(io.emissions.filter((e) => e.event === event).length, 0, `${event} emitted nothing`);
  }
});

test('a clean disconnect releases the claim', () => {
  const io = fixture();
  twoRunnersClaiming(io);
  releaseMachineSocket('sock-runner-b');
  io.killSocket('sock-runner-b');

  dispatchLaunchToMachine(MACHINE, {
    repoPath: '/Users/x/code/neoncore', agentType: 'claude', sessionId: 'remote-3', context: '',
  });
  const sent = io.emissions.filter((e) => e.event === 'launch_cartridge');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].room, 'sock-runner-a');
});

// ── Runner-side: the duplicate daemon never gets to exist ──────────────────

function lockFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-runner-lock-'));
  const configPath = path.join(dir, 'runner.config.json');
  return { configPath, lockPath: lockPathFor(configPath, MACHINE) };
}

test('a second runner for the same machineId refuses to start', () => {
  const { lockPath } = lockFixture();
  const alive = () => true;

  const first = acquireRunnerLock({ lockPath, machineId: MACHINE, pid: 111, isAlive: alive });
  assert.equal(first.ok, true, 'the first runner starts');

  const second = acquireRunnerLock({ lockPath, machineId: MACHINE, pid: 222, isAlive: alive });
  assert.equal(second.ok, false, 'the second runner must not shadow the first');
  assert.equal(second.holder.pid, 111, 'and it can name the process to stop');
});

test('a lock left by a dead or wedged runner never blocks a restart', () => {
  const cases: { name: string; isAlive: () => boolean; heldAt: number; now: number }[] = [
    { name: 'holder exited', isAlive: () => false, heldAt: 1_000_000, now: 1_000_000 },
    { name: 'holder stopped checking in', isAlive: () => true, heldAt: 1_000_000, now: 1_000_000 + LOCK_STALE_MS + 1 },
  ];
  for (const c of cases) {
    const { lockPath } = lockFixture();
    acquireRunnerLock({ lockPath, machineId: MACHINE, pid: 111, isAlive: () => true, now: c.heldAt });
    const retry = acquireRunnerLock({ lockPath, machineId: MACHINE, pid: 222, isAlive: c.isAlive, now: c.now });
    assert.equal(retry.ok, true, `${c.name}: a stale lock must not strand the machine`);
  }
});

test('a live runner refreshing its lock keeps holding it', () => {
  const { lockPath } = lockFixture();
  acquireRunnerLock({ lockPath, machineId: MACHINE, pid: 111, isAlive: () => true, now: 1_000_000 });
  refreshRunnerLock({ lockPath, machineId: MACHINE, pid: 111, now: 1_000_000 + LOCK_STALE_MS });

  const intruder = acquireRunnerLock({
    lockPath, machineId: MACHINE, pid: 222, isAlive: () => true, now: 1_000_000 + LOCK_STALE_MS + 1,
  });
  assert.equal(intruder.ok, false, 'refreshing proves the holder is alive');
});

test('a different machineId is a different lock', () => {
  const { configPath } = lockFixture();
  const mine = lockPathFor(configPath, MACHINE);
  const theirs = lockPathFor(configPath, 'other-machine');
  assert.notEqual(mine, theirs);

  acquireRunnerLock({ lockPath: mine, machineId: MACHINE, pid: 111, isAlive: () => true });
  const other = acquireRunnerLock({ lockPath: theirs, machineId: 'other-machine', pid: 222, isAlive: () => true });
  assert.equal(other.ok, true, 'runners with distinct identities coexist');
});
