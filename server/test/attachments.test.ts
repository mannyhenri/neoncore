import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAttachmentsInput,
  materializeAttachments,
  materializeForRepos,
  parseAttachmentBlocks,
  blockForRepo,
} from '../src/lib/attachments.ts';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-attach-'));
}

function file(name: string, body: string, mimeType = 'text/plain') {
  const dataBase64 = Buffer.from(body, 'utf-8').toString('base64');
  return { name, mimeType, size: Buffer.byteLength(body, 'utf-8'), dataBase64 };
}

/** The one file written under .neoncore/attachments that is not metadata.json. */
function writtenFiles(repo: string): string[] {
  const root = path.join(repo, '.neoncore', 'attachments');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== 'metadata.json') found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

test('parseAttachmentsInput: absent → empty, non-array and malformed entries throw', () => {
  assert.deepEqual(parseAttachmentsInput(undefined), []);
  assert.deepEqual(parseAttachmentsInput(null), []);
  assert.throws(() => parseAttachmentsInput('nope'), /must be an array/);
  assert.throws(() => parseAttachmentsInput([{ name: 'a.txt' }]), /name, size, and dataBase64/);
  const ok = [file('a.txt', 'hello')];
  assert.deepEqual(parseAttachmentsInput(ok), ok);
});

test('materializeAttachments: writes bytes into the repo and names the path in the block', () => {
  const repo = tmpRepo();
  const block = materializeAttachments(repo, [file('report.txt', 'evidence')]);

  const written = writtenFiles(repo);
  assert.equal(written.length, 1);
  assert.equal(fs.readFileSync(written[0], 'utf-8'), 'evidence');

  const relative = path.relative(repo, written[0]);
  assert.match(block, /report\.txt/);
  assert.ok(block.includes(relative), `block should carry the repo-relative path\n${block}`);
  assert.ok(!path.isAbsolute(relative));
});

test('materializeAttachments: gitignores the attachment dir so evidence is never committed', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules');  // no trailing newline
  materializeAttachments(repo, [file('a.txt', 'x')]);
  const ignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf-8');
  assert.deepEqual(ignore.split('\n').filter(Boolean), ['node_modules', '.neoncore/attachments/']);

  // Second batch must not append a duplicate entry.
  materializeAttachments(repo, [file('b.txt', 'y')]);
  const again = fs.readFileSync(path.join(repo, '.gitignore'), 'utf-8');
  assert.equal(again.split('\n').filter((l) => l === '.neoncore/attachments/').length, 1);
});

test('materializeAttachments: absolutePaths option emits paths valid from any cwd', () => {
  const repo = tmpRepo();
  const block = materializeAttachments(repo, [file('a.txt', 'x')], { absolutePaths: true });
  const written = writtenFiles(repo)[0];
  assert.ok(block.includes(written), `block should carry the absolute path\n${block}`);
});

test('materializeAttachments: unsafe filenames are sanitized, collisions are de-duped', () => {
  const repo = tmpRepo();
  materializeAttachments(repo, [
    file('../../escape.txt', 'one'),
    file('escape.txt', 'two'),
  ]);
  const names = writtenFiles(repo).map((f) => path.basename(f)).sort();
  assert.deepEqual(names, ['escape-2.txt', 'escape.txt']);
});

test('materializeAttachments: nothing to attach → empty block, no directory created', () => {
  const repo = tmpRepo();
  assert.equal(materializeAttachments(repo, []), '');
  assert.equal(materializeAttachments(repo, undefined), '');
  assert.equal(fs.existsSync(path.join(repo, '.neoncore')), false);
});

test('materializeAttachments: rejects a missing repo path rather than writing somewhere else', () => {
  assert.throws(() => materializeAttachments('', [file('a.txt', 'x')]), /no repo path/);
  assert.throws(
    () => materializeAttachments(path.join(os.tmpdir(), 'neoncore-does-not-exist'), [file('a.txt', 'x')]),
    /does not exist/,
  );
});

test('materializeAttachments: rejects a payload whose size does not match its bytes', () => {
  const repo = tmpRepo();
  const bad = { ...file('a.txt', 'hello'), size: 9999 };
  assert.throws(() => materializeAttachments(repo, [bad]), /did not match uploaded data/);
});

test('materializeForRepos: one copy per distinct repo, each with its own valid path', () => {
  const repoA = tmpRepo();
  const repoB = tmpRepo();
  const blocks = materializeForRepos([repoA, repoB, repoA, '', null], [file('a.txt', 'shared')]);

  assert.deepEqual(Object.keys(blocks).sort(), [repoA, repoB].sort());
  for (const repo of [repoA, repoB]) {
    const written = writtenFiles(repo);
    assert.equal(written.length, 1, `${repo} should get exactly one copy`);
    assert.equal(fs.readFileSync(written[0], 'utf-8'), 'shared');
    assert.ok(blocks[repo].includes(written[0]));
  }
});

test('materializeForRepos: nothing to attach → empty map; files but no repo → throws', () => {
  assert.deepEqual(materializeForRepos([tmpRepo()], []), {});
  assert.throws(() => materializeForRepos(['', null, undefined], [file('a.txt', 'x')]), /has a repo path/);
});

test('parseAttachmentBlocks: tolerates null, garbage, and non-object JSON', () => {
  assert.deepEqual(parseAttachmentBlocks(null), {});
  assert.deepEqual(parseAttachmentBlocks(''), {});
  assert.deepEqual(parseAttachmentBlocks('{not json'), {});
  assert.deepEqual(parseAttachmentBlocks('["a"]'), {});
  assert.deepEqual(parseAttachmentBlocks('{"/repo":"block"}'), { '/repo': 'block' });
});

test('blockForRepo: exact match wins; single-repo runs fall back; ambiguous returns nothing', () => {
  assert.equal(blockForRepo({ '/a': 'A', '/b': 'B' }, '/b'), 'B');
  // One repo in play — an agent whose repo_path was recorded differently still hears about it.
  assert.equal(blockForRepo({ '/a': 'A' }, '/elsewhere'), 'A');
  // Several repos and no match: guessing would hand out a path that resolves to nothing.
  assert.equal(blockForRepo({ '/a': 'A', '/b': 'B' }, '/elsewhere'), '');
  assert.equal(blockForRepo({}, '/a'), '');
});
