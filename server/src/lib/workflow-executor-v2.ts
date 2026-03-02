/**
 * Workflow V2 Executor — Canvas step-based workflows
 *
 * Polls running V2 workflows and executes steps based on dependency resolution.
 * Steps at the same level run in parallel; sequential steps wait for dependencies.
 * Every step dispatches a natural language command to a Claude Code agent.
 * The agent handles MCP tool selection natively via its own MCP server config.
 */
import db from '../db.js';
import { getIO } from '../ws.js';
import { sendCommandToAgent } from './send-command.js';
import type { WorkflowStep, StepLogType } from '../types.js';

const POLL_INTERVAL_MS = 12_000;
/** Minimum time (ms) a step must be running before idle-detection can auto-complete it.
 *  This prevents the race condition where the agent hasn't picked up the command yet. */
const MIN_RUNNING_BEFORE_COMPLETE_MS = 60_000;

/** Expert role prompt prefixes — keyed by role ID */
const ROLE_PROMPTS: Record<string, string> = {
  general: '',
  architect: 'You are a senior software architect. Analyze the system, identify key components, design the implementation plan, and define clear interfaces between modules. Provide a structured breakdown with rationale for each decision.\n\n',
  backend: 'You are a backend specialist. Implement server-side logic, APIs, database interactions, and ensure proper error handling and validation. Follow existing patterns and conventions in the codebase.\n\n',
  frontend: 'You are a frontend specialist. Build UI components with clean, accessible markup, proper state management, and responsive design. Match the existing visual style and component patterns.\n\n',
  reviewer: 'You are a senior code reviewer. Identify up to 5 concrete improvements ranked by impact. Focus on non-obvious issues like race conditions, edge cases, architectural concerns, and maintainability. Be specific with file paths and line numbers.\n\n',
  security: 'You are a security expert. Examine for injection risks, authentication issues, credential exposure, insecure defaults, and OWASP top 10 vulnerabilities. Flag any sensitive data handling concerns.\n\n',
  tester: 'You are a QA engineer. Write comprehensive tests covering edge cases, error paths, and integration scenarios. Ensure tests are deterministic, maintainable, and provide good coverage of the specified functionality.\n\n',
  performance: 'You are a performance expert. Identify N+1 queries, blocking operations, memory leaks, unnecessary re-renders, bundle size issues, and hot-path bottlenecks. Suggest concrete optimizations with expected impact.\n\n',
  researcher: 'You are a research analyst. Investigate thoroughly, compare approaches, evaluate trade-offs, and provide well-sourced recommendations. Present findings in a structured format with clear conclusions.\n\n',
  planner: '[PLAN MODE] You are a technical planner. Analyze requirements and create a detailed, step-by-step implementation plan with clear milestones, dependencies, and acceptance criteria.\n\n',
};

function normalizeStep(row: Record<string, unknown>): WorkflowStep {
  return {
    id: row.id as string,
    workflowId: row.workflow_id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    positionX: row.position_x as number,
    positionY: row.position_y as number,
    executorType: row.executor_type as WorkflowStep['executorType'],
    executorId: (row.executor_id as string) || '',
    executorConfig: JSON.parse((row.executor_config as string) || '{}'),
    autoAdvance: (row.auto_advance as number) === 1,
    status: (row.status as WorkflowStep['status']) || 'pending',
    result: (row.result as string) || '',
    error: (row.error as string) || '',
    dependsOn: JSON.parse((row.depends_on as string) || '[]'),
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
  };
}

function emitStepUpdate(stepId: string) {
  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as Record<string, unknown> | undefined;
  if (row) getIO().emit('workflow_step_updated', normalizeStep(row));
}

function emitStepLog(
  workflowId: string,
  stepId: string,
  stepName: string,
  message: string,
  type: StepLogType = 'info',
) {
  getIO().emit('workflow_step_log', {
    workflowId, stepId, stepName, message, type,
    timestamp: new Date().toISOString(),
  });
}

function getAgentName(agentId: string): string {
  const row = db.prepare('SELECT repo_name, name FROM agents WHERE id = ?')
    .get(agentId) as { repo_name: string; name: string } | undefined;
  return row?.repo_name || row?.name || agentId.slice(0, 8);
}

