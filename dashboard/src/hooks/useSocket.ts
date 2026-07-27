import { useEffect, useRef, useState, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import type { Agent, Activity, PermissionRequest, Command, StuckAlert, EpicRun, Workflow, WorkflowStep, WorkflowStepLog, VirtualCartridge, WorkflowNotification, Task, Machine, ServerEntry } from '../types';

/**
 * One socket per server, always (D6).
 *
 * Sharing a connection is not an option — each server is a separate process with its own
 * event stream. The reconnect and backoff logic here is the same proven code as before,
 * now instantiated N times rather than once.
 *
 * Every handler receives the ORIGIN that emitted the event. Without it an incoming
 * `agent_updated` cannot be attributed: agent ids are unique per database, not across the
 * fleet, so an event from studio could silently patch a same-id row belonging to desktop.
 *
 * Revisit around ~5 servers, where per-tab connection count starts to matter.
 */

interface SocketHandlers {
  onAgentRegistered?: (agent: Agent, origin: string) => void;
  onAgentUpdated?: (agent: Agent, origin: string) => void;
  onActivityLogged?: (activity: Activity, origin: string) => void;
  onPermissionRequested?: (request: PermissionRequest, origin: string) => void;
  onPermissionDecided?: (request: PermissionRequest, origin: string) => void;
  onCommandSend?: (command: Command, origin: string) => void;
  onAgentStuck?: (alert: StuckAlert, origin: string) => void;
  onAgentUnstuck?: (data: { agentId: string }, origin: string) => void;
  onMemoryUpdated?: (data: { agentId: string }, origin: string) => void;
  onPermissionsExpired?: (data: { count: number }, origin: string) => void;
  onEpicUpdated?: (run: EpicRun, origin: string) => void;
  onWorkflowUpdated?: (workflow: Workflow, origin: string) => void;
  onWorkflowDeleted?: (data: { id: string }, origin: string) => void;
  onWorkflowStepUpdated?: (step: WorkflowStep, origin: string) => void;
  onWorkflowStepLog?: (log: WorkflowStepLog, origin: string) => void;
  onWorkflowStepRecovery?: (data: {
    stepId: string;
    workflowId: string;
    name: string;
    status: string;
    recoveryStatus: string;
    interruptedAt: string | null;
    recoveryAttempts: number;
  }, origin: string) => void;
  onVirtualCartridgeUpdated?: (vc: VirtualCartridge, origin: string) => void;
  onWorkflowNotification?: (n: WorkflowNotification, origin: string) => void;
  onTaskCreated?: (task: Task, origin: string) => void;
  onTaskUpdated?: (task: Task, origin: string) => void;
  onMachineUpdated?: (machine: Machine, origin: string) => void;
  /** Fired per server, with the origin that just came back. */
  onReconnect?: (origin: string) => void;
}

export function useSockets(servers: ServerEntry[], handlers: SocketHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const [connectedOrigins, setConnectedOrigins] = useState<Record<string, boolean>>({});

  // Re-subscribe only when the SET of servers changes, not on every render. Keying on the
  // urls+tokens means a token edit reconnects that server and nothing else.
  const key = useMemo(
    () => servers.map((s) => `${s.url}|${s.token ?? ''}`).join(','),
    [servers],
  );

  useEffect(() => {
    const sockets: Socket[] = [];
    const seenOnce = new Set<string>();

    for (const server of servers) {
      const origin = server.url;
      // Empty origin means the server that served this page — socket.io's own default.
      const target = origin || window.location.origin;

      const socket = io(target, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
        timeout: 10000,
        // Presented for when the fleet moves to strict. Harmless while permissive.
        auth: server.token ? { token: server.token } : undefined,
      });
      sockets.push(socket);

      socket.on('connect', () => {
        console.log(`[ws] Connected to ${server.name || target}`);
        setConnectedOrigins((prev) => ({ ...prev, [origin]: true }));
        if (seenOnce.has(origin)) {
          console.log(`[ws] Reconnected to ${server.name || target} — refreshing`);
          handlersRef.current.onReconnect?.(origin);
        }
        seenOnce.add(origin);
      });

      socket.on('disconnect', () => {
        console.log(`[ws] Disconnected from ${server.name || target}`);
        setConnectedOrigins((prev) => ({ ...prev, [origin]: false }));
      });

      const on = <T,>(event: string, pick: (h: SocketHandlers) => ((data: T, origin: string) => void) | undefined) => {
        socket.on(event as never, (data: T) => pick(handlersRef.current)?.(data, origin));
      };

      on<Agent>('agent_registered', (h) => h.onAgentRegistered);
      on<Agent>('agent_updated', (h) => h.onAgentUpdated);
      on<Activity>('activity_logged', (h) => h.onActivityLogged);
      on<PermissionRequest>('permission_requested', (h) => h.onPermissionRequested);
      on<PermissionRequest>('permission_decided', (h) => h.onPermissionDecided);
      on<Command>('command_send', (h) => h.onCommandSend);
      on<StuckAlert>('agent_stuck', (h) => h.onAgentStuck);
      on<{ agentId: string }>('agent_unstuck', (h) => h.onAgentUnstuck);
      on<{ agentId: string }>('memory_updated', (h) => h.onMemoryUpdated);
      on<{ count: number }>('permissions_expired', (h) => h.onPermissionsExpired);
      on<EpicRun>('epic_updated', (h) => h.onEpicUpdated);
      on<Workflow>('workflow_updated', (h) => h.onWorkflowUpdated);
      on<{ id: string }>('workflow_deleted', (h) => h.onWorkflowDeleted);
      on<WorkflowStep>('workflow_step_updated', (h) => h.onWorkflowStepUpdated);
      on<WorkflowStepLog>('workflow_step_log', (h) => h.onWorkflowStepLog);
      on<Parameters<NonNullable<SocketHandlers['onWorkflowStepRecovery']>>[0]>(
        'workflow_step_recovery', (h) => h.onWorkflowStepRecovery,
      );
      on<VirtualCartridge>('virtual_cartridge_updated', (h) => h.onVirtualCartridgeUpdated);
      on<WorkflowNotification>('workflow_notification', (h) => h.onWorkflowNotification);
      on<Task>('task_created', (h) => h.onTaskCreated);
      on<Task>('task_updated', (h) => h.onTaskUpdated);
      on<Machine>('machine_updated', (h) => h.onMachineUpdated);
    }

    // Mobile: refresh when the tab comes back. Every server is refreshed, since any of
    // them could have moved on while the tab was backgrounded.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      console.log('[ws] Tab visible — reconnecting and refreshing');
      for (let i = 0; i < sockets.length; i++) {
        if (!sockets[i].connected) sockets[i].connect();
        handlersRef.current.onReconnect?.(servers[i].url);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      for (const s of sockets) s.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { connectedOrigins };
}

/** The local server, as a stable single-element list. */
const LOCAL_ONLY: ServerEntry[] = [{ url: '', serverId: '', name: 'This machine', token: null, manual: true }];

/**
 * Subscribe to the LOCAL server only.
 *
 * Kept for the panels whose subject matter is inherently single-server — workflows,
 * goals, machine launching. Cross-server workflows are explicitly out of scope: a shared
 * queue would imply a hub, and the whole topology is built on servers being independent.
 * When one of these panels does become fleet-aware, it moves to `useSockets`.
 *
 * Handlers written before federation take one argument. TypeScript allows those wherever
 * a two-argument handler is expected, so every existing call site compiles unchanged.
 */
export function useSocket(handlers: SocketHandlers) {
  const { connectedOrigins } = useSockets(LOCAL_ONLY, handlers);
  return { connected: connectedOrigins[''] ?? false };
}
