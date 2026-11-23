/**
 * setup.mjs produces a standalone git repo (not nested in neoncore) whose suite runs, starts the
 * seeded simulator, and prints a source config that matches the contract's Source shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_ENV, makeRepo, setup } from '../setup.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('setup: a fresh git repo with one commit on main, its own root, and a passing suite', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'triage-setup-')), 'ledgerly');
  const { repoPath, sim, config } = await setup({ dir, port: 0 });
  try {
    assert.equal(repoPath, dir);
    assert.equal(git(repoPath, 'rev-parse', '--show-toplevel'), git(repoPath, 'rev-parse', '--show-toplevel'));
    assert.ok(git(repoPath, 'rev-parse', '--show-toplevel').endsWith('ledgerly'), 'the repo root is the copy itself, not neoncore');
    assert.equal(git(repoPath, 'branch', '--show-current'), 'main');
    assert.equal(git(repoPath, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(git(repoPath, 'status', '--porcelain'), '', 'everything is committed');
    for (const f of ['package.json', 'CODEOWNERS', 'src/auth/session.js', 'test/ledgerly.test.js']) assert.ok(existsSync(join(repoPath, f)), f);
    assert.ok(!existsSync(join(repoPath, 'BUGS.md')), 'the bug list never goes into the repo the agent works in');
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env; // a nested runner would report to this one instead of printing
    const out = execFileSync('npm', ['test', '--silent'], { cwd: repoPath, encoding: 'utf8', env });
    assert.match(out, /ℹ fail 0/);

    // The config: the contract's Source fields, credentials as ENV NAMES only.
    assert.equal(config.jiraBaseUrl, sim.baseUrl);
    assert.deepEqual(config.projects, ['DEMO']);
    assert.deepEqual(config.issueTypes, ['Bug']);
    assert.deepEqual(config.repoFor, { DEMO: repoPath });
    assert.deepEqual(config.authEnv, AUTH_ENV);
    for (const v of Object.values(config.authEnv)) assert.match(v, /^[A-Z_][A-Z0-9_]*$/);
    assert.equal(config.reporters, 'internal');
    assert.equal(config.transitions, false);
    assert.ok(config.protectedPaths.some((p) => p.startsWith('src/auth')));
    for (const k of ['maxFiles', 'maxLines', 'minutesPerIssue', 'dispatchesPerIssue', 'reviewRounds']) assert.equal(typeof config.limits[k], 'number', k);

    // The simulator it started answers, seeded.
    const r = await fetch(`${sim.baseUrl}/rest/api/3/search/jql`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('a:b').toString('base64')}` },
      body: JSON.stringify({ jql: 'project = DEMO', maxResults: 100 }),
    });
    assert.equal((await r.json()).issues.length, 11);
  } finally {
    await sim.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup refuses a directory that is not empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-setup-full-'));
  writeFileSync(join(dir, 'x'), 'x');
  try {
    assert.throws(() => makeRepo(dir), /not empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
