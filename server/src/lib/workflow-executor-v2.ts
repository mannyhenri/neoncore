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
import type { WorkflowStep, StepLogType, WorkflowStatus } from '../types.js';
import { execFileSync } from 'child_process';
import { pushNotify } from './push-notify.js';
import { notifyWorkflowFinished, sendPushToAll } from './expo-push.js';
import { DEP_RESULT_MAX_CHARS, DEP_TOTAL_MAX_CHARS } from './context-budget.js';
import { getServerBaseUrl } from './server-url.js';
import { createWorktree } from './worktree.js';

const POLL_INTERVAL_MS = 12_000;

/**
 * A step completes ONLY when its agent explicitly says so.
 *
 * This used to infer completion from agent status === 'idle'. That was wrong and it
 * corrupted results: 'idle' means "no hook has fired for IDLE_THRESHOLD_MS" (see
 * index.ts), and hooks only fire *after a tool returns*. An agent running one long
 * operation — a test suite, a build, a big grep, or parked on a permission prompt —
 * emits nothing and gets marked idle *while it is still working*. The executor then
 * completed the step and harvested the last assistant message, so a review gate would
 * parse PASS/FAIL out of mid-work chatter like "Let me check the files...".
 *
 * Every dispatched prompt now carries a completion instruction, and the step stays
 * `running` until the agent calls it. Silence is never a completion signal.
 */
function buildCompletionSuffix(stepId: string): string {
  const baseUrl = getServerBaseUrl();
  return `\n\nIMPORTANT: When you have fully completed this task, you MUST signal completion. Preferred: call the \`neoncore_report_step_done\` tool with step_id="${stepId}" and a \`result\` summarizing what you did and what the next step should focus on.\nIf that tool is not available, instead run:\ncurl -s -X POST "\${NEONCORE_URL:-${baseUrl}}/api/workflows/webhook/${stepId}/complete" -H 'Content-Type: application/json' -d '{"result": "<Summarize what you did and what the next step should focus on>"}'\nDo NOT signal completion until all work is finished. This step will remain in a "running" state until you signal.`;
}

/**
 * Panel members in a deliberation each report against the SAME step, so they need a
 * per-agent channel — otherwise the first one to answer would complete the step for
 * everyone. Their verdicts land in executor_config.panelResults[agentId].
 */
function buildPanelCompletionSuffix(stepId: string, agentId: string): string {
  const baseUrl = getServerBaseUrl();
  return `\n\nIMPORTANT: When you have fully finished, you MUST submit your response by running:\ncurl -s -X POST "\${NEONCORE_URL:-${baseUrl}}/api/workflows/webhook/${stepId}/panel/${agentId}/complete" -H 'Content-Type: application/json' -d '{"result": "<your full response>"}'\nYou are one member of a panel; the deliberation cannot advance until you submit. Do NOT submit until your work is finished.`;
}

/**
 * Dispatch a step's command and FAIL THE STEP if it went nowhere.
 *
 * Previously a command sent to a cartridge with no relay/extension socket was queued as
 * 'pending' into the void, and the step sat `running` forever with no error — the workflow
 * cheerfully reported itself as in-progress while nothing was listening. A step whose
 * command was never delivered is a failed step, and it says so.
 *
 * Returns false if delivery failed (the step has already been marked failed).
 */
function dispatchStepCommand(step: WorkflowStep, agentId: string, text: string, includeMemory: boolean): boolean {
  // Branch-per-step: if a worktree was created for this step, tell the agent to work
  // there so parallel steps on one repo don't clobber each other's files.
  const wt = step.executorConfig?._worktreePath;
  const branch = step.executorConfig?.branch;
  const finalText = typeof wt === 'string' && wt
    ? `A dedicated git worktree was created for this step at:\n  ${wt}\n`
      + `Run \`cd "${wt}"\` first and make ALL changes there`
      + (typeof branch === 'string' && branch ? ` (branch \`${branch}\`)` : '')
      + `.\n\n${text}`
    : text;

  const command = sendCommandToAgent(agentId, finalText, includeMemory);

  if (!command || command.delivered === false) {
    const reason = !command
      ? `agent ${agentId} not found`
      : `no command channel for "${getAgentName(agentId)}" — nothing is listening (start a relay for that cartridge)`;
    const now = new Date().toISOString();
    db.prepare('UPDATE workflow_steps SET status = ?, error = ?, completed_at = ? WHERE id = ?')
      .run('failed', `Command not delivered: ${reason}`, now, step.id);
    emitStepUpdate(step.id);
    emitStepLog(step.workflowId, step.id, step.name, `Command not delivered: ${reason}`, 'error');
    console.error(`[workflow-v2] Step "${step.name}" failed — ${reason}`);
    return false;
  }
  return true;
}

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

/**
 * executor_config is written as JSON by every code path, but a truncated write (the repo
 * has already been bitten by power-loss truncating settings.json) or a hand-edited row
 * would make this throw — inside a setInterval callback, which kills the process. A bad
 * config should degrade one step, not crash the orchestrator.
 */
function parseExecutorConfig(raw: string | null | undefined, stepId: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    console.error(`[workflow-v2] Step ${stepId}: executor_config is not valid JSON — treating as empty. Raw: ${String(raw).slice(0, 120)}`);
    return {};
  }
}

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
    executorConfig: parseExecutorConfig(row.executor_config as string, row.id as string),
    autoAdvance: (row.auto_advance as number) === 1,
    status: (row.status as WorkflowStep['status']) || 'pending',
    result: (row.result as string) || '',
    error: (row.error as string) || '',
    dispatchedPrompt: (row.dispatched_prompt as string) || '',
    dependsOn: JSON.parse((row.depends_on as string) || '[]'),
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
    recoveryStatus: (row.recovery_status as string) || '',
    interruptedAt: (row.interrupted_at as string) || null,
    recoveryAttempts: (row.recovery_attempts as number) || 0,
  };
}

