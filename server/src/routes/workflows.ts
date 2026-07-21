import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Workflow, WorkflowPlayer, WorkflowPhaseState, WorkflowStatus, WorkflowStep } from '../types.js';
import { sendCommandToAgent } from '../lib/send-command.js';
import { agentIdForRepoAndType } from '../lib/resolve-agent.js';
import { recoverStep } from '../lib/recovery.js';
import { completeStepFromSignal, recordPanelResult } from '../lib/workflow-executor-v2.js';
import { recordJournal } from '../lib/workflow-journal.js';

const router = Router();

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

// Create V2 workflow with steps
router.post('/v2/create', (req, res) => {
  const { name, description, targetRepos, steps } = req.body;

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

  const workflow = normalizeWorkflow(
    db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as Record<string, unknown>
  );
  res.status(201).json({ workflow, steps: createdSteps });
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
        current_phase, iteration, max_iterations, shared_context, initial_context, created_at, started_at, completed_at, error,
        target_repos, template_id, run_number)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, NULL, '',
        ?, ?, ?)
    `).run(
      runId,
      row.name, row.jira_task_id, row.description, row.players, row.phases,
      row.current_phase, row.iteration, row.max_iterations, row.shared_context, initialContext,
      now, now,
      row.target_repos, templateId, runNum,
    );

    // Assign project immediately if provided
    if (projectId) {
      db.prepare('UPDATE workflows SET project_id = ? WHERE id = ?').run(projectId, runId);
    }

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

    // Recompute linear layout for the run — use fixed spacing so edges are always visible,
    // regardless of how tightly the template steps may have been saved.
    const STEP_SPACING = 230;
    const START_Y = 80;
    const FIXED_X = 300;

    for (let i = 0; i < templateSteps.length; i++) {
      const s = templateSteps[i];
      const newStepId = oldToNew.get(s.id as string)!;
      const oldDeps: string[] = JSON.parse((s.depends_on as string) || '[]');
      const remappedDeps = oldDeps.map((d) => oldToNew.get(d)).filter(Boolean);
      insertStep.run(
        newStepId, runId,
        s.name, s.description,
        FIXED_X, START_Y + i * STEP_SPACING,
        s.executor_type, s.executor_id, s.executor_config, s.auto_advance,
        JSON.stringify(remappedDeps), now,
      );
    }

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
    db.prepare("UPDATE workflows SET status = 'running', started_at = ?, completed_at = NULL, error = '', initial_context = ? WHERE id = ?").run(now, reRunCtx, runId);

    db.prepare(`
      UPDATE workflow_steps
      SET status = 'pending', result = '', error = '', started_at = NULL, completed_at = NULL
      WHERE workflow_id = ?
    `).run(runId);

    // Reset loop counters
    const loopSteps = db.prepare(
      "SELECT id, executor_config FROM workflow_steps WHERE workflow_id = ? AND executor_config LIKE '%_currentLoop%'"
    ).all(runId) as { id: string; executor_config: string }[];
    for (const ls of loopSteps) {
      const config = JSON.parse(ls.executor_config);
      delete config._currentLoop;
      db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?').run(JSON.stringify(config), ls.id);
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
    const engineSteps = db.prepare('SELECT id, executor_config FROM workflow_steps WHERE workflow_id = ?')
      .all(runId) as { id: string; executor_config: string }[];
    for (const s of engineSteps) {
      const config = JSON.parse(s.executor_config || '{}') as Record<string, unknown>;
      const wantType = typeof config.agentType === 'string' ? config.agentType : '';
      if (!wantType) continue;
      if (!workflowRepo) {
        console.warn(`[workflow] step ${s.id}: agentType='${wantType}' but no repo to resolve against — launch with a cartridge.`);
        continue;
      }
      const resolved = agentIdForRepoAndType(workflowRepo, wantType);
      if (resolved) {
        db.prepare('UPDATE workflow_steps SET executor_id = ? WHERE id = ?').run(resolved, s.id);
        console.log(`[workflow] step ${s.id}: pinned to ${wantType} cartridge ${resolved}`);
      } else {
        console.warn(`[workflow] step ${s.id}: no live ${wantType} cartridge in ${workflowRepo} — start one, or override at launch.`);
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

  const config = JSON.parse((row.executor_config as string) || '{}');
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
router.post('/webhook/:stepId/complete', (req, res) => {
  const { result } = req.body || {};
  const invalid = validateResult(result);
  if (invalid) return res.status(400).json({ error: invalid });

  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?')
    .get(req.params.stepId) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Step not found' });

  const step = normalizeStep(row);
  if (step.status !== 'running') {
    return res.status(400).json({ error: `Step is not running (current status: ${step.status})` });
  }

  // Prepend captured plan content (from ExitPlanMode with plansIncluded) if present
  const planContent = (row.plan_content as string) || '';
  const finalResult = planContent
    ? `[Plan]\n${planContent}\n\n[Implementation Summary]\n${result || 'Completed via webhook'}`
    : (result || 'Completed via webhook');

  const tokensIn = Math.round(((row.dispatched_prompt as string) || '').length / 4);
  const tokensOut = Math.round(finalResult.length / 4);
  db.prepare('UPDATE workflow_steps SET tokens_in = ?, tokens_out = ? WHERE id = ?')
    .run(tokensIn, tokensOut, step.id);

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
router.post('/steps/:stepId/recover', (req, res) => {
  const result = recoverStep(req.params.stepId);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

export default router;
