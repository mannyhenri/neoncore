import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Workflow, WorkflowPlayer, WorkflowPhaseState, WorkflowStatus, WorkflowStep } from '../types.js';

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
    createdAt: (row.created_at ?? '') as string,
    startedAt: (row.started_at ?? '') as string,
    completedAt: (row.completed_at as string) || null,
    error: (row.error ?? '') as string,
  };
}

function emitWorkflowUpdate(id: string) {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (row) getIO().emit('workflow_updated', normalizeWorkflow(row));
}

function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
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

    // Validate API model config
    if (player.playerType === 'openai') {
      if (!getSetting('openai_api_key')) {
        return res.status(400).json({ error: 'OpenAI API key not configured. Set it in Settings.' });
      }
      if (!player.modelId) return res.status(400).json({ error: 'OpenAI players need a modelId' });
    }

    if (player.playerType === 'gridlight-gateway') {
      if (!player.modelId) return res.status(400).json({ error: 'GridLight players need a modelId' });
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
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM workflows ORDER BY created_at DESC LIMIT 50')
    .all() as Record<string, unknown>[];
  const workflows = rows.map((row) => {
    const wf: Record<string, unknown> = { ...normalizeWorkflow(row) };
    // Attach step summary for V2 canvas workflows
    const stepRows = db.prepare('SELECT name, status FROM workflow_steps WHERE workflow_id = ? ORDER BY created_at')
      .all(wf.id as string) as { name: string; status: string }[];
    if (stepRows.length > 0) {
      wf.stepSummary = {
        total: stepRows.length,
        completed: stepRows.filter((s) => s.status === 'completed').length,
        running: stepRows.filter((s) => s.status === 'running').length,
        failed: stepRows.filter((s) => s.status === 'failed').length,
        pending: stepRows.filter((s) => s.status === 'pending').length,
        stepNames: stepRows.map((s) => s.name),
      };
    }
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

// List available API models
router.get('/models', (_req, res) => {
  const openaiKey = getSetting('openai_api_key');
  const openaiModels = getSetting('openai_models') || 'gpt-4.1,gpt-4.1-mini';
  const gridlightModels = getSetting('gridlight_models') || '';

  res.json({
    openai: openaiKey ? openaiModels.split(',').map((m) => m.trim()).filter(Boolean) : [],
    gridlight: gridlightModels ? gridlightModels.split(',').map((m) => m.trim()).filter(Boolean) : [],
  });
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
    dependsOn: JSON.parse((row.depends_on as string) || '[]'),
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
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

// Start V2 workflow
router.post('/v2/:id/start', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Workflow not found' });

  const now = new Date().toISOString();
  db.prepare("UPDATE workflows SET status = 'running', started_at = ?, completed_at = NULL WHERE id = ?").run(now, req.params.id);

  // Reset all step statuses so the workflow runs from scratch
  db.prepare(`
    UPDATE workflow_steps
    SET status = 'pending', result = '', error = '', started_at = NULL, completed_at = NULL
    WHERE workflow_id = ?
  `).run(req.params.id);

  // Apply deferred agent overrides (steps that had "Choose when running")
  // Store overrides in executor_config so we can restore __deferred__ after completion
  const agentOverrides = req.body?.agentOverrides as Record<string, string> | undefined;
  if (agentOverrides && Object.keys(agentOverrides).length > 0) {
    console.log(`[workflow] Applying ${Object.keys(agentOverrides).length} agent overrides for workflow ${req.params.id}`);
    for (const [stepId, agentId] of Object.entries(agentOverrides)) {
      console.log(`[workflow]   Step ${stepId} -> agent ${agentId}`);
      // Mark as originally deferred in executor_config
      const step = db.prepare('SELECT executor_config FROM workflow_steps WHERE id = ?').get(stepId) as { executor_config: string } | undefined;
      const config = JSON.parse(step?.executor_config || '{}');
      config._wasDeferred = true;
      db.prepare('UPDATE workflow_steps SET executor_id = ?, executor_config = ? WHERE id = ? AND workflow_id = ?')
        .run(agentId, JSON.stringify(config), stepId, req.params.id);
    }
  }

  // Apply deferred prompt overrides (empty prompt fields filled at runtime)
  const promptOverrides = req.body?.promptOverrides as Record<string, Record<string, string>> | undefined;
  if (promptOverrides && Object.keys(promptOverrides).length > 0) {
    console.log(`[workflow] Applying prompt overrides for ${Object.keys(promptOverrides).length} steps`);
    for (const [stepId, fields] of Object.entries(promptOverrides)) {
      const step = db.prepare('SELECT executor_config, description FROM workflow_steps WHERE id = ? AND workflow_id = ?')
        .get(stepId, req.params.id) as { executor_config: string; description: string } | undefined;
      if (!step) continue;

      const config = JSON.parse(step.executor_config || '{}');
      // Track which fields were deferred for restoration after completion
      config._deferredPrompts = Object.keys(fields);

      let description = step.description;
      for (const [field, value] of Object.entries(fields)) {
        if (field === 'intent.objective') {
          // Nested in intent object
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
        .run(JSON.stringify(config), description, stepId, req.params.id);
    }
  }

  emitWorkflowUpdate(req.params.id);

  const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  const stepRows = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(req.params.id) as Record<string, unknown>[];
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

  res.json(updated);
});

// Webhook: external process marks a step as complete (only needs step ID)
// Usage: curl -X POST http://localhost:4040/api/workflows/webhook/<stepId>/complete -H 'Content-Type: application/json' -d '{"result": "done"}'
router.post('/webhook/:stepId/complete', (req, res) => {
  const { result } = req.body || {};
  const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?')
    .get(req.params.stepId) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Step not found' });

  const step = normalizeStep(row);
  if (step.status !== 'running') {
    return res.status(400).json({ error: `Step is not running (current status: ${step.status})` });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE workflow_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
    .run('completed', result || 'Completed via webhook', now, step.id);

  const updated = normalizeStep(
    db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(step.id) as Record<string, unknown>
  );
  getIO().emit('workflow_step_updated', updated);

  // Emit log
  getIO().emit('workflow_step_log', {
    workflowId: step.workflowId,
    stepId: step.id,
    stepName: step.name,
    message: 'Completed via external webhook',
    type: 'success',
    timestamp: now,
  });

  console.log(`[workflow-v2] Step "${step.name}" completed via webhook`);
  res.json(updated);
});

export default router;
