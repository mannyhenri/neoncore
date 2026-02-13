import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { ServerToClientEvents, ClientToServerEvents } from './types.js';
import db from './db.js';

let io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;

// Track which socket belongs to which agent (for offline detection on disconnect)
const socketToAgent = new Map<string, string>();

export function initWebSocket(server: HTTPServer) {
  io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    pingInterval: 10000,  // Ping every 10s (detect dead connections faster)
    pingTimeout: 5000,    // Wait 5s for pong before considering disconnected
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    console.log(`[ws] Client connected: ${socket.id}`);

    // VS Code extensions register with machine+repoPath+agentType (known immediately, no HTTP needed)
    socket.on('register_extension', ({ machine, repoPath, agentType }) => {
      // Always join the path-based room (works even if agent not yet in DB)
      const pathRoom = `ext:${machine}:${repoPath}`;
      socket.join(pathRoom);
      console.log(`[ws] Socket ${socket.id} joined path room ${pathRoom} (${agentType || 'claude'})`);

      // Try to resolve to agent ID for targeted delivery and offline tracking
      let agent: { id: string } | undefined;
      if (agentType) {
        agent = db.prepare('SELECT id FROM agents WHERE machine = ? AND repo_path = ? AND agent_type = ?')
          .get(machine, repoPath, agentType) as { id: string } | undefined;
      }
      if (!agent) {
        agent = db.prepare('SELECT id FROM agents WHERE machine = ? AND repo_path = ?')
          .get(machine, repoPath) as { id: string } | undefined;
      }

      if (agent) {
        const agentRoom = `agent:${agent.id}`;
        socket.join(agentRoom);
        socketToAgent.set(socket.id, agent.id);
        console.log(`[ws] Socket ${socket.id} also joined agent room ${agentRoom}`);
      } else {
        console.log(`[ws] No agent found yet for ${machine}:${repoPath} — path room only`);
      }
    });

    // Extension joins agent room after HTTP registration confirms agent ID (closes race condition)
    socket.on('join_agent_room', ({ agentId }) => {
      const agentRoom = `agent:${agentId}`;
      socket.join(agentRoom);
      socketToAgent.set(socket.id, agentId);
      console.log(`[ws] Socket ${socket.id} joined agent room ${agentRoom} (post-registration)`);
    });

    socket.on('disconnect', () => {
      const agentId = socketToAgent.get(socket.id);
      if (agentId) {
        socketToAgent.delete(socket.id);
        markAgentOffline(agentId);
      }
      console.log(`[ws] Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

function markAgentOffline(agentId: string) {
  const now = new Date().toISOString();
  db.prepare("UPDATE agents SET status = 'offline', last_seen = ? WHERE id = ?").run(now, agentId);

  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
  if (row) {
    const mode = ((row.agent_mode as string) ?? 'manual') as import('./types.js').AgentMode;
    io.emit('agent_updated', {
      id: row.id as string,
      name: row.name as string,
      machine: row.machine as string,
      repoPath: (row.repo_path as string) ?? '',
      repoName: (row.repo_name as string) ?? '',
      branch: (row.branch as string) ?? '',
      currentTask: (row.current_task as string) ?? '',
      status: 'offline',
      trustMode: mode === 'trust',
      mode,
      agentType: ((row.agent_type as string) ?? 'claude') as import('./types.js').AgentType,
      lastSeen: now,
      sessionId: (row.session_id as string) ?? '',
      lastMessage: (row.last_message as string) ?? '',
      pendingQuestion: (row.pending_question as string) ?? '',
    });
    console.log(`[ws] Agent ${agentId} marked offline (extension disconnected)`);
  }
}

/** Check if an agent has a live extension socket connected */
export function hasActiveSocket(agentId: string): boolean {
  for (const id of socketToAgent.values()) {
    if (id === agentId) return true;
  }
  return false;
}

/** Upgrade sockets in a path room to also join an agent room (handles race condition) */
export function upgradeSocketsToAgentRoom(machine: string, repoPath: string, agentId: string) {
  const pathRoom = `ext:${machine}:${repoPath}`;
  const agentRoom = `agent:${agentId}`;
  const socketsInRoom = io.sockets.adapter.rooms.get(pathRoom);
  if (socketsInRoom && socketsInRoom.size > 0) {
    for (const socketId of socketsInRoom) {
      const s = io.sockets.sockets.get(socketId);
      if (s) {
        s.join(agentRoom);
        socketToAgent.set(socketId, agentId);
      }
    }
    console.log(`[ws] Upgraded ${socketsInRoom.size} socket(s) from ${pathRoom} to ${agentRoom}`);
  }
}

export function getIO() {
  if (!io) {
    throw new Error('WebSocket not initialized. Call initWebSocket first.');
  }
  return io;
}
