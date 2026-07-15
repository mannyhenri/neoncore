import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { initWebSocket } from './ws.js';
import agentsRouter from './routes/agents.js';
import activityRouter from './routes/activity.js';
import permissionsRouter from './routes/permissions.js';
import trustRouter from './routes/trust.js';
import commandsRouter from './routes/commands.js';
import memoryRouter from './routes/memory.js';
import notesRouter from './routes/notes.js';
import settingsRouter from './routes/settings.js';
import reposRouter from './routes/repos.js';
import gitRouter from './routes/git.js';
import epicsRouter from './routes/epics.js';
import workflowsRouter from './routes/workflows.js';
import mcpRouter from './routes/mcp.js';
import journalRouter from './routes/journal.js';
import commandTemplatesRouter from './routes/command-templates.js';
import virtualCartridgesRouter from './routes/virtual-cartridges.js';
import toolsRouter from './routes/tools.js';
import goalsRouter from './routes/goals.js';
import projectsRouter from './routes/projects.js';
import heartbeatsRouter from './routes/heartbeats.js';
import tasksRouter from './routes/tasks.js';
import pushRouter from './routes/push.js';
import { startStuckDetector } from './stuck-detector.js';
import { startMemoryAnalyzer } from './memory-analyzer.js';
import { startWorkflowExecutor } from './lib/workflow-executor.js';
import { startWorkflowExecutorV2 } from './lib/workflow-executor-v2.js';
import { startHeartbeatScheduler, stopHeartbeatScheduler } from './lib/heartbeat-scheduler.js';
import { restoreRunningServers } from './lib/mcp-manager.js';
import { endSession } from './lib/session-manager.js';
import { reconcileInterruptedSteps } from './lib/recovery.js';
import { startCleanupScheduler } from './lib/cleanup-scheduler.js';
import { runFirstLaunchSetup } from './lib/first-launch.js';

const PORT = parseInt(process.env.PORT || '4040');
const app = express();
const server = createServer(app);

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Request logging
app.use((req, _res, next) => {
  if (req.method !== 'GET') {
    console.log(`[api] ${req.method} ${req.path}`);
  }
  next();
});

