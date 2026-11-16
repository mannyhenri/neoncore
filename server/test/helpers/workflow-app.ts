/**
 * The workflows router on a real port, plus a connected fake cartridge — for tests that must go
 * through the COMPLETION WEBHOOK the way an agent does, not around it.
 *
 * Calling completeStepFromSignal directly skips everything the webhook does to a result before
 * the executor sees it (the `next` hand-off moved to line 1, the scope/verify block appended,
 * the plan prefix). A loop test that skipped it passed while the real path was broken.
 */
import express from 'express';
import type { Server } from 'node:http';
import db from '../../src/db.ts';
import workflowsRouter from '../../src/routes/workflows.ts';
import { installStubIO } from './stub-io.ts';

export interface WorkflowApp {
  base: string;
  agent: string;
  post(route: string, body: unknown): Promise<{ status: number; json: any }>;
  put(route: string, body: unknown): Promise<{ status: number; json: any }>;
  close(): void;
}

export async function startWorkflowApp(agent = 'wf-app-agent'): Promise<WorkflowApp> {
  const io = installStubIO();
  io.connect(agent);
  db.prepare(`INSERT OR REPLACE INTO agents
      (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
      VALUES (?, 'box/app-repo', 'box', '/tmp/app-repo', 'app-repo', 'idle', ?, 'sess-app', 'claude')`)
    .run(agent, new Date().toISOString());

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/workflows', workflowsRouter);
  let server!: Server;
  const base = await new Promise<string>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  const send = async (method: string, route: string, body: unknown) => {
    const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  };
  return {
    base, agent,
    post: (route, body) => send('POST', route, body),
    put: (route, body) => send('PUT', route, body),
    close: () => server.close(),
  };
}

export interface StepRow { id: string; name: string; status: string; executor_type: string; executor_config: string; depends_on: string; result: string; dispatched_prompt: string; auto_advance: number }

export function stepsOf(workflowId: string): StepRow[] {
  return db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y, position_x').all(workflowId) as StepRow[];
}

export function stepNamed(workflowId: string, name: string): StepRow {
  const s = stepsOf(workflowId).find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in ${workflowId}`);
  return s;
}

export function templateIdNamed(name: string): string {
  const r = db.prepare('SELECT id FROM workflows WHERE name = ? AND template_id IS NULL').get(name) as { id: string } | undefined;
  if (!r) throw new Error(`no template "${name}"`);
  return r.id;
}

/** What a well-behaved work step reports: result plus the work-standard fields. */
export const verified = (result: string, extra: Record<string, unknown> = {}) => ({
  result, scope: '1/1', verify: 'npm test → 12 passed', deferred: 'none', ...extra,
});
