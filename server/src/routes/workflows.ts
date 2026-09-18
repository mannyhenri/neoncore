import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Workflow, WorkflowPlayer, WorkflowPhaseState, WorkflowStatus, WorkflowStep } from '../types.js';
import { sendCommandToAgent } from '../lib/send-command.js';
import { routeFunction } from '../lib/engine-router.js';
import { loadProfile, loadDemotions } from '../lib/engine-store.js';
import { guardBusy, resolveWorkflowTargets } from '../lib/queue-if-busy.js';
import { unrunnableSteps, CONFER_FILL } from '../lib/workflow-launch.js';
import { DEFAULT_AUTONOMY } from '../lib/autonomy.js';
import { layoutSteps, STEP_X, STEP_START_Y, STEP_SPACING_Y } from '../lib/workflow-layout.js';
import { workflowRepoTargets } from '../lib/workflow-cartridges.js';
import { awaitsLaunchFill } from '../lib/cartridge-exists.js';
import { workflowNeedsAttention } from '../lib/workflow-attention.js';
import { libelleContexte } from '../lib/context-label.js';
import { agentIdForRepoAndType } from '../lib/resolve-agent.js';
import { recoverStep } from '../lib/recovery.js';
import { completeStepFromSignal, recordPanelResult } from '../lib/workflow-executor-v2.js';
import { recordJournal } from '../lib/workflow-journal.js';
import { materializeForRepos, parseAttachmentsInput } from '../lib/attachments.js';
import { isLocalMachine, machineLabel } from '../lib/machine-locality.js';
import { validateCompletionPayload } from '../lib/work-standard.js';
import { withReportStep } from '../lib/workflow-report.js';
import { loopCountRequirements, validateUpstreamCount, configForRerun, LOOP_RUN_KEYS, type LoopConfig } from '../lib/workflow-loop.js';
import { normalizeStep, parseExecutorConfig } from '../lib/workflow-normalize.js';
import {
  isAutonomyLevel, SETTABLE_LEVELS, setWorkflowAutonomy, effectiveAutonomy, listAutoResolutions,
} from '../lib/autonomy.js';
import type { StepExecutorType } from '../types.js';
import fs from 'fs';
import path from 'path';

const router = Router();

/**
 * Record an engine substitution in `routing_note`, NOT in `error`.
 *
 * `error` is painted red by the execution log, and a step that ran correctly on frontier
 * because the router said so is not an error. Appends rather than overwrites so one note
 * cannot erase another.
 */
function recordStepNote(stepId: string, note: string): void {
  const row = db.prepare('SELECT routing_note FROM workflow_steps WHERE id = ?').get(stepId) as { routing_note: string } | undefined;
  const merged = row?.routing_note ? `${row.routing_note}\n${note}` : note;
  db.prepare('UPDATE workflow_steps SET routing_note = ? WHERE id = ?').run(merged, stepId);
}

// --- Helpers ---

function normalizeWorkflow(row: Record<string, unknown>): Workflow {
  return {
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
    // The short subject a list shows instead of an id. Derived from initialContext at write
    // time, not here: a list must not have to re-derive it for every row it renders.
    contextLabel: (row.context_label ?? '') as string,
    // Derived, not stored: "is this waiting on me right now" must be answerable at any moment,
    // not only at the instant something happened and a notification fired.
    needsAttention: workflowNeedsAttention(row.id as string),
    createdAt: (row.created_at ?? '') as string,
    startedAt: (row.started_at ?? '') as string,
    completedAt: (row.completed_at as string) || null,
    error: (row.error ?? '') as string,
    templateId: (row.template_id as string) || null,
    runNumber: (row.run_number as number) || 0,
  };
}

function emitWorkflowUpdate(id: string) {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (row) getIO().emit('workflow_updated', normalizeWorkflow(row));
}

function buildStepSummary(workflowId: string): Record<string, unknown> | null {
  const stepRows = db.prepare(
    'SELECT name, status, executor_id FROM workflow_steps WHERE workflow_id = ? ORDER BY created_at'
  ).all(workflowId) as { name: string; status: string; executor_id: string }[];
  if (stepRows.length === 0) return null;

  const executorIds = [...new Set(
    stepRows.map((s) => s.executor_id).filter((id) => id && id !== '__deferred__')
  )];
  let projects: string[] = [];
  if (executorIds.length > 0) {
    const placeholders = executorIds.map(() => '?').join(',');
    const agentRows = db.prepare(
      `SELECT repo_name, name FROM agents WHERE id IN (${placeholders})`
    ).all(...executorIds) as { repo_name: string; name: string }[];
    projects = [...new Set(agentRows.map((r) => r.repo_name || r.name).filter(Boolean))];
  }

  return {
    total: stepRows.length,
    completed: stepRows.filter((s) => s.status === 'completed').length,
    running: stepRows.filter((s) => s.status === 'running').length,
    failed: stepRows.filter((s) => s.status === 'failed').length,
    pending: stepRows.filter((s) => s.status === 'pending').length,
    stepNames: stepRows.map((s) => s.name),
    projects,
  };
}

// --- Routes ---

// Start a new workflow
router.post('/start', (req, res) => {
  const { name, jiraTaskId, description, players, maxIterations } = req.body;

  if (!description || !Array.isArray(players) || players.length === 0) {
    return res.status(400).json({ error: 'description and non-empty players array required' });
  }

  // Validate players
  const validatedPlayers: WorkflowPlayer[] = [];
  let hasVsCodeCoder = false;

  for (const p of players) {
    if (!p.playerType || !Array.isArray(p.roles) || p.roles.length === 0) {
      return res.status(400).json({ error: 'Each player needs playerType and at least one role' });
    }
    if (p.playerType === 'openai' || p.playerType === 'gridlight-gateway') {
      return res.status(400).json({ error: 'API model players have been removed. Use a connected cartridge instead.' });
    }
    if (p.playerType !== 'vscode-agent') {
      return res.status(400).json({ error: `Unsupported player type: ${p.playerType}` });
    }

    const player: WorkflowPlayer = {
      id: p.agentId || uuid(),
      name: p.name || p.modelId || 'Unknown',
      playerType: p.playerType,
      modelId: p.modelId,
      roles: p.roles,
      agentId: p.agentId,
    };

    // Validate VS Code agents
    if (player.playerType === 'vscode-agent') {
      if (!player.agentId) {
        return res.status(400).json({ error: 'VS Code agent players need agentId' });
      }
      const agent = db.prepare('SELECT id, status FROM agents WHERE id = ?')
        .get(player.agentId) as { id: string; status: string } | undefined;
      if (!agent) return res.status(404).json({ error: `Agent ${player.agentId} not found` });
      if (agent.status === 'offline') return res.status(400).json({ error: `Agent ${player.agentId} is offline` });

      if (player.roles.includes('coding')) hasVsCodeCoder = true;
    }

    validatedPlayers.push(player);
  }

  // At least one VS Code agent must have coding role
  if (!hasVsCodeCoder) {
    return res.status(400).json({ error: 'At least one VS Code agent must have the coding role (file access needed)' });
  }

  const now = new Date().toISOString();
  const id = uuid();
  const workflowName = name || `Workflow ${jiraTaskId || id.slice(0, 8)}`;

  // Initialize phases
  const phases: WorkflowPhaseState[] = [
    { phase: 'research', status: 'pending', currentRound: 0, startedAt: '', completedAt: '', playerResults: [] },
    { phase: 'coding', status: 'pending', currentRound: 0, startedAt: '', completedAt: '', playerResults: [] },
    { phase: 'review', status: 'pending', currentRound: 0, startedAt: '', completedAt: '', playerResults: [] },
  ];

  db.prepare(`
    INSERT INTO workflows (id, name, jira_task_id, description, players, phases, status, current_phase, iteration, max_iterations, shared_context, created_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', 0, 1, ?, '', ?, ?)
  `).run(
    id, workflowName, jiraTaskId || '', description,
    JSON.stringify(validatedPlayers), JSON.stringify(phases),
    maxIterations || 3, now, now,
  );

  console.log(`[workflow] Started ${id}: "${workflowName}" with ${validatedPlayers.length} players`);

  emitWorkflowUpdate(id);
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(normalizeWorkflow(row));
});

// List workflows (includes step summary for V2 workflows)
// ?templates=true returns only templates, ?runs=true returns only runs
router.get('/', (req, res) => {
  let sql = 'SELECT * FROM workflows';
  if (req.query.templates === 'true') {
    sql += ' WHERE template_id IS NULL';
  } else if (req.query.runs === 'true') {
    sql += ' WHERE template_id IS NOT NULL';
  }
  sql += ' ORDER BY created_at DESC LIMIT 50';
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  const workflows = rows.map((row) => {
    const wf: Record<string, unknown> = { ...normalizeWorkflow(row) };
    const summary = buildStepSummary(wf.id as string);
    if (summary) wf.stepSummary = summary;
    return wf;
  });
  res.json(workflows);
});

