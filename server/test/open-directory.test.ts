import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath } from '../src/lib/open-directory.ts';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-opendir-'));
}

// Regression: ~/.neoncore/relay symlinked straight to the repo's agent/relay made the
// relay-install copy try to write a tree onto itself, which fs.cpSync rejects with "src and
// dest cannot be the same" — and that throw surfaced as a bogus "Failed to create repo".
test('samePath: a directory reached through a symlink equals its real target', () => {
  const root = tmpdir();
  const real = path.join(root, 'agent', 'relay');
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(root, 'link-relay');
  fs.symlinkSync(real, link);

  assert.equal(samePath(real, link), true);
  assert.equal(samePath(path.join(real, 'scripts'), path.join(link, 'scripts')), false); // neither exists yet

  fs.mkdirSync(path.join(real, 'scripts'));
  assert.equal(samePath(path.join(real, 'scripts'), path.join(link, 'scripts')), true);
});

test('samePath: distinct real directories are not the same', () => {
  const a = tmpdir();
  const b = tmpdir();
  assert.equal(samePath(a, b), false);
});

test('samePath: a missing path is never "the same" and does not throw', () => {
  const a = tmpdir();
  assert.equal(samePath(a, path.join(a, 'does-not-exist')), false);
  assert.equal(samePath(path.join(a, 'nope'), path.join(a, 'nope')), false);
});
