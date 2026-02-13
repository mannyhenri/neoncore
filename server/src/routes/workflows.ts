import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import { sendCommandToAgent } from '../lib/send-command.js';
import type { WorkflowTemplate, WorkflowRun, WorkflowStepState } from '../types.js';

const router = Router();

// ─── Template CRUD ───────────────────────────────────

router.get('/templates', (_req, res) => {
  const rows = db.prepare('SELECT * FROM workflow_templates ORDER BY updated_at DESC')
    .all() as Record<string, unknown>[];
  res.json(rows.map(normalizeTemplate));
});

router.post('/templates', (req, res) => {
  const { name, description, steps, autoRun, intervalMinutes, triggerWhen } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workflow_templates (id, name, description, steps, auto_run, interval_minutes, trigger_when, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, description || '', JSON.stringify(steps || []), autoRun ? 1 : 0, intervalMinutes || 60, triggerWhen || 'idle', now, now);

  const row = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(normalizeTemplate(row));
});

router.put('/templates/:id', (req, res) => {
  const { name, description, steps, autoRun, intervalMinutes, triggerWhen } = req.body;
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT id FROM workflow_templates WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Template not found' });

  db.prepare(`
    UPDATE workflow_templates SET name = ?, description = ?, steps = ?, auto_run = ?, interval_minutes = ?, trigger_when = ?, updated_at = ? WHERE id = ?
  `).run(name, description || '', JSON.stringify(steps || []), autoRun ? 1 : 0, intervalMinutes || 60, triggerWhen || 'idle', now, req.params.id);

  const row = db.prepare('SELECT * FROM workflow_templates WHERE id = ?')
    .get(req.params.id) as Record<string, unknown>;
  res.json(normalizeTemplate(row));
});

