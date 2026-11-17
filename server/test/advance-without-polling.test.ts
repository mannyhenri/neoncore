// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.ts';
import conferRouter from '../src/routes/confer.ts';
import { setImmediateAdvance, executorSettled } from '../src/lib/workflow-executor-v2.ts';
import { loopCountRequirements } from '../src/lib/workflow-loop.ts';
import { countsOwed } from '../src/lib/coverage-loop.ts';
import { startWorkflowApp, stepsOf, verified, type WorkflowApp } from './helpers/workflow-app.ts';

/**
 * A RUN NEVER WAITS FOR THE POLL WHEN SOMETHING HAS ALREADY UNBLOCKED IT.
 *
 * Every transition used to wait for the executor's 12-second poll: a step's successors, each
 * connector in a chain, a gate's retry, the first step after launch. Measured over the seeded
 * catalogue: 242 polls, ~24 minutes of average idle per pass, for work that was ready the moment
 * the previous step reported.
 *
 * The strongest form of the rule, tested here: with immediate advance on (as in production), every
 * seeded template runs to completion WITHOUT A SINGLE CALL to the poll — driven only by what
 * agents and people do (completion webhook, confer milestone reports, decide, advance). If any
 * transition still depended on the poll, its run would stop and this test would see it.
 * SET-BASED over every template; happy path and a gate that fails once.
 */

let app: WorkflowApp;
let conferBase = '';
let conferServer: Server;
const SECOND = 'advance-agent-2';

before(async () => {
  app = await startWorkflowApp('advance-agent');
  db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, 'box/app-repo-2', 'box', '/tmp/app-repo-2', 'app-repo-2', 'idle', ?, 'sess-2', 'codex')`).run(SECOND, new Date().toISOString());
  const { installStubIO } = await import('./helpers/stub-io.ts');
  const io = installStubIO();
  io.connect(app.agent);
  io.connect(SECOND);
  const ex = express(); ex.use(express.json()); ex.use('/api/confer', conferRouter);
  conferBase = await new Promise<string>((r) => { conferServer = ex.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(conferServer.address() as { port: number }).port}`)); });
  setImmediateAdvance(true);
});
after(() => { setImmediateAdvance(false); app.close(); conferServer?.close(); });

// Wait until the engine has done everything it will do on its own — not a guessed number of
// event-loop turns, which read a connector finishing a moment later as a stall.
const settle = () => executorSettled();

async function driveWithoutPolling(templateId: string, failGateOnce: boolean): Promise<string> {
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  const needsConfer = stepsOf(templateId).some((s) => s.executor_type === 'confer');
  const start = await app.post(`/api/workflows/v2/${templateId}/start`, needsConfer
    ? { conferAllSteps: [app.agent, SECOND], initialContext: 'x' }
    : { agentId: app.agent, initialContext: 'x' });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const runId = start.json.workflow.id as string;
  const answered = new Set<string>();
  const judged = new Set<string>();

  for (let guard = 0; guard < 300; guard++) {
    await settle();
    const status = (db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status: string }).status;
    if (status !== 'running') return status;
    const all = stepsOf(runId);
    let acted = false;
    for (const s of all) {
      const cfg = JSON.parse(s.executor_config);
      if (s.status === 'completed' && !s.auto_advance && all.some((d) => d.status === 'pending' && JSON.parse(d.depends_on).includes(s.id))) {
        await app.post(`/api/workflows/v2/${runId}/steps/${s.id}/advance`, {}); acted = true; continue;
      }
      if (s.status !== 'running') continue;
      if (s.executor_type === 'decision') {
        await app.post(`/api/workflows/v2/${runId}/steps/${s.id}/decide`, { optionId: cfg.options[0].id }); acted = true; continue;
      }
      if (s.executor_type === 'confer') {
        const session = db.prepare('SELECT status, current_milestone, participant_ids FROM confer_sessions WHERE id = ?').get(cfg.conferSessionId ?? '') as { status: string; participant_ids: string } | undefined;
        if (!session || session.status !== 'running') continue;
        for (const p of JSON.parse(session.participant_ids) as string[]) {
          const r = await fetch(`${conferBase}/api/confer/${cfg.conferSessionId}/milestone/${p}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'done' }) });
          if (r.ok) acted = true;
        }
        continue;
      }
      const key = `${s.id}:${s.dispatched_prompt.slice(0, 60)}`;
      if (answered.has(key)) continue;
      answered.add(key);
      acted = true;
      if (s.executor_type.endsWith('gate')) {
        const fail = failGateOnce && !judged.has(s.id);
        judged.add(s.id);
        await app.post(`/api/workflows/webhook/${s.id}/complete`, { result: fail ? 'FAIL\nnot yet' : 'PASS\nok' });
        continue;
      }
      // Every count this step owes — counts other steps read from it, and a coverage step's own.
      const owed = countsOwed({ name: s.name, config: cfg }, loopCountRequirements(s.name, all.map((x) => ({ name: x.name, config: JSON.parse(x.executor_config) }))));
      const k = Number(cfg._currentLoop) || 1;
      const lines = [cfg.loopCountFrom ? `DONE T-${k} · ${Math.max(0, 2 - k)} remaining` : `${s.name} done`,
        ...owed.map((o) => o.pattern.replace(/\(\\d\+\)/g, '2').replace(/\\s[*+]/g, ' ').replace(/(.)\?/g, '$1').replace(/\\(.)/g, '$1'))];
      await app.post(`/api/workflows/webhook/${s.id}/complete`, verified(lines.join('\n')));
    }
    if (!acted) {
      const stuck = stepsOf(runId).filter((x) => x.status === 'running' || x.status === 'pending').map((x) => `${x.name}:${x.status}`);
      return `stalled without a poll (${stuck.slice(0, 4).join(', ')})`;
    }
  }
  return 'guard exhausted';
}

const templates = () => db.prepare('SELECT id, name FROM workflows WHERE template_id IS NULL').all() as Array<{ id: string; name: string }>;

for (const failGateOnce of [false, true]) {
  test(`every seeded template completes without one executor poll${failGateOnce ? ' — with each gate failing once' : ''}`, async () => {
    const wrong: string[] = [];
    for (const t of templates()) {
      const status = await driveWithoutPolling(t.id, failGateOnce);
      // A zero-retry terminal gate is MEANT to end the run on its first FAIL.
      const terminal = failGateOnce && stepsOf(t.id).some((s) => JSON.parse(s.executor_config).terminalOnFail && JSON.parse(s.executor_config).maxRetries === 0);
      if (status !== (terminal ? 'failed' : 'completed')) wrong.push(`${t.name}: ${status}`);
    }
    assert.deepEqual(wrong, []);
  });
}
