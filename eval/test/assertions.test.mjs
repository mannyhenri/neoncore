import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TASKS = path.resolve(import.meta.dirname, '..', 'tasks');

async function loadAssert(id) {
  const mod = await import(pathToFileURL(path.join(TASKS, id, 'assert.mjs')).href);
  return mod.assert;
}
async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'assert-test-'));
}

// The critical guard (review): an assertion MUST fail on a wrong end-state,
// not just pass on a right one. Each task is checked both ways.

test('edit-timeout: passes on 60 with siblings intact, fails on unchanged / clobbered', async () => {
  const a = await loadAssert('edit-timeout');
  const good = await tmp();
  const unchanged = await tmp();
  const clobbered = await tmp();
  try {
    const full = (t) => `export const config = { retries: 3, timeout: ${t}, verbose: false };\n`;
    await writeFile(path.join(good, 'config.ts'), full(60));
    await writeFile(path.join(unchanged, 'config.ts'), full(30));
    // right timeout but a sibling field clobbered → must fail ("change nothing else")
    await writeFile(path.join(clobbered, 'config.ts'), 'export const config = { retries: 9, timeout: 60, verbose: false };\n');
    assert.equal((await a({ cwd: good })).pass, true);
    assert.equal((await a({ cwd: unchanged })).pass, false);
    assert.equal((await a({ cwd: clobbered })).pass, false);
  } finally {
    for (const d of [good, unchanged, clobbered]) await rm(d, { recursive: true, force: true });
  }
});

test('write-sum: passes when sum works, fails when missing', async () => {
  const a = await loadAssert('write-sum');
  const good = await tmp();
  const bad = await tmp();
  try {
    await writeFile(path.join(good, 'math.js'), 'module.exports = { sum: (a, b) => a + b };\n');
    await writeFile(path.join(bad, 'math.js'), 'module.exports = {};\n');
    assert.equal((await a({ cwd: good })).pass, true);
    assert.equal((await a({ cwd: bad })).pass, false);
  } finally {
    await rm(good, { recursive: true, force: true });
    await rm(bad, { recursive: true, force: true });
  }
});

test('refactor-rename: passes only when rename is complete AND consistent', async () => {
  const a = await loadAssert('refactor-rename');
  const good = await tmp();
  const partial = await tmp();
  try {
    await writeFile(path.join(good, 'user.js'), 'function fetchUser(id){return {id};}\nmodule.exports={fetchUser};\n');
    await writeFile(path.join(good, 'handler.js'), "const {fetchUser}=require('./user');\nmodule.exports=(id)=>fetchUser(id);\n");
    await writeFile(path.join(good, 'report.js'), "const {fetchUser}=require('./user');\nmodule.exports=(id)=>`u:${fetchUser(id).id}`;\n");
    // partial: a call site still says getUser -> broken require, must fail
    await writeFile(path.join(partial, 'user.js'), 'function fetchUser(id){return {id};}\nmodule.exports={fetchUser};\n');
    await writeFile(path.join(partial, 'handler.js'), "const {getUser}=require('./user');\nmodule.exports=(id)=>getUser(id);\n");
    await writeFile(path.join(partial, 'report.js'), "const {fetchUser}=require('./user');\nmodule.exports=(id)=>fetchUser(id).id;\n");
    assert.equal((await a({ cwd: good })).pass, true);
    assert.equal((await a({ cwd: partial })).pass, false);
  } finally {
    await rm(good, { recursive: true, force: true });
    await rm(partial, { recursive: true, force: true });
  }
});

test('file-answer tasks: assert the written file, reject wrong / missing / over-broad', async () => {
  const port = await loadAssert('read-port');
  const pGood = await tmp();
  const pBad = await tmp();
  const pMissing = await tmp();
  await writeFile(path.join(pGood, 'answer.txt'), '4040\n');
  await writeFile(path.join(pBad, 'answer.txt'), '8080\n');
  assert.equal((await port({ cwd: pGood })).pass, true);
  assert.equal((await port({ cwd: pBad })).pass, false);
  assert.equal((await port({ cwd: pMissing })).pass, false); // no answer.txt at all

  const count = await loadAssert('bash-count-ts');
  const cGood = await tmp();
  const cBad = await tmp();
  await writeFile(path.join(cGood, 'answer.txt'), '3');
  await writeFile(path.join(cBad, 'answer.txt'), '4');
  assert.equal((await count({ cwd: cGood })).pass, true);
  assert.equal((await count({ cwd: cBad })).pass, false);

  const search = await loadAssert('search-imports');
  const sGood = await tmp();
  const sDump = await tmp();
  await writeFile(path.join(sGood, 'lodash-users.txt'), 'alpha.js\ngamma.js\n');
  // a bare `ls` dump that includes the distractor beta.js must be rejected
  await writeFile(path.join(sDump, 'lodash-users.txt'), 'alpha.js\nbeta.js\ngamma.js\n');
  assert.equal((await search({ cwd: sGood })).pass, true);
  assert.equal((await search({ cwd: sDump })).pass, false);

  for (const d of [pGood, pBad, pMissing, cGood, cBad, sGood, sDump]) await rm(d, { recursive: true, force: true });
});