// Toggle auto-run on/off (quick action from template list)
router.patch('/templates/:id/auto-run', (req, res) => {
  const { autoRun, intervalMinutes, triggerWhen } = req.body;
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT id FROM workflow_templates WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Template not found' });

  const updates: string[] = ['auto_run = ?', 'updated_at = ?'];
  const values: unknown[] = [autoRun ? 1 : 0, now];
  if (intervalMinutes !== undefined) { updates.push('interval_minutes = ?'); values.push(intervalMinutes); }
  if (triggerWhen !== undefined) { updates.push('trigger_when = ?'); values.push(triggerWhen); }
  values.push(req.params.id);

  db.prepare(`UPDATE workflow_templates SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM workflow_templates WHERE id = ?')
    .get(req.params.id) as Record<string, unknown>;
  res.json(normalizeTemplate(row));
});

router.delete('/templates/:id', (req, res) => {
  // Delete related runs first (FK constraint)
  db.prepare('DELETE FROM workflow_runs WHERE template_id = ?').run(req.params.id);
  db.prepare('DELETE FROM workflow_templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Run Management ──────────────────────────────────

router.post('/run', (req, res) => {
  const { templateId } = req.body;
  if (!templateId) return res.status(400).json({ error: 'templateId required' });

  const template = db.prepare('SELECT * FROM workflow_templates WHERE id = ?')
    .get(templateId) as Record<string, unknown> | undefined;
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const steps: { command: string; target: string }[] = JSON.parse(template.steps as string);
  if (steps.length === 0) return res.status(400).json({ error: 'Template has no steps' });

  const id = uuid();
  const now = new Date().toISOString();

  const stepsState: WorkflowStepState[] = steps.map((s) => ({
    command: s.command,
    target: s.target,
    agentId: '',
    status: 'pending',
    startedAt: '',
    completedAt: '',
  }));

  db.prepare(`
    INSERT INTO workflow_runs (id, template_id, name, status, current_step, steps_state, started_at)
    VALUES (?, ?, ?, 'running', 0, ?, ?)
  `).run(id, templateId, template.name as string, JSON.stringify(stepsState), now);

  // Dispatch the first step immediately
  const resolvedAgentId = resolveTarget(steps[0].target);
  if (resolvedAgentId) {
    dispatchStep(id, 0, resolvedAgentId, steps[0].command);
  }

  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(id) as Record<string, unknown>;
  const run = normalizeRun(row);

  getIO().emit('workflow_updated', run);
  res.status(201).json(run);
});

router.get('/runs', (_req, res) => {
  const rows = db.prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT 50')
    .all() as Record<string, unknown>[];
  res.json(rows.map(normalizeRun));
});

router.get('/runs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Run not found' });
  res.json(normalizeRun(row));
});

router.post('/runs/:id/advance', (req, res) => {
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Run not found' });
  if (row.status !== 'running') return res.status(400).json({ error: 'Run is not active' });

  advanceWorkflow(req.params.id);

  const updated = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(req.params.id) as Record<string, unknown>;
  res.json(normalizeRun(updated));
});

router.post('/runs/:id/cancel', (req, res) => {
  const now = new Date().toISOString();
  db.prepare("UPDATE workflow_runs SET status = 'cancelled', completed_at = ? WHERE id = ?")
    .run(now, req.params.id);

  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Run not found' });

  const run = normalizeRun(row);
  getIO().emit('workflow_updated', run);
  res.json(run);
});

// ─── Helpers ─────────────────────────────────────────

function resolveTarget(target: string): string | null {
  if (target === 'any_idle' || target === 'all_idle') {
    const idle = db.prepare("SELECT id FROM agents WHERE status IN ('idle', 'working') ORDER BY status ASC LIMIT 1")
      .get() as { id: string } | undefined;
    return idle?.id || null;
  }
  const agent = db.prepare('SELECT id FROM agents WHERE id = ?')
    .get(target) as { id: string } | undefined;
  return agent?.id || null;
}

function resolveAllIdle(): string[] {
  const rows = db.prepare("SELECT id FROM agents WHERE status = 'idle'")
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

function dispatchStep(runId: string, stepIndex: number, agentId: string, command: string) {
  const now = new Date().toISOString();

  // Update the step state
  const row = db.prepare('SELECT steps_state FROM workflow_runs WHERE id = ?')
    .get(runId) as Record<string, unknown>;
  const stepsState: WorkflowStepState[] = JSON.parse(row.steps_state as string);
  stepsState[stepIndex].agentId = agentId;
  stepsState[stepIndex].status = 'running';
  stepsState[stepIndex].startedAt = now;

  db.prepare('UPDATE workflow_runs SET steps_state = ?, current_step = ? WHERE id = ?')
    .run(JSON.stringify(stepsState), stepIndex, runId);

  // Send the command through the orchestrator (memory injection + activity logging + socket emit)
  sendCommandToAgent(agentId, command, false);

  // Emit updated run
  const updated = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(runId) as Record<string, unknown>;
  getIO().emit('workflow_updated', normalizeRun(updated));

  console.log(`[workflow] Run ${runId} step ${stepIndex} dispatched to agent ${agentId}: ${command.slice(0, 80)}`);
}

function advanceWorkflow(runId: string) {
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(runId) as Record<string, unknown> | undefined;
  if (!row || row.status !== 'running') return;

  const stepsState: WorkflowStepState[] = JSON.parse(row.steps_state as string);
  const currentStep = row.current_step as number;
  const now = new Date().toISOString();

  // Mark current step as completed
  stepsState[currentStep].status = 'completed';
  stepsState[currentStep].completedAt = now;

  const nextStep = currentStep + 1;

  if (nextStep >= stepsState.length) {
    // All steps done
    db.prepare(`
      UPDATE workflow_runs SET status = 'completed', steps_state = ?, completed_at = ? WHERE id = ?
    `).run(JSON.stringify(stepsState), now, runId);

    const updated = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
      .get(runId) as Record<string, unknown>;
    getIO().emit('workflow_updated', normalizeRun(updated));
    console.log(`[workflow] Run ${runId} completed`);
  } else {
    // Save current state and dispatch next step
    db.prepare('UPDATE workflow_runs SET steps_state = ?, current_step = ? WHERE id = ?')
      .run(JSON.stringify(stepsState), nextStep, runId);

    const resolvedAgentId = resolveTarget(stepsState[nextStep].target);
    if (resolvedAgentId) {
      dispatchStep(runId, nextStep, resolvedAgentId, stepsState[nextStep].command);
    } else {
      console.log(`[workflow] Run ${runId} step ${nextStep} — no agent available, waiting...`);
      const updated = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
        .get(runId) as Record<string, unknown>;
      getIO().emit('workflow_updated', normalizeRun(updated));
    }
  }
}

function normalizeTemplate(row: Record<string, unknown>): WorkflowTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description ?? '') as string,
    steps: JSON.parse((row.steps ?? '[]') as string),
    autoRun: Boolean(row.auto_run),
    intervalMinutes: (row.interval_minutes as number) || 60,
    triggerWhen: ((row.trigger_when as string) || 'idle') as 'idle' | 'any',
    lastAutoRunAt: (row.last_auto_run_at as string) || null,
    createdAt: (row.created_at as string),
    updatedAt: (row.updated_at as string),
  };
}

function normalizeRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: row.id as string,
    templateId: (row.template_id as string),
    name: (row.name ?? '') as string,
    status: (row.status ?? 'pending') as WorkflowRun['status'],
    currentStep: (row.current_step ?? 0) as number,
    steps: JSON.parse((row.steps_state ?? '[]') as string),
    startedAt: (row.started_at as string),
    completedAt: (row.completed_at as string) || null,
  };
}

// ─── Background Executor ─────────────────────────────

export function startWorkflowExecutor() {
  setInterval(() => {
    // ─── Process running workflow runs ───
    const runs = db.prepare("SELECT * FROM workflow_runs WHERE status = 'running'")
      .all() as Record<string, unknown>[];

    for (const row of runs) {
      try {
        const stepsState: WorkflowStepState[] = JSON.parse(row.steps_state as string);
        const currentStep = row.current_step as number;
        const step = stepsState[currentStep];

        if (!step) continue;

        if (step.status === 'running' && step.agentId) {
          // Check if the agent is now idle (step likely finished)
          const agent = db.prepare('SELECT status, last_seen FROM agents WHERE id = ?')
            .get(step.agentId) as Record<string, unknown> | undefined;

          if (agent && agent.status === 'idle') {
            const lastSeen = new Date(agent.last_seen as string).getTime();
            const idleFor = Date.now() - lastSeen;
            if (idleFor > 30_000) {
              console.log(`[workflow] Agent ${step.agentId} idle for ${Math.floor(idleFor / 1000)}s — advancing run ${row.id}`);
              advanceWorkflow(row.id as string);
            }
          }
        } else if (step.status === 'pending') {
          // Step not yet dispatched — retry finding an agent
          const resolvedAgentId = resolveTarget(step.target);
          if (resolvedAgentId) {
            dispatchStep(row.id as string, currentStep, resolvedAgentId, step.command);
          }
        }
      } catch (err) {
        console.error(`[workflow] Error processing run ${row.id}:`, err);
      }
    }

    // ─── Check auto-run templates ───
    const autoTemplates = db.prepare('SELECT * FROM workflow_templates WHERE auto_run = 1')
      .all() as Record<string, unknown>[];

    for (const tplRow of autoTemplates) {
      try {
        const intervalMs = ((tplRow.interval_minutes as number) || 60) * 60 * 1000;
        const lastRun = tplRow.last_auto_run_at
          ? new Date(tplRow.last_auto_run_at as string).getTime()
          : 0;

        if (Date.now() - lastRun < intervalMs) continue; // Not time yet

        const triggerWhen = (tplRow.trigger_when as string) || 'idle';
        const steps: { command: string; target: string }[] = JSON.parse(tplRow.steps as string);
        if (steps.length === 0) continue;

        // Check trigger condition
        const idleAgents = resolveAllIdle();
        if (triggerWhen === 'idle' && idleAgents.length === 0) continue;

        // Execute auto-run
        executeAutoRun(tplRow, steps, idleAgents);
      } catch (err) {
        console.error(`[workflow] Error checking auto-run template ${tplRow.id}:`, err);
      }
    }
  }, 30_000);

  console.log('[workflow] Workflow executor started (30s interval)');
}

function executeAutoRun(
  tplRow: Record<string, unknown>,
  steps: { command: string; target: string }[],
  idleAgents: string[]
) {
  const now = new Date().toISOString();
  const templateId = tplRow.id as string;
  const templateName = tplRow.name as string;

  // Build expanded steps: 'all_idle' expands to one step per idle agent
  const expandedSteps: WorkflowStepState[] = [];
  for (const step of steps) {
    if (step.target === 'all_idle') {
      for (const agentId of idleAgents) {
        expandedSteps.push({
          command: step.command,
          target: 'all_idle',
          agentId,
          status: 'running',
          startedAt: now,
          completedAt: '',
        });
      }
    } else {
      const resolvedId = resolveTarget(step.target);
      expandedSteps.push({
        command: step.command,
        target: step.target,
        agentId: resolvedId || '',
        status: resolvedId ? 'running' : 'pending',
        startedAt: resolvedId ? now : '',
        completedAt: '',
      });
    }
  }

  if (expandedSteps.length === 0) return;

  // Create a run record
  const runId = uuid();
  db.prepare(`
    INSERT INTO workflow_runs (id, template_id, name, status, current_step, steps_state, started_at)
    VALUES (?, ?, ?, 'running', 0, ?, ?)
  `).run(runId, templateId, `${templateName} (auto)`, JSON.stringify(expandedSteps), now);

  // Dispatch commands to all agents with resolved IDs
  let dispatched = 0;
  for (const step of expandedSteps) {
    if (step.agentId && step.status === 'running') {
      sendCommandToAgent(step.agentId, step.command, false);
      dispatched++;
    }
  }

  // Mark run as completed (all commands dispatched — agents handle execution independently)
  db.prepare(`
    UPDATE workflow_runs SET status = 'completed', completed_at = ?, steps_state = ? WHERE id = ?
  `).run(now, JSON.stringify(expandedSteps.map((s) => ({
    ...s,
    status: s.agentId ? 'completed' : 'failed',
    completedAt: s.agentId ? now : '',
  }))), runId);

  // Update last auto-run timestamp
  db.prepare('UPDATE workflow_templates SET last_auto_run_at = ? WHERE id = ?')
    .run(now, templateId);

  const updated = db.prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(runId) as Record<string, unknown>;
  getIO().emit('workflow_updated', normalizeRun(updated));

  console.log(`[workflow] Auto-run "${templateName}" dispatched ${dispatched} command(s) to ${expandedSteps.length} step(s)`);
}

export default router;
