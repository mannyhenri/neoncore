import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadTasks } from '../src/loadTasks.mjs';
import { runTask } from '../src/runner.mjs';

const TASKS = path.resolve(import.meta.dirname, '..', 'tasks');
const MOCKS = path.resolve(import.meta.dirname, 'mocks');

const baseEnv = { model: 'mock', gatewayUrl: 'http://localhost:0', backendMode: 'openai-compatible' };

test('loadTasks: loads the 6-task suite, skips _lib', async () => {
  const tasks = await loadTasks(TASKS);
  assert.equal(tasks.length, 6);
  assert.ok(tasks.every((t) => t.id && t.class && t.prompt && t.fixtureDir && t.assertPath));
  assert.ok(!tasks.some((t) => t.id === '_lib'));
});

test('runTask: solver mock passes edit-timeout end-to-end', async () => {
  const [task] = await loadTasks(TASKS, ['edit-timeout']);
  const r = await runTask(task, { ...baseEnv, gridlightBin: path.join(MOCKS, 'gridlight-editfix.mjs') });
  assert.equal(r.error, null, r.error || '');
  assert.equal(r.pass, true, JSON.stringify(r.checks));
});

test('runTask: noop mock fails edit-timeout (fixture untouched)', async () => {
  const [task] = await loadTasks(TASKS, ['edit-timeout']);
  const r = await runTask(task, { ...baseEnv, gridlightBin: path.join(MOCKS, 'gridlight-noop.mjs') });
  assert.equal(r.pass, false);
});

test('runTask: fixture isolation — the source fixture is never mutated', async () => {
  const { readFileSync } = await import('node:fs');
  const [task] = await loadTasks(TASKS, ['edit-timeout']);
  await runTask(task, { ...baseEnv, gridlightBin: path.join(MOCKS, 'gridlight-editfix.mjs') });
  const original = readFileSync(path.join(task.fixtureDir, 'config.ts'), 'utf8');
  assert.match(original, /timeout:\s*30\b/); // still 30 in the repo fixture
});
