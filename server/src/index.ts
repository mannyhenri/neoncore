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

const PORT = parseInt(process.env.PORT || '4040');
const app = express();
const server = createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

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

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve built dashboard (production mode)
// After `npm run build --workspace=dashboard`, static files land in server/public/
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (_req, res, next) => {
  // Only serve index.html for non-API routes (SPA fallback)
  if (_req.path.startsWith('/api') || _req.path.startsWith('/socket.io')) {
    return next();
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Initialize WebSocket
initWebSocket(server);

// Import db to ensure schema is created
import db from './db.js';
import { getIO as getSocketIO } from './ws.js';

// Staleness check: mark agents as idle if no activity for 2 minutes
const STALE_THRESHOLD_MS = 2 * 60 * 1000;
setInterval(() => {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  const stale = db.prepare(
    "SELECT id FROM agents WHERE status = 'working' AND last_seen < ?"
  ).all(cutoff) as { id: string }[];

  if (stale.length > 0) {
    const now = new Date().toISOString();
    for (const { id } of stale) {
      db.prepare("UPDATE agents SET status = 'idle', last_seen = ? WHERE id = ?").run(now, id);
      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;
      if (row) {
        const mode = ((row.agent_mode as string) ?? 'manual') as import('./types.js').AgentMode;
        getSocketIO().emit('agent_updated', {
          id: row.id as string,
          name: row.name as string,
          machine: row.machine as string,
          repoPath: (row.repo_path as string) ?? '',
          repoName: (row.repo_name as string) ?? '',
          branch: (row.branch as string) ?? '',
          currentTask: (row.current_task as string) ?? '',
          status: ((row.status as string) ?? 'idle') as import('./types.js').Agent['status'],
          trustMode: mode === 'trust',
          mode,
          lastSeen: (row.last_seen as string) ?? '',
          sessionId: (row.session_id as string) ?? '',
          lastMessage: (row.last_message as string) ?? '',
        });
      }
    }
  }
}, 30_000); // Check every 30 seconds

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

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   NeonCore Orchestrator Server               ║
  ║                                              ║
  ║   Local:   http://localhost:${PORT}              ║
  ║   Network: http://${localIP}:${PORT}    ║
  ║                                              ║
  ║   Open the network URL on any device         ║
  ║   on your LAN to access the dashboard.       ║
  ╚══════════════════════════════════════════════╝
  `);
});
