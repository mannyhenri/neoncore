// Task loader. Each task is a directory under tasks/<id>/:
//   task.json   { id, class, prompt, timeoutMs }
//   fixture/    seed file tree copied fresh into a temp dir per run
//   assert.mjs  exports async assert({cwd, stdout, exitCode}) -> {pass, checks[]}

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} class     capability class (bash|read|edit|write|refactor|search|git|bugfix)
 * @property {string} prompt    natural-language instruction handed to Gridlight
 * @property {number} timeoutMs
 * @property {string} dir
 * @property {string} fixtureDir
 * @property {string} assertPath
 */

/**
 * @param {string} tasksDir
 * @param {string[]} [only]  optional list of task ids to include
 * @returns {Promise<Task[]>}
 */
export async function loadTasks(tasksDir, only) {
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const tasks = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue; // _lib, .keep, etc.
    if (only && only.length && !only.includes(e.name)) continue;
    const dir = path.join(tasksDir, e.name);
    const metaRaw = await readFile(path.join(dir, 'task.json'), 'utf8');
    const meta = JSON.parse(metaRaw);
    const fixtureDir = path.join(dir, 'fixture');
    const assertPath = path.join(dir, 'assert.mjs');
    // Fail loud on a malformed task rather than silently skipping it — a missing
    // fixture or assertion would otherwise look like a model failure.
    await stat(fixtureDir);
    await stat(assertPath);
    tasks.push({
      id: meta.id || e.name,
      class: meta.class,
      prompt: meta.prompt,
      timeoutMs: meta.timeoutMs || 120000,
      dir,
      fixtureDir,
      assertPath,
    });
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return tasks;
}
