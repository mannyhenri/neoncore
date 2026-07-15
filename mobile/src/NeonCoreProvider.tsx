import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { io, Socket } from 'socket.io-client';
import { api } from './api';
import type { Agent, PermissionRequest, TranscriptEvent, Workflow, WorkflowStep } from './types';

type TranscriptListener = (ev: TranscriptEvent) => void;
type WorkflowStepListener = (step: WorkflowStep) => void;
type WorkflowListener = (wf: Workflow) => void;

interface NeonCoreValue {
  baseUrl: string;
  connected: boolean;
  agents: Agent[];
  permissions: PermissionRequest[];
  refresh: () => Promise<void>;
  /** Put a cartridge away / bring it back. Does NOT stop the agent — see api.dismissAgent. */
  dismissAgent: (agentId: string) => Promise<void>;
  restoreAgent: (agentId: string) => Promise<void>;
  /** Subscribe to live transcript events for one agent. Returns an unsubscribe fn. */
  onTranscript: (agentId: string, cb: TranscriptListener) => () => void;
  /** Subscribe to live workflow step updates (all runs — caller filters). Returns an unsubscribe fn. */
  onWorkflowStep: (cb: WorkflowStepListener) => () => void;
  /** Subscribe to live workflow (run) status updates. Returns an unsubscribe fn. */
  onWorkflowUpdate: (cb: WorkflowListener) => () => void;
}

const Ctx = createContext<NeonCoreValue | null>(null);

export function useNeonCore(): NeonCoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNeonCore must be used within NeonCoreProvider');
  return v;
}

export function NeonCoreProvider({ baseUrl, children }: { baseUrl: string; children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const socketRef = useRef<Socket | null>(null);
  // Map<agentId, Set<listener>> for per-agent transcript fan-out.
  const listeners = useRef<Map<string, Set<TranscriptListener>>>(new Map());
  // Global fan-out for workflow step/status events — the run detail screen filters by id.
  const stepListeners = useRef<Set<WorkflowStepListener>>(new Set());
  const workflowListeners = useRef<Set<WorkflowListener>>(new Set());

  const refresh = useCallback(async () => {
    const [a, p] = await Promise.all([
      api.listAgents(baseUrl).catch(() => [] as Agent[]),
      api.pendingPermissions(baseUrl).catch(() => [] as PermissionRequest[]),
    ]);
    setAgents(a);
    setPermissions(p);
  }, [baseUrl]);

  // Patch the agent locally as well as relying on the server's agent_updated broadcast, so
  // the row leaves (or rejoins) the list immediately rather than after a socket round-trip.
  const dismissAgent = useCallback(async (agentId: string) => {
    setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, dismissedAt: new Date().toISOString() } : a)));
    try {
      await api.dismissAgent(baseUrl, agentId);
    } catch {
      refresh(); // put it back if the server disagreed
    }
  }, [baseUrl, refresh]);

  const restoreAgent = useCallback(async (agentId: string) => {
    setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, dismissedAt: '' } : a)));
    try {
      await api.restoreAgent(baseUrl, agentId);
    } catch {
      refresh();
    }
  }, [baseUrl, refresh]);

  const onTranscript = useCallback((agentId: string, cb: TranscriptListener) => {
    let set = listeners.current.get(agentId);
    if (!set) {
      set = new Set();
      listeners.current.set(agentId, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }, []);

  const onWorkflowStep = useCallback((cb: WorkflowStepListener) => {
    stepListeners.current.add(cb);
    return () => { stepListeners.current.delete(cb); };
  }, []);

  const onWorkflowUpdate = useCallback((cb: WorkflowListener) => {
    workflowListeners.current.add(cb);
    return () => { workflowListeners.current.delete(cb); };
  }, []);

  useEffect(() => {
    refresh();
    const socket = io(baseUrl, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    // Re-sync on every (re)connect, not just the first one.
    //
    // A phone drops its socket constantly — screen lock, backgrounding, Wi-Fi/cell
    // handoff. Any `permission_requested` emitted while we were away is gone: socket
    // events are fire-and-forget, there is no replay. Without this refetch the client
    // reconnects, cheerfully renders "live", and shows an EMPTY approvals inbox while
    // an agent sits blocked on a question. That is the whole point of the app failing.
    socket.on('connect', () => {
      setConnected(true);
      refresh();
    });
    socket.on('disconnect', () => setConnected(false));

    const upsertAgent = (agent: Agent) =>
      setAgents((prev) => {
        const i = prev.findIndex((x) => x.id === agent.id);
        if (i === -1) return [...prev, agent];
        const next = prev.slice();
        next[i] = agent;
        return next;
      });

    socket.on('agent_registered', upsertAgent);
    socket.on('agent_updated', upsertAgent);

    socket.on('permission_requested', (r: PermissionRequest) =>
      setPermissions((prev) => (prev.some((p) => p.id === r.id) ? prev : [r, ...prev])),
    );
    socket.on('permission_decided', (r: PermissionRequest) =>
      setPermissions((prev) => prev.filter((p) => p.id !== r.id)),
    );
    socket.on('permissions_expired', () => {
      // A batch expired server-side — reconcile from source of truth.
      api.pendingPermissions(baseUrl).then(setPermissions).catch(() => {});
    });

    socket.on('transcript_event', (ev: TranscriptEvent) => {
      const set = listeners.current.get(ev.agentId);
      if (set) set.forEach((cb) => cb(ev));
    });

    // Live workflow progress — drives the run detail screen without polling.
    socket.on('workflow_step_updated', (step: WorkflowStep) =>
      stepListeners.current.forEach((cb) => cb(step)),
    );
    socket.on('workflow_updated', (wf: Workflow) =>
      workflowListeners.current.forEach((cb) => cb(wf)),
    );
    // Recovery transitions arrive on their own channel — reshape to a partial step patch.
    socket.on('workflow_step_recovery', (d: { stepId: string; workflowId: string; status: string; recoveryStatus: string }) =>
      stepListeners.current.forEach((cb) =>
        cb({ id: d.stepId, workflowId: d.workflowId, status: d.status, recoveryStatus: d.recoveryStatus } as WorkflowStep),
      ),
    );

    // Belt-and-braces: iOS can suspend the app without the socket ever firing
    // `disconnect`, so a reconnect refetch alone can miss events. Any time we come
    // back to the foreground — the exact moment you look at the phone — re-sync.
    const appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });

    return () => {
      appStateSub.remove();
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [baseUrl, refresh]);

  const value = useMemo<NeonCoreValue>(
    () => ({
      baseUrl, connected, agents, permissions, refresh, dismissAgent, restoreAgent,
      onTranscript, onWorkflowStep, onWorkflowUpdate,
    }),
    [baseUrl, connected, agents, permissions, refresh, dismissAgent, restoreAgent,
      onTranscript, onWorkflowStep, onWorkflowUpdate],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