function emitWorkflowUpdate(workflowId: string) {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as Record<string, unknown> | undefined;
  if (!row) return;
  // Compute step summary for the dashboard
  const stepRows = db.prepare('SELECT status, name, executor_id FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as { status: string; name: string; executor_id: string }[];
  const executorIds = [...new Set(stepRows.map((s) => s.executor_id).filter((id) => id && id !== '__deferred__'))];
  let projects: string[] = [];
  if (executorIds.length > 0) {
    const placeholders = executorIds.map(() => '?').join(',');
    const agentRows = db.prepare(`SELECT repo_name, name FROM agents WHERE id IN (${placeholders})`).all(...executorIds) as { repo_name: string; name: string }[];
    projects = [...new Set(agentRows.map((r) => r.repo_name || r.name).filter(Boolean))];
  }
  const stepSummary = {
    total: stepRows.length,
    completed: stepRows.filter((s) => s.status === 'completed').length,
    running: stepRows.filter((s) => s.status === 'running').length,
    failed: stepRows.filter((s) => s.status === 'failed').length,
    pending: stepRows.filter((s) => s.status === 'pending').length,
    stepNames: stepRows.map((s) => s.name),
    projects,
  };
  getIO().emit('workflow_updated', {
    id: row.id as string,
    name: (row.name ?? '') as string,
    jiraTaskId: (row.jira_task_id ?? '') as string,
    description: (row.description ?? '') as string,
    players: JSON.parse((row.players ?? '[]') as string),
    phases: JSON.parse((row.phases ?? '[]') as string),
    status: (row.status ?? 'pending') as WorkflowStatus,
    currentPhase: (row.current_phase ?? 0) as number,
    iteration: (row.iteration ?? 1) as number,
    maxIterations: (row.max_iterations ?? 3) as number,
    sharedContext: (row.shared_context ?? '') as string,
    initialContext: (row.initial_context ?? '') as string,
    createdAt: (row.created_at ?? '') as string,
    startedAt: (row.started_at ?? '') as string,
    completedAt: (row.completed_at as string) || null,
    error: (row.error ?? '') as string,
    templateId: (row.template_id as string) || null,
    runNumber: (row.run_number as number) || 0,
    stepSummary,
  });
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

/** Compose a structured intent into a formatted prompt */
function composeIntentPrompt(config: Record<string, unknown>): string {
  const intent = config.intent as {
    objective?: string;
    acceptanceCriteria?: string[];
    constraints?: string[];
    context?: string;
  } | undefined;
  if (!intent?.objective) return '';

  const parts: string[] = [`## Objective\n${intent.objective}`];
  if (intent.acceptanceCriteria?.length) {
    parts.push(`## Acceptance Criteria\n${intent.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  }
  if (intent.constraints?.length) {
    parts.push(`## Constraints\n${intent.constraints.map((c) => `- ${c}`).join('\n')}`);
  }
  if (intent.context) {
    parts.push(`## Context\n${intent.context}`);
  }
  return parts.join('\n\n');
}

/** Collect result text from all dependency steps (capped by budget) */
function gatherDependencyContext(step: WorkflowStep): string {
  if (step.dependsOn.length === 0) return '';

  const parts: string[] = [];
  for (const depId of step.dependsOn) {
    const depRow = db.prepare('SELECT name, result FROM workflow_steps WHERE id = ?').get(depId) as { name: string; result: string } | undefined;
    if (depRow?.result) {
      const truncated = depRow.result.length > DEP_RESULT_MAX_CHARS
        ? depRow.result.slice(0, DEP_RESULT_MAX_CHARS) + '...truncated'
        : depRow.result;
      parts.push(`[Output from previous step: "${depRow.name}"]\n${truncated}`);
    }
  }
  if (parts.length === 0) return '';
  let result = parts.join('\n\n---\n\n') + '\n\n';
  if (result.length > DEP_TOTAL_MAX_CHARS) {
    result = result.slice(0, DEP_TOTAL_MAX_CHARS) + '...truncated\n\n';
  }
  return result;
}

/** Memory is always included when entries exist — managed via the memory modal */
function isMemoryEnabled(_agentId: string): boolean {
  return true;
}

/** Standard step execution — dispatches prompt to agent with role prefix, memory, webhook */
async function executeStandardStep(step: WorkflowStep): Promise<void> {
  const context = step.executorConfig.includeDepOutput ? gatherDependencyContext(step) : '';
  const prompt = step.executorConfig.useIntent
    ? composeIntentPrompt(step.executorConfig)
    : (step.executorConfig.prompt as string) || step.description || step.name;

  // Resolve expert role from config, default to general
  const role = (step.executorConfig.role as string) || 'general';

  const rolePrefix = ROLE_PROMPTS[role] ?? '';

  // If workflowContext: true, prepend the workflow name + description so the agent
  // knows what feature/task it is validating (set on first steps with no deps).
  let workflowCtx = '';
  if (step.executorConfig.workflowContext) {
    const wf = db.prepare('SELECT name, description FROM workflows WHERE id = ?')
      .get(step.workflowId) as { name: string; description: string } | undefined;
    if (wf?.description) {
      workflowCtx = `## Feature Under Validation\n**${wf.name}**\n\n${wf.description}\n\n`;
    }
  }

  // For first steps (no dependencies), prepend the user-supplied initial context if present.
  let initialCtxPrefix = '';
  if (step.dependsOn.length === 0) {
    const wfRow = db.prepare('SELECT initial_context FROM workflows WHERE id = ?')
      .get(step.workflowId) as { initial_context: string } | undefined;
    const ic = wfRow?.initial_context?.trim();
    if (ic) {
      initialCtxPrefix = `## Context\n${ic}\n\n`;
    }
  }

  // Typed output format instructions
  const outputSchema = step.executorConfig.outputSchema as string | undefined;
  const OUTPUT_FORMAT_INSTRUCTIONS: Record<string, string> = {
    test_results: `\n\nOUTPUT FORMAT: After completing all work, end your response with a structured test results block (copy this format exactly):\n\n---TEST RESULTS---\nSTATUS: PASS\nPASSED: N\nFAILED: N\nFAILED_TESTS:\n- test name: error message\n---END TEST RESULTS---\n\nReplace N with actual counts. List each failed test on its own "- name: error" line. If all pass, omit FAILED_TESTS.`,
    code_review: `\n\nOUTPUT FORMAT: After completing your review, end your response with a structured code review block (copy this format exactly):\n\n---CODE REVIEW---\nSTATUS: PASS\nCRITICAL: N\nHIGH: N\nMEDIUM: N\nLOW: N\nISSUES:\n- [SEVERITY] file:line — description\n---END CODE REVIEW---\n\nSTATUS is PASS if no critical/high issues, FAIL otherwise. List each issue on its own line.`,
    design_doc: `\n\nOUTPUT FORMAT: Structure your response as a markdown design document with clear sections (## headings). Include: Overview, Problem, Solution, Architecture, Trade-offs, and Next Steps.`,
  };
  const formatSuffix = outputSchema ? (OUTPUT_FORMAT_INSTRUCTIONS[outputSchema] || '') : '';

  // Always append completion instructions so the agent signals when done. The MCP tool is
  // primary (works for agents on other machines); the curl webhook is a same-machine
  // fallback. There is no idle-detection backstop any more — see buildCompletionSuffix.
  const webhookSuffix = buildCompletionSuffix(step.id);

  const finalPrompt = initialCtxPrefix + workflowCtx + context + rolePrefix + prompt + formatSuffix + webhookSuffix;

  const agentName = getAgentName(step.executorId);
  const roleLabel = role === 'general' ? 'general' : role;
  emitStepLog(step.workflowId, step.id, step.name, `Dispatching [${roleLabel}] command to agent "${agentName}" (${step.executorId.slice(0, 8)})`, 'info');

  const parts: string[] = [];
  if (context) parts.push('dependency context');
  if (rolePrefix) parts.push(`${roleLabel} role prefix`);
  parts.push(step.executorConfig.useIntent ? 'structured intent' : 'prompt');
  if (webhookSuffix) parts.push('webhook callback');

  const includeMemory = isMemoryEnabled(step.executorId);
  if (includeMemory) parts.push('agent memory');

  emitStepLog(step.workflowId, step.id, step.name, `Prompt composed: ${parts.join(' + ')} (${finalPrompt.length} chars)`, 'info');
  console.log(`[workflow-v2] Step "${step.name}" prompt (${finalPrompt.length} chars): role=${role}, webhook=true, memory=${includeMemory}, deps=${step.dependsOn.length}`);

  db.prepare("UPDATE workflow_steps SET dispatched_prompt = ? WHERE id = ?").run(finalPrompt, step.id);
  if (!dispatchStepCommand(step, step.executorId, finalPrompt, includeMemory)) return;

  emitStepLog(step.workflowId, step.id, step.name, `Waiting for webhook callback to complete this step (POST /workflows/webhook/${step.id}/complete)`, 'warn');
}

/** Command template step — looks up a saved command template and sends its content */
async function executeCommandStep(step: WorkflowStep): Promise<void> {
  const templateId = step.executorConfig.commandTemplateId as string;
  if (!templateId) throw new Error('Command step requires a commandTemplateId in executorConfig');
  if (!step.executorId) throw new Error('Command step requires an agent ID');

  const template = db.prepare('SELECT * FROM command_templates WHERE id = ?')
    .get(templateId) as { id: string; name: string; content: string } | undefined;
  if (!template) throw new Error(`Command template "${templateId}" not found`);

  const context = step.executorConfig.includeDepOutput ? gatherDependencyContext(step) : '';

  const baseUrl = getServerBaseUrl();
  const webhookSuffix = `\n\nIMPORTANT: When you have fully completed this task, you MUST signal completion by running this command:\ncurl -s -X POST "\${NEONCORE_URL:-${baseUrl}}/api/workflows/webhook/${step.id}/complete" -H 'Content-Type: application/json' -d '{"result": "<Summarize what you did and what the next step should focus on>"}'\nDo NOT call this webhook until all work is finished. This step will remain in a "running" state until the webhook is called.`;

  const finalPrompt = context + template.content + webhookSuffix;

  const agentName = getAgentName(step.executorId);
  emitStepLog(step.workflowId, step.id, step.name,
    `Dispatching command template "${template.name}" to cartridge "${agentName}"`, 'info');

  const includeMemory = isMemoryEnabled(step.executorId);
  if (!dispatchStepCommand(step, step.executorId, finalPrompt, includeMemory)) return;

  emitStepLog(step.workflowId, step.id, step.name, `Waiting for webhook callback to complete this step`, 'warn');
}

/** Review gate step — dispatches a critic prompt to evaluate dependency outputs */
async function executeReviewGate(step: WorkflowStep): Promise<void> {
  const reviewAgentId = (step.executorConfig.reviewAgentId as string) || step.executorId;
  if (!reviewAgentId) throw new Error('Review gate requires a review agent ID');

  const depContext = gatherDependencyContext(step);
  if (!depContext) {
    emitStepLog(step.workflowId, step.id, step.name, 'Warning: No dependency results to review', 'warn');
  }

  const criteria = (step.executorConfig.criteria as string) || 'general code quality and correctness';
  const currentRetry = (step.executorConfig.currentRetry as number) || 0;
  const maxRetries = (step.executorConfig.maxRetries as number) || 3;

  const reviewPrompt = `You are a code review critic. Evaluate the following work against these criteria:\n\n**Criteria:** ${criteria}\n\n---\n${depContext || 'No dependency output available.'}\n---\n\nYou MUST respond with exactly **PASS** or **FAIL** on the FIRST line of your response.\nThen provide your detailed reasoning.\nIf FAIL, provide specific actionable feedback for improvement.\n\nRetry ${currentRetry + 1} of ${maxRetries + 1}.`
    + buildCompletionSuffix(step.id)
    + `\n\nThe \`result\` you report MUST begin with PASS or FAIL on its first line — the gate verdict is read from it.`;

  const agentName = getAgentName(reviewAgentId);
  emitStepLog(step.workflowId, step.id, step.name, `Dispatching critic review to "${agentName}" (retry ${currentRetry}/${maxRetries})`, 'info');

  db.prepare("UPDATE workflow_steps SET dispatched_prompt = ? WHERE id = ?").run(reviewPrompt, step.id);
  const includeMemory = isMemoryEnabled(reviewAgentId);
  dispatchStepCommand(step, reviewAgentId, reviewPrompt, includeMemory);
}

/** Find online agents matching a repo path */
function findOnlineAgentsForRepo(repoPath: string): string[] {
  const rows = db.prepare(
    "SELECT id FROM agents WHERE repo_path = ? AND status != 'offline'"
  ).all(repoPath) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Launch VS Code windows for a repo path */
async function launchVSCodeWindows(repoPath: string, count: number, stepName: string): Promise<void> {
  const { exec } = await import('child_process');
  for (let i = 0; i < count; i++) {
    exec(`code --new-window "${repoPath}"`, (err) => {
      if (err) console.error(`[workflow-v2] Failed to launch VS Code window ${i + 1} for "${stepName}": ${err.message}`);
    });
  }
}

/** Deliberation step — dispatch prompt to panel agents in parallel */
async function executeDeliberation(step: WorkflowStep): Promise<void> {
  const autoLaunch = !!step.executorConfig.autoLaunch;
  const repoPath = (step.executorConfig.repoPath as string) || '';
  const panelSize = (step.executorConfig.panelSize as number) || 2;

  if (autoLaunch) {
    // Auto-launch mode: find or spawn agents for the repo
    if (!repoPath) throw new Error('Auto-launch deliberation requires a repo path');

    const onlineAgents = findOnlineAgentsForRepo(repoPath);
    const needed = Math.max(0, panelSize - onlineAgents.length);

    if (needed > 0) {
      emitStepLog(step.workflowId, step.id, step.name,
        `Found ${onlineAgents.length}/${panelSize} agents for "${repoPath}" — launching ${needed} VS Code window(s)`, 'info');
      await launchVSCodeWindows(repoPath, needed, step.name);

      // Set phase to launching — poll loop will check for agents
      const updatedConfig = JSON.stringify({
        ...step.executorConfig,
        deliberationPhase: 'launching',
        launchedAt: new Date().toISOString(),
        panelResults: {},
      });
      db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
        .run(updatedConfig, step.id);
      return;
    }

    // All agents available — pick the first N and dispatch immediately
    const panelAgentIds = onlineAgents.slice(0, panelSize);
    emitStepLog(step.workflowId, step.id, step.name,
      `All ${panelSize} agents online — dispatching deliberation`, 'info');
    dispatchDeliberationPrompts(step, panelAgentIds);
    return;
  }

  // Manual mode: use pre-selected panel agent IDs
  const panelAgentIds = (step.executorConfig.panelAgentIds as string[]) || [];
  if (panelAgentIds.length < 2) throw new Error('Deliberation requires at least 2 panel agents');
  dispatchDeliberationPrompts(step, panelAgentIds);
}

/** Dispatch the deliberation prompt to panel agents and set phase to collecting */
function dispatchDeliberationPrompts(step: WorkflowStep, panelAgentIds: string[]): void {
  const context = gatherDependencyContext(step);
  const prompt = (step.executorConfig.prompt as string) || step.description || step.name;
  const fullPrompt = context + prompt;

  emitStepLog(step.workflowId, step.id, step.name, `Dispatching to ${panelAgentIds.length} panel agents for deliberation`, 'info');

  for (const agentId of panelAgentIds) {
    if (!agentId) continue;
    const agentName = getAgentName(agentId);
    const includeMemory = isMemoryEnabled(agentId);
    emitStepLog(step.workflowId, step.id, step.name, `Panel dispatch → "${agentName}"`, 'info');
    // Each panel member reports on its own channel — see buildPanelCompletionSuffix.
    dispatchStepCommand(step, agentId, fullPrompt + buildPanelCompletionSuffix(step.id, agentId), includeMemory);
  }

  // Set phase to collecting — processWorkflow will monitor panel agents
  const updatedConfig = JSON.stringify({
    ...step.executorConfig,
    panelAgentIds,
    deliberationPhase: 'collecting',
    panelResults: {},
  });
  db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
    .run(updatedConfig, step.id);
}

// ── Quality Gate Presets ──────────────────────────────────────────
// Derived from .claude/commands/ skills — these get sent as prompts to agents.
// Each preset instructs the agent to perform a quality check and respond with a verdict.

const QUALITY_GATE_PRESETS: Record<string, { label: string; prompt: string }> = {
  test: {
    label: 'Test Suite',
    prompt: `You are a QA engineer. Run the full test suite for this project.

## Step 1: Detect Test Framework
Check for package.json (vitest/jest/mocha), Cargo.toml (cargo test), pyproject.toml (pytest), go.mod (go test).

## Step 2: Run Tests
Execute the appropriate test command:
- Node (vitest): npx vitest run
- Node (jest): npx jest --verbose
- Rust: cargo test
- Python: pytest -v
- Go: go test ./... -v

## Step 3: Analyze Results
Review the output for failures, errors, and coverage.

If tests fail:
1. Determine if it's a test bug or a code bug
2. Fix the issue (prefer fixing the code if it's a real bug)
3. Re-run to verify

## Step 4: Verdict
After running tests, respond on the FIRST LINE with exactly **PASS** or **FAIL**.
- PASS: All tests pass (or failures are known/pre-existing and not related to recent changes)
- FAIL: New test failures found

Then provide a summary: how many tests ran, passed, failed, and what failed.`,
  },

  lint: {
    label: 'Lint & Type Check',
    prompt: `You are a code quality engineer. Run linting, formatting, and type checks for this project.

## Step 1: Detect Project Type
Check for package.json, Cargo.toml, pyproject.toml, go.mod.

## Step 2: Run Checks
**JavaScript/TypeScript** (if package.json):
- npx prettier --check . 2>/dev/null
- npm run lint 2>/dev/null || npx eslint . 2>/dev/null
- npx tsc --noEmit 2>/dev/null

**Rust** (if Cargo.toml):
- cargo fmt --check
- cargo clippy -- -D warnings

**Python** (if pyproject.toml):
- ruff check . 2>/dev/null || flake8 . 2>/dev/null
- ruff format --check . 2>/dev/null || black --check . 2>/dev/null
- mypy . 2>/dev/null

**Go** (if go.mod):
- go vet ./...
- gofmt -l .

## Step 3: Auto-Fix (if issues found)
Attempt auto-fix for formatting/lint issues, then re-run checks.

## Step 4: Verdict
Respond on the FIRST LINE with exactly **PASS** or **FAIL**.
- PASS: All checks pass clean (auto-fixes are OK)
- FAIL: Errors remain that couldn't be auto-fixed (type errors, unfixable lint errors)

Then list what passed, what was auto-fixed, and what still fails.`,
  },

  security: {
    label: 'Security Scan',
    prompt: `You are a security auditor. Perform a security review of the recent changes in this project.

## Step 1: Determine Scope
Check files changed since last commit:
git diff --name-only HEAD
git diff --name-only --cached
git status --porcelain

## Step 2: Secrets Scan
Search changed files for potential secrets: API keys, passwords, tokens, private keys, .env files staged for commit.

## Step 3: OWASP Vulnerability Check
Review changed files for:
- Injection (SQL, command, XSS)
- Broken auth/access control
- Data exposure (logging PII, unencrypted sensitive data)
- Path traversal
- Insecure deserialization

## Step 4: Dependency Audit
- npm audit --audit-level=high 2>/dev/null
- cargo audit 2>/dev/null
- pip-audit 2>/dev/null

## Step 5: Verdict
Respond on the FIRST LINE with exactly **PASS** or **FAIL**.
- PASS: No HIGH severity issues found
- FAIL: HIGH severity security issues found that must be addressed

Then list all findings with severity (CRITICAL/HIGH/MEDIUM/LOW).`,
  },

  'full-review': {
    label: 'Full Code Review',
    prompt: `You are a senior code reviewer. Perform a comprehensive code review of the recent changes.

## Step 1: Determine Scope
Check files changed on this branch:
git diff --name-only main...HEAD 2>/dev/null || git diff --name-only HEAD~5..HEAD

## Step 2: Lint & Format
Run appropriate linters for the project type. Auto-fix what you can.

## Step 3: Security Scan
Check for secrets, injection risks, auth issues, OWASP vulnerabilities.

## Step 4: Code Quality Review
- Identify up to 5 concrete improvements ranked by impact
- Focus on: race conditions, edge cases, architectural concerns, maintainability
- Check for missing error handling, resource leaks, performance issues

## Step 5: Test Coverage
Check if changed files have corresponding tests. Note any coverage gaps.

## Step 6: Verdict
Respond on the FIRST LINE with exactly **PASS** or **FAIL**.
- PASS: Code is production-ready (minor suggestions OK, no blocking issues)
- FAIL: Critical issues found that must be addressed before shipping

Then provide:
- Summary of issues found (blocking and non-blocking)
- Specific file:line references for each issue
- Recommended fixes`,
  },

  build: {
    label: 'Build Check',
    prompt: `You are a build engineer. Verify that this project builds successfully.

## Step 1: Detect Build System
Check for package.json (npm/yarn build), Cargo.toml (cargo build), pyproject.toml (python -m build), go.mod (go build), Makefile.

## Step 2: Run Build
Execute the appropriate build command:
- Node: npm run build
- Rust: cargo build --release
- Python: python -m build 2>/dev/null || pip install -e . 2>/dev/null
- Go: go build ./...

## Step 3: Verify
Check the build output for errors and warnings.

## Step 4: Verdict
Respond on the FIRST LINE with exactly **PASS** or **FAIL**.
- PASS: Build completes without errors
- FAIL: Build fails with errors

Then provide the build output summary.`,
  },
};

/** Quality gate step — dispatches a quality check skill to an agent, expects PASS/FAIL */
async function executeQualityGate(step: WorkflowStep): Promise<void> {
  const agentId = step.executorId;
  if (!agentId) throw new Error('Quality gate requires an agent ID');

  const gateType = (step.executorConfig.gateType as string) || 'test';
  const customPrompt = (step.executorConfig.customPrompt as string) || '';
  const currentRetry = (step.executorConfig.currentRetry as number) || 0;
  const maxRetries = (step.executorConfig.maxRetries as number) || 2;

  // Use custom prompt or preset
  const preset = QUALITY_GATE_PRESETS[gateType];
  const basePrompt = customPrompt || (preset?.prompt ?? QUALITY_GATE_PRESETS.test.prompt);

  // If this is a retry, prepend feedback from the previous failure
  const lastFeedback = (step.executorConfig.lastFeedback as string) || '';
  const feedbackBlock = lastFeedback
    ? `\n\n[FEEDBACK FROM PREVIOUS ATTEMPT — address these issues]\n${lastFeedback}\n\n---\n\n`
    : '';

  const depContext = gatherDependencyContext(step);
  const finalPrompt = depContext + feedbackBlock + basePrompt
    + buildCompletionSuffix(step.id)
    + `\n\nThe \`result\` you report MUST begin with PASS or FAIL on its first line — the gate verdict is read from it.`;

  const agentName = getAgentName(agentId);
  const gateLabel = preset?.label ?? gateType;
  emitStepLog(step.workflowId, step.id, step.name, `Dispatching quality gate [${gateLabel}] to "${agentName}" (attempt ${currentRetry + 1}/${maxRetries + 1})`, 'info');

  db.prepare("UPDATE workflow_steps SET dispatched_prompt = ? WHERE id = ?").run(finalPrompt, step.id);
  const includeMemory = isMemoryEnabled(agentId);
  dispatchStepCommand(step, agentId, finalPrompt, includeMemory);
}

/** Handle quality-gate result: PASS completes, FAIL triggers retry or fails */
function processQualityGateResult(
  workflowId: string,
  step: WorkflowStep,
  result: string,
  allSteps: WorkflowStep[],
) {
  const now = new Date().toISOString();
  const firstLine = result.trim().split('\n')[0].toUpperCase();
  const passed = firstLine.includes('PASS');
  const currentRetry = (step.executorConfig.currentRetry as number) || 0;
  const maxRetries = (step.executorConfig.maxRetries as number) || 2;
  const gateType = (step.executorConfig.gateType as string) || 'test';
  const preset = QUALITY_GATE_PRESETS[gateType];
  const gateLabel = preset?.label ?? gateType;

  if (passed) {
    db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
      .run('completed', result, now, step.id);
    emitStepUpdate(step.id);
    emitStepLog(workflowId, step.id, step.name, `Quality gate [${gateLabel}] PASSED`, 'success');
    console.log(`[workflow-v2] Quality gate "${step.name}" PASSED`);
  } else if (currentRetry < maxRetries) {
    const nextRetry = currentRetry + 1;
    emitStepLog(workflowId, step.id, step.name, `Quality gate [${gateLabel}] FAILED (retry ${nextRetry}/${maxRetries}) — re-running`, 'warn');

    const updatedConfig = JSON.stringify({
      ...step.executorConfig,
      currentRetry: nextRetry,
      lastFeedback: result,
    });
    db.prepare('UPDATE workflow_steps SET status = ?, result = ?, executor_config = ?, started_at = NULL, completed_at = NULL WHERE id = ?')
      .run('pending', '', updatedConfig, step.id);
    emitStepUpdate(step.id);

    // Also reset dependency steps so the agent can re-do the work with feedback
    for (const depId of step.dependsOn) {
      const dep = allSteps.find((s) => s.id === depId);
      if (!dep) continue;

      const updatedDepConfig = JSON.stringify({
        ...dep.executorConfig,
        retryFeedback: `[Quality gate "${gateLabel}" feedback from attempt ${nextRetry}]\n${result}`,
        prompt: dep.executorConfig.prompt
          ? `${dep.executorConfig.prompt}\n\n[QUALITY GATE FEEDBACK — please address these issues]\n${result}`
          : dep.executorConfig.prompt,
      });

      db.prepare('UPDATE workflow_steps SET status = ?, result = ?, error = ?, started_at = NULL, completed_at = NULL, executor_config = ? WHERE id = ?')
        .run('pending', '', '', updatedDepConfig, depId);
      emitStepUpdate(depId);
      emitStepLog(workflowId, depId, dep.name, `Reset for quality gate retry ${nextRetry} with feedback`, 'warn');
    }
  } else {
    db.prepare('UPDATE workflow_steps SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?')
      .run('failed', result, `Quality gate [${gateLabel}] failed after ${maxRetries} retries`, now, step.id);
    emitStepUpdate(step.id);
    emitStepLog(workflowId, step.id, step.name, `Quality gate [${gateLabel}] FAILED — retries exhausted (${maxRetries})`, 'error');
    console.log(`[workflow-v2] Quality gate "${step.name}" FAILED — retries exhausted`);
  }
}

/** Main step dispatcher — routes to the appropriate execution function */
// ─── Conditional Routing ─────────────────────────────────────────────────────

/** Evaluate a single routing condition against the step result */
function evaluateRoutingCondition(condition: string, value: string, result: string): boolean {
  switch (condition) {
    case 'contains': return result.includes(value);
    case 'not_contains': return !result.includes(value);
    case 'starts_with': return result.trimStart().startsWith(value);
    case 'matches_regex': {
      try { return new RegExp(value, 'i').test(result); } catch { return false; }
    }
    default: return false;
  }
}

/** Apply routing rules for a just-completed step. Returns the nextStepId that fired, or null. */
function applyRoutingRules(step: WorkflowStep, allSteps: WorkflowStep[]): string | null {
  const config = step.executorConfig;
  const routingRules = (config.routingRules as Array<{ id: string; condition: string; value: string; nextStepId: string }>) || [];
  if (routingRules.length === 0) return null;

  const maxCycles = (config.maxCycles as number) || 5;
  const cycleCount = (config.cycleCount as number) || 0;

  if (cycleCount >= maxCycles) {
    emitStepLog(step.workflowId, step.id, step.name, `Routing rules exhausted (max cycles ${maxCycles} reached) — normal flow proceeds`, 'warn');
    return null;
  }

  for (const rule of routingRules) {
    if (!evaluateRoutingCondition(rule.condition, rule.value, step.result)) continue;

    const targetStep = allSteps.find((s) => s.id === rule.nextStepId);
    if (!targetStep) continue;

    // Clear runtime flags on target step when resetting it
    const targetConfig = { ...targetStep.executorConfig };
    for (const key of Object.keys(targetConfig)) {
      if (key.startsWith('_')) delete targetConfig[key];
    }

    // Reset target step to pending
    db.prepare(
      'UPDATE workflow_steps SET status = ?, result = \'\', error = \'\', started_at = NULL, completed_at = NULL, executor_config = ? WHERE id = ?'
    ).run('pending', JSON.stringify(targetConfig), rule.nextStepId);

    // Increment cycle count on the routing source step
    const updatedConfig = { ...config, cycleCount: cycleCount + 1, _routingAppliedAt: step.completedAt };
    db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
      .run(JSON.stringify(updatedConfig), step.id);

    emitStepUpdate(rule.nextStepId);
    emitStepUpdate(step.id);
    emitStepLog(
      step.workflowId, step.id, step.name,
      `Routing: condition "${rule.condition} '${rule.value}'" matched — resetting "${targetStep.name}" to pending (cycle ${cycleCount + 1}/${maxCycles})`,
      'info',
    );
    console.log(`[workflow-v2] Routing fired on "${step.name}" → target "${targetStep.name}" (cycle ${cycleCount + 1}/${maxCycles})`);
    return rule.nextStepId;
  }
  return null;
}

// ─── External Connector Step ─────────────────────────────────────────────────

/** Substitute {{variable}} placeholders in a template string */
function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

/** Decision step — presents a structured choice to the human and waits.
 *  Completion happens via POST /api/workflows/v2/:id/steps/:stepId/decide. */
async function executeDecisionStep(step: WorkflowStep): Promise<void> {
  const config = step.executorConfig;
  if (!config.question) throw new Error('Decision step requires a question in executorConfig');

  emitStepLog(
    step.workflowId, step.id, step.name,
    `Decision required: "${config.question}" — waiting for human choice`,
    'info',
  );

  // Native app push — a decision gate blocks the run on a human, same as an approval.
  // Deep-links into the run so the choice can be made from the phone. Fire-and-forget.
  const wfRow = db.prepare('SELECT name, run_number FROM workflows WHERE id = ?')
    .get(step.workflowId) as { name: string; run_number: number } | undefined;
  const wfLabel = wfRow ? `${wfRow.name}${wfRow.run_number ? ` #${wfRow.run_number}` : ''}` : 'Workflow';
  sendPushToAll(
    `${wfLabel} — Decision needed`,
    String(config.question).slice(0, 300),
    { type: 'decision_gate', workflowId: step.workflowId, stepId: step.id },
  ).catch(() => {});

  // Step stays in `running` state; the /decide endpoint completes it.
}

/** Execute an external connector step (Slack, GitHub, Linear, or generic HTTP) */
async function executeConnectorStep(step: WorkflowStep): Promise<void> {
  const config = step.executorConfig;
  const connectorType = config.connectorType as string;
  if (!connectorType) throw new Error('Connector step requires connectorType in executorConfig');

  const depContext = config.includeDepOutput ? gatherDependencyContext(step) : '';
  const agentName = step.executorId ? getAgentName(step.executorId) : 'NeonCore';
  const wfRow = db.prepare('SELECT name FROM workflows WHERE id = ?').get(step.workflowId) as { name: string } | undefined;
  const workflowName = wfRow?.name || step.workflowId.slice(0, 8);

  // Collect project/cartridge names from assigned steps in this workflow
  const assignedAgents = db.prepare(
    `SELECT DISTINCT COALESCE(a.repo_name, a.name) AS label
     FROM workflow_steps ws
     JOIN agents a ON a.id = ws.executor_id
     WHERE ws.workflow_id = ? AND ws.executor_id != '' AND ws.executor_id != '__deferred__'`
  ).all(step.workflowId) as { label: string }[];
  const projects = assignedAgents.map((r) => r.label).filter(Boolean);
  const projectName = projects.join(', ');

  const vars: Record<string, string> = {
    result: depContext,
    stepName: step.name,
    workflowName,
    agentName,
    projectName,
    timestamp: new Date().toISOString(),
  };

  emitStepLog(step.workflowId, step.id, step.name, `Executing connector: ${connectorType}`, 'info');

  switch (connectorType) {
    case 'slack':
    case 'discord': {
      const webhookUrl = config.webhookUrl as string;
      if (!webhookUrl) throw new Error(`${connectorType} connector requires webhookUrl`);
      const text = substituteVars(
        (config.messageTemplate as string) || '{{workflowName}} — {{stepName}} completed:\n{{result}}',
        vars,
      );
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`${connectorType} webhook returned ${res.status}: ${res.statusText}`);
      break;
    }

    case 'github': {
      const token = config.githubToken as string;
      const repo = config.githubRepo as string;
      const action = (config.githubAction as string) || 'create_issue';
      if (!token) throw new Error('GitHub connector requires githubToken');
      if (!repo) throw new Error('GitHub connector requires githubRepo');
      const headers = {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      };
      if (action === 'create_issue') {
        const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST', headers,
          body: JSON.stringify({
            title: substituteVars((config.githubTitle as string) || '{{workflowName}}: {{stepName}}', vars),
            body: substituteVars((config.githubBody as string) || '{{result}}', vars),
          }),
        });
        if (!res.ok) throw new Error(`GitHub create_issue returned ${res.status}`);
      } else if (action === 'comment_pr') {
        const prNumber = config.githubPrNumber as string;
        if (!prNumber) throw new Error('GitHub comment_pr requires githubPrNumber');
        const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
          method: 'POST', headers,
          body: JSON.stringify({ body: substituteVars((config.githubBody as string) || '{{result}}', vars) }),
        });
        if (!res.ok) throw new Error(`GitHub comment_pr returned ${res.status}`);
      } else if (action === 'trigger_workflow') {
        const workflowId = config.githubWorkflowId as string;
        if (!workflowId) throw new Error('GitHub trigger_workflow requires githubWorkflowId');
        const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`, {
          method: 'POST', headers,
          body: JSON.stringify({ ref: 'main' }),
        });
        if (!res.ok) throw new Error(`GitHub trigger_workflow returned ${res.status}`);
      } else {
        throw new Error(`Unknown GitHub action: ${action}`);
      }
      break;
    }

    case 'linear': {
      const apiKey = config.linearApiKey as string;
      const teamId = config.linearTeamId as string;
      const action = (config.linearAction as string) || 'create_issue';
      if (!apiKey) throw new Error('Linear connector requires linearApiKey');
      if (!teamId) throw new Error('Linear connector requires linearTeamId');
      const headers = { 'Authorization': apiKey, 'Content-Type': 'application/json' };
      if (action === 'create_issue') {
        const res = await fetch('https://api.linear.app/graphql', {
          method: 'POST', headers,
          body: JSON.stringify({
            query: `mutation CreateIssue($title: String!, $description: String, $teamId: String!) {
              issueCreate(input: { title: $title, description: $description, teamId: $teamId }) {
                success issue { id identifier url }
              }
            }`,
            variables: {
              title: substituteVars((config.linearTitle as string) || '{{workflowName}}: {{stepName}}', vars),
              description: substituteVars((config.linearDescription as string) || '{{result}}', vars),
              teamId,
            },
          }),
        });
        if (!res.ok) throw new Error(`Linear create_issue returned ${res.status}`);
      } else if (action === 'update_issue') {
        const issueId = config.linearIssueId as string;
        if (!issueId) throw new Error('Linear update_issue requires linearIssueId');
        const res = await fetch('https://api.linear.app/graphql', {
          method: 'POST', headers,
          body: JSON.stringify({
            query: `mutation UpdateIssue($id: String!, $description: String) {
              issueUpdate(id: $id, input: { description: $description }) { success }
            }`,
            variables: {
              id: issueId,
              description: substituteVars((config.linearDescription as string) || '{{result}}', vars),
            },
          }),
        });
        if (!res.ok) throw new Error(`Linear update_issue returned ${res.status}`);
      } else {
        throw new Error(`Unknown Linear action: ${action}`);
      }
      break;
    }

    case 'http': {
      const url = config.httpUrl as string;
      if (!url) throw new Error('HTTP connector requires httpUrl');
      const method = (config.httpMethod as string) || 'POST';
      const customHeaders = (config.httpHeaders as Record<string, string>) || {};
      const bodyTemplate = (config.httpBodyTemplate as string) || '{"message": "{{result}}"}';
      const res = await fetch(substituteVars(url, vars), {
        method,
        headers: { 'Content-Type': 'application/json', ...customHeaders },
        body: method !== 'GET' ? substituteVars(bodyTemplate, vars) : undefined,
      });
      if (!res.ok) throw new Error(`HTTP connector returned ${res.status}: ${res.statusText}`);
      break;
    }

    case 'system-notify': {
      // Build title — include project name if not already in the custom title
      const defaultTitle = projectName
        ? `{{workflowName}} — Done · {{projectName}}`
        : `{{workflowName}} — Done`;
      const title = substituteVars((config.title as string) || defaultTitle, vars);
      const body = substituteVars((config.message as string) || '{{workflowName}} completed.', vars);

      // OS notification
      try {
        if (process.platform === 'darwin') {
          execFileSync('osascript', [
            '-e',
            `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
          ], { timeout: 5000 });
        } else if (process.platform === 'linux') {
          execFileSync('notify-send', [title, body], { timeout: 5000 });
        } else if (process.platform === 'win32') {
          const ps = [
            `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
            `$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
            `$template.SelectSingleNode('//text[@id=1]').InnerText = ${JSON.stringify(title)}`,
            `$template.SelectSingleNode('//text[@id=2]').InnerText = ${JSON.stringify(body)}`,
            `$toast = [Windows.UI.Notifications.ToastNotification]::new($template)`,
            `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('NeonCore').Show($toast)`,
          ].join('; ');
          execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10000 });
        }
      } catch { /* notification failure is non-fatal */ }

      // In-app bell notification
      getIO().emit('workflow_notification' as any, {
        id: crypto.randomUUID(),
        workflowId: step.workflowId,
        workflowName,
        title,
        body,
        projects,
        timestamp: new Date().toISOString(),
      });

      // Phone push (ntfy)
      await pushNotify(title, body).then(() => {
        console.log(`[workflow] Push sent: "${title}"`);
      }).catch((err) => {
        console.warn('[workflow] pushNotify failed:', err instanceof Error ? err.message : err);
      });
      break;
    }

    case 'capture-learnings': {
      // Collect all completed step results from this workflow run
      const completedSteps = db.prepare(
        `SELECT name, result FROM workflow_steps WHERE workflow_id = ? AND status = 'completed' AND result != '' ORDER BY completed_at ASC`
      ).all(step.workflowId) as { name: string; result: string }[];

      // Get the project_id for this workflow
      const wfProjectRow = db.prepare('SELECT project_id FROM workflows WHERE id = ?').get(step.workflowId) as { project_id: string | null } | undefined;
      const projectId = wfProjectRow?.project_id || null;

      const contentTemplate = (config.content as string) || '';
      let content: string;
      if (contentTemplate) {
        content = substituteVars(contentTemplate, vars);
      } else {
        // Auto-synthesize from step results
        const stepSummaries = completedSteps
          .filter((s) => s.name !== step.name)
          .map((s) => `### ${s.name}\n${s.result.slice(0, 500)}${s.result.length > 500 ? '...' : ''}`)
          .join('\n\n');
        content = `## Workflow: ${workflowName}\n\nRan on ${new Date().toLocaleString()}\n\n${stepSummaries || 'No step results captured.'}`;
      }

      const tagsRaw = config.tags as string | undefined;
      const tags = tagsRaw ? JSON.parse(tagsRaw) : [];

      const { randomUUID } = await import('crypto');
      db.prepare(
        `INSERT INTO project_learnings (id, project_id, workflow_id, workflow_name, content, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), projectId, step.workflowId, workflowName, content, JSON.stringify(tags), new Date().toISOString());

      emitStepLog(step.workflowId, step.id, step.name,
        `Learnings captured for workflow "${workflowName}"${projectId ? ' and stored to project' : ' (no project assigned)'}`, 'success');
      break;
    }

    case 'save-to-project': {
      // Write workflow output as an MD file to {primary_repo}/.neoncore/docs/
      const wfProjRow = db.prepare('SELECT project_id FROM workflows WHERE id = ?').get(step.workflowId) as { project_id: string | null } | undefined;
      const saveProjectId = wfProjRow?.project_id || null;

      if (!saveProjectId) {
        emitStepLog(step.workflowId, step.id, step.name, 'No project linked to this workflow — skipping save-to-project', 'warn');
        break;
      }

      const projRow = db.prepare('SELECT primary_repo FROM projects WHERE id = ?').get(saveProjectId) as { primary_repo: string } | undefined;
      if (!projRow?.primary_repo) {
        emitStepLog(step.workflowId, step.id, step.name, 'Project has no primary_repo path — skipping save-to-project', 'warn');
        break;
      }

      const { promises: fsPromises } = await import('fs');
      const pathMod = await import('path');

      const docsDir = pathMod.join(projRow.primary_repo, '.neoncore', 'docs');
      await fsPromises.mkdir(docsDir, { recursive: true });

      const dateStr = new Date().toISOString().slice(0, 10);
      const safeName = workflowName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const filePath = pathMod.join(docsDir, `${safeName}-${dateStr}.md`);

      // Collect completed step results to build the doc
      const docSteps = db.prepare(
        `SELECT name, result FROM workflow_steps WHERE workflow_id = ? AND status = 'completed' AND result != '' ORDER BY completed_at ASC`
      ).all(step.workflowId) as { name: string; result: string }[];

      const docContent = [
        `# ${workflowName}`,
        `*Generated by NeonCore — ${new Date().toLocaleString()}*`,
        '',
        ...docSteps
          .filter((s) => s.name !== step.name)
          .map((s) => `## ${s.name}\n\n${s.result}`),
      ].join('\n\n');

      await fsPromises.writeFile(filePath, docContent, 'utf8');

      emitStepLog(step.workflowId, step.id, step.name,
        `Saved workflow output to ${filePath}`, 'success');
      break;
    }

    default:
      throw new Error(`Unknown connector type: ${connectorType}`);
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
    .run('completed', `Connector "${connectorType}" executed successfully`, now, step.id);
  emitStepUpdate(step.id);
  emitStepLog(step.workflowId, step.id, step.name, `Connector "${connectorType}" executed successfully`, 'success');
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * If a step declares a `branch` in its config, create a git worktree on the target
 * agent's repo and remember its path (config._worktreePath). dispatchStepCommand then
 * tells the agent to `cd` there — so "step A → Claude, step B → Codex, each on its own
 * branch" produces isolated, independently-mergeable work. Idempotent (createWorktree
 * reuses an existing dir), so looped/re-run steps don't refail. Failure is logged, not
 * fatal — the step still runs in the main checkout.
 */
