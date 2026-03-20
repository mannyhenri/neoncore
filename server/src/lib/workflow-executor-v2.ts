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

/** Memory is always included when entries exist — managed via the memory modal */
function isMemoryEnabled(_agentId: string): boolean {
  return true;
}

/** Standard step execution — dispatches prompt to agent with role prefix, memory, webhook */
async function executeStandardStep(step: WorkflowStep): Promise<void> {
  const context = gatherDependencyContext(step);
  const prompt = step.executorConfig.useIntent
    ? composeIntentPrompt(step.executorConfig)
    : (step.executorConfig.prompt as string) || step.description || step.name;

  // Resolve expert role from config, default to general
  const role = (step.executorConfig.role as string) || 'general';

  const rolePrefix = ROLE_PROMPTS[role] ?? '';

  // If the step waits for a webhook, append instructions so the agent calls it when done
  let webhookSuffix = '';
  if (step.executorConfig.waitForWebhook) {
    const port = process.env.PORT || '4040';
    webhookSuffix = `\n\nIMPORTANT: When you have fully completed this task, you MUST signal completion by running this command:\ncurl -s -X POST http://localhost:${port}/api/workflows/webhook/${step.id}/complete -H 'Content-Type: application/json' -d '{"result": "Done"}'\nDo NOT call this webhook until all work is finished. This step will remain in a "running" state until the webhook is called.`;
  }

  const finalPrompt = context + rolePrefix + prompt + webhookSuffix;

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
  console.log(`[workflow-v2] Step "${step.name}" prompt (${finalPrompt.length} chars): role=${role}, webhook=${!!step.executorConfig.waitForWebhook}, memory=${includeMemory}, deps=${step.dependsOn.length}`);

  sendCommandToAgent(step.executorId, finalPrompt, includeMemory);

  if (step.executorConfig.waitForWebhook) {
    emitStepLog(step.workflowId, step.id, step.name, `Waiting for webhook callback to complete this step (POST /workflows/webhook/${step.id}/complete)`, 'warn');
  }
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

  const reviewPrompt = `You are a code review critic. Evaluate the following work against these criteria:\n\n**Criteria:** ${criteria}\n\n---\n${depContext || 'No dependency output available.'}\n---\n\nYou MUST respond with exactly **PASS** or **FAIL** on the FIRST line of your response.\nThen provide your detailed reasoning.\nIf FAIL, provide specific actionable feedback for improvement.\n\nRetry ${currentRetry + 1} of ${maxRetries + 1}.`;

  const agentName = getAgentName(reviewAgentId);
  emitStepLog(step.workflowId, step.id, step.name, `Dispatching critic review to "${agentName}" (retry ${currentRetry}/${maxRetries})`, 'info');

  const includeMemory = isMemoryEnabled(reviewAgentId);
  sendCommandToAgent(reviewAgentId, reviewPrompt, includeMemory);
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
    sendCommandToAgent(agentId, fullPrompt, includeMemory);
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
  const finalPrompt = depContext + feedbackBlock + basePrompt;

  const agentName = getAgentName(agentId);
  const gateLabel = preset?.label ?? gateType;
  emitStepLog(step.workflowId, step.id, step.name, `Dispatching quality gate [${gateLabel}] to "${agentName}" (attempt ${currentRetry + 1}/${maxRetries + 1})`, 'info');

  const includeMemory = isMemoryEnabled(agentId);
  sendCommandToAgent(agentId, finalPrompt, includeMemory);
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
    } else {
      if (!step.executorId) throw new Error('Step requires an agent ID');
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

      const depConfig = JSON.stringify({
        ...dep.executorConfig,
        retryFeedback: `[Critic feedback from retry ${nextRetry}]\n${result}`,
      });

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

/** Handle deliberation step phases: launching → collecting → synthesis → done */
function processDeliberationStep(workflowId: string, step: WorkflowStep) {
  const config = step.executorConfig;
  const phase = (config.deliberationPhase as string) || 'dispatch';
  const panelAgentIds = (config.panelAgentIds as string[]) || [];
  const panelResults = (config.panelResults as Record<string, string>) || {};

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

  if (phase === 'collecting') {
    // Check if all panel agents are idle and collect their results
    let allCollected = true;
    const updatedResults = { ...panelResults };

    for (const agentId of panelAgentIds) {
      if (!agentId) continue;
      if (updatedResults[agentId]) continue; // Already collected

      const agent = db.prepare('SELECT status, last_message FROM agents WHERE id = ?')
        .get(agentId) as { status: string; last_message: string } | undefined;

      if (agent && agent.status === 'idle' && agent.last_message) {
        updatedResults[agentId] = agent.last_message;
        const agentName = getAgentName(agentId);
        emitStepLog(workflowId, step.id, step.name, `Collected response from "${agentName}"`, 'info');
      } else {
        allCollected = false;
      }
    }

    // Persist any newly collected results
    if (Object.keys(updatedResults).length > Object.keys(panelResults).length) {
      const updatedConfig = JSON.stringify({ ...config, panelResults: updatedResults });
      db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
        .run(updatedConfig, step.id);
    }

    if (allCollected) {
      // All panel results collected — dispatch synthesis
      const synthesisAgentId = (config.synthesisAgentId as string) || '';
      if (!synthesisAgentId) {
        // No synthesis agent — just combine results and complete
        const combined = Object.entries(updatedResults)
          .map(([id, r]) => `[${getAgentName(id)}]\n${r}`)
          .join('\n\n---\n\n');
        const now = new Date().toISOString();
        db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
          .run('completed', combined, now, step.id);
        emitStepUpdate(step.id);
        emitStepLog(workflowId, step.id, step.name, `All ${panelAgentIds.length} responses collected — no synthesis agent, combining directly`, 'success');
        return;
      }

      // Build synthesis prompt
      const responsesBlock = Object.entries(updatedResults)
        .map(([id, r]) => `### ${getAgentName(id)}\n${r}`)
        .join('\n\n---\n\n');

      const synthesisPrompt = `You are synthesizing multiple expert perspectives into a unified consensus.\n\nHere are the independent responses:\n\n${responsesBlock}\n\nProvide a unified recommendation that:\n1. Identifies areas of agreement\n2. Resolves conflicting viewpoints with reasoning\n3. Combines the best elements from each perspective\n4. Provides a clear, actionable conclusion`;

      const agentName = getAgentName(synthesisAgentId);
      emitStepLog(workflowId, step.id, step.name, `Dispatching synthesis to "${agentName}"`, 'info');

      const includeMemory = isMemoryEnabled(synthesisAgentId);
      sendCommandToAgent(synthesisAgentId, synthesisPrompt, includeMemory);

      const updatedConfig = JSON.stringify({
        ...config,
        panelResults: updatedResults,
        deliberationPhase: 'synthesis',
      });
      db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
        .run(updatedConfig, step.id);
    }
  } else if (phase === 'synthesis') {
    // Check if synthesis agent is idle
    const synthesisAgentId = (config.synthesisAgentId as string) || '';
    if (!synthesisAgentId) return;

    const agent = db.prepare('SELECT status, last_message FROM agents WHERE id = ?')
      .get(synthesisAgentId) as { status: string; last_message: string } | undefined;

    if (agent && agent.status === 'idle') {
      const now = new Date().toISOString();
      const result = agent.last_message || 'Synthesis completed';
      db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
        .run('completed', result, now, step.id);

      const updatedConfig = JSON.stringify({ ...config, deliberationPhase: 'done' });
      db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
        .run(updatedConfig, step.id);

      emitStepUpdate(step.id);
      emitStepLog(workflowId, step.id, step.name, `Deliberation complete — synthesis finalized`, 'success');
      console.log(`[workflow-v2] Deliberation "${step.name}" completed`);
    }
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

    // If the step is waiting for an external webhook, don't auto-complete on agent idle
    if (step.executorConfig.waitForWebhook) continue;

    // Don't auto-complete steps that just started — the agent may not have picked up
    // the command yet. Wait at least MIN_RUNNING_BEFORE_COMPLETE_MS before checking idle.
    if (step.startedAt) {
      const elapsed = Date.now() - new Date(step.startedAt).getTime();
      if (elapsed < MIN_RUNNING_BEFORE_COMPLETE_MS) continue;
    }

    // ── Deliberation: multi-phase completion ──
    if (step.executorType === 'deliberation') {
      processDeliberationStep(workflowId, step);
      continue;
    }

    // For review-gate steps, check the reviewAgentId (not executorId)
    const checkAgentId = step.executorType === 'review-gate'
      ? (step.executorConfig.reviewAgentId as string) || step.executorId
      : step.executorId;
    if (!checkAgentId) continue;

    const agent = db.prepare('SELECT status, last_message FROM agents WHERE id = ?')
      .get(checkAgentId) as { status: string; last_message: string } | undefined;

    if (agent && agent.status === 'idle') {
      const now = new Date().toISOString();
      const result = agent.last_message || 'Step completed (agent idle)';

      // ── Review gate: check PASS/FAIL and handle retries ──
      if (step.executorType === 'review-gate') {
        processReviewGateResult(workflowId, step, result, steps);
        continue;
      }

      // ── Quality gate: check PASS/FAIL and handle retries ──
      if (step.executorType === 'quality-gate') {
        processQualityGateResult(workflowId, step, result, steps);
        continue;
      }

      // Standard step completion
      db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
        .run('completed', result, now, step.id);
      emitStepUpdate(step.id);
      if (step.autoAdvance) {
        emitStepLog(workflowId, step.id, step.name, 'Auto-completed (agent went idle)', 'success');
      } else {
        emitStepLog(workflowId, step.id, step.name, 'Step completed — waiting for manual advance before continuing', 'warn');
      }
      console.log(`[workflow-v2] Step "${step.name}" auto-completed (agent ${checkAgentId} idle)`);
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

      if (dep.status !== 'completed' && dep.status !== 'skipped') {
        return false; // Normal — dep still in progress
      }

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
