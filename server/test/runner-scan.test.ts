import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
// @ts-expect-error — plain ESM JS shared with the runner, which has no type declarations.
import { findGitRepos, rescanRoots, sameRepoSet } from '../../agent/runner/scan.js';

/**
 * Keeping a scanned directory up to date.
 *
 * "Watched directory" was a misnomer: the runner enumerated a root ONCE at setup and served
 * that snapshot forever, so a repo cloned into Documents/Git afterwards never appeared and
 * never would. Nothing in the runner watched the filesystem at all.
 *
 * These roots are now re-scanned on a timer, which means the merge has to be exactly right:
 * pick up new repos, drop ones that were deleted, and never lose a folder the user added by
 * hand outside any scanned root.
 */

function fixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-scan-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const mkRepo = (parent: string, name: string) => {
  const p = path.join(parent, name);
  fs.mkdirSync(path.join(p, '.git'), { recursive: true });
  return p;
};
const mkPlain = (parent: string, name: string) => {
  const p = path.join(parent, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

// The registry this test iterates: what a real Documents/Git looks like.
const REPO_NAMES = ['drift-golf-services', 'luna', 'mercury', 'venus'];

test('finds every git repo directly under a root', () => {
  const { root, cleanup } = fixture();
  try {
    for (const n of REPO_NAMES) mkRepo(root, n);
    mkPlain(root, 'not-a-repo');
    mkPlain(root, 'screenshots');

    const found = findGitRepos(root).map((r: { name: string }) => r.name).sort();
    assert.deepEqual(found, [...REPO_NAMES].sort(), 'every git repo under the root must be found');
  } finally { cleanup(); }
});

test('a plain directory is never mistaken for a repo', () => {
  const { root, cleanup } = fixture();
  try {
    mkPlain(root, 'Movies');
    mkPlain(root, 'Adobe');
    assert.deepEqual(findGitRepos(root), [], 'directories without .git are not repos');
  } finally { cleanup(); }
});

test('THE ASK: a repo cloned after setup shows up on the next rescan', () => {
  const { root, cleanup } = fixture();
  try {
    for (const n of REPO_NAMES) mkRepo(root, n);
    const first = rescanRoots({ existing: [], roots: [root] });
    assert.equal(first.repos.length, 4);

    // ...later, the user clones a new one.
    mkRepo(root, 'juno');
    const second = rescanRoots({ existing: first.repos, roots: [root] });

    assert.ok(
      second.repos.some((r: { name: string }) => r.name === 'juno'),
      'a repo added after setup must appear without re-running setup',
    );
    assert.equal(second.changed, true, 'the runner must notice and re-register');
  } finally { cleanup(); }
});

test('a repo deleted from the root drops out', () => {
  const { root, cleanup } = fixture();
  try {
    for (const n of REPO_NAMES) mkRepo(root, n);
    const first = rescanRoots({ existing: [], roots: [root] });
    fs.rmSync(path.join(root, 'venus'), { recursive: true, force: true });

    const second = rescanRoots({ existing: first.repos, roots: [root] });
    assert.ok(!second.repos.some((r: { name: string }) => r.name === 'venus'), 'a deleted repo must not linger');
    assert.equal(second.changed, true);
  } finally { cleanup(); }
});

test('a hand-added folder OUTSIDE any scanned root survives a rescan', () => {
  const { root, cleanup } = fixture();
  const other = fixture();
  try {
    for (const n of REPO_NAMES) mkRepo(root, n);
    const manual = mkRepo(other.root, 'hand-added');

    const out = rescanRoots({ existing: [{ path: manual, name: 'hand-added' }], roots: [root] });
    assert.ok(
      out.repos.some((r: { path: string }) => r.path === manual),
      'rescanning a root must never delete folders the user added elsewhere',
    );
    assert.equal(out.repos.length, 5);
  } finally { cleanup(); other.cleanup(); }
});

test('a hand-added folder that no longer exists is dropped', () => {
  const { root, cleanup } = fixture();
  try {
    const out = rescanRoots({
      existing: [{ path: path.join(root, 'deleted-long-ago'), name: 'gone' }],
      roots: [root],
    });
    assert.deepEqual(out.repos, [], 'a path that is not on disk cannot be launched');
  } finally { cleanup(); }
});

test('an unchanged tree reports changed=false, so we do not re-register every tick', () => {
  const { root, cleanup } = fixture();
  try {
    for (const n of REPO_NAMES) mkRepo(root, n);
    const first = rescanRoots({ existing: [], roots: [root] });
    const second = rescanRoots({ existing: first.repos, roots: [root] });
    assert.equal(second.changed, false, 'a quiet tree must not produce churn on the server');
  } finally { cleanup(); }
});

test('a root that disappears is survivable, not fatal', () => {
  const { root, cleanup } = fixture();
  try {
    const gone = path.join(root, 'never-existed');
    const out = rescanRoots({ existing: [], roots: [gone, root] });
    assert.deepEqual(out.repos, [], 'a missing root is skipped rather than throwing');
  } finally { cleanup(); }
});

test('sameRepoSet ignores ordering', () => {
  const a = [{ path: '/x', name: 'x' }, { path: '/y', name: 'y' }];
  const b = [{ path: '/y', name: 'y' }, { path: '/x', name: 'x' }];
  assert.equal(sameRepoSet(a, b), true);
  assert.equal(sameRepoSet(a, [{ path: '/x', name: 'x' }]), false);
});
