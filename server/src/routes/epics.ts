import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getIO } from '../ws.js';
import { sendCommandToAgent } from '../lib/send-command.js';
import type { AgentMode, EpicRun, EpicRunConfig, EpicTaskState } from '../types.js';

const router = Router();

const DEFAULT_CONFIG: EpicRunConfig = {
  idleThresholdMs: 45000,
  commitCommand: '/commit-push',
  taskPromptTemplate: '',
  skipCommitOnLast: false,
  autoEnableTrust: true,
  taskPrefix: '.claude/tasks/',
};

// --- Discovery Routes ---

// Scan agent's repo for available epics and task prefixes
router.get('/scan/:agentId', (req, res) => {
  const agent = db.prepare('SELECT repo_path FROM agents WHERE id = ?')
    .get(req.params.agentId) as { repo_path: string } | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const repoPath = agent.repo_path;
  const scopingDir = path.join(repoPath, '.claude', 'scoping');
  const tasksDir = path.join(repoPath, '.claude', 'tasks');

  // Scan for epic files
  const epics: { name: string; filename: string; path: string }[] = [];
  try {
    const files = fs.readdirSync(scopingDir);
    for (const f of files) {
      if (f.startsWith('EPIC-') && f.endsWith('.md')) {
        const name = f.replace('EPIC-', '').replace('.md', '');
        epics.push({ name, filename: f, path: path.join(scopingDir, f) });
      }
    }
  } catch {
    // No scoping dir — that's fine
  }

  // Scan for task files and extract prefixes
  const taskFiles: string[] = [];
  const prefixSet = new Set<string>();
  try {
    const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md')).sort();
    for (const f of files) {
      taskFiles.push(f);
      // Extract prefix from TASK-{PREFIX}-{NNN}.md pattern
      const match = f.match(/^TASK-([A-Z0-9]+)-\d+\.md$/i);
      if (match) prefixSet.add(match[1]);
      // Also handle GRD-NNN.md, GRID-NNN.md patterns
      const grdMatch = f.match(/^(GRD|GRID)-\d+\.md$/i);
      if (grdMatch) prefixSet.add(grdMatch[1].toUpperCase());
    }
  } catch {
    // No tasks dir
  }

  res.json({
    epics: epics.sort((a, b) => a.name.localeCompare(b.name)),
    prefixes: [...prefixSet].sort(),
    taskCount: taskFiles.length,
  });
});