// Routes
app.use('/api/agents', agentsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/permissions', permissionsRouter);
app.use('/api/trust', trustRouter);
app.use('/api/commands', commandsRouter);
app.use('/api/agents', memoryRouter);
app.use('/api/agents', notesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/repos', reposRouter);
app.use('/api/git', gitRouter);
app.use('/api/epics', epicsRouter);
app.use('/api/workflows', workflowsRouter);
app.use('/api/mcp', mcpRouter);
app.use('/api/journal', journalRouter);
app.use('/api/command-templates', commandTemplatesRouter);
app.use('/api/virtual-cartridges', virtualCartridgesRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/heartbeats', heartbeatsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/push', pushRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve built dashboard (production mode)
// After `npm run build --workspace=dashboard`, static files land in server/public/
const publicDir = path.join(__dirname, '..', 'public');
// Hashed assets get long cache; index.html must always be fresh
app.use(express.static(publicDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
app.get('*', (_req, res, next) => {
  // Only serve index.html for non-API routes (SPA fallback)
  if (_req.path.startsWith('/api') || _req.path.startsWith('/socket.io')) {
    return next();
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Initialize WebSocket
initWebSocket(server);

// Import db to ensure schema is created
import db from './db.js';
import { getIO as getSocketIO, hasActiveSocket } from './ws.js';

// working → idle after 2min of no tool activity. This is a *display* state, not a
// death sentence — an idle agent stays visible in the grid.
const IDLE_THRESHOLD_MS = 2 * 60 * 1000;

// An agent going quiet does NOT mean it died. Death is reported, not inferred:
//   - SessionEnd hook  → POST /api/agents/session-end (the honest signal)
//   - socket disconnect → markAgentOffline (relay / VS Code extension)
//   - relay SIGTERM    → POST /api/agents/interrupted
// This timer only reaps ZOMBIES — sessions killed in a way that fires none of the
// above (kill -9, terminal window closed, laptop slept). At 24h it can only ever
// catch the genuinely dead, never someone who stepped away for coffee.
//
// It used to be 5 minutes, which is why cartridges vanished out of the grid while
// their session was still sitting open in a terminal.
const ZOMBIE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function emitAgentUpdate(row: Record<string, unknown>) {
  const mode = ((row.agent_mode as string) ?? 'manual') as import('./types.js').AgentMode;
  getSocketIO().emit('agent_updated', {
    id: row.id as string,
    name: row.name as string,
    machine: row.machine as string,
    repoPath: (row.repo_path as string) ?? '',
    repoName: (row.repo_name as string) ?? '',
    branch: (row.branch as string) ?? '',
    currentTask: (row.current_task as string) ?? '',
    status: (row.status as string ?? 'idle') as import('./types.js').Agent['status'],
    trustMode: mode === 'trust',
    plansIncluded: Boolean((row as Record<string,unknown>).plans_included),
    mode,
    agentType: ((row.agent_type as string) ?? 'claude') as import('./types.js').AgentType,
    lastSeen: (row.last_seen as string) ?? '',
    sessionId: (row.session_id as string) ?? '',
    lastMessage: (row.last_message as string) ?? '',
    pendingQuestion: (row.pending_question as string) ?? '',
    dismissedAt: (row.dismissed_at as string) ?? '',
  });
}

setInterval(() => {
  // working → idle after 2 minutes of no activity.
  // NB: do NOT touch last_seen here. It means "when did this agent last actually do
  // something", and the old code overwrote it with now() on this transition — which
  // destroyed the real timestamp (the UI's "last seen" was really "when we noticed it
  // went quiet") and restarted every staleness clock that reads it.
  const idleCutoff = new Date(Date.now() - IDLE_THRESHOLD_MS).toISOString();
  const staleWorking = db.prepare(
    "SELECT id FROM agents WHERE status = 'working' AND last_seen < ?"
  ).all(idleCutoff) as { id: string }[];

  for (const { id } of staleWorking) {
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(id);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;
    if (row) emitAgentUpdate(row);
  }

  // Zombie reaper — see ZOMBIE_THRESHOLD_MS. Sessions that died without firing any of
  // the real death signals would otherwise sit in the grid forever.
  const zombieCutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_MS).toISOString();
  const zombies = db.prepare(
    "SELECT id FROM agents WHERE status IN ('idle', 'waiting', 'working') AND last_seen < ?"
  ).all(zombieCutoff) as { id: string }[];

  for (const { id } of zombies) {
    if (hasActiveSocket(id)) continue; // still connected — demonstrably not dead
    endSession(id);
    db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(id);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;
    if (row) emitAgentUpdate(row);
    console.log(`[zombie] Agent ${id} reaped (no activity for 24h, no socket, no SessionEnd)`);
  }

  // Recovery backstop: now that offline agents are marked, flag any running
  // steps stranded by a dead agent as interrupted (the relay's SIGTERM POST is
  // the fast path; this catches crashes where that POST never landed).
  try { reconcileInterruptedSteps(); } catch (err) { console.error('[recovery] reconcile failed:', err); }
}, 30_000); // Check every 30 seconds

// Expire pending permissions that no agent is waiting on any more.
//
// This MUST outlive the agent's own wait. The hook (agent/hooks/permission-proxy.py)
// long-polls for POLL_TIMEOUT(120s) x MAX_POLL_RETRIES(5) ~= 10 minutes. This sweep
// used to expire at 2 minutes, so from minute 2 to minute 10 the agent sat blocked on
// a question that had already vanished from /api/permissions/pending — unanswerable
// from the dashboard OR the phone. Keep this comfortably above the hook's max wait.
const PERMISSION_TTL_MS = 15 * 60 * 1000;

/**
 * `agents.pending_question` is set by the hook when AskUserQuestion fires. Nothing used
 * to clear it, so cartridges showed "❓ <already-answered question>" forever, and the
 * detail screen pointed at an approvals inbox that had nothing in it. The invariant is
 * simple: a question banner is only meaningful while a permission is actually open to
 * answer. Enforce it rather than trusting every write path to clean up after itself.
 */
function clearOrphanedQuestions(): number {
  return db.prepare(
    `UPDATE agents SET pending_question = ''
      WHERE pending_question != ''
        AND id NOT IN (SELECT agent_id FROM permissions WHERE status = 'pending')`
  ).run().changes;
}

setInterval(() => {
  const cutoff = new Date(Date.now() - PERMISSION_TTL_MS).toISOString();
  const expired = db.prepare(
    `UPDATE permissions SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?`
  ).run(new Date().toISOString(), cutoff);
  if (expired.changes > 0) {
    console.log(`[cleanup] Expired ${expired.changes} stale pending permission(s)`);
    getSocketIO().emit('permissions_expired', { count: expired.changes });
  }
  const cleared = clearOrphanedQuestions();
  if (cleared > 0) console.log(`[cleanup] Cleared ${cleared} orphaned question banner(s)`);
}, 120_000);

// Also on boot — a crash mid-question would otherwise leave the banner stuck forever.
{
  const cleared = clearOrphanedQuestions();
  if (cleared > 0) console.log(`[startup] Cleared ${cleared} orphaned question banner(s)`);
}

// Last-resort backstops. Several schedulers run inside setInterval callbacks, where an
// unhandled synchronous throw is an uncaught exception that takes the whole process down —
// and since the offending row is still there on restart, it crash-loops. NeonCore is the
// thing that watches everything else; it must not be the first thing to die. Log loudly
// and keep serving rather than exiting.
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception — server staying up:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled promise rejection — server staying up:', reason);
});

// Start stuck detector and memory analyzer
startStuckDetector();
startMemoryAnalyzer();
startCleanupScheduler();
startWorkflowExecutor();
startWorkflowExecutorV2();
startHeartbeatScheduler();

// Graceful shutdown — stop the schedulers that own intervals.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[shutdown] ${sig} received — stopping schedulers`);
    stopHeartbeatScheduler();
    process.exit(0);
  });
}

// Recover from a crash on boot: flag steps left mid-run by the previous process.
// (Most take effect once the sweep marks their dead agents offline; this call
// catches any agent already persisted as offline.)
try { reconcileInterruptedSteps(); } catch (err) { console.error('[recovery] startup reconcile failed:', err); }

// Restore MCP servers that were running before restart
restoreRunningServers().catch((err) => console.error('[mcp] Restore failed:', err));

// Get local IP for display
import os from 'os';
function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const devName of Object.keys(interfaces)) {
    for (const iface of interfaces[devName] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Graceful port-conflict handling for Gridlight deployment
server.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      const data = await res.json() as { status?: string };
      if (data.status === 'ok') {
        console.log(`[startup] NeonCore already running on port ${PORT}, piggybacking`);
        process.exit(0);
      }
    } catch { /* not NeonCore */ }
    console.error(`[startup] Port ${PORT} is in use by another process`);
    process.exit(1);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   NeonCore Server                             ║
  ║                                              ║
  ║   Local:   http://localhost:${PORT}              ║
  ║   Network: http://${localIP}:${PORT}    ║
  ║                                              ║
  ║   Open the network URL on any device         ║
  ║   on your LAN to access the dashboard.       ║
  ╚══════════════════════════════════════════════╝
  `);

  // Install Claude Code hooks on the local machine on first launch
  runFirstLaunchSetup(PORT);
});