// Get single workflow
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Workflow not found' });
  res.json(normalizeWorkflow(row));
});

// Pause
router.post('/:id/pause', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Workflow not found' });
  if (row.status !== 'running') return res.status(400).json({ error: 'Can only pause running workflows' });

  db.prepare("UPDATE workflows SET status = 'paused' WHERE id = ?").run(req.params.id);
  console.log(`[workflow] Paused ${req.params.id}`);
  emitWorkflowUpdate(req.params.id);

  const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalizeWorkflow(updated));
});

// Resume
router.post('/:id/resume', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Workflow not found' });
  if (row.status !== 'paused') return res.status(400).json({ error: 'Can only resume paused workflows' });

  db.prepare("UPDATE workflows SET status = 'running' WHERE id = ?").run(req.params.id);
  console.log(`[workflow] Resumed ${req.params.id}`);
  emitWorkflowUpdate(req.params.id);

  const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalizeWorkflow(updated));
});

// Cancel
router.post('/:id/cancel', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Workflow not found' });
  if (['completed', 'cancelled'].includes(row.status as string)) {
    return res.status(400).json({ error: 'Workflow already finished' });
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE workflows SET status = 'cancelled', completed_at = ? WHERE id = ?").run(now, req.params.id);
  console.log(`[workflow] Cancelled ${req.params.id}`);
  emitWorkflowUpdate(req.params.id);

  const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalizeWorkflow(updated));
});

// Delete a workflow (V1 or V2) and its steps
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Workflow not found' });

  db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(req.params.id);
  db.prepare('DELETE FROM workflows WHERE id = ?').run(req.params.id);
  console.log(`[workflow] Deleted ${req.params.id}`);
  res.status(204).send();
});

// Assign/unassign workflow to a project
router.put('/:id/project', (req, res) => {
  const { projectId } = req.body;
  db.prepare('UPDATE workflows SET project_id = ? WHERE id = ?').run(projectId || null, req.params.id);
  res.status(204).send();
});

// ─── V2 Canvas Workflow Routes ───────────────────────────────


// Create V2 workflow with steps
/**
 * Append the work-standard verify gate to a step list, unless one is already there.
 *
 * The gate depends on every TERMINAL step (nothing depends on it), so it runs after all
 * the work regardless of how the graph branches — appending it to the last step in the
 * array would silently skip parallel branches.
 *
 * Skipped when: the caller opted out, the workflow already ends in a gate (don't stack two
 * critics), or there is no work step to audit.
 */
export function withStandardGate(
  steps: Record<string, unknown>[],
  opts: { skip?: boolean } = {},
): Record<string, unknown>[] {
  if (opts.skip) return steps;

  const GATE_TYPES = new Set(['quality-gate', 'review-gate']);
  if (steps.some((s) => GATE_TYPES.has((s.executorType as string) || ''))) return steps;

  const WORK_TYPES = new Set(['claude-code', 'command', '']);
  const workSteps = steps.filter((s) => WORK_TYPES.has((s.executorType as string) || ''));
  if (workSteps.length === 0) return steps;

  const dependedOn = new Set<string>();
  for (const s of steps) {
    for (const dep of (s.dependsOn as string[] | undefined) || []) dependedOn.add(dep);
  }
  const terminal = steps.filter((s) => !dependedOn.has(s.id as string)).map((s) => s.id as string);

  // Inherit the executor from the last work step so the gate lands on a cartridge that
  // actually has the repo. A gate with no executor fails at dispatch.
  const executorId = (workSteps[workSteps.length - 1].executorId as string) || '';

  return [
    ...steps,
    {
      id: `standard-gate-${uuid().slice(0, 8)}`,
      name: 'Work Standard Check',
      description: 'Verifies the work covered the complete set and is proven by a set-based test.',
      executorType: 'quality-gate',
      executorId,
      executorConfig: { gateType: 'standard', maxRetries: 1 },
      dependsOn: terminal.length > 0 ? terminal : [steps[steps.length - 1].id],
      autoAdvance: true,
      positionX: STEP_X,
      // Real coordinates rather than 0,0 — every gate used to stack at the top of the canvas.
      // The final layout is recomputed by layoutSteps once the graph is complete.
      positionY: STEP_START_Y,
    },
  ];
}

router.post('/v2/create', (req, res) => {
  const { name, description, targetRepos, skipStandardGate, skipReportStep } = req.body;
  // ORDER IS LOAD-BEARING. The gate goes on first so it is terminal, and the report is then
  // appended depending on it — the run is audited and THEN reports itself. Reverse the two
  // and withReportStep's terminal scan hands the gate a dependency on the report, so the
  // workflow writes its completion report before the work-standard check has run.
  const steps = Array.isArray(req.body?.steps)
    ? withReportStep(
        withStandardGate(req.body.steps, { skip: Boolean(skipStandardGate) }),
        { skip: Boolean(skipReportStep) },
      )
    : req.body?.steps;

  if (!name || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'name and non-empty steps array required' });
  }

  const now = new Date().toISOString();
  const workflowId = uuid();

  db.prepare(`
    INSERT INTO workflows (id, name, description, status, target_repos, created_at, started_at)
    VALUES (?, ?, ?, 'pending', ?, ?, '')
  `).run(workflowId, name, description || '', JSON.stringify(targetRepos || []), now);

  const insertStep = db.prepare(`
    INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y, executor_type, executor_id, executor_config, auto_advance, depends_on, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Map client-side step IDs to server-generated IDs so dependsOn references stay valid
  const clientToServerIds = new Map<string, string>();
  for (const s of steps) {
    clientToServerIds.set(s.id, uuid());
  }

  const createdSteps: WorkflowStep[] = [];
  for (const s of steps) {
    const stepId = clientToServerIds.get(s.id)!;
    // Remap dependsOn from client IDs to server IDs
    const remappedDeps = (s.dependsOn || [])
      .map((depId: string) => clientToServerIds.get(depId))
      .filter(Boolean);

    insertStep.run(
      stepId, workflowId,
      s.name || 'Untitled Step',
      s.description || '',
      s.positionX ?? 0,
      s.positionY ?? 0,
      s.executorType || 'claude-code',
      s.executorId || '',
      JSON.stringify(s.executorConfig || {}),
      s.autoAdvance !== false ? 1 : 0,
      JSON.stringify(remappedDeps),
      now
    );
    const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as Record<string, unknown>;
    createdSteps.push(normalizeStep(row));
  }

  layoutSteps(db, workflowId);
  const workflow = normalizeWorkflow(
    db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as Record<string, unknown>
  );
  const laidOut = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y')
    .all(workflowId) as Record<string, unknown>[];
  res.status(201).json({ workflow, steps: laidOut.map(normalizeStep) });
});

// Update V2 workflow (name, description, and full step replacement)
router.put('/v2/:id', (req, res) => {
  const { name, description, steps } = req.body;
  const existing = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Workflow not found' });

  if (!name || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'name and non-empty steps array required' });
  }

  const now = new Date().toISOString();

  // Update workflow metadata
  db.prepare('UPDATE workflows SET name = ?, description = ? WHERE id = ?')
    .run(name, description || '', req.params.id);

  // Delete existing steps and re-insert (full replace)
  db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(req.params.id);

  const insertStep = db.prepare(`
    INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y, executor_type, executor_id, executor_config, auto_advance, depends_on, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Map client-side step IDs to server-generated IDs so dependsOn references stay valid
  const clientToServerIds = new Map<string, string>();
  for (const s of steps) {
    clientToServerIds.set(s.id, uuid());
  }

  const createdSteps: WorkflowStep[] = [];
  for (const s of steps) {
    const stepId = clientToServerIds.get(s.id)!;
    const remappedDeps = (s.dependsOn || [])
      .map((depId: string) => clientToServerIds.get(depId))
      .filter(Boolean);

    insertStep.run(
      stepId, req.params.id,
      s.name || 'Untitled Step',
      s.description || '',
      s.positionX ?? 0,
      s.positionY ?? 0,
      s.executorType || 'claude-code',
      s.executorId || '',
      JSON.stringify(s.executorConfig || {}),
      s.autoAdvance !== false ? 1 : 0,
      JSON.stringify(remappedDeps),
      now
    );
    const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as Record<string, unknown>;
    createdSteps.push(normalizeStep(row));
  }

  emitWorkflowUpdate(req.params.id);
  const workflow = normalizeWorkflow(
    db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown>
  );
  res.json({ workflow, steps: createdSteps });
});

