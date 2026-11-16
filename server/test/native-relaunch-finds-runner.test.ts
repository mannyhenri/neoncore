// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { findRunnerFor } from '../src/lib/native-relaunch.ts';

/**
 * "RESUME SESSION" AFTER A CRASH MUST FIND THE RUNNER THAT IS RIGHT THERE.
 *
 * Found by cutting the power on the sandbox mid-workflow and clicking Resume: "no runner is
 * registered for vm" — with the runner online. Cartridges register under os.hostname(); a runner
 * uses runner.config.json's `hostname` when set (documented; the sandbox sets "sandbox-machine"),
 * and macOS renames os.hostname() between networks. Matching on hostname alone failed every time
 * the two differed. The repo path — where the terminal must open — identifies the machine too.
 */

const now = new Date().toISOString();
const machine = (id: string, hostname: string, repos: string[]) =>
  db.prepare(`INSERT OR REPLACE INTO machines (id, hostname, repos, status, last_seen, created_at) VALUES (?, ?, ?, 'online', ?, ?)`)
    .run(id, hostname, JSON.stringify(repos.map((path) => ({ path, name: path.split('/').pop() }))), now, now);

test('a runner whose hostname matches is used', () => {
  machine('m-host', 'vm-a', ['/code/app']);
  assert.equal(findRunnerFor('vm-a', '/code/app', () => true).machine?.id, 'm-host');
});

test('a runner with a custom hostname is found by the repo it allows', () => {
  machine('m-custom', 'Sams laptop', ['/code/ledger']);
  const r = findRunnerFor('vm-b', '/code/ledger', () => true);
  assert.equal(r.machine?.id, 'm-custom', r.reason);
});

test('two online runners listing the same repo is ambiguous — refused, not guessed', () => {
  machine('m-x', 'x', ['/code/shared']);
  machine('m-y', 'y', ['/code/shared']);
  const r = findRunnerFor('vm-c', '/code/shared', () => true);
  assert.equal(r.machine, undefined);
  assert.match(r.reason, /2 online runners list \/code\/shared/);
});

test('an offline runner is reported as offline, whichever way it was found', () => {
  assert.match(findRunnerFor('vm-a', '/code/app', () => false).reason, /offline/);
  assert.match(findRunnerFor('vm-b', '/code/ledger', () => false).reason, /offline/);
  assert.match(findRunnerFor('nowhere', '/code/none', () => true).reason, /no runner is registered for nowhere/);
});
