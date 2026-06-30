import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { ServerToClientEvents, ClientToServerEvents } from './types.js';
import db from './db.js';
import { endSession } from './lib/session-manager.js';

let io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;

// Track which socket belongs to which agent (for offline detection on disconnect)
const socketToAgent = new Map<string, string>();

// Track the primary (most recently registered) socket per agent — commands go here
const agentPrimarySocket = new Map<string, string>(); // agentId → socketId

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
      // Join type-specific path room so upgradeSocketsToAgentRoom doesn't cross-contaminate
      const resolvedType = agentType || 'claude';
      const pathRoom = `ext:${machine}:${repoPath}:${resolvedType}`;
      socket.join(pathRoom);
      console.log(`[ws] Socket ${socket.id} joined path room ${pathRoom}`);

      // Resolve to agent ID — require exact match on machine + path + type to prevent misrouting
      if (agentType) {
        const agent = db.prepare('SELECT id FROM agents WHERE machine = ? AND repo_path = ? AND agent_type = ?')
          .get(machine, repoPath, agentType) as { id: string } | undefined;

        if (agent) {
          const agentRoom = `agent:${agent.id}`;
          socket.join(agentRoom);
          socketToAgent.set(socket.id, agent.id);
          agentPrimarySocket.set(agent.id, socket.id);
          console.log(`[ws] Socket ${socket.id} also joined agent room ${agentRoom} (primary)`);
        } else {
          console.log(`[ws] No agent found for ${machine}:${repoPath} (type=${agentType}) — path room only`);
        }
      } else {
        console.log(`[ws] No agentType provided for ${machine}:${repoPath} — path room only, awaiting join_agent_room`);
      }
    });

    // Extension joins agent room after HTTP registration confirms agent ID (closes race condition)
    socket.on('join_agent_room', ({ agentId }) => {
      const agentRoom = `agent:${agentId}`;
      socket.join(agentRoom);
      socketToAgent.set(socket.id, agentId);
      agentPrimarySocket.set(agentId, socket.id);
      console.log(`[ws] Socket ${socket.id} joined agent room ${agentRoom} (post-registration, primary)`);
    });

    socket.on('disconnect', () => {
      const agentId = socketToAgent.get(socket.id);
      if (agentId) {
        socketToAgent.delete(socket.id);
        if (agentPrimarySocket.get(agentId) === socket.id) {
          agentPrimarySocket.delete(agentId);
        }
        markAgentOffline(agentId);
      }
      console.log(`[ws] Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

function markAgentOffline(agentId: string) {
  endSession(agentId);
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
      plansIncluded: Boolean(row.plans_included),
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

/**
 * Check if an agent has a live extension socket connected.
 *
 * The `socketToAgent` map is only as accurate as the `disconnect` events that
 * maintain it — a server restart, a missed disconnect, or a half-open socket
 * can leave a stale entry that would otherwise pin a cartridge as "online"
 * forever (the idle→offline reaper skips agents this returns true for). So we
 * don't trust the map alone: every candidate socket is verified against the
 * live Socket.IO registry, and any entry whose socket is gone or no longer
 * connected is pruned in place.
 */
export function hasActiveSocket(agentId: string): boolean {
  let live = false;
  for (const [socketId, mappedAgentId] of socketToAgent) {
    if (mappedAgentId !== agentId) continue;

    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.connected) {
      live = true;
      continue;
    }

    // Stale mapping — the socket is gone but `disconnect` never cleaned it up.
    socketToAgent.delete(socketId);
    if (agentPrimarySocket.get(agentId) === socketId) {
      agentPrimarySocket.delete(agentId);
    }
  }
  return live;
}

/** Upgrade sockets in a path room to also join an agent room (handles race condition) */
export function upgradeSocketsToAgentRoom(machine: string, repoPath: string, agentId: string, agentType?: string) {
  const resolvedType = agentType || 'claude';
  const pathRoom = `ext:${machine}:${repoPath}:${resolvedType}`;
  const agentRoom = `agent:${agentId}`;
  const socketsInRoom = io.sockets.adapter.rooms.get(pathRoom);
  if (socketsInRoom && socketsInRoom.size > 0) {
    let lastSocketId: string | undefined;
    for (const socketId of socketsInRoom) {
      const s = io.sockets.sockets.get(socketId);
      if (s) {
        s.join(agentRoom);
        socketToAgent.set(socketId, agentId);
        lastSocketId = socketId;
      }
    }
    // Most recently iterated socket becomes primary
    if (lastSocketId) agentPrimarySocket.set(agentId, lastSocketId);
    console.log(`[ws] Upgraded ${socketsInRoom.size} socket(s) from ${pathRoom} to ${agentRoom}`);
  }
}

/** Return the primary (most recently registered) socket ID for an agent */
export function getPrimarySocket(agentId: string): string | undefined {
  return agentPrimarySocket.get(agentId);
}

export function getIO() {
  if (!io) {
    throw new Error('WebSocket not initialized. Call initWebSocket first.');
  }
  return io;
}