// Get V2 workflow with steps
router.get('/v2/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Workflow not found' });

  const stepRows = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y, position_x')
    .all(req.params.id) as Record<string, unknown>[];

  res.json({ workflow: normalizeWorkflow(row), steps: stepRows.map(normalizeStep) });
});

// List all runs for a template
router.get('/v2/:id/runs', (req, res) => {
  const rows = db.prepare('SELECT * FROM workflows WHERE template_id = ? ORDER BY run_number DESC')
    .all(req.params.id) as Record<string, unknown>[];
  const runs = rows.map((row) => {
    const wf: Record<string, unknown> = { ...normalizeWorkflow(row) };
    const summary = buildStepSummary(wf.id as string);
    if (summary) wf.stepSummary = summary;
    return wf;
  });
  res.json(runs);
});

// Bulk update step positions
router.put('/v2/:id/steps', (req, res) => {
  const { steps } = req.body;
  if (!Array.isArray(steps)) return res.status(400).json({ error: 'steps array required' });

  const update = db.prepare(`
    UPDATE workflow_steps SET position_x = ?, position_y = ?, depends_on = ?
    WHERE id = ? AND workflow_id = ?
  `);

  for (const s of steps) {
    update.run(s.positionX ?? 0, s.positionY ?? 0, JSON.stringify(s.dependsOn || []), s.id, req.params.id);
  }

  res.json({ ok: true });
});