// Discover tasks matching a prefix from the agent's repo
router.get('/scan/:agentId/tasks', (req, res) => {
  const prefix = (req.query.prefix as string || '').trim();
  if (!prefix) return res.status(400).json({ error: 'prefix query param required' });

  const agent = db.prepare('SELECT repo_path FROM agents WHERE id = ?')
    .get(req.params.agentId) as { repo_path: string } | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const tasksDir = path.join(agent.repo_path, '.claude', 'tasks');
  const tasks: { taskId: string; label: string; filename: string; taskFilePath: string }[] = [];

  try {
    const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md')).sort();
    const upperPrefix = prefix.toUpperCase();

    for (const f of files) {
      const upperFile = f.toUpperCase();
      // Match TASK-{PREFIX}-NNN.md or {PREFIX}-NNN.md
      if (upperFile.startsWith(`TASK-${upperPrefix}-`) || upperFile.startsWith(`${upperPrefix}-`)) {
        const taskId = f.replace('.md', '');
        // Try to extract a label from the first heading in the file
        let label = taskId;
        try {
          const content = fs.readFileSync(path.join(tasksDir, f), 'utf-8');
          const headingMatch = content.match(/^#\s+(?:\S+:\s*)?(.+)/m);
          if (headingMatch) {
            label = headingMatch[1].trim();
            // If the heading starts with the task ID, include the whole thing
            if (label.toLowerCase().startsWith(taskId.toLowerCase())) {
              label = label;
            } else {
              label = `${taskId}: ${label}`;
            }
          }
        } catch {
          // Can't read file — use taskId as label
        }

        tasks.push({
          taskId,
          label,
          filename: f,
          taskFilePath: `.claude/tasks/${f}`,
        });
      }
    }
  } catch {
    return res.json({ tasks: [], error: 'Could not read tasks directory' });
  }

  // Sort by numeric suffix
  tasks.sort((a, b) => {
    const numA = parseInt(a.taskId.match(/(\d+)$/)?.[1] || '0');
    const numB = parseInt(b.taskId.match(/(\d+)$/)?.[1] || '0');
    return numA - numB;
  });

  res.json({ tasks, prefix });
});

// --- Run Routes ---

// Start a new epic run
router.post('/start', (req, res) => {
  const { name, agentId, tasks, config: userConfig, startPaused } = req.body;

  if (!name || !agentId || !Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'name, agentId, and non-empty tasks array required' });
  }

  // Validate agent exists and is not offline
  const agent = db.prepare('SELECT id, agent_mode, status FROM agents WHERE id = ?')
    .get(agentId) as { id: string; agent_mode: string; status: string } | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (agent.status === 'offline') return res.status(400).json({ error: 'Agent is offline' });

  // Check no active epic on this agent
  const active = db.prepare(
    "SELECT id FROM epic_runs WHERE agent_id = ? AND status IN ('running', 'committing', 'paused')"
  ).get(agentId) as { id: string } | undefined;
  if (active) return res.status(409).json({ error: 'Agent already has an active epic run', epicId: active.id });

  const config: EpicRunConfig = { ...DEFAULT_CONFIG, ...userConfig };
  const previousMode = (agent.agent_mode || 'manual') as AgentMode;
  const now = new Date().toISOString();

  // Build task states
  const taskStates: EpicTaskState[] = tasks.map((t: { taskId: string; label?: string; taskFilePath?: string }) => ({
    taskId: t.taskId,
    label: t.label || t.taskId,
    taskFilePath: t.taskFilePath || `${config.taskPrefix}${t.taskId}.md`,
    status: 'pending' as const,
    startedAt: '',
    completedAt: '',
    error: '',
  }));

  const initialStatus = startPaused ? 'paused' : 'running';

  if (!startPaused) {
    // Mark first task as running immediately
    taskStates[0].status = 'running';
    taskStates[0].startedAt = now;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO epic_runs (id, name, agent_id, status, current_task, tasks, config, previous_mode, started_at, error)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, '')
  `).run(id, name, agentId, initialStatus, JSON.stringify(taskStates), JSON.stringify(config), previousMode, now);

  // Enable trust mode if configured
  if (config.autoEnableTrust && previousMode !== 'trust') {
    enableTrustMode(agentId);
  }

  if (!startPaused) {
    // Dispatch first task
    const prompt = buildTaskPrompt(taskStates[0], config);
    sendCommandToAgent(agentId, prompt, false);
  }
  console.log(`[epic] Started run ${id}: ${name} (${taskStates.length} tasks) on agent ${agentId}${startPaused ? ' (paused — waiting for user)' : ''}`);

  const run = normalizeEpicRun(db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(id) as Record<string, unknown>);
  getIO().emit('epic_updated', run);
  res.status(201).json(run);
});

// List epic runs
router.get('/runs', (_req, res) => {
  const rows = db.prepare('SELECT * FROM epic_runs ORDER BY started_at DESC LIMIT 50')
    .all() as Record<string, unknown>[];
  res.json(rows.map(normalizeEpicRun));
});

// Get single run
router.get('/runs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Epic run not found' });
  res.json(normalizeEpicRun(row));
});

// Pause
router.post('/runs/:id/pause', (req, res) => {
  const row = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Epic run not found' });
  if (!['running', 'committing'].includes(row.status as string)) {
    return res.status(400).json({ error: 'Can only pause running/committing epics' });
  }

  db.prepare("UPDATE epic_runs SET status = 'paused' WHERE id = ?").run(req.params.id);
  const updated = normalizeEpicRun(db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown>);
  getIO().emit('epic_updated', updated);
  console.log(`[epic] Paused run ${req.params.id}`);
  res.json(updated);
});

// Resume
router.post('/runs/:id/resume', (req, res) => {
  const row = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Epic run not found' });
  if (row.status !== 'paused') return res.status(400).json({ error: 'Can only resume paused epics' });

  // Check agent is online
  const agent = db.prepare('SELECT status FROM agents WHERE id = ?').get(row.agent_id as string) as { status: string } | undefined;
  if (agent?.status === 'offline') return res.status(400).json({ error: 'Agent is offline, cannot resume' });

  const tasks: EpicTaskState[] = JSON.parse(row.tasks as string);
  const config: EpicRunConfig = JSON.parse(row.config as string);
  const currentIdx = row.current_task as number;
  const currentTask = tasks[currentIdx];
  const now = new Date().toISOString();

  // Start-paused case: first task is still pending — need to kick it off
  if (currentTask?.status === 'pending') {
    currentTask.status = 'running';
    currentTask.startedAt = now;
    db.prepare('UPDATE epic_runs SET status = ?, tasks = ? WHERE id = ?')
      .run('running', JSON.stringify(tasks), req.params.id);

    const prompt = buildTaskPrompt(currentTask, config);
    sendCommandToAgent(row.agent_id as string, prompt, false);
    console.log(`[epic] Resumed run ${req.params.id} — dispatching first task`);
  } else {
    // Normal resume: task was already running or committing
    const resumeStatus = currentTask?.status === 'committing' ? 'committing' : 'running';
    db.prepare('UPDATE epic_runs SET status = ? WHERE id = ?').run(resumeStatus, req.params.id);
    console.log(`[epic] Resumed run ${req.params.id} as ${resumeStatus}`);
  }

  const updated = normalizeEpicRun(db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown>);
  getIO().emit('epic_updated', updated);
  res.json(updated);
});

// Cancel
router.post('/runs/:id/cancel', (req, res) => {
  const row = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Epic run not found' });
  if (['completed', 'cancelled'].includes(row.status as string)) {
    return res.status(400).json({ error: 'Epic already finished' });
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE epic_runs SET status = 'cancelled', completed_at = ? WHERE id = ?").run(now, req.params.id);

  // Restore agent mode
  restoreAgentMode(row.agent_id as string, row.previous_mode as string);

  const updated = normalizeEpicRun(db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown>);
  getIO().emit('epic_updated', updated);
  console.log(`[epic] Cancelled run ${req.params.id}`);
  res.json(updated);
});

// Skip current task
router.post('/runs/:id/skip', (req, res) => {
  const row = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Epic run not found' });
  if (!['running', 'committing', 'failed'].includes(row.status as string)) {
    return res.status(400).json({ error: 'No active task to skip' });
  }

  const tasks: EpicTaskState[] = JSON.parse(row.tasks as string);
  const config: EpicRunConfig = JSON.parse(row.config as string);
  const currentIdx = row.current_task as number;
  const now = new Date().toISOString();

  // Mark current task as skipped
  tasks[currentIdx].status = 'skipped';
  tasks[currentIdx].completedAt = now;

  const nextIdx = currentIdx + 1;
  if (nextIdx >= tasks.length) {
    // No more tasks
    completeEpic(req.params.id, tasks, row.agent_id as string, row.previous_mode as string);
  } else {
    // Dispatch next task
    tasks[nextIdx].status = 'running';
    tasks[nextIdx].startedAt = now;
    updateEpicState(req.params.id, 'running', nextIdx, tasks);

    const prompt = buildTaskPrompt(tasks[nextIdx], config);
    sendCommandToAgent(row.agent_id as string, prompt, false);
    console.log(`[epic] Skipped task ${currentIdx}, advancing to ${nextIdx} in run ${req.params.id}`);
  }

  const updated = normalizeEpicRun(db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown>);
  res.json(updated);
});

// Retry current failed task
router.post('/runs/:id/retry', (req, res) => {
  const row = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Epic run not found' });
  if (row.status !== 'failed') return res.status(400).json({ error: 'Can only retry failed epics' });

  const tasks: EpicTaskState[] = JSON.parse(row.tasks as string);
  const config: EpicRunConfig = JSON.parse(row.config as string);
  const currentIdx = row.current_task as number;
  const now = new Date().toISOString();

  // Reset current task
  tasks[currentIdx].status = 'running';
  tasks[currentIdx].startedAt = now;
  tasks[currentIdx].completedAt = '';
  tasks[currentIdx].error = '';

  updateEpicState(req.params.id, 'running', currentIdx, tasks);
  db.prepare('UPDATE epic_runs SET error = ? WHERE id = ?').run('', req.params.id);

  // Re-dispatch
  const prompt = buildTaskPrompt(tasks[currentIdx], config);
  sendCommandToAgent(row.agent_id as string, prompt, false);
  console.log(`[epic] Retrying task ${currentIdx} in run ${req.params.id}`);

  const updated = normalizeEpicRun(db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(req.params.id) as Record<string, unknown>);
  getIO().emit('epic_updated', updated);
  res.json(updated);
});

// --- Epic Executor (background loop) ---
// TODO: Autopilot disabled — not working yet. Uncomment when ready.

/*
const EPIC_POLL_INTERVAL_MS = 15_000;

export function startEpicExecutor() {
  setInterval(() => {
    const runs = db.prepare(
      "SELECT * FROM epic_runs WHERE status IN ('running', 'committing')"
    ).all() as Record<string, unknown>[];

    for (const row of runs) {
      try {
        processEpicRun(row);
      } catch (err) {
        console.error(`[epic] Error processing run ${row.id}:`, err);
      }
    }
  }, EPIC_POLL_INTERVAL_MS);

  console.log(`[epic] Epic executor started (${EPIC_POLL_INTERVAL_MS / 1000}s interval)`);
}

function processEpicRun(row: Record<string, unknown>) {
  const epicId = row.id as string;
  const status = row.status as string;
  const tasks: EpicTaskState[] = JSON.parse(row.tasks as string);
  const config: EpicRunConfig = JSON.parse(row.config as string);
  const currentIdx = row.current_task as number;
  const agentId = row.agent_id as string;

  const agent = db.prepare('SELECT status, last_seen FROM agents WHERE id = ?')
    .get(agentId) as { status: string; last_seen: string } | undefined;
  if (!agent) return;

  // Agent offline → fail epic
  if (agent.status === 'offline') {
    failEpic(epicId, tasks, currentIdx, 'Agent went offline');
    restoreAgentMode(agentId, row.previous_mode as string);
    return;
  }

  // Agent waiting for human input → permission relay handles it, skip
  if (agent.status === 'waiting') return;

  // Agent not idle yet → skip
  if (agent.status !== 'idle') return;

  // Check idle duration
  const lastSeen = new Date(agent.last_seen).getTime();
  const idleFor = Date.now() - lastSeen;
  if (idleFor < config.idleThresholdMs) return;

  const now = new Date().toISOString();

  if (status === 'running') {
    // Current task just completed
    const task = tasks[currentIdx];
    if (task.status !== 'running') return; // Guard against double-processing

    task.status = 'completed';
    task.completedAt = now;

    const isLastTask = currentIdx >= tasks.length - 1;

    if (isLastTask && config.skipCommitOnLast) {
      completeEpic(epicId, tasks, agentId, row.previous_mode as string);
    } else {
      // Send commit-push
      updateEpicState(epicId, 'committing', currentIdx, tasks);
      sendCommandToAgent(agentId, config.commitCommand, false);
      console.log(`[epic] Run ${epicId} task ${currentIdx} (${task.taskId}) completed — committing`);
    }

  } else if (status === 'committing') {
    // Commit done → advance
    const nextIdx = currentIdx + 1;

    if (nextIdx >= tasks.length) {
      completeEpic(epicId, tasks, agentId, row.previous_mode as string);
    } else {
      // Dispatch next task
      tasks[nextIdx].status = 'running';
      tasks[nextIdx].startedAt = now;
      updateEpicState(epicId, 'running', nextIdx, tasks);

      const prompt = buildTaskPrompt(tasks[nextIdx], config);
      sendCommandToAgent(agentId, prompt, false);
      console.log(`[epic] Run ${epicId} advancing to task ${nextIdx}: ${tasks[nextIdx].taskId}`);
    }
  }
}
*/

// Stub export so the import in index.ts doesn't break
export function startEpicExecutor() {
  console.log('[epic] Epic autopilot is disabled');
}

// --- Helpers ---

function buildTaskPrompt(task: EpicTaskState, config: EpicRunConfig): string {
  if (config.taskPromptTemplate) {
    return config.taskPromptTemplate
      .replace(/\{\{taskId\}\}/g, task.taskId)
      .replace(/\{\{taskFilePath\}\}/g, task.taskFilePath)
      .replace(/\{\{label\}\}/g, task.label);
  }

  return [
    `Start working on task ${task.taskId}.`,
    `Read the task file at ${task.taskFilePath} for full implementation details.`,
    `Follow all acceptance criteria. When complete, stop and wait.`,
    `Do NOT commit or push — that will be handled automatically.`,
  ].join('\n');
}

function updateEpicState(epicId: string, status: string, currentTask: number, tasks: EpicTaskState[]) {
  db.prepare('UPDATE epic_runs SET status = ?, current_task = ?, tasks = ? WHERE id = ?')
    .run(status, currentTask, JSON.stringify(tasks), epicId);

  const row = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(epicId) as Record<string, unknown>;
  getIO().emit('epic_updated', normalizeEpicRun(row));
}

function completeEpic(epicId: string, tasks: EpicTaskState[], agentId: string, previousMode: string) {
  const now = new Date().toISOString();
  db.prepare("UPDATE epic_runs SET status = 'completed', tasks = ?, completed_at = ? WHERE id = ?")
    .run(JSON.stringify(tasks), now, epicId);

  restoreAgentMode(agentId, previousMode);

  const row = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(epicId) as Record<string, unknown>;
  getIO().emit('epic_updated', normalizeEpicRun(row));
  console.log(`[epic] Run ${epicId} completed — all ${tasks.length} tasks done`);
}

function failEpic(epicId: string, tasks: EpicTaskState[], currentTask: number, error: string) {
  const now = new Date().toISOString();
  if (tasks[currentTask]) {
    tasks[currentTask].status = 'failed';
    tasks[currentTask].error = error;
  }
  db.prepare("UPDATE epic_runs SET status = 'failed', tasks = ?, error = ?, completed_at = ? WHERE id = ?")
    .run(JSON.stringify(tasks), error, now, epicId);

  const row = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(epicId) as Record<string, unknown>;
  getIO().emit('epic_updated', normalizeEpicRun(row));
  console.log(`[epic] Run ${epicId} failed at task ${currentTask}: ${error}`);
}

function enableTrustMode(agentId: string) {
  const now = new Date().toISOString();
  db.prepare('UPDATE agents SET agent_mode = ?, trust_mode = 1, last_seen = ? WHERE id = ?')
    .run('trust', now, agentId);

  // Auto-approve pending permissions (except AskUserQuestion/ExitPlanMode)
  const pending = db.prepare(
    "SELECT id, tool_name FROM permissions WHERE agent_id = ? AND status = 'pending'"
  ).all(agentId) as { id: string; tool_name: string }[];

  for (const perm of pending) {
    if (perm.tool_name !== 'AskUserQuestion' && perm.tool_name !== 'ExitPlanMode') {
      db.prepare("UPDATE permissions SET status = 'allowed', decided_at = ? WHERE id = ?")
        .run(now, perm.id);
    }
  }

  emitAgentUpdate(agentId);
}

function restoreAgentMode(agentId: string, previousMode: string) {
  const now = new Date().toISOString();
  const trustMode = previousMode === 'trust' ? 1 : 0;
  db.prepare('UPDATE agents SET agent_mode = ?, trust_mode = ?, last_seen = ? WHERE id = ?')
    .run(previousMode, trustMode, now, agentId);

  emitAgentUpdate(agentId);
  console.log(`[epic] Restored agent ${agentId} to mode: ${previousMode}`);
}

function emitAgentUpdate(agentId: string) {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
  if (!row) return;

  const mode = ((row.agent_mode as string) ?? 'manual') as AgentMode;
  getIO().emit('agent_updated', {
    id: row.id as string,
    name: row.name as string,
    machine: row.machine as string,
    repoPath: (row.repo_path as string) ?? '',
    repoName: (row.repo_name as string) ?? '',
    branch: (row.branch as string) ?? '',
    currentTask: (row.current_task as string) ?? '',
    status: (row.status as string ?? 'idle') as 'working' | 'idle' | 'waiting' | 'offline',
    trustMode: mode === 'trust',
    mode,
    agentType: ((row.agent_type as string) ?? 'claude') as 'claude' | 'gridlight',
    lastSeen: (row.last_seen as string) ?? '',
    sessionId: (row.session_id as string) ?? '',
    lastMessage: (row.last_message as string) ?? '',
    pendingQuestion: (row.pending_question as string) ?? '',
    memoryEnabled: (row.memory_enabled as number) === 1,
  });
}

function normalizeEpicRun(row: Record<string, unknown>): EpicRun {
  return {
    id: row.id as string,
    name: (row.name ?? '') as string,
    agentId: row.agent_id as string,
    status: (row.status ?? 'pending') as EpicRun['status'],
    currentTask: (row.current_task ?? 0) as number,
    tasks: JSON.parse((row.tasks ?? '[]') as string),
    config: { ...DEFAULT_CONFIG, ...JSON.parse((row.config ?? '{}') as string) },
    previousMode: (row.previous_mode ?? 'manual') as AgentMode,
    startedAt: (row.started_at ?? '') as string,
    completedAt: (row.completed_at as string) || null,
    error: (row.error ?? '') as string,
  };
}

export default router;
