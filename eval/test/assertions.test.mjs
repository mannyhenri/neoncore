import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
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

// The critical guard (eng review): an assertion MUST fail on a wrong end-state,
// not just pass on a right one. Each task is checked both ways.

test('edit-timeout: passes on 60, fails on unchanged 30', async () => {
  const a = await loadAssert('edit-timeout');
  const good = await tmp();
  const bad = await tmp();
  try {
    await writeFile(path.join(good, 'config.ts'), 'export const config = { timeout: 60 };\n');
    await writeFile(path.join(bad, 'config.ts'), 'export const config = { timeout: 30 };\n');
    assert.equal((await a({ cwd: good })).pass, true);
    assert.equal((await a({ cwd: bad })).pass, false);
  } finally {
    await rm(good, { recursive: true, force: true });
    await rm(bad, { recursive: true, force: true });
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
    for (const d of [good]) {
      await writeFile(path.join(d, 'user.js'), 'function fetchUser(id){return {id};}\nmodule.exports={fetchUser};\n');
      await writeFile(path.join(d, 'handler.js'), "const {fetchUser}=require('./user');\nmodule.exports=(id)=>fetchUser(id);\n");
      await writeFile(path.join(d, 'report.js'), "const {fetchUser}=require('./user');\nmodule.exports=(id)=>`u:${fetchUser(id).id}`;\n");
    }
    // partial: definition renamed but a call site still says getUser -> broken require, must fail
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

test('stdout tasks: pass on expected token, fail without', async () => {
  const port = await loadAssert('read-port');
  assert.equal((await port({ stdout: 'the server listens on 4040' })).pass, true);
  assert.equal((await port({ stdout: 'it uses port 8080' })).pass, false);

  const count = await loadAssert('bash-count-ts');
  assert.equal((await count({ stdout: 'There are 3 .ts files' })).pass, true);
  assert.equal((await count({ stdout: 'There are 5 .ts files' })).pass, false);
});
