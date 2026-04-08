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
import { startStuckDetector } from './stuck-detector.js';
import { startMemoryAnalyzer } from './memory-analyzer.js';
import { startEpicExecutor } from './routes/epics.js';
import { startWorkflowExecutor } from './lib/workflow-executor.js';
import { startWorkflowExecutorV2 } from './lib/workflow-executor-v2.js';
import { restoreRunningServers } from './lib/mcp-manager.js';
import { endSession } from './lib/session-manager.js';
import { startCleanupScheduler } from './lib/cleanup-scheduler.js';

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

// Staleness check: working → idle after 2min, idle → offline after 5min
const IDLE_THRESHOLD_MS = 2 * 60 * 1000;
const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;

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
    mode,
    agentType: ((row.agent_type as string) ?? 'claude') as import('./types.js').AgentType,
    lastSeen: (row.last_seen as string) ?? '',
    sessionId: (row.session_id as string) ?? '',
    lastMessage: (row.last_message as string) ?? '',
    pendingQuestion: (row.pending_question as string) ?? '',
  });
}

setInterval(() => {
  const now = new Date().toISOString();

  // working → idle after 2 minutes of no activity
  const idleCutoff = new Date(Date.now() - IDLE_THRESHOLD_MS).toISOString();
  const staleWorking = db.prepare(
    "SELECT id FROM agents WHERE status = 'working' AND last_seen < ?"
  ).all(idleCutoff) as { id: string }[];

  for (const { id } of staleWorking) {
    db.prepare("UPDATE agents SET status = 'idle', last_seen = ? WHERE id = ?").run(now, id);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;
    if (row) emitAgentUpdate(row);
  }

  // idle/waiting → offline after 5 minutes (only if no active extension socket)
  const offlineCutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS).toISOString();
  const staleIdle = db.prepare(
    "SELECT id FROM agents WHERE status IN ('idle', 'waiting') AND last_seen < ?"
  ).all(offlineCutoff) as { id: string }[];

  for (const { id } of staleIdle) {
    if (hasActiveSocket(id)) continue; // extension still connected — skip
    endSession(id);
    db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(id);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;
    if (row) emitAgentUpdate(row);
    console.log(`[stale] Agent ${id} marked offline (no activity for 5min, no active socket)`);
  }
}, 30_000); // Check every 30 seconds

// Periodically expire stale pending permissions (older than 2 minutes)
setInterval(() => {
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const expired = db.prepare(
    `UPDATE permissions SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?`
  ).run(new Date().toISOString(), twoMinAgo);
  if (expired.changes > 0) {
    console.log(`[cleanup] Expired ${expired.changes} stale pending permission(s)`);
    getSocketIO().emit('permissions_expired', { count: expired.changes });
  }
}, 120_000);

// Start stuck detector and memory analyzer
startStuckDetector();
startMemoryAnalyzer();
startCleanupScheduler();
// startEpicExecutor(); // TODO: disabled — autopilot not working yet
startWorkflowExecutor();
startWorkflowExecutorV2();

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
});
