import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLocalMachine, normalizeHostname, machineLabel } from '../src/lib/machine-locality.ts';
import { materializeForRepos } from '../src/lib/attachments.ts';

/**
 * A cartridge registers with exactly ONE server, but it does not have to RUN on that
 * server's machine. A relay on a second Mac writes its own `repo_path` into this DB —
 * `/Users/someone-else/Documents/Git/foo`, which does not exist here.
 *
 * Every surface that copies attachments into an agent's checkout used to decide "is this
 * mine to write to?" by asking whether the agent row was in the local DB. It always was.
 * So the write went ahead against a foreign path and surfaced as:
 *
 *     Cannot attach files: repo path does not exist (/Users/emmanuelhenri/Documents/Git/backend-interlag)
 *
 * — which reads as a deleted repo and sends you hunting through your own settings for a
 * directory that was never on your disk. The set of surfaces that do this is THREE:
 * confer start, workflow launch, and single-agent send-command. This locks the predicate
 * they all now share.
 */

test('isLocalMachine: this host is local, bare or .local-suffixed', () => {
  const host = os.hostname();
  assert.equal(isLocalMachine(host), true);
  assert.equal(isLocalMachine(host.replace(/\.local$/i, '')), true);
  assert.equal(isLocalMachine(`${host.replace(/\.local$/i, '')}.local`), true);
  assert.equal(isLocalMachine(host.toUpperCase()), true);
});

test('isLocalMachine: another machine is not local', () => {
  assert.equal(isLocalMachine('Emmanuels-MacBook-Pro.local'), false);
  assert.equal(isLocalMachine('some-linux-box'), false);
});

test('isLocalMachine: a blank machine stays local (rows predating the column)', () => {
  assert.equal(isLocalMachine(''), true);
  assert.equal(isLocalMachine(null), true);
  assert.equal(isLocalMachine(undefined), true);
});

test('normalizeHostname / machineLabel', () => {
  assert.equal(normalizeHostname('Mannys-Mac-Pro.LOCAL'), 'mannys-mac-pro');
  assert.equal(machineLabel('Emmanuels-MacBook-Pro.local'), 'Emmanuels-MacBook-Pro');
  assert.equal(machineLabel(''), 'another machine');
});

/**
 * The reproduction: filtering participants by machine BEFORE materializing is what keeps
 * the raw fs error from ever being reachable. Without the filter, materializeForRepos is
 * handed a path from another user's home and throws the message above.
 */
test('materializeForRepos still throws on a foreign path — the filter is what saves us', () => {
  const foreign = path.join('/Users', 'someone-who-is-not-me', 'Documents', 'Git', 'backend-interlag');
  assert.equal(fs.existsSync(foreign), false, 'fixture path must not exist on this machine');

  const file = {
    name: 'evidence.txt',
    mimeType: 'text/plain',
    size: 8,
    dataBase64: Buffer.from('evidence', 'utf-8').toString('base64'),
  };

  assert.throws(
    () => materializeForRepos([foreign], [file]),
    /repo path does not exist/,
    'unguarded, a cross-machine repo path is a hard failure',
  );

  // With the locality predicate applied first, the foreign participant is dropped and the
  // local one is still served — which is exactly what the three call sites now do.
  const localRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-locality-'));
  const rows = [
    { repo_path: foreign, machine: 'Emmanuels-MacBook-Pro.local' },
    { repo_path: localRepo, machine: os.hostname() },
  ];
  const blocks = materializeForRepos(
    rows.filter((r) => isLocalMachine(r.machine)).map((r) => r.repo_path),
    [file],
  );
  assert.deepEqual(Object.keys(blocks), [localRepo]);
});

/**
 * The three call sites must not regress to "is it in the DB". Absence of a machine check
 * next to a materialize call is the bug, so assert the check is present in each file.
 */
test('confer, workflow launch, and send-command all gate attachments on machine', () => {
  const src = (rel: string) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf-8');

  for (const rel of ['routes/confer.ts', 'routes/workflows.ts', 'lib/send-command.ts']) {
    const body = src(rel);
    assert.match(body, /isLocalMachine/, `${rel} must gate repo writes on machine locality`);
    assert.match(
      body,
      /another machine/i,
      `${rel} must name the machine in its refusal, not leak a foreign path`,
    );
  }
});
