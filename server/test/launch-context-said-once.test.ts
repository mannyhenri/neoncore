/**
 * A FIRST STEP HEARS WHAT THE RUN IS ABOUT ONCE — AND ONLY WHAT IS MEANT FOR IT.
 *
 * Two kinds of noise reached every first step of six standard templates:
 *   1. The description twice: buildLaunchContext prepends it as "## About this workflow", and
 *      `workflowContext: true` prepended it again as "## Feature Under Validation".
 *   2. Operator guidance as the subject: those templates' descriptions open with "Set the
 *      workflow description to the system under review…" — an instruction to the person
 *      launching the run, which the agent then received as its context.
 * SET-BASED over every seeded template, every first step that dispatches a prompt.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';

const io = installStubIO();
let n = 0;

function freshAgent(): string {
  const id = `lcso-${++n}`;
  io.connect(id);
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, ?, 'box', ?, 'repo', 'idle', ?, ?, 'claude')`)
    .run(id, `box/${id}`, `/tmp/${id}`, new Date().toISOString(), `sess-${id}`);
  return id;
}

const templates = () => db.prepare(
  `SELECT id, name, description FROM workflows WHERE template_id IS NULL ORDER BY name`,
).all() as { id: string; name: string; description: string }[];

test('EVERY first-step prompt carries the description at most once, without operator guidance', () => {
  const wrong: string[] = [];
  let checked = 0;
  for (const tpl of templates()) {
    const agent = freshAgent();
    const runId = cloneTemplateAsRun(tpl.id, null, '');
    if (!runId) continue;
    db.prepare('UPDATE workflow_steps SET executor_id = ? WHERE workflow_id = ?').run(agent, runId);
    db.prepare("UPDATE workflows SET status = 'running' WHERE id = ?").run(runId);
    tickWorkflowsOnce();
    const first = db.prepare(
      `SELECT name, dispatched_prompt FROM workflow_steps
        WHERE workflow_id = ? AND depends_on = '[]' AND COALESCE(dispatched_prompt, '') != ''`,
    ).all(runId) as { name: string; dispatched_prompt: string }[];
    // The run's own description, as the agent would receive it (minus any operator lead-in).
    const run = db.prepare('SELECT description FROM workflows WHERE id = ?').get(runId) as { description: string };
    const tail = (run.description || '').split('. ').pop()!.trim().slice(0, 60);
    for (const s of first) {
      checked++;
      if (/Set the workflow description/i.test(s.dispatched_prompt)) wrong.push(`${tpl.name} / ${s.name}: operator guidance sent to the agent`);
      if (tail.length > 20) {
        const times = s.dispatched_prompt.split(tail).length - 1;
        if (times > 1) wrong.push(`${tpl.name} / ${s.name}: description sent ${times}×`);
      }
    }
    db.prepare("UPDATE workflows SET status = 'cancelled' WHERE id = ?").run(runId);
  }
  assert.ok(checked >= 6, `expected the six workflowContext templates at least, checked ${checked}`);
  assert.deepEqual(wrong, [], wrong.join('\n'));
});
