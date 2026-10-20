import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { ServerToClientEvents, ClientToServerEvents } from './types.js';
import db from './db.js';
import { endSession } from './lib/session-manager.js';
import { markAgentSessionInterrupted } from './lib/agent-session-state.js';
import {
  claimMachineSocket,
  releaseMachineSocket,
  machineSocketId as resolveMachineSocket,
  machineClaimants,
} from './lib/machine-sockets.js';

let io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;

// Track which socket belongs to which agent (for offline detection on disconnect)
const socketToAgent = new Map<string, string>();

// Track the primary (most recently registered) socket per agent — commands go here
const agentPrimarySocket = new Map<string, string>(); // agentId → socketId

// Which socket speaks for which machine runner lives in lib/machine-sockets.ts — machine
// instructions are point-to-point (one socket), never a room broadcast. See that module for
// why: two runner daemons share one machineId, and a broadcast opened two terminals per click.

/** Is this socket still connected? The liveness probe machine-sockets.ts is given. */
const socketIsConnected = (socketId: string): boolean =>
  io.sockets.sockets.get(socketId)?.connected === true;

/**
 * How long a cartridge may be without a relay socket before it is treated as gone.
 *
 * A disconnect used to be final the instant it arrived. But relays reconnect on their own in
 * well under a second, so one network hiccup (all ten sockets dropped at once on Sep 27, the
 * server stayed up) marked every cartridge offline, interrupted its session and ended its
 * session record — and since nothing on rejoin undid that, every idle cartridge vanished from
 * the dashboard until it next ran a tool. A relay that is really gone is still gone after this.
 */
