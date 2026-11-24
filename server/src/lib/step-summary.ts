import db from '../db.js';

/**
 * A run's step summary — the one implementation behind GET /api/workflows, GET .../v2/:id/runs and
 * the `workflow_updated` socket emit (there used to be two copies). `runningAgentIds` names who is
 * running a step right now, so the run card can show that agent's background work instead of
 * looking stalled (test/step-summary.test.ts).
 */
export interface StepSummary {
  total: number;
  completed: number;
  running: number;
  failed: number;
  pending: number;
  stepNames: string[];
  projects: string[];
  runningAgentIds: string[];
}

export function buildStepSummary(workflowId: string): StepSummary | null {
  const stepRows = db.prepare(
    'SELECT name, status, executor_id, dispatch_agent_id FROM workflow_steps WHERE workflow_id = ? ORDER BY created_at'
  ).all(workflowId) as { name: string; status: string; executor_id: string; dispatch_agent_id: string | null }[];
  if (stepRows.length === 0) return null;

  const real = (id: string | null | undefined) => !!id && id !== '__deferred__';
  const executorIds = [...new Set(stepRows.map((s) => s.executor_id).filter(real))];
  let projects: string[] = [];
  if (executorIds.length > 0) {
    const placeholders = executorIds.map(() => '?').join(',');
    const agentRows = db.prepare(`SELECT repo_name, name FROM agents WHERE id IN (${placeholders})`)
      .all(...executorIds) as { repo_name: string; name: string }[];
    projects = [...new Set(agentRows.map((r) => r.repo_name || r.name).filter(Boolean))];
  }
  // The agent a running step was typed into: its dispatch agent, else the step's own executor.
  const runningAgentIds = [...new Set(stepRows
    .filter((s) => s.status === 'running')
    .map((s) => (real(s.dispatch_agent_id) ? s.dispatch_agent_id! : s.executor_id))
    .filter(real))];

  const count = (status: string) => stepRows.filter((s) => s.status === status).length;
  return {
    total: stepRows.length,
    completed: count('completed'),
    running: count('running'),
    failed: count('failed'),
    pending: count('pending'),
    stepNames: stepRows.map((s) => s.name),
    projects,
    runningAgentIds,
  };
}