// Add a step
router.post('/v2/:id/steps', (req, res) => {
  const s = req.body;
  const now = new Date().toISOString();
  const stepId = uuid();

  db.prepare(`
    INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y, executor_type, executor_id, executor_config, auto_advance, depends_on, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stepId, req.params.id,
    s.name || 'Untitled Step',
    s.description || '',
    s.positionX ?? 0,
    s.positionY ?? 0,
    s.executorType || 'claude-code',
    s.executorId || '',
    JSON.stringify(s.executorConfig || {}),
    s.autoAdvance !== false ? 1 : 0,
    JSON.stringify(s.dependsOn || []),
    now
  );

  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as Record<string, unknown>;
  res.status(201).json(normalizeStep(row));
});

// Update a step
router.put('/v2/:id/steps/:stepId', (req, res) => {
  const { name, description, executorType, executorId, executorConfig, autoAdvance, positionX, positionY, dependsOn } = req.body;
  const updates: string[] = [];
  const values: unknown[] = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (executorType !== undefined) { updates.push('executor_type = ?'); values.push(executorType); }
  if (executorId !== undefined) { updates.push('executor_id = ?'); values.push(executorId); }
  if (executorConfig !== undefined) { updates.push('executor_config = ?'); values.push(JSON.stringify(executorConfig)); }
  if (autoAdvance !== undefined) { updates.push('auto_advance = ?'); values.push(autoAdvance ? 1 : 0); }
  if (positionX !== undefined) { updates.push('position_x = ?'); values.push(positionX); }
  if (positionY !== undefined) { updates.push('position_y = ?'); values.push(positionY); }
  if (dependsOn !== undefined) { updates.push('depends_on = ?'); values.push(JSON.stringify(dependsOn)); }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(req.params.stepId, req.params.id);
  db.prepare(`UPDATE workflow_steps SET ${updates.join(', ')} WHERE id = ? AND workflow_id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(req.params.stepId) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Step not found' });
  res.json(normalizeStep(row));
});

// Delete a step
router.delete('/v2/:id/steps/:stepId', (req, res) => {
  db.prepare('DELETE FROM workflow_steps WHERE id = ? AND workflow_id = ?').run(req.params.stepId, req.params.id);
  res.status(204).send();
});

// Steer a running step — inject a message to the agent currently executing it
router.post('/v2/:id/steps/:stepId/steer', (req, res) => {
  const { message } = req.body;
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const step = db.prepare(
    'SELECT * FROM workflow_steps WHERE id = ? AND workflow_id = ?'
  ).get(req.params.stepId, req.params.id) as Record<string, unknown> | undefined;

  if (!step) return res.status(404).json({ error: 'Step not found' });

  if (step.status !== 'running') {
    return res.status(400).json({ error: 'Step is not currently running' });
  }

  const executorType = step.executor_type as string;
  const executorId = step.executor_id as string;

  if (executorType !== 'claude-code' || !executorId) {
    return res.status(400).json({ error: 'This step type cannot be steered' });
  }

  const command = sendCommandToAgent(executorId, String(message).trim(), false);
  if (!command) return res.status(404).json({ error: 'Agent not found or offline' });

  res.json({ ok: true, commandId: command.id });
});

// Start V2 workflow
// If the target is a template (template_id IS NULL), clone it into a new run.
// If the target is already a run, reset its steps and re-run in place.
router.post('/v2/:id/start', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Workflow not found' });

  // Same rule as prompts and confers: if the cartridges this run would drive are mid-task,
  // queue the run rather than starting it on top of work in progress. Targets are the agents
  // already pinned to this workflow's steps — the ones it will actually dispatch to.
  // REFUSE AT THE DOOR. A template's steps are `__deferred__` until launch; if nothing in this
  // request assigns them, the run would be created, all its rows cloned, marked `running`, and
  // then die on step 1 with "has no cartridge assigned". Reject before anything exists — the
  // same rule the queue applies to enqueue: validate while a human is watching.
  const blocked = unrunnableSteps(req.params.id, req.body);
  if (blocked.length > 0) {
    const names = blocked.map((b) => b.name);
    const shown = names.slice(0, 3).join(', ');
    const more = names.length > 3 ? ` (+${names.length - 3} more)` : '';
    // "have none" and "point at a cartridge that no longer exists" send you to different places.
    // A restarted cartridge keeps its steps but registers a NEW id, so the second case looks
    // fully configured on the board and is the one worth naming out loud.
    const gone = blocked.filter((b) => b.reason === 'cartridge-gone').length;
    const why = gone === blocked.length
      ? `their cartridge no longer exists (it was restarted, or removed)`
      : gone > 0
        ? `${gone} point at a cartridge that no longer exists, the rest have none`
        : `they have none`;
    return res.status(400).json({
      error: `Pick a cartridge for this run — ${blocked.length} step(s) cannot run: ${shown}${more} — ${why}`,
      unassignedSteps: names,
      blockedSteps: blocked,
    });
  }

  if (req.body?.queueIfBusy !== false) {
    // Targets come from resolveWorkflowTargets, NOT from the step rows alone. A template's
    // steps are '__deferred__' until launch, so reading only pinned executors made this check
    // fire on almost nothing: pick a template, pick a cartridge, hit Run, and the run started
    // on top of whatever that cartridge was doing. The cartridge is in the request body.
    const targets = resolveWorkflowTargets(req.params.id, req.body);
    // repoPath is stored so the item lands in that repo's lane instead of the shared
    // `repo:default` bucket, where every workflow in the fleet queued behind every other.
    const repoPath = targets.length
      ? (db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(targets[0]) as { repo_path?: string } | undefined)?.repo_path || ''
      : '';
    const guard = guardBusy({
      kind: 'workflow',
      targets,
      payload: { workflowId: req.params.id, repoPath, startOptions: req.body ?? {} },
    });
    if ('error' in guard) return res.status(400).json({ error: guard.error });
    if (guard.queued) {
      return res.status(202).json({
        queued: true,
        item: guard.item,
        note: `${guard.busy.length} cartridge(s) busy — the run was queued and starts when they are free`,
      });
    }
  }

  // Shape-check the upload before anything is cloned — a malformed payload should never
  // leave a half-created run behind.
  let attachments;
  try {
    attachments = parseAttachmentsInput(req.body?.attachments);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const now = new Date().toISOString();
  const isTemplate = !row.template_id;

  // Determine the workflow ID that will actually run
  let runId: string;

  if (isTemplate) {
    // ── Clone template into a new run ──────────────────
    const templateId = req.params.id;
    const runNum = (db.prepare('SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM workflows WHERE template_id = ?')
      .get(templateId) as { next: number }).next;
    runId = uuid();

    const projectId = (req.body?.projectId as string) || null;
    let initialContext = (req.body?.initialContext as string) || '';

    // Auto-inject recent project learnings into initial context
    if (projectId) {
      const learnings = db.prepare(
        `SELECT content, workflow_name FROM project_learnings WHERE project_id = ? ORDER BY created_at DESC LIMIT 3`
      ).all(projectId) as { content: string; workflow_name: string }[];
      if (learnings.length > 0) {
        const learningsBlock = [
          '## Recent Project Learnings',
          ...learnings.map((l, i) => `### ${i + 1}. From "${l.workflow_name}"\n${l.content.slice(0, 600)}${l.content.length > 600 ? '...' : ''}`),
          '---',
        ].join('\n\n');
        initialContext = learningsBlock + (initialContext ? '\n\n' + initialContext : '');
      }
    }

    db.prepare(`
      INSERT INTO workflows (id, name, jira_task_id, description, players, phases, status,
        current_phase, iteration, max_iterations, shared_context, initial_context, context_label, created_at, started_at, completed_at, error,
        target_repos, template_id, run_number)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, NULL, '',
        ?, ?, ?)
    `).run(
      runId,
      row.name, row.jira_task_id, row.description, row.players, row.phases,
      row.current_phase, row.iteration, row.max_iterations, row.shared_context, initialContext,
      // Derived HERE, beside the context it summarises. Deriving it at render time would make
      // every list row re-parse a paragraph, and two surfaces would drift on how they cut it.
      libelleContexte(initialContext),
      now, now,
      row.target_repos, templateId, runNum,
    );

    // Assign project immediately if provided
    if (projectId) {
      db.prepare('UPDATE workflows SET project_id = ? WHERE id = ?').run(projectId, runId);
    }

    // The run's posture. Explicit, because the column default cannot be changed on an existing
    // SQLite table and every real database is an existing one — see DEFAULT_AUTONOMY.
    db.prepare('UPDATE workflows SET autonomy = ? WHERE id = ?').run(DEFAULT_AUTONOMY, runId);

    // Clone steps with new IDs, remapping depends_on references
    const templateSteps = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?')
      .all(templateId) as Record<string, unknown>[];
    const oldToNew = new Map<string, string>();
    for (const s of templateSteps) {
      oldToNew.set(s.id as string, uuid());
    }

    const insertStep = db.prepare(`
      INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y,
        executor_type, executor_id, executor_config, auto_advance, depends_on, created_at,
        status, result, error, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', NULL, NULL)
    `);

    // Layout is recomputed for the run AFTER the rows land — see layoutSteps. This used to
    // declare its own STEP_SPACING = 230, one of four different spacings in the codebase.

    for (let i = 0; i < templateSteps.length; i++) {
      const s = templateSteps[i];
      const newStepId = oldToNew.get(s.id as string)!;
      const oldDeps: string[] = JSON.parse((s.depends_on as string) || '[]');
      const remappedDeps = oldDeps.map((d) => oldToNew.get(d)).filter(Boolean);
      insertStep.run(
        newStepId, runId,
        s.name, s.description,
        STEP_X, STEP_START_Y + i * STEP_SPACING_Y,
        s.executor_type, s.executor_id, s.executor_config, s.auto_advance,
        JSON.stringify(remappedDeps), now,
      );
    }

    // One authority for where a step sits, applied once the whole graph exists.
    layoutSteps(db, runId);
    console.log(`[workflow] Cloned template ${templateId} → run ${runId} (#${runNum}, ${templateSteps.length} steps)`);

    // Remap overrides from template step IDs to cloned step IDs
    const agentOverrides = req.body?.agentOverrides as Record<string, string> | undefined;
    if (agentOverrides) {
      const remapped: Record<string, string> = {};
      for (const [oldStepId, agentId] of Object.entries(agentOverrides)) {
        const newId = oldToNew.get(oldStepId);
        if (newId) remapped[newId] = agentId;
      }
      req.body.agentOverrides = remapped;
    }
    const promptOverrides = req.body?.promptOverrides as Record<string, Record<string, string>> | undefined;
    if (promptOverrides) {
      const remapped: Record<string, Record<string, string>> = {};
      for (const [oldStepId, fields] of Object.entries(promptOverrides)) {
        const newId = oldToNew.get(oldStepId);
        if (newId) remapped[newId] = fields;
      }
      req.body.promptOverrides = remapped;
    }
  } else {
    // ── Re-run an existing run in place ───────────────
    runId = req.params.id;
    const reRunCtx = (req.body?.initialContext as string) || '';
    // The label travels with the context it describes. A re-run with a NEW subject that kept the
    // old label would name the run after work it is no longer doing — the worst kind of stale,
    // because it looks correct.
    db.prepare("UPDATE workflows SET status = 'running', started_at = ?, completed_at = NULL, error = '', initial_context = ?, context_label = ? WHERE id = ?")
      .run(now, reRunCtx, libelleContexte(reRunCtx), runId);

    db.prepare(`
      UPDATE workflow_steps
      SET status = 'pending', result = '', error = '', started_at = NULL, completed_at = NULL
      WHERE workflow_id = ?
    `).run(runId);

    // Reset loop state. Every key a loop run writes, not just the counter: the resolved count
    // is read from a step that is about to run again and may count differently, and the last
    // report would otherwise be shown to the first dispatch of the new run as its own.
    const loopSteps = db.prepare(
      "SELECT id, executor_config FROM workflow_steps WHERE workflow_id = ?"
    ).all(runId) as { id: string; executor_config: string }[];
    for (const ls of loopSteps) {
      const config = parseExecutorConfig(ls.executor_config, ls.id);
      if (!LOOP_RUN_KEYS.some((k) => k in config)) continue;
      db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?').run(JSON.stringify(configForRerun(config)), ls.id);
    }
  }

  // ── Run-level cartridge: "run the whole thing on this one" ────────────────────────────
  // A workflow's steps are each assigned an executor, and a template can mark a step
  // `__deferred__` = "ask me at launch". Requiring the caller to name a cartridge for every
  // deferred step is busywork: in practice you pick one cartridge and the whole workflow runs
  // there. So `agentId` fills every step that hasn't got one.
  //
  // Applied BEFORE agentOverrides, so a per-step override still wins — the escape hatch for
  // the genuine cross-cartridge case survives.
  const runAgentId = (req.body?.agentId as string) || '';
  if (runAgentId) {
    const steps = db.prepare('SELECT id, executor_type, executor_id, executor_config FROM workflow_steps WHERE workflow_id = ?')
      .all(runId) as { id: string; executor_type: string; executor_id: string; executor_config: string }[];

    let filled = 0;
    for (const s of steps) {
      const needsExecutor = !s.executor_id || s.executor_id === '__deferred__';

      // A review-gate carries a SECOND agent in its config (the reviewer), which can be
      // deferred independently of the executor. Fill that too, or the run stalls at the gate
      // with no reviewer even though the user did pick a cartridge.
      const config = JSON.parse(s.executor_config || '{}') as Record<string, unknown>;
      const needsReviewer = config.reviewAgentId === '__deferred__';
      if (needsReviewer) config.reviewAgentId = runAgentId;

      if (!needsExecutor && !needsReviewer) continue;

      db.prepare('UPDATE workflow_steps SET executor_id = ?, executor_config = ? WHERE id = ?')
        .run(needsExecutor ? runAgentId : s.executor_id, JSON.stringify(config), s.id);
      filled++;
    }
    console.log(`[workflow] Run ${runId}: assigned cartridge ${runAgentId} to ${filled} unassigned step(s)`);
  }

  // Per-step engine pin: a step whose executor_config.agentType names an engine
  // (e.g. 'codex', 'gridlight') gets the matching LIVE cartridge in the workflow's
  // repo — this is what lets a template SAVE "step 1 → Claude, step 2 → Codex,
  // step 3 → Gridlight" instead of naming raw agent ids at launch. Runs after the
  // generic runAgentId fill (overrides it for pinned steps) and before
  // agentOverrides (an explicit per-step cartridge still wins).
  {
    let workflowRepo = '';
    if (runAgentId) {
      const a = db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(runAgentId) as { repo_path: string } | undefined;
      workflowRepo = a?.repo_path || '';
    }
    const engineSteps = db.prepare('SELECT id, executor_config, executor_type FROM workflow_steps WHERE workflow_id = ?')
      .all(runId) as { id: string; executor_config: string; executor_type: string }[];
    for (const s of engineSteps) {
      const config = JSON.parse(s.executor_config || '{}') as Record<string, unknown>;
      const wantType = typeof config.agentType === 'string' ? config.agentType : '';
      if (!wantType) continue;
      if (!workflowRepo) {
        const note = `Requested ${wantType} but the run has no repo to resolve against — ran on the pre-assigned agent`;
        recordStepNote(s.id, note);
        console.warn(`[workflow] step ${s.id}: ${note}`);
        continue;
      }
      // CAPABILITY ROUTING. Consult the measured profile before honouring a local pin.
      // Safe by construction: with no stored profile every function is UNMEASURED, and
      // UNMEASURED routes frontier — which is exactly the behaviour before this existed.
      // So on an unmeasured machine this block is a no-op.
      let effectiveType = wantType;
      let routingNote = '';
      if (wantType === 'gridlight') {
        // executor_type IS a registry function id ('claude-code', 'review-gate', ...), so
        // the step already tells us which function it performs. No new config needed, and
        // no defaulting every step to 'claude-code' and routing the wrong function.
        const functionId = s.executor_type || 'claude-code';
        // The model comes from the cartridge itself. Gridlight reports it at registration;
        // reading a settings key nobody writes made this whole block inert.
        const cartridge = db.prepare('SELECT model FROM agents WHERE repo_path = ? AND agent_type = ? AND status != ? ORDER BY last_seen DESC LIMIT 1')
          .get(workflowRepo, 'gridlight', 'offline') as { model: string } | undefined;
        const modelId = typeof config.modelId === 'string' ? config.modelId : (cartridge?.model || '');
        const profile = modelId ? loadProfile(modelId) : null;
        const decision = routeFunction(functionId, profile, modelId ? loadDemotions(modelId) : []);
        if (decision.engine === 'frontier') {
          effectiveType = 'claude';
          routingNote = `capability routing: ${functionId} -> frontier (${decision.state}: ${decision.reason})`;
          console.log(`[workflow] step ${s.id}: ${routingNote}`);
        }
      }

      const resolved = agentIdForRepoAndType(workflowRepo, effectiveType);
      if (resolved) {
        db.prepare('UPDATE workflow_steps SET executor_id = ? WHERE id = ?').run(resolved, s.id);
        if (routingNote) recordStepNote(s.id, routingNote);
        console.log(`[workflow] step ${s.id}: pinned to ${effectiveType} cartridge ${resolved}`);
      } else {
        // DO NOT FAIL SILENTLY. Previously this warned and `continue`d, leaving executor_id
        // untouched, so the step ran on whatever agent was already assigned while the run
        // reported success. That made a routing bug and a missing cartridge
        // indistinguishable — and it manufactured false evidence that local-first was
        // working when nothing had run locally.
        //
        // Keep running (a sleeping cartridge should not fail a workflow) but RECORD the
        // substitution where the UI already renders it, so the user can see it.
        const note = `Requested ${effectiveType}, ran on the pre-assigned agent — no live ${effectiveType} cartridge in ${workflowRepo}`;
        recordStepNote(s.id, note);
        console.warn(`[workflow] step ${s.id}: ${note}`);
      }
    }
  }

  // Apply deferred agent overrides to the run's steps (per-step; wins over agentId above)
  const agentOverrides = req.body?.agentOverrides as Record<string, string> | undefined;
  if (agentOverrides && Object.keys(agentOverrides).length > 0) {
    console.log(`[workflow] Applying ${Object.keys(agentOverrides).length} agent overrides for run ${runId}`);
    for (const [stepId, agentId] of Object.entries(agentOverrides)) {
      const step = db.prepare('SELECT executor_config FROM workflow_steps WHERE id = ? AND workflow_id = ?')
        .get(stepId, runId) as { executor_config: string } | undefined;
      if (!step) continue;
      const config = JSON.parse(step.executor_config || '{}');
      config._wasDeferred = true;
      db.prepare('UPDATE workflow_steps SET executor_id = ?, executor_config = ? WHERE id = ? AND workflow_id = ?')
        .run(agentId, JSON.stringify(config), stepId, runId);
    }
  }

  /**
   * RUN-LEVEL CONFER: two or more repos working the whole workflow together.
   *
   * REQUESTED: "select any of the workflow and have two repos confer on each step ... like
   * epic jira task would work together on completing tasks whichever repo owns the code
   * throughout."
   *
   * So this is not a step type and not a template — it is a MODE applied to whatever template
   * you already wanted to run. Every step that would have been dispatched to one cartridge is
   * rewritten to a `confer` step with these participants, and the question of which repo owns
   * a given piece is answered by the participants at each step. That is the only place it can
   * be answered: the template author does not know, and a scoping step deciding it up front
   * is exactly what made the earlier attempts wrong.
   *
   * ── WHY EACH TYPE IS TREATED THE WAY IT IS ────────────────────────────────────────────
   * Converting only the obvious type and ignoring the rest produces a half-collaborative run
   * — some steps conferred, some single-owner, no error anywhere — so every member of
   * StepExecutorType is a stated decision here:
   *
   *   'claude-code'    CONVERTED. The agent-work step; this is the whole point.
   *   'review-gate'    LEFT ALONE. A gate reads a PASS/FAIL verdict out of the result. A
   *   'quality-gate'   confer produces work, not a judgement, so converting these breaks the
   *                    gate — and it breaks as a gate that never passes, which reads as the
   *                    agents being bad rather than as a wiring mistake.
   *   'deliberation'   LEFT ALONE. Already multi-agent, with its own panel semantics.
   *   'confer'         LEFT ALONE. Already a confer; participants come from the step or from
   *                    conferOverrides below.
   *   'command'        LEFT ALONE. A shell command has no cartridge to confer with.
   *   'connector'      LEFT ALONE. Server-side action, no agent involved.
   *   'decision'       LEFT ALONE. Waits for a HUMAN. Converting it would quietly replace
   *                    your judgement with the agents' own.
   */
  const conferAllSteps = (req.body?.conferAllSteps as string[] | undefined)?.filter(Boolean) ?? [];
  if (conferAllSteps.length > 0) {
    if (conferAllSteps.length < 2) {
      return res.status(400).json({
        error: 'conferAllSteps needs at least 2 cartridges — a one-person confer is an ordinary dispatch.',
      });
    }
    const known = db.prepare(
      `SELECT id FROM agents WHERE id IN (${conferAllSteps.map(() => '?').join(',')})`,
    ).all(...conferAllSteps) as { id: string }[];
    const missing = conferAllSteps.filter((id) => !known.some((k) => k.id === id));
    if (missing.length > 0) {
      return res.status(400).json({ error: `No such cartridge(s): ${missing.join(', ')}` });
    }

    /**
     * What run-level confer gives each executor type comes from CONFER_FILL
     * (lib/workflow-launch.ts) — the SAME registry the door checks a moment earlier.
     *
     * It used to be declared here as `CONFER_CONVERSION` while the door kept its own Set of
     * four names, and the door runs first: 12 of 24 templates were refused for steps this
     * block would have handled perfectly well. One registry, both halves.
     */
    const rows = db.prepare('SELECT id, executor_type, executor_id, executor_config FROM workflow_steps WHERE workflow_id = ?')
      .all(runId) as { id: string; executor_type: string; executor_id: string; executor_config: string }[];

    // The judge for every single-cartridge step. First participant rather than a random one so
    // two runs of the same template are comparable, and so the choice is explainable.
    const judge = conferAllSteps[0];

    let converted = 0;
    let assigned = 0;
    for (const r of rows) {
      const fill = CONFER_FILL[r.executor_type as StepExecutorType];
      if (!fill || fill === 'none') continue;

      const config = JSON.parse(r.executor_config || '{}') as Record<string, unknown>;
      const awaiting = awaitsLaunchFill((r.executor_id ?? '').trim());

      if (fill === 'confer-all') {
        config.conferAgentIds = conferAllSteps;
        config.conferMode = config.conferMode ?? 'divide';
        config.conferIsolation = config.conferIsolation ?? 'shared';
        config._wasDeferred = true;
        // executor_id stops meaning anything for a confer step, and leaving a stale one behind
        // makes the run look single-owner on every surface that reads it.
        db.prepare('UPDATE workflow_steps SET executor_type = ?, executor_id = ?, executor_config = ? WHERE id = ?')
          .run('confer', '', JSON.stringify(config), r.id);
        converted += 1;
        continue;
      }

      // Everything below fills only what is still AWAITING a cartridge. A pin someone made
      // deliberately — or a stale one the door already refused — is never overwritten here.
      if (!awaiting) continue;

      if (fill === 'single') {
        // A gate is a single-judge verdict and a command step dispatches to one cartridge;
        // converting either would break what it is. They just need somebody.
        if (r.executor_type === 'review-gate' && !config.reviewAgentId) config.reviewAgentId = judge;
        db.prepare('UPDATE workflow_steps SET executor_id = ?, executor_config = ? WHERE id = ?')
          .run(judge, JSON.stringify(config), r.id);
        assigned += 1;
      } else if (fill === 'multi-if-empty') {
        // Already multi-agent. Its own roster wins; an EMPTY roster is what left the
        // confer-across-repos template unable to launch its own confer step.
        const key = r.executor_type === 'deliberation' ? 'panelAgentIds' : 'conferAgentIds';
        const existing = Array.isArray(config[key]) ? (config[key] as unknown[]).filter(Boolean) : [];
        if (existing.length < 2) config[key] = conferAllSteps;
        db.prepare('UPDATE workflow_steps SET executor_id = ?, executor_config = ? WHERE id = ?')
          .run('', JSON.stringify(config), r.id);
        assigned += 1;
      }
    }
    console.log(`[workflow] Run ${runId}: ${converted} step(s) converted to confer across `
      + `${conferAllSteps.length} cartridges, ${assigned} given a cartridge from the set`);
  }

  /**
   * Confer participants, per step.
   *
   * A confer step needs a LIST of cartridges, not the single executor `agentOverrides` sets —
   * that is the whole difference between "who runs this step" and "who works on it together".
   * Without this the step launches with an empty roster and refuses at dispatch, which is the
   * correct failure but a useless one if there is no way to supply them.
   */
  const conferOverrides = req.body?.conferOverrides as Record<string, string[]> | undefined;
  if (conferOverrides && Object.keys(conferOverrides).length > 0) {
    for (const [stepId, agentIds] of Object.entries(conferOverrides)) {
      if (!Array.isArray(agentIds)) continue;
      const stepRow = db.prepare('SELECT executor_config FROM workflow_steps WHERE id = ? AND workflow_id = ?')
        .get(stepId, runId) as { executor_config: string } | undefined;
      if (!stepRow) continue;
      const config = JSON.parse(stepRow.executor_config || '{}');
      config.conferAgentIds = agentIds.filter(Boolean);
      config._wasDeferred = true;
      db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ? AND workflow_id = ?')
        .run(JSON.stringify(config), stepId, runId);
    }
    console.log(`[workflow] Applied confer participants for ${Object.keys(conferOverrides).length} step(s) in run ${runId}`);
  }

  // Apply deferred prompt overrides
  const promptOverrides = req.body?.promptOverrides as Record<string, Record<string, string>> | undefined;
  if (promptOverrides && Object.keys(promptOverrides).length > 0) {
    console.log(`[workflow] Applying prompt overrides for ${Object.keys(promptOverrides).length} steps`);
    for (const [stepId, fields] of Object.entries(promptOverrides)) {
      const step = db.prepare('SELECT executor_config, description FROM workflow_steps WHERE id = ? AND workflow_id = ?')
        .get(stepId, runId) as { executor_config: string; description: string } | undefined;
      if (!step) continue;

      const config = JSON.parse(step.executor_config || '{}');
      config._deferredPrompts = Object.keys(fields);

      let description = step.description;
      for (const [field, value] of Object.entries(fields)) {
        if (field === 'intent.objective') {
          if (!config.intent) config.intent = {};
          config.intent.objective = value;
        } else if (field === 'prompt') {
          config.prompt = value;
          description = value;
        } else {
          config[field] = value;
        }
      }

      db.prepare('UPDATE workflow_steps SET executor_config = ?, description = ? WHERE id = ? AND workflow_id = ?')
        .run(JSON.stringify(config), description, stepId, runId);
    }
  }

  // ── Launch attachments ────────────────────────────────────────────────────────────────
  // Runs last: every step now has its final executor, so we know exactly which repos this
  // run touches and can drop a copy of each file into each one. The resulting repoPath →
  // block map is appended to every prompt this run dispatches (see dispatchStepCommand).
  if (attachments.length > 0) {
    // FROM THE SHARED RESOLVER, not an inline join on executor_id.
    //
    // That join is what produced "Cannot attach files: none of the selected cartridges has a
    // repo path" on every confer run that carried an attachment: the confer conversion empties
    // executor_id by design and puts the roster in executorConfig.conferAgentIds, so the join
    // matched nothing while all the cartridges sat right there with valid repo paths.
    const executorRows = workflowRepoTargets(runId).map((t) => ({
      repo_path: t.repoPath, machine: t.machine, repo_name: t.repoName,
    }));

    // An executor on another machine registered into this DB, but its repo_path lives on
    // that box. Writing files there is impossible from here, so say which machine rather
    // than letting fs.existsSync report a path the user has never seen.
    const offBox = executorRows.filter((r) => !isLocalMachine(r.machine));
    if (offBox.length > 0) {
      const machines = [...new Set(offBox.map((r) => machineLabel(r.machine)))].join(', ');
      const who = [...new Set(offBox.map((r) => r.repo_name || r.repo_path))].join(', ');
      const message =
        `Attachments cannot be sent to cartridges on another machine yet — ${who} runs on ${machines}. ` +
        `Run this workflow without attachments, or assign steps to cartridges on this machine.`;
      db.prepare("UPDATE workflows SET status = 'failed', error = ?, completed_at = ? WHERE id = ?")
        .run(message, new Date().toISOString(), runId);
      emitWorkflowUpdate(runId);
      return res.status(400).json({ error: message });
    }

    try {
      const blocks = materializeForRepos(executorRows.map((r) => r.repo_path), attachments);
      db.prepare('UPDATE workflows SET attachments = ? WHERE id = ?').run(JSON.stringify(blocks), runId);
      console.log(`[workflow] Run ${runId}: attached ${attachments.length} file(s) into ${Object.keys(blocks).length} repo(s)`);
    } catch (err) {
      // Fail the run rather than let it march on without the evidence it was launched with.
      const message = err instanceof Error ? err.message : String(err);
      db.prepare("UPDATE workflows SET status = 'failed', error = ?, completed_at = ? WHERE id = ?")
        .run(message, new Date().toISOString(), runId);
      emitWorkflowUpdate(runId);
      return res.status(400).json({ error: message });
    }
  }

  emitWorkflowUpdate(runId);

  const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(runId) as Record<string, unknown>;
  const stepRows = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(runId) as Record<string, unknown>[];
  res.json({ workflow: normalizeWorkflow(updated), steps: stepRows.map(normalizeStep) });
});

// Manually mark step as complete (for non-auto-advance steps or claude-code steps)
router.post('/v2/:id/steps/:stepId/complete', (req, res) => {
  const { result } = req.body;
  const now = new Date().toISOString();

  db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ? AND workflow_id = ?')
    .run('completed', result || '', now, req.params.stepId, req.params.id);

  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(req.params.stepId) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Step not found' });

  const step = normalizeStep(row);
  getIO().emit('workflow_step_updated', step);
  res.json(step);
});

// Record a human decision choice on a decision step
router.post('/v2/:id/steps/:stepId/decide', (req, res) => {
  const { optionId } = req.body;
  if (!optionId) return res.status(400).json({ error: 'optionId required' });

  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ? AND workflow_id = ?')
    .get(req.params.stepId, req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Step not found' });

  // Guarded: a gate whose config is unreadable must 400 with 'Unknown optionId', not 500.
  const config = parseExecutorConfig(row.executor_config as string, row.id as string);
  const options = (config.options as Array<{ id: string; label: string; description?: string; nextStepId?: string }>) || [];
  const chosen = options.find((o) => o.id === optionId);
  if (!chosen) return res.status(400).json({ error: 'Unknown optionId' });

  const resultText = JSON.stringify({ choice: chosen.label, optionId: chosen.id, description: chosen.description || '' });
  const now = new Date().toISOString();

  db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
    .run('completed', resultText, now, req.params.stepId);

  const updated = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(req.params.stepId) as Record<string, unknown>;
  const step = normalizeStep(updated);
  getIO().emit('workflow_step_updated', step);
  res.json(step);
});

// Advance a completed step (set auto_advance = 1 so dependents can proceed)
router.post('/v2/:id/steps/:stepId/advance', (req, res) => {
  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ? AND workflow_id = ?')
    .get(req.params.stepId, req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Step not found' });

  db.prepare('UPDATE workflow_steps SET auto_advance = 1 WHERE id = ?')
    .run(req.params.stepId);

  const updated = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(req.params.stepId) as Record<string, unknown>;
  const step = normalizeStep(updated);
  getIO().emit('workflow_step_updated', step);
  res.json(step);
});

// Force-complete a running workflow: complete running steps, skip pending ones
router.post('/v2/:id/complete', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Workflow not found' });
  if ((row.status as string) !== 'running') {
    return res.status(400).json({ error: `Workflow is not running (status: ${row.status})` });
  }

  const now = new Date().toISOString();

  // Complete any running steps
  db.prepare(`
    UPDATE workflow_steps SET status = 'completed', result = 'Force-completed manually', completed_at = ?, auto_advance = 1
    WHERE workflow_id = ? AND status = 'running'
  `).run(now, req.params.id);

  // Skip any remaining pending steps
  db.prepare(`
    UPDATE workflow_steps SET status = 'skipped', completed_at = ?
    WHERE workflow_id = ? AND status = 'pending'
  `).run(now, req.params.id);

  // Mark workflow as completed
  db.prepare("UPDATE workflows SET status = 'completed', completed_at = ? WHERE id = ?").run(now, req.params.id);

  // Emit updates for all steps
  const stepRows = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(req.params.id) as Record<string, unknown>[];
  for (const sr of stepRows) {
    getIO().emit('workflow_step_updated', normalizeStep(sr));
  }

  getIO().emit('workflow_step_log', {
    workflowId: req.params.id,
    stepId: '',
    stepName: 'Workflow',
    message: 'Workflow force-completed manually',
    type: 'success',
    timestamp: now,
  });
  recordJournal({
    workflowId: req.params.id,
    stepName: 'Workflow',
    eventType: 'success',
    message: 'Workflow force-completed manually',
    createdAt: now,
  });

  console.log(`[workflow-v2] Workflow ${req.params.id} force-completed`);
  emitWorkflowUpdate(req.params.id);

  const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalizeWorkflow(updated));
});

// Skip a specific step (mark as skipped so dependents are unblocked)
router.post('/v2/:id/steps/:stepId/skip', (req, res) => {
  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ? AND workflow_id = ?')
    .get(req.params.stepId, req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Step not found' });

  const now = new Date().toISOString();
  db.prepare('UPDATE workflow_steps SET status = ?, completed_at = ?, auto_advance = 1 WHERE id = ?')
    .run('skipped', now, req.params.stepId);

  const updated = normalizeStep(
    db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(req.params.stepId) as Record<string, unknown>
  );
  getIO().emit('workflow_step_updated', updated);

  getIO().emit('workflow_step_log', {
    workflowId: req.params.id,
    stepId: updated.id,
    stepName: updated.name,
    message: 'Step skipped manually',
    type: 'warn',
    timestamp: now,
  });
  recordJournal({
    workflowId: req.params.id,
    stepId: updated.id,
    stepName: updated.name,
    eventType: 'warn',
    message: 'Step skipped manually',
    createdAt: now,
  });

  res.json(updated);
});

/** Cap on a reported result. Long enough for a full review; short enough that a runaway
 *  agent (or a bad actor) can't wedge a multi-megabyte blob into SQLite. */
const MAX_RESULT_CHARS = 200_000;

/** Validate the `result` field of a completion signal. Returns an error string, or null. */
function validateResult(result: unknown): string | null {
  if (result === undefined || result === null) return null; // optional — a default is used
  if (typeof result !== 'string') return 'result must be a string';
  if (result.length > MAX_RESULT_CHARS) return `result exceeds ${MAX_RESULT_CHARS} characters`;
  return null;
}

// Webhook: the agent reports that a step is complete (only needs step ID).
// This is THE completion path — steps are never completed by inferring it from agent idleness.
// Gate verdicts (PASS/FAIL), retries and loop re-dispatch are all routed by completeStepFromSignal.
// Usage: curl -X POST http://localhost:4040/api/workflows/webhook/<stepId>/complete -H 'Content-Type: application/json' -d '{"result": "done"}'
/**
 * The completion report, coming back from the cartridge.
 *
 * The report step writes `workflow-report.json` and `.html` to `.neoncore/reports/<runId>/` on
 * the cartridge's own disk — which is the right place for the agent to work, and a place the
 * app can never read. Without this endpoint NeonCore supplies the run record that goes INTO the
 * report and then never learns what came out, which is why the reports appeared not to work.
 *
 * The JSON is stored verbatim. It is the structured half of a document whose whole design point
 * is that the HTML is rendered FROM it, so summarising it here would throw away the reason it
 * exists. The project is resolved from the executing cartridge's repo name, matching how
 * project_knowledge and the journal routes are keyed.
 */
/**
 * The report files a run wrote, on the cartridge's own disk.
 *
 * THE THIRD INGEST PATH, and the only one that needs no cooperation from the agent. A report
 * was found sitting complete at
 *   /Users/…/gl-dev-lane-b-gateway-api/.neoncore/reports/<runId>/workflow-report.html
 * while the journal was empty, because delivery had been built entirely as "the agent must POST
 * it" and that run's prompt predated the POST instruction. For a cartridge on THIS machine the
 * server can simply read it.
 *
 * Local machines only: a cartridge registered from another box reports a repo_path that does
 * not exist here, and fs would be answering about the wrong disk (see lib/machine-locality.ts).
 */
function reportDir(workflowId: string, executorId: string): string | null {
  const agent = db.prepare('SELECT repo_path, machine FROM agents WHERE id = ?')
    .get(executorId) as { repo_path?: string; machine?: string } | undefined;
  const repo = (agent?.repo_path || '').trim();
  if (!repo || !isLocalMachine(agent?.machine)) return null;
  return path.join(repo, '.neoncore', 'reports', workflowId);
}

function findReportHtml(workflowId: string, executorId: string): string {
  const dir = reportDir(workflowId, executorId);
  if (!dir) return '';
  const html = path.join(dir, 'workflow-report.html');
  try { return fs.existsSync(html) ? html : ''; } catch { return ''; }
}

/**
 * Read a run's report off disk when the agent did not send one.
 *
 * Called on step completion, AFTER any posted report — a posted report is the agent's own
 * account and wins; this is the safety net, not the source of truth.
 */
export function backfillReportsFromDisk(): number {
  // Every completed report step that never delivered. Reports written before the return path
  // existed are sitting on disk complete — one was found at
  // gl-dev-lane-b-gateway-api/.neoncore/reports/<runId>/workflow-report.html while the journal
  // showed nothing. Nothing about them is unreachable; they were simply never asked for.
  const steps = db.prepare(
    `SELECT s.id FROM workflow_steps s
      WHERE s.status = 'completed'
        AND s.executor_config LIKE '%workflow-report%'
        AND NOT EXISTS (SELECT 1 FROM workflow_reports r WHERE r.step_id = s.id)`,
  ).all() as { id: string }[];
  let found = 0;
  for (const s of steps) {
    ingestReportFromDisk(s.id);
    if (db.prepare('SELECT 1 FROM workflow_reports WHERE step_id = ?').get(s.id)) found++;
  }
  return found;
}

function ingestReportFromDisk(stepId: string): void {
  try {
    const step = db.prepare('SELECT id, workflow_id, executor_id FROM workflow_steps WHERE id = ?')
      .get(stepId) as { id: string; workflow_id: string; executor_id: string } | undefined;
    if (!step) return;
    if (db.prepare('SELECT 1 FROM workflow_reports WHERE step_id = ?').get(stepId)) return;

    const dir = reportDir(step.workflow_id, step.executor_id);
    if (!dir) return;
    const jsonPath = path.join(dir, 'workflow-report.json');
    if (!fs.existsSync(jsonPath)) return;

    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const stored = storeStepReport(stepId, parsed, findReportHtml(step.workflow_id, step.executor_id));
    if (stored) console.log(`[workflow] Report read from disk for step ${stepId.slice(0, 8)} → ${dir}`);
  } catch (err) {
    // Never let this fail a completion. A missing or malformed report on disk is a report we
    // do not have, not a step that did not finish.
    console.warn(`[workflow] Could not read a report from disk for ${stepId}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Store a completion report against its step. ONE implementation, both callers.
 *
 * Two of them reach here: the dedicated endpoint below (for an engine with no MCP) and the
 * step-completion webhook, which is where `neoncore_report_step_done` posts. The second is the
 * one that matters — the agent MUST call it or the step never completes, so carrying the report
 * there makes delivery part of a call it cannot skip. The first version had only the dedicated
 * endpoint and relied on the agent remembering a second, optional curl; a completed run proved
 * the cost, with both files on disk and `workflow_reports` empty.
 *
 * Returns null when there is nothing storable. NEVER throws: a report riding along with a
 * completion must not be able to fail the completion. Losing a report is recoverable; losing
 * the completion strands the workflow.
 */
function storeStepReport(stepId: string, report: unknown, htmlPath = ''): { id: string; project: string } | null {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  try {
    const step = db.prepare(
      'SELECT id, workflow_id, executor_id FROM workflow_steps WHERE id = ?',
    ).get(stepId) as { id: string; workflow_id: string; executor_id: string } | undefined;
    if (!step) return null;

    const wf = db.prepare('SELECT name, run_number FROM workflows WHERE id = ?')
      .get(step.workflow_id) as { name: string; run_number: number } | undefined;
    const agent = db.prepare('SELECT repo_name FROM agents WHERE id = ?')
      .get(step.executor_id) as { repo_name: string } | undefined;

    const header = (report as Record<string, unknown>).header as Record<string, unknown> | undefined;
    const status = typeof header?.overallStatus === 'string' ? header.overallStatus : '';

    // Replace on retry. A second attempt at the same step is a corrected report, not another.
    db.prepare(
      `INSERT INTO workflow_reports (id, project, workflow_id, step_id, workflow_name, run_number, status, report, html_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(step_id) DO UPDATE SET
         report = excluded.report, status = excluded.status, created_at = excluded.created_at,
         -- Keep a known html path when a later post does not carry one; losing the link to the
         -- readable half because a retry omitted it would be a silent downgrade.
         html_path = CASE WHEN excluded.html_path != '' THEN excluded.html_path ELSE workflow_reports.html_path END`,
    ).run(
      uuid(), agent?.repo_name || '', step.workflow_id, step.id,
      wf?.name || '', wf?.run_number ?? 0, status, JSON.stringify(report),
      htmlPath || findReportHtml(step.workflow_id, step.executor_id),
      new Date().toISOString(),
    );

    const row = db.prepare('SELECT id FROM workflow_reports WHERE step_id = ?').get(step.id) as { id: string };
    console.log(`[workflow] Report stored for ${wf?.name || step.workflow_id} → project "${agent?.repo_name || '(none)'}"`);
    getIO().emit('workflow_report_stored', { id: row.id, project: agent?.repo_name || '', workflowId: step.workflow_id });
    return { id: row.id, project: agent?.repo_name || '' };
  } catch (err) {
    console.error(`[workflow] Could not store report for step ${stepId}:`, err);
    return null;
  }
}

/**
 * The dedicated report endpoint — the fallback for an engine with no MCP tooling, and the one
 * the canned prompt's curl targets.
 */
router.post('/webhook/:stepId/report', (req, res) => {
  const step = db.prepare('SELECT id FROM workflow_steps WHERE id = ?').get(req.params.stepId);
  if (!step) return res.status(404).json({ error: 'Step not found' });

  const stored = storeStepReport(req.params.stepId, req.body?.report);
  if (!stored) {
    return res.status(400).json({ error: 'report must be the workflow-report.json object' });
  }
  res.status(201).json(stored);
});

router.post('/webhook/:stepId/complete', (req, res) => {
  const { result, scope, verify, deferred } = req.body || {};

  // A completion may CARRY the run's report. Stored best-effort and never allowed to fail the
  // completion — see storeStepReport. This is the path neoncore_report_step_done uses, which is
  // the call an agent cannot skip, so it is the reliable half of report delivery.
  if (req.body?.report) storeStepReport(req.params.stepId, req.body.report);
  // …and if nothing was posted, look on the cartridge's disk. This is the path that needs no
  // agent cooperation at all, and the one that would have caught every report written so far.
  ingestReportFromDisk(req.params.stepId);
  const invalid = validateResult(result);
  if (invalid) return res.status(400).json({ error: invalid });

  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?')
    .get(req.params.stepId) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Step not found' });

  const step = normalizeStep(row);
  if (step.status !== 'running') {
    return res.status(400).json({ error: `Step is not running (current status: ${step.status})` });
  }

  // Work-standard check — WORK steps only.
  //
  // Gates (review-gate / quality-gate) speak a different protocol: their result must start
  // with PASS or FAIL and is parsed as a verdict, not a completion report. Demanding a
  // scope/verify pair from a critic that was asked to judge someone else's work would be
  // incoherent, and would break every existing gate. Deliberation panels report through
  // their own endpoint and never reach here.
  const WORK_STEP_TYPES = new Set(['claude-code', 'command', '']);
  let standardNote = '';
  if (WORK_STEP_TYPES.has(step.executorType)) {
    const check = validateCompletionPayload({ result, scope, verify, deferred });
    if (!check.ok) {
      // 400 leaves the step RUNNING on purpose: the agent must come back with real
      // verification rather than the workflow advancing on an unverified claim.
      return res.status(400).json({ error: check.reason });
    }
    standardNote = `\n\n---\nscope: ${check.block.scope}\nverify: ${check.block.verify}\ndeferred: ${check.block.deferred}`;
  }

  // Prepend captured plan content (from ExitPlanMode with plansIncluded) if present
  const planContent = (row.plan_content as string) || '';
  const baseResult = (result || 'Completed via webhook') + standardNote;
  const finalResult = planContent
    ? `[Plan]\n${planContent}\n\n[Implementation Summary]\n${baseResult}`
    : baseResult;

  const tokensIn = Math.round(((row.dispatched_prompt as string) || '').length / 4);
  const tokensOut = Math.round(finalResult.length / 4);
  db.prepare('UPDATE workflow_steps SET tokens_in = ?, tokens_out = ? WHERE id = ?')
    .run(tokensIn, tokensOut, step.id);

  // ── UPSTREAM COUNT GATE (LOOP-001) ──────────────────────────────────────────────────
  //
  // If a sibling step sizes its loop by reading a number out of THIS step's result, that
  // number is a condition of completion. Without it `explainLoopCount` falls back to a budget
  // of 1 and the dependent loop works one task and reports a clean finish — 10 of the 27 epic
  // loops dispatched on this machine died exactly that way. The engine logged a warning each
  // time, which nobody read until after the run it should have stopped.
  //
  // Validated against `finalResult` rather than the raw body: that is what gets STORED, and
  // therefore precisely what the reader will later parse. Gating on a different string than
  // the parser sees is how a gate lets through the very thing it exists to catch.
  const siblings = (db.prepare(
    'SELECT name, executor_config FROM workflow_steps WHERE workflow_id = ? AND id != ?'
  ).all(row.workflow_id as string, step.id) as { name: string; executor_config: string }[])
    .map((r) => {
      let config: LoopConfig = {};
      try { config = JSON.parse(r.executor_config || '{}'); } catch { /* unreadable config owes nothing */ }
      return { name: r.name, config };
    });

  const owed = validateUpstreamCount(finalResult, loopCountRequirements(step.name, siblings));
  if (!owed.ok) {
    // 400 leaves the step RUNNING, same as the work-standard gate: the agent comes back with
    // the count rather than the workflow advancing on a budget it knows is wrong.
    return res.status(400).json({ error: owed.reason });
  }

  if (!completeStepFromSignal(step.id, finalResult)) {
    return res.status(409).json({ error: 'Step could not be completed (no longer running)' });
  }

  const updated = normalizeStep(
    db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(step.id) as Record<string, unknown>
  );
  res.json(updated);
});

// Webhook: one member of a deliberation panel submits its response. Panel members all
// report against the same step, so each gets its own channel — otherwise the first to
// answer would complete the step on everyone else's behalf.
// Usage: curl -X POST http://localhost:4040/api/workflows/webhook/<stepId>/panel/<agentId>/complete -d '{"result": "..."}'
router.post('/webhook/:stepId/panel/:agentId/complete', (req, res) => {
  const { result } = req.body || {};
  const invalid = validateResult(result);
  if (invalid) return res.status(400).json({ error: invalid });

  const accepted = recordPanelResult(
    req.params.stepId,
    req.params.agentId,
    (result as string) || 'Panel member reported no output',
  );
  if (!accepted) {
    return res.status(400).json({
      error: 'Not an active deliberation step awaiting this panel member',
    });
  }

  const updated = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(req.params.stepId) as Record<string, unknown>;
  res.json(normalizeStep(updated));
});

// Resume an interrupted step (human-gated recovery). Rebuilds context from the
// stored transcript and re-dispatches it to the step's agent. Idempotent via a
// CAS on recovery_status inside recoverStep.
/**
 * Set a run's autonomy — the dashboard's half of N4.
 *
 * A raise REQUIRES a duration. "I'm willing to take the risk" is nearly always bounded risk,
 * and a mode you forget to flip back is not bounded. Lowering to 'manual' needs no window.
 */
router.put('/v2/:id/autonomy', (req, res) => {
  const { level, durationMs } = req.body || {};
  if (!isAutonomyLevel(level) || !SETTABLE_LEVELS.includes(level)) {
    return res.status(400).json({ error: `level must be one of: ${SETTABLE_LEVELS.join(', ')}` });
  }
  const row = db.prepare('SELECT id FROM workflows WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Workflow not found' });

  const ms = Number(durationMs);
  if (level !== 'manual' && (!Number.isFinite(ms) || ms <= 0)) {
    return res.status(400).json({ error: 'Raising autonomy requires a positive durationMs' });
  }

  setWorkflowAutonomy(req.params.id, level, level === 'manual' ? null : Date.now() + ms);
  res.json({ ok: true, ...effectiveAutonomy(req.params.id) });
});

/** What is in force, where it came from, and what it has already decided. */
router.get('/v2/:id/autonomy', (req, res) => {
  const row = db.prepare('SELECT id FROM workflows WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Workflow not found' });
  res.json({ ...effectiveAutonomy(req.params.id), resolutions: listAutoResolutions(req.params.id, 10) });
});

router.post('/steps/:stepId/recover', (req, res) => {
  const result = recoverStep(req.params.stepId);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

export default router;
