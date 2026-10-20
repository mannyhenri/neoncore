/**
 * THE HANDOFF SURVIVES TRUNCATION.
 *
 * A step's result reaches the next step through gatherDependencyContext, cut at 1,500 chars
 * (DEP_RESULT_MAX_CHARS). 85 of 190 stored results were longer, and the completion instruction
 * told agents to put "what the next step should focus on" at the END of the result — exactly the
 * part the cut removes. `next` is now its own field, stored FIRST in the result.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../src/db.ts';
import workflowsRouter from '../src/routes/workflows.ts';
import { DEP_RESULT_MAX_CHARS } from '../src/lib/context-budget.ts';
import { installStubIO } from './helpers/stub-io.ts';

installStubIO();
let base = '';
let server: Server;
test.before(async () => {
  const app = express(); app.use(express.json()); app.use('/api/workflows', workflowsRouter);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r(); }); });
});
test.after(() => server?.close());

let n = 0;
function runningStep(executorType: string): string {
  const id = `hn-${++n}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, status, template_id, created_at) VALUES (?, 'run', 'running', 'tpl', ?)`).run(`w-${id}`, now);
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, position_x, position_y, created_at, started_at)
              VALUES (?,?,?,'running',?,'','{}',0,0,?,?)`).run(id, `w-${id}`, 'step', executorType, now, now);
  return id;
}
const complete = (id: string, body: Record<string, unknown>) => fetch(`${base}/api/workflows/webhook/${id}/complete`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const stored = (id: string) => (db.prepare('SELECT result FROM workflow_steps WHERE id = ?').get(id) as { result: string }).result;

const LONG = 'detail '.repeat(600); // ~4.2k, well past the dependency cut

for (const executorType of ['claude-code', 'command', 'review-gate', 'quality-gate']) {
  test(`${executorType}: next is stored first and survives the dependency cut`, async () => {
    const id = runningStep(executorType);
    const gate = executorType.endsWith('gate');
    const res = await complete(id, {
      result: gate ? `PASS\n${LONG}` : LONG,
      next: 'Focus on the report spec.', scope: '1/1', verify: 'npm test → 1 passed',
    });
    assert.ok(res.ok, await res.text());
    assert.match(stored(id).slice(0, DEP_RESULT_MAX_CHARS), /Focus on the report spec\./, 'the handoff was cut off');
    if (gate) assert.match(stored(id), /^PASS/, 'the gate verdict must stay on line 1');
  });
}

test('without next the stored result is unchanged', async () => {
  const id = runningStep('claude-code');
  await complete(id, { result: 'did it', scope: '1/1', verify: 'npm test → ok' });
  assert.match(stored(id), /^did it/);
});

test('the MCP tool accepts next and forwards it', () => {
  const mcp = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/mcp-server.ts'), 'utf8');
  const tool = mcp.slice(mcp.indexOf("name: 'neoncore_report_step_done'"), mcp.indexOf("name: 'neoncore_my_queue'"));
  assert.match(tool, /\bnext:\s*\{/, 'the tool schema has no next field');
  const handler = mcp.slice(mcp.indexOf("if (name === 'neoncore_report_step_done')"), mcp.indexOf("if (name === 'neoncore_my_queue')"));
  assert.match(handler, /\bnext\b/, 'the handler drops next');
});
