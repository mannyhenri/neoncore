import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { Agent, Activity, PermissionRequest, Command, StuckAlert, EpicRun } from '../types';

interface SocketHandlers {
  onAgentRegistered?: (agent: Agent) => void;
  onAgentUpdated?: (agent: Agent) => void;
  onActivityLogged?: (activity: Activity) => void;
  onPermissionRequested?: (request: PermissionRequest) => void;
  onPermissionDecided?: (request: PermissionRequest) => void;
  onCommandSend?: (command: Command) => void;
  onAgentStuck?: (alert: StuckAlert) => void;
  onAgentUnstuck?: (data: { agentId: string }) => void;
  onMemoryUpdated?: (data: { agentId: string }) => void;
  onPermissionsExpired?: (data: { count: number }) => void;
  onEpicUpdated?: (run: EpicRun) => void;
  onReconnect?: () => void;
}

export function useSocket(handlers: SocketHandlers) {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const hasConnectedOnce = useRef(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[ws] Connected to orchestrator');
      setConnected(true);
      if (hasConnectedOnce.current) {
        console.log('[ws] Reconnected — refreshing data');
        handlersRef.current.onReconnect?.();
      }
      hasConnectedOnce.current = true;
    });

    socket.on('disconnect', () => {
      console.log('[ws] Disconnected from orchestrator');
      setConnected(false);
    });

    socket.on('agent_registered', (agent: Agent) => {
      handlersRef.current.onAgentRegistered?.(agent);
    });

    socket.on('agent_updated', (agent: Agent) => {
      handlersRef.current.onAgentUpdated?.(agent);
    });

    socket.on('activity_logged', (activity: Activity) => {
      handlersRef.current.onActivityLogged?.(activity);
    });

    socket.on('permission_requested', (request: PermissionRequest) => {
      handlersRef.current.onPermissionRequested?.(request);
    });

    socket.on('permission_decided', (request: PermissionRequest) => {
      handlersRef.current.onPermissionDecided?.(request);
    });

    socket.on('command_send', (command: Command) => {
      handlersRef.current.onCommandSend?.(command);
    });

    socket.on('agent_stuck' as any, (alert: StuckAlert) => {
      handlersRef.current.onAgentStuck?.(alert);
    });

    socket.on('agent_unstuck' as any, (data: { agentId: string }) => {
      handlersRef.current.onAgentUnstuck?.(data);
    });

    socket.on('memory_updated' as any, (data: { agentId: string }) => {
      handlersRef.current.onMemoryUpdated?.(data);
    });

    socket.on('permissions_expired' as any, (data: { count: number }) => {
      handlersRef.current.onPermissionsExpired?.(data);
    });

    socket.on('epic_updated' as any, (run: EpicRun) => {
      handlersRef.current.onEpicUpdated?.(run);
    });

    // Mobile: refresh data when tab becomes visible again
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('[ws] Tab visible — reconnecting and refreshing');
        if (!socket.connected) {
          socket.connect();
        }
        handlersRef.current.onReconnect?.();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      socket.disconnect();
    };
  }, []);

  return { connected };
}