/** Collect result text from all dependency steps */
function gatherDependencyContext(step: WorkflowStep): string {
  if (step.dependsOn.length === 0) return '';

  const parts: string[] = [];
  for (const depId of step.dependsOn) {
    const depRow = db.prepare('SELECT name, result FROM workflow_steps WHERE id = ?').get(depId) as { name: string; result: string } | undefined;
    if (depRow?.result) {
      parts.push(`[Result from "${depRow.name}"]\n${depRow.result}`);
    }
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') + '\n\n' : '';
}

async function executeStep(step: WorkflowStep): Promise<void> {
  const now = new Date().toISOString();
  db.prepare('UPDATE workflow_steps SET status = ?, started_at = ? WHERE id = ?')
    .run('running', now, step.id);
  emitStepUpdate(step.id);
  emitStepLog(step.workflowId, step.id, step.name, 'Step execution started', 'info');

  if (!step.executorId) {
    throw new Error('Step requires an agent ID');
  }

  const context = gatherDependencyContext(step);
  const prompt = (step.executorConfig.prompt as string) || step.description || step.name;

  // Resolve expert role: new role field → legacy mode → legacy executorType → general
  let role = (step.executorConfig.role as string) || '';
  if (!role) {
    const mode = (step.executorConfig.mode as string) || '';
    if (mode === 'plan' || step.executorType === 'claude-plan') role = 'planner';
    else if (mode === 'review' || step.executorType === 'claude-review') role = 'reviewer';
    else role = 'general';
  }

  const rolePrefix = ROLE_PROMPTS[role] ?? '';

  // If the step waits for a webhook, append instructions so the agent calls it when done
  let webhookSuffix = '';
  if (step.executorConfig.waitForWebhook) {
    const port = process.env.PORT || '4040';
    webhookSuffix = `\n\nIMPORTANT: When you have fully completed this task, you MUST signal completion by running this command:\ncurl -s -X POST http://localhost:${port}/api/workflows/webhook/${step.id}/complete -H 'Content-Type: application/json' -d '{"result": "Done"}'\nDo NOT call this webhook until all work is finished. This step will remain in a "running" state until the webhook is called.`;
  }

  const finalPrompt = context + rolePrefix + prompt + webhookSuffix;

  try {
    const agentName = getAgentName(step.executorId);
    const roleLabel = role === 'general' ? 'general' : role;
    emitStepLog(step.workflowId, step.id, step.name, `Dispatching [${roleLabel}] command to agent "${agentName}"`, 'info');

    // Log what components are included in the final prompt
    const parts: string[] = [];
    if (context) parts.push('dependency context');
    if (rolePrefix) parts.push(`${roleLabel} role prefix`);
    parts.push('prompt');
    if (webhookSuffix) parts.push('webhook callback');
    emitStepLog(step.workflowId, step.id, step.name, `Prompt composed: ${parts.join(' + ')} (${finalPrompt.length} chars)`, 'info');

    console.log(`[workflow-v2] Step "${step.name}" prompt (${finalPrompt.length} chars): role=${role}, webhook=${!!step.executorConfig.waitForWebhook}, deps=${step.dependsOn.length}`);

    sendCommandToAgent(step.executorId, finalPrompt);

    if (step.executorConfig.waitForWebhook) {
      emitStepLog(step.workflowId, step.id, step.name, `Waiting for webhook callback to complete this step (POST /workflows/webhook/${step.id}/complete)`, 'warn');
    }

    // Agent steps complete asynchronously when the agent goes idle (detected in processWorkflow)
    return;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedAt = new Date().toISOString();
    db.prepare('UPDATE workflow_steps SET status = ?, error = ?, completed_at = ? WHERE id = ?')
      .run('failed', errMsg, failedAt, step.id);
    emitStepUpdate(step.id);
    emitStepLog(step.workflowId, step.id, step.name, `Failed: ${errMsg}`, 'error');
    console.error(`[workflow-v2] Step "${step.name}" failed: ${errMsg}`);
  }
}

function processWorkflow(workflowId: string) {
  const steps = (db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as Record<string, unknown>[])
    .map(normalizeStep);

  if (steps.length === 0) return;

  // Auto-complete running steps when the assigned agent goes idle.
  // This bridges the gap: agent finishes work → goes idle → workflow detects completion.
  // Steps with waitForWebhook skip this — they complete only via the webhook endpoint.
  for (const step of steps) {
    if (step.status !== 'running') continue;
    if (!step.executorId) continue;

    // If the step is waiting for an external webhook, don't auto-complete on agent idle
    if (step.executorConfig.waitForWebhook) continue;

    // Don't auto-complete steps that just started — the agent may not have picked up
    // the command yet. Wait at least MIN_RUNNING_BEFORE_COMPLETE_MS before checking idle.
    if (step.startedAt) {
      const elapsed = Date.now() - new Date(step.startedAt).getTime();
      if (elapsed < MIN_RUNNING_BEFORE_COMPLETE_MS) continue;
    }

    const agent = db.prepare('SELECT status, last_message FROM agents WHERE id = ?')
      .get(step.executorId) as { status: string; last_message: string } | undefined;

    if (agent && agent.status === 'idle') {
      const now = new Date().toISOString();
      const result = agent.last_message || 'Step completed (agent idle)';
      db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
        .run('completed', result, now, step.id);
      emitStepUpdate(step.id);
      if (step.autoAdvance) {
        emitStepLog(workflowId, step.id, step.name, 'Auto-completed (agent went idle)', 'success');
      } else {
        emitStepLog(workflowId, step.id, step.name, 'Step completed — waiting for manual advance before continuing', 'warn');
      }
      console.log(`[workflow-v2] Step "${step.name}" auto-completed (agent ${step.executorId} idle)`);
    }
  }

  // Re-read steps after possible completions
  const currentSteps = (db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as Record<string, unknown>[])
    .map(normalizeStep);

  // Check for ready steps: all dependencies completed + auto-advanced + step is pending
  const readySteps = currentSteps.filter((step) => {
    if (step.status !== 'pending') return false;

    if (step.dependsOn.length === 0) return true; // No deps → always ready

    for (const depId of step.dependsOn) {
      const dep = currentSteps.find((s) => s.id === depId);
      if (!dep) {
        console.log(`[workflow-v2] Step "${step.name}" blocked: dependency ${depId.slice(0, 8)} not found in step list`);
        emitStepLog(workflowId, step.id, step.name, `Blocked: dependency ID ${depId.slice(0, 8)}... not found`, 'warn');
        return false;
      }

      if (dep.status !== 'completed') {
        return false; // Normal — dep still in progress
      }

      // If the dependency has autoAdvance off, block until manually advanced
      if (!dep.autoAdvance) return false;
    }
    return true;
  });

  // Execute all ready steps in parallel
  for (const step of readySteps) {
    emitStepLog(workflowId, step.id, step.name, `Dependencies satisfied — dispatching step`, 'info');
    executeStep(step).catch((err) => {
      console.error(`[workflow-v2] Unhandled error in step "${step.name}": ${err}`);
    });
  }

  // Check if all steps are done (completed, failed, or skipped)
  const terminalStatuses = ['completed', 'failed', 'skipped'];
  const allDone = currentSteps.every((s) => terminalStatuses.includes(s.status));
  if (allDone) {
    const hasFailed = currentSteps.some((s) => s.status === 'failed');
    const finalStatus = hasFailed ? 'failed' : 'completed';
    const now = new Date().toISOString();
    db.prepare('UPDATE workflows SET status = ?, completed_at = ? WHERE id = ?')
      .run(finalStatus, now, workflowId);
    emitStepLog(workflowId, '', 'Workflow', `Workflow ${finalStatus}`, finalStatus === 'completed' ? 'success' : 'error');
    console.log(`[workflow-v2] Workflow ${workflowId} ${finalStatus}`);
  } else {
    // Log pending steps summary for debugging
    const pending = currentSteps.filter((s) => s.status === 'pending');
    const running = currentSteps.filter((s) => s.status === 'running');
    if (pending.length > 0 || running.length > 0) {
      console.log(`[workflow-v2] Workflow ${workflowId.slice(0, 8)}: ${running.length} running, ${pending.length} pending`);
    }
  }
}

function tick() {
  // Find running V2 workflows (those with steps in workflow_steps table)
  const runningWorkflows = db.prepare(
    "SELECT DISTINCT w.id FROM workflows w INNER JOIN workflow_steps ws ON ws.workflow_id = w.id WHERE w.status = 'running'"
  ).all() as { id: string }[];

  for (const { id } of runningWorkflows) {
    processWorkflow(id);
  }
}

export function startWorkflowExecutorV2() {
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[workflow-v2] Executor started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
}
