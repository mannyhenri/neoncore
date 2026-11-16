// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { tickWorkflowsOnce, executorSettled } from '../src/lib/workflow-executor-v2.ts';
import { learningsContext } from '../src/lib/workflow-from-template.ts';
import { DEP_RESULT_MAX_CHARS } from '../src/lib/context-budget.ts';
import { startWorkflowApp, stepsOf, verified, type WorkflowApp } from './helpers/workflow-app.ts';

/**
 * WHAT THE NEXT STEP SEES OF AN ANSWER.
 *
 * A dependency's result was forwarded as its first 1,500 chars. The webhook adds ~150 chars to
 * every stored result (the `NEXT:` hand-off on top, the scope/verify block at the end), so even a
 * 1,500-char answer was cut — and the cut removed the END, which is where an agent states its
 * conclusion. 192 of the catalogue's results were cut that way.
 *
 * Now: a long result keeps its head AND its tail, says how much was dropped and where the whole
 * text is; a work step is not sent the previous step's verification block (a gate still is — it
 * audits it). And the "learnings" a later run of the same workflow is given are one line per
 * step, cut at line boundaries, instead of a 600-char slice of the first step's output.
 *
 * SET-BASED over the consumers (work step, quality gate, review gate) and the two sizes (under
 * and over the cap). Run on an engine the session ledger does not track, so the result is
 * forwarded as text rather than referred to.
 */

let app: WorkflowApp;
before(async () => {
  app = await startWorkflowApp('response-agent');
  db.prepare("UPDATE agents SET agent_type = 'codex' WHERE id = ?").run(app.agent);
});
after(() => app.close());

const CONCLUSION = 'CONCLUSION: the refund path double-applies the coupon.';

async function runPair(consumerType: 'claude-code' | 'quality-gate' | 'review-gate', bodyChars: number): Promise<{ prompt: string; producerId: string }> {
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  const created = await app.post('/api/workflows/v2/create', {
    name: `pair-${consumerType}-${bodyChars}`, skipStandardGate: true, skipReportStep: true,
    steps: [
      { id: 'p', name: 'Producer', executorConfig: { prompt: 'Investigate.', includeDepOutput: true } },
      { id: 'c', name: 'Consumer', dependsOn: ['p'], executorType: consumerType,
        executorConfig: { prompt: 'Act on it.', gateType: 'test', criteria: 'correct', includeDepOutput: true } },
    ],
  });
  const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent });
  const runId = start.json.workflow.id as string;
  tickWorkflowsOnce();
  const producer = stepsOf(runId).find((s) => s.name === 'Producer')!;
  const result = `HEADLINE: found it.\n${'detail line about the ledger\n'.repeat(Math.ceil(bodyChars / 29))}${CONCLUSION}`;
  const res = await app.post(`/api/workflows/webhook/${producer.id}/complete`, verified(result, { next: 'Fix the coupon path.' }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  tickWorkflowsOnce();
  const consumer = stepsOf(runId).find((s) => s.name === 'Consumer')!;
  return { prompt: consumer.dispatched_prompt, producerId: producer.id };
}

for (const consumer of ['claude-code', 'quality-gate', 'review-gate'] as const) {
  test(`${consumer}: a long answer arrives with its head, its conclusion, and where the rest is`, async () => {
    const { prompt, producerId } = await runPair(consumer, 4000);
    assert.match(prompt, /NEXT: Fix the coupon path\./, 'the hand-off was lost');
    assert.match(prompt, /HEADLINE: found it\./, 'the head was lost');
    assert.ok(prompt.includes(CONCLUSION), 'the conclusion at the END of the answer was cut');
    const note = /…\[(\d+) chars omitted — full text: [^\]]*?(\/api\/workflows\/steps\/[^/\s"]+\/result)/.exec(prompt);
    assert.ok(note, 'the cut does not say what was dropped or where the whole text is');
    assert.equal(note![2], `/api/workflows/steps/${producerId}/result`);
    const full = await (await fetch(`${app.base}${note![2]}`)).text();
    assert.ok(full.length > 4000 && full.includes(CONCLUSION));
    const section = prompt.slice(prompt.indexOf('[Output from previous step: "Producer"]'));
    const forwarded = section.slice(0, section.indexOf(consumer === 'claude-code' ? 'Act on it.' : '\n\n', 40));
    assert.ok(forwarded.length < DEP_RESULT_MAX_CHARS + 200, `forwarded ${forwarded.length} chars — the cap no longer holds`);
  });

  test(`${consumer}: a short answer arrives whole${consumer === 'claude-code' ? ', without the verification block' : ', verification block included (a gate audits it)'}`, async () => {
    const { prompt } = await runPair(consumer, 200);
    assert.ok(prompt.includes(CONCLUSION));
    assert.doesNotMatch(prompt, /chars omitted/);
    if (consumer === 'claude-code') assert.doesNotMatch(prompt, /\nverify: npm test/, 'a work step was sent the previous step\'s verification block');
    else assert.match(prompt, /\nverify: npm test → 12 passed/, 'a gate lost the evidence it audits');
  });
}

test('learnings a later run receives are one line per step, never cut mid-sentence', async () => {
  // The previous test's consumer step is still running on this cartridge, which would hold ours.
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, primary_repo, created_at, updated_at) VALUES ('lp', 'L', '/tmp/l', ?, ?)`).run(now, now);
  const created = await app.post('/api/workflows/v2/create', {
    name: 'learning-run', skipStandardGate: true, skipReportStep: true,
    steps: [
      { id: 'a', name: 'Investigate', executorConfig: { prompt: 'Look.' } },
      { id: 'b', name: 'Capture', dependsOn: ['a'], executorType: 'connector', executorConfig: { connectorType: 'capture-learnings' } },
    ],
  });
  const tplId = created.json.workflow.id as string;
  const start = await app.post(`/api/workflows/v2/${tplId}/start`, { agentId: app.agent, projectId: 'lp' });
  const runId = start.json.workflow.id as string;
  tickWorkflowsOnce();
  const inv = stepsOf(runId).find((s) => s.name === 'Investigate')!;
  await app.post(`/api/workflows/webhook/${inv.id}/complete`, verified(`Root cause is the coupon order.\n${'noise '.repeat(400)}`, { next: 'Fix it.' }));
  tickWorkflowsOnce();
  await executorSettled();   // the connector finishes asynchronously
  const stored = (db.prepare('SELECT content FROM project_learnings WHERE workflow_id = ?').get(runId) as { content: string }).content;
  assert.match(stored, /^- Investigate: Root cause is the coupon order\.$/m, stored);
  assert.doesNotMatch(stored, /noise noise/, 'the learning is still a slice of raw output');

  // A long learning injected into a later run is cut at a line, never mid-line.
  db.prepare(`INSERT INTO project_learnings (id, project_id, workflow_id, workflow_name, content, tags, created_at) VALUES ('l2', 'lp', ?, 'learning-run', ?, '[]', ?)`)
    .run(runId, Array.from({ length: 30 }, (_, i) => `- Step ${i}: a complete sentence about step ${i}.`).join('\n'), new Date(Date.now() + 1000).toISOString());
  const ctx = learningsContext('lp', tplId);
  for (const line of ctx.split('\n').filter((l) => l.startsWith('- Step'))) {
    assert.match(line, /^- Step \d+: a complete sentence about step \d+\.$/, `cut mid-line: "${line}"`);
  }
});