function ensureStepWorktree(step: WorkflowStep): void {
  const cfg = step.executorConfig || {};
  const branch = typeof cfg.branch === 'string' ? cfg.branch.trim() : '';
  if (!branch || cfg._worktreePath) return;
  const agent = db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(step.executorId) as { repo_path: string } | undefined;
  if (!agent?.repo_path) return;
  try {
    const { path: wtPath } = createWorktree(agent.repo_path, branch);
    cfg._worktreePath = wtPath;
    db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?').run(JSON.stringify(cfg), step.id);
    step.executorConfig = cfg;
    emitStepLog(step.workflowId, step.id, step.name, `Worktree ready: ${wtPath} (branch ${branch})`, 'info');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitStepLog(step.workflowId, step.id, step.name, `Worktree create failed for branch ${branch}: ${msg}`, 'error');
  }
}

async function executeStep(step: WorkflowStep): Promise<void> {
  const now = new Date().toISOString();
  db.prepare('UPDATE workflow_steps SET status = ?, started_at = ? WHERE id = ?')
    .run('running', now, step.id);
  emitStepUpdate(step.id);
  emitStepLog(step.workflowId, step.id, step.name, 'Step execution started', 'info');

  try {
    if (step.executorType === 'review-gate') {
      await executeReviewGate(step);
    } else if (step.executorType === 'deliberation') {
      await executeDeliberation(step);
    } else if (step.executorType === 'quality-gate') {
      await executeQualityGate(step);
    } else if (step.executorType === 'command') {
      await executeCommandStep(step);
    } else if (step.executorType === 'connector') {
      await executeConnectorStep(step);
    } else if (step.executorType === 'decision') {
      await executeDecisionStep(step);
    } else {
      // '__deferred__' means "the user picks the cartridge at launch". It is a TRUTHY string,
      // so it used to sail past a bare `!step.executorId` check, get handed to
      // sendCommandToAgent('__deferred__'), which finds no such agent and returns null
      // SILENTLY — leaving the step marked `running` forever. Recovery skips deferred steps by
      // design, so nothing ever reaped it: the run just hung at step 1 with no error anywhere.
      // That is what happened to every workflow launched without an agent (e.g. from mobile).
      // Treat it as unset and fail loudly; the catch below marks the step failed.
      if (!step.executorId || step.executorId === '__deferred__') {
        throw new Error(
          `Step "${step.name}" has no cartridge assigned. Pick one when you start the workflow.`,
        );
      }
      ensureStepWorktree(step);
      await executeStandardStep(step);
    }
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

/** Handle review-gate result: PASS completes, FAIL triggers retry or fails */
/**
 * The single completion path for a running step: the agent has explicitly reported.
 *
 * Gates must keep their PASS/FAIL + retry semantics, and looped steps must still
 * re-dispatch — that logic used to hang off idle-detection, so it lives here now.
 * Returns false if the step doesn't exist or isn't running (already completed, etc).
 */
export function completeStepFromSignal(stepId: string, result: string): boolean {
  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as Record<string, unknown> | undefined;
  if (!row) return false;

  const step = normalizeStep(row);
  if (step.status !== 'running') return false;

  const workflowId = step.workflowId;
  const allSteps = (db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as Record<string, unknown>[])
    .map(normalizeStep);

  // ── Gates: the reported result carries the verdict ──
  if (step.executorType === 'review-gate') {
    processReviewGateResult(workflowId, step, result, allSteps);
    return true;
  }
  if (step.executorType === 'quality-gate') {
    processQualityGateResult(workflowId, step, result, allSteps);
    return true;
  }

  const now = new Date().toISOString();

  // ── Looped steps: re-dispatch until the loop count is exhausted ──
  const loopCount = (step.executorConfig.loopCount as number) || 1;
  const currentLoop = (step.executorConfig._currentLoop as number) || 1;
  if (loopCount > 1 && currentLoop < loopCount) {
    const nextLoop = currentLoop + 1;
    db.prepare('UPDATE workflow_steps SET executor_config = ?, started_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...step.executorConfig, _currentLoop: nextLoop }), now, step.id);
    emitStepLog(workflowId, step.id, step.name, `Loop ${nextLoop}/${loopCount} — re-dispatching`, 'info');

    const freshStep = normalizeStep(
      db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(step.id) as Record<string, unknown>
    );
    executeStep(freshStep).catch((err) => {
      console.error(`[workflow-v2] Loop re-dispatch failed for "${step.name}": ${err}`);
    });
    return true;
  }

  // ── Deliberation synthesis finishing ──
  const extraConfig = step.executorType === 'deliberation'
    ? JSON.stringify({ ...step.executorConfig, deliberationPhase: 'done' })
    : null;

  if (extraConfig) {
    db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ?, executor_config = ? WHERE id = ?')
      .run('completed', result, now, extraConfig, step.id);
  } else {
    db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
      .run('completed', result, now, step.id);
  }

  emitStepUpdate(step.id);
  if (step.autoAdvance) {
    emitStepLog(workflowId, step.id, step.name, 'Completed', 'success');
  } else {
    emitStepLog(workflowId, step.id, step.name, 'Step completed — waiting for manual advance before continuing', 'warn');
  }
  console.log(`[workflow-v2] Step "${step.name}" completed (agent reported)`);
  return true;
}

function processReviewGateResult(
  workflowId: string,
  step: WorkflowStep,
  result: string,
  allSteps: WorkflowStep[],
) {
  const now = new Date().toISOString();
  const firstLine = result.trim().split('\n')[0].toUpperCase();
  const passed = firstLine.includes('PASS');
  const currentRetry = (step.executorConfig.currentRetry as number) || 0;
  const maxRetries = (step.executorConfig.maxRetries as number) || 3;

  if (passed) {
    // PASS — mark review gate as completed
    db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
      .run('completed', result, now, step.id);
    emitStepUpdate(step.id);
    emitStepLog(workflowId, step.id, step.name, `Review PASSED`, 'success');
    console.log(`[workflow-v2] Review gate "${step.name}" PASSED`);
  } else if (currentRetry < maxRetries) {
    // FAIL with retries remaining — reset dependency steps and re-run
    const nextRetry = currentRetry + 1;
    emitStepLog(workflowId, step.id, step.name, `Review FAILED (retry ${nextRetry}/${maxRetries}) — resetting dependency steps`, 'warn');
    console.log(`[workflow-v2] Review gate "${step.name}" FAILED, retry ${nextRetry}/${maxRetries}`);

    // Update the review gate's config with incremented retry count and reset to pending
    const updatedConfig = JSON.stringify({
      ...step.executorConfig,
      currentRetry: nextRetry,
      lastFeedback: result,
    });
    db.prepare('UPDATE workflow_steps SET status = ?, result = ?, executor_config = ?, started_at = NULL, completed_at = NULL WHERE id = ?')
      .run('pending', '', updatedConfig, step.id);
    emitStepUpdate(step.id);

    // Reset each dependency step to pending with feedback appended
    for (const depId of step.dependsOn) {
      const dep = allSteps.find((s) => s.id === depId);
      if (!dep) continue;

      // Prepend feedback to the next prompt
      const feedbackPrompt = dep.executorConfig.prompt
        ? `${dep.executorConfig.prompt}\n\n[FEEDBACK FROM REVIEW — please address these issues]\n${result}`
        : '';

      const updatedDepConfig = JSON.stringify({
        ...dep.executorConfig,
        prompt: feedbackPrompt || dep.executorConfig.prompt,
        retryFeedback: result,
      });

      db.prepare('UPDATE workflow_steps SET status = ?, result = ?, error = ?, started_at = NULL, completed_at = NULL, executor_config = ? WHERE id = ?')
        .run('pending', '', '', updatedDepConfig, depId);
      emitStepUpdate(depId);
      emitStepLog(workflowId, depId, dep.name, `Reset for retry ${nextRetry} with critic feedback`, 'warn');
    }
  } else {
    // FAIL with retries exhausted — mark as failed
    db.prepare('UPDATE workflow_steps SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?')
      .run('failed', result, `Review failed after ${maxRetries} retries`, now, step.id);
    emitStepUpdate(step.id);
    emitStepLog(workflowId, step.id, step.name, `Review FAILED — retries exhausted (${maxRetries})`, 'error');
    console.log(`[workflow-v2] Review gate "${step.name}" FAILED — retries exhausted`);
  }
}

/**
 * Deliberation phases: launching → collecting → synthesis → done.
 *
 * Only `launching` is polled — it waits for the panel's agents to come online. `collecting`
 * and `synthesis` are event-driven: panel members report via recordPanelResult() and the
 * synthesis agent via the normal step webhook. Nothing here infers progress from idleness.
 */
function processDeliberationStep(workflowId: string, step: WorkflowStep) {
  const config = step.executorConfig;
  const phase = (config.deliberationPhase as string) || 'dispatch';

  if (phase === 'launching') {
    // Auto-launch mode: waiting for agents to come online
    const repoPath = (config.repoPath as string) || '';
    const panelSize = (config.panelSize as number) || 2;
    const launchedAt = new Date((config.launchedAt as string) || Date.now()).getTime();
    const LAUNCH_TIMEOUT_MS = 120_000; // 2 minutes to wait for agents

    if (Date.now() - launchedAt > LAUNCH_TIMEOUT_MS) {
      const now = new Date().toISOString();
      db.prepare('UPDATE workflow_steps SET status = ?, error = ?, completed_at = ? WHERE id = ?')
        .run('failed', 'Timed out waiting for agents to come online', now, step.id);
      emitStepUpdate(step.id);
      emitStepLog(workflowId, step.id, step.name, 'Timed out waiting for agents to launch (2 min)', 'error');
      return;
    }

    const onlineAgents = findOnlineAgentsForRepo(repoPath);
    if (onlineAgents.length >= panelSize) {
      const selectedAgents = onlineAgents.slice(0, panelSize);
      emitStepLog(workflowId, step.id, step.name,
        `${selectedAgents.length} agents now online — dispatching deliberation`, 'success');
      dispatchDeliberationPrompts(step, selectedAgents);
    }
    // else: keep waiting, next poll will check again
    return;
  }

  // 'collecting' and 'synthesis' are event-driven, not polled: panel members report via
  // recordPanelResult() (the /panel/:agentId/complete webhook) and the synthesis agent
  // reports via the normal step webhook. Nothing to poll — we wait for those signals.
}

/**
 * Record one panel member's response. When the last member reports, dispatch synthesis
 * (or, with no synthesis agent, combine and complete). Called by the panel webhook.
 *
 * Returns false if the step isn't an active deliberation or the agent isn't on the panel.
 */
export function recordPanelResult(stepId: string, agentId: string, result: string): boolean {
  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as Record<string, unknown> | undefined;
  if (!row) return false;

  const step = normalizeStep(row);
  if (step.status !== 'running') return false;

  const config = step.executorConfig;
  if ((config.deliberationPhase as string) !== 'collecting') return false;

  const panelAgentIds = (config.panelAgentIds as string[]) || [];
  if (!panelAgentIds.includes(agentId)) return false;

  const panelResults = { ...((config.panelResults as Record<string, string>) || {}) };
  panelResults[agentId] = result;

  const workflowId = step.workflowId;
  emitStepLog(workflowId, step.id, step.name,
    `Collected response from "${getAgentName(agentId)}" (${Object.keys(panelResults).length}/${panelAgentIds.length})`, 'info');

  const allCollected = panelAgentIds.filter(Boolean).every((id) => panelResults[id]);

  if (!allCollected) {
    db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
      .run(JSON.stringify({ ...config, panelResults }), step.id);
    return true;
  }

  const synthesisAgentId = (config.synthesisAgentId as string) || '';

  if (!synthesisAgentId) {
    // No synthesis agent — combine the panel responses and complete.
    const combined = Object.entries(panelResults)
      .map(([id, r]) => `[${getAgentName(id)}]\n${r}`)
      .join('\n\n---\n\n');
    const now = new Date().toISOString();
    db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ?, executor_config = ? WHERE id = ?')
      .run('completed', combined, now, JSON.stringify({ ...config, panelResults, deliberationPhase: 'done' }), step.id);
    emitStepUpdate(step.id);
    emitStepLog(workflowId, step.id, step.name,
      `All ${panelAgentIds.length} responses collected — no synthesis agent, combining directly`, 'success');
    return true;
  }

  const responsesBlock = Object.entries(panelResults)
    .map(([id, r]) => `### ${getAgentName(id)}\n${r}`)
    .join('\n\n---\n\n');

  const synthesisPrompt = `You are synthesizing multiple expert perspectives into a unified consensus.\n\nHere are the independent responses:\n\n${responsesBlock}\n\nProvide a unified recommendation that:\n1. Identifies areas of agreement\n2. Resolves conflicting viewpoints with reasoning\n3. Combines the best elements from each perspective\n4. Provides a clear, actionable conclusion`
    + buildCompletionSuffix(step.id);

  emitStepLog(workflowId, step.id, step.name, `Dispatching synthesis to "${getAgentName(synthesisAgentId)}"`, 'info');
  db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
    .run(JSON.stringify({ ...config, panelResults, deliberationPhase: 'synthesis' }), step.id);
  dispatchStepCommand(step, synthesisAgentId, synthesisPrompt, isMemoryEnabled(synthesisAgentId));
  return true;
}

function processWorkflow(workflowId: string) {
  const steps = (db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as Record<string, unknown>[])
    .map(normalizeStep);

  if (steps.length === 0) return;

  // Steps are NEVER completed by inferring it from agent idleness — see buildCompletionSuffix.
  // A running step completes only when its agent explicitly reports (report_step_done / the
  // webhook), which routes through completeStepFromSignal(). The only thing still polled here
  // is a deliberation waiting for its panel agents to come online.
  for (const step of steps) {
    if (step.status !== 'running') continue;
    if (step.executorType === 'deliberation') {
      processDeliberationStep(workflowId, step);
    }
  }

  // Re-read steps after possible completions
  let currentSteps = (db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as Record<string, unknown>[])
    .map(normalizeStep);

  // ── Evaluate routing rules on completed steps ──
  // For each completed step that hasn't had routing applied for this completion,
  // check if any routing rule fires. If one does, reset the target step to pending
  // and block normal dependent activation for this source step.
  const routingFiredFor = new Set<string>(); // source step IDs where a routing rule fired
  for (const step of currentSteps) {
    if (step.status !== 'completed' || !step.completedAt) continue;
    // Skip if routing was already applied for this exact completion
    if ((step.executorConfig._routingAppliedAt as string) === step.completedAt) continue;

    const firedTarget = applyRoutingRules(step, currentSteps);

    if (firedTarget !== null) {
      routingFiredFor.add(step.id);
    } else {
      // No rule fired — mark as applied so we don't re-check on next poll
      const updatedConfig = { ...step.executorConfig, _routingAppliedAt: step.completedAt };
      db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
        .run(JSON.stringify(updatedConfig), step.id);
    }
  }

  // If routing fired on any step, re-read to get fresh statuses
  if (routingFiredFor.size > 0) {
    currentSteps = (db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as Record<string, unknown>[])
      .map(normalizeStep);
  }

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

      if (dep.status !== 'completed' && dep.status !== 'skipped') {
        return false; // Normal — dep still in progress
      }

      // If routing just fired on this dependency, block normal activation
      // (wait for the routing cycle to complete first)
      if (routingFiredFor.has(depId)) return false;

      // If the dependency has autoAdvance off, block until manually advanced
      // (skipped steps always allow advancement)
      if (dep.status !== 'skipped' && !dep.autoAdvance) return false;
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

    // Restore deferred values on template workflows only (not on runs — runs are
    // disposable clones and the template already has the originals intact)
    const wfRow = db.prepare('SELECT template_id FROM workflows WHERE id = ?').get(workflowId) as { template_id: string | null } | undefined;
    const isRun = !!wfRow?.template_id;
    for (const step of currentSteps) {
      if (isRun) continue; // Skip restoration for runs — preserve resolved values for history
      const config = { ...step.executorConfig };
      let needsUpdate = false;
      let executorId = step.executorId;
      let clearDescription = false;

      // Restore __deferred__ agent
      if (config._wasDeferred) {
        delete config._wasDeferred;
        executorId = '__deferred__';
        needsUpdate = true;
      }

      // Restore empty prompts that were filled at runtime
      if (Array.isArray(config._deferredPrompts)) {
        for (const field of config._deferredPrompts as string[]) {
          if (field === 'intent.objective') {
            if (config.intent) (config.intent as Record<string, unknown>).objective = '';
          } else if (field === 'prompt') {
            config.prompt = '';
            clearDescription = true;
          } else {
            config[field] = '';
          }
        }
        delete config._deferredPrompts;
        needsUpdate = true;
      }

      if (needsUpdate) {
        if (clearDescription) {
          db.prepare('UPDATE workflow_steps SET executor_id = ?, executor_config = ?, description = \'\' WHERE id = ?')
            .run(executorId, JSON.stringify(config), step.id);
        } else {
          db.prepare('UPDATE workflow_steps SET executor_id = ?, executor_config = ? WHERE id = ?')
            .run(executorId, JSON.stringify(config), step.id);
        }
      }
    }

    // Emit workflow update so the dashboard reflects the final status
    emitWorkflowUpdate(workflowId);
    emitStepLog(workflowId, '', 'Workflow', `Workflow ${finalStatus}`, finalStatus === 'completed' ? 'success' : 'error');
    console.log(`[workflow-v2] Workflow ${workflowId} ${finalStatus}`);

    // Push to the mobile app so you learn a run finished without keeping it open.
    // Only for runs (not template dry-runs), and fire-and-forget — never block completion.
    if (isRun) {
      notifyWorkflowFinished(workflowId, finalStatus).catch(() => {});
    }

    // Finished runs are RETAINED. They used to be hard-deleted 30s after finishing, which
    // destroyed every step result — the entire output of a review/analysis workflow was gone
    // half a minute after it produced it, and neither UI had anything left to show. Old runs
    // are now pruned on a retention window by cleanup-scheduler.ts instead.
    if (isRun) {
      console.log(`[workflow-v2] Run ${workflowId.slice(0, 8)} ${finalStatus} — results retained`);
    }
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
    // Isolate each workflow. This runs inside a setInterval callback, so an unhandled
    // synchronous throw here is an uncaught exception that kills the whole server — and
    // on restart the tick would hit the same bad row again, crash-looping. One poisoned
    // workflow must not take down the executor, the other workflows, or the process.
    try {
      processWorkflow(id);
    } catch (err) {
      console.error(`[workflow-v2] processWorkflow(${id.slice(0, 8)}) threw — skipping this tick:`, err);
    }
  }
}

export function startWorkflowExecutorV2() {
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[workflow-v2] Executor started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
}