function disconnectGraceMs(): number {
  const v = Number(process.env.NEONCORE_DISCONNECT_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 15_000;
}

/**
 * Cartridges whose `interrupted` flag THIS module set because their socket went away. Only
 * those are cleared when the relay rejoins; an interruption recorded for any other reason (a
 * crashed session, a server restart) may really need resuming and is left alone.
 */
const interruptedByDisconnect = new Set<string>();

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
          markAgentBackOnline(agent.id);
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
      markAgentBackOnline(agentId);
    });

    // Runner daemon claims its machine room after REST registration. The newest claim wins
    // the machine: a runner that just reconnected is the live one, and any older socket
    // still holding the id is either a stale reconnect or a duplicate daemon.
    socket.on('join_machine_room', ({ machineId }) => {
      socket.join(`machine:${machineId}`);
      claimMachineSocket(socket.id, machineId);
      markMachineStatus(machineId, 'online');
      console.log(`[ws] Socket ${socket.id} joined machine room machine:${machineId} (primary)`);

      // Two live sockets for one machineId means two runner processes on that box. Only the
      // primary gets instructions now, but say so — the other keeps duplicating heartbeats,
      // registrations and config writes until someone stops it.
      const claimants = machineClaimants(machineId, socketIsConnected);
      if (claimants.length > 1) {
        console.warn(
          `[ws] machine:${machineId} is claimed by ${claimants.length} live sockets ` +
          `(${claimants.join(', ')}) — a duplicate runner is running on that machine. ` +
          `Instructions go to ${socket.id} only.`,
        );
      }
    });

    socket.on('machine_heartbeat', ({ machineId }) => {
      db.prepare("UPDATE machines SET last_seen = ? WHERE id = ?").run(new Date().toISOString(), machineId);
    });

    socket.on('disconnect', () => {
      const agentId = socketToAgent.get(socket.id);
      if (agentId) {
        socketToAgent.delete(socket.id);
        if (agentPrimarySocket.get(agentId) === socket.id) {
          agentPrimarySocket.delete(agentId);
        }
        // Not yet: a relay that reconnects inside the grace window never went away.
        const timer = setTimeout(() => {
          if (!agentHasLiveSocket(agentId)) markAgentOffline(agentId);
        }, disconnectGraceMs());
        timer.unref?.();
      }
      const machineId = releaseMachineSocket(socket.id);
      if (machineId) {
        // Only flip offline if no OTHER live socket still holds this machine (rare, but a
        // reconnect can briefly overlap). The lookup also promotes that survivor to primary,
        // so instructions keep flowing without waiting for a re-join.
        if (!resolveMachineSocket(machineId, socketIsConnected)) markMachineStatus(machineId, 'offline');
      }
      console.log(`[ws] Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

function markAgentOffline(agentId: string) {
  if (markAgentSessionInterrupted(agentId, 'disconnect')) interruptedByDisconnect.add(agentId);
  endSession(agentId);
  const now = new Date().toISOString();
  db.prepare("UPDATE agents SET status = 'offline', last_seen = ? WHERE id = ?").run(now, agentId);
  broadcastAgent(agentId, now);
  console.log(`[ws] Agent ${agentId} marked offline (extension disconnected)`);
}

/**
 * A relay rejoined. If the cartridge was marked offline, it is back: idle, and without the
 * `interrupted` flag its own disconnect set. A status that is not `offline` (working, waiting)
 * belongs to the session and is never touched here.
 */
function markAgentBackOnline(agentId: string) {
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
  if (!row || row.status !== 'offline') return;
  const now = new Date().toISOString();
  db.prepare("UPDATE agents SET status = 'idle', last_seen = ? WHERE id = ?").run(now, agentId);
  if (interruptedByDisconnect.delete(agentId)) {
    db.prepare(
      "UPDATE agents SET recovery_status = '', interrupted_at = NULL, recovery_session_id = '' WHERE id = ? AND recovery_status = 'interrupted'",
    ).run(agentId);
  }
  broadcastAgent(agentId, now);
  console.log(`[ws] Agent ${agentId} back online (relay rejoined)`);
}

/** Push the cartridge's current row to every dashboard. */
export function broadcastAgent(agentId: string, now: string) {
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
      status: row.status as import('./types.js').Agent['status'],
      trustMode: mode === 'trust',
      plansIncluded: Boolean(row.plans_included),
      mode,
      agentType: ((row.agent_type as string) ?? 'claude') as import('./types.js').AgentType,
      lastSeen: now,
      sessionId: (row.session_id as string) ?? '',
      lastMessage: (row.last_message as string) ?? '',
      pendingQuestion: (row.pending_question as string) ?? '',
      dismissedAt: (row.dismissed_at as string) ?? '',
      recoveryStatus: ((row.recovery_status as string) ?? '') as import('./types.js').Agent['recoveryStatus'],
      interruptedAt: (row.interrupted_at as string) ?? '',
      activeObjective: (row.active_objective as string) ?? '',
      standardState: ((row.standard_state as string) ?? '') as '' | 'needs_review',
    });
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

/** A quiet cartridge can retain a live relay even when its last tool hook is old. */
export function agentHasLiveSocket(agentId: string): boolean {
  if (!io) return false;
  const primary = agentPrimarySocket.get(agentId);
  if (primary && socketIsConnected(primary)) return true;
  const room = io.sockets.adapter.rooms.get(`agent:${agentId}`);
  return Boolean(room && [...room].some(socketIsConnected));
}

// ─── Machine runners ────────────────────────────────────────────

/** Update a machine's status, persist last_seen, and broadcast to dashboards/mobile. */
function markMachineStatus(machineId: string, status: 'online' | 'offline') {
  const now = new Date().toISOString();
  db.prepare('UPDATE machines SET status = ?, last_seen = ? WHERE id = ?').run(status, now, machineId);
  const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId) as Record<string, unknown> | undefined;
  if (row) {
    io.emit('machine_updated', {
      id: row.id as string,
      hostname: (row.hostname as string) ?? '',
      platform: (row.platform as string) ?? '',
      arch: (row.arch as string) ?? '',
      repos: JSON.parse((row.repos as string) || '[]'),
      status,
      lastSeen: now,
    });
  }
}

/** True if a runner socket is currently connected for this machine. */
export function isMachineOnline(machineId: string): boolean {
  return resolveMachineSocket(machineId, socketIsConnected) !== null;
}

/**
 * Dispatch a launch instruction to a machine's runner. Returns false if it's offline.
 *
 * Addressed to ONE socket, never the machine room: duplicate runners share a machineId, and a
 * broadcast turned one click into one terminal per daemon.
 */
export function dispatchLaunchToMachine(
  machineId: string,
  payload: { repoPath: string; agentType: string; sessionId: string; context: string; resumeSessionId?: string },
): boolean {
  const target = resolveMachineSocket(machineId, socketIsConnected);
  if (!target) return false;
  io.to(target).emit('launch_cartridge', {
    machineId,
    repoPath: payload.repoPath,
    agentType: payload.agentType as import('./types.js').AgentType,
    sessionId: payload.sessionId,
    context: payload.context,
    resumeSessionId: payload.resumeSessionId || '',
  });
  return true;
}

/** Ask a machine's runner to set its exposed-folder allowlist. The runner validates each
 *  path against its own disk, persists to its config, and re-registers — so the DB updates
 *  via that register, not here. Returns false if the machine is offline. */
export function dispatchSetReposToMachine(
  machineId: string,
  repos: import('./types.js').MachineRepo[],
): boolean {
  const target = resolveMachineSocket(machineId, socketIsConnected);
  if (!target) return false;
  io.to(target).emit('machine_set_repos', { machineId, repos });
  return true;
}

/** Ask a machine's runner to scan a directory on its own disk and add the git repos under
 *  it to its allowlist. Returns false if the machine is offline. */
export function dispatchScanToMachine(machineId: string, root: string): boolean {
  const target = resolveMachineSocket(machineId, socketIsConnected);
  if (!target) return false;
  io.to(target).emit('machine_scan', { machineId, root });
  return true;
}

/**
 * TEST ONLY — install a stand-in for the socket server.
 *
 * A test suite must not be able to emit to anything a human is reading. Constructing a real
 * Socket.IO Server from a test sets the same module-global `io` that production code reads,
 * which is a capability the suite should simply not have — independent of whether any given
 * suite currently misuses it. A recording stub gives tests the dispatch happy path with no
 * blast radius, and makes emissions assertable instead of invisible.
 */
export function setIOForTests(fake: unknown): void {
  io = fake as typeof io;
}

export function getIO() {
  if (!io) {
    throw new Error('WebSocket not initialized. Call initWebSocket first.');
  }
  return io;
}
