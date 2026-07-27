import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { io, Socket } from 'socket.io-client';
import { api, ApiError, setServerToken } from './api';
import {
  type ServerEntry, activeServers, fallbackName, saveServers, upsertServer,
} from './config';
import type { Agent, ConferSession, PermissionRequest, TranscriptEvent, Workflow, WorkflowStep } from './types';

type TranscriptListener = (ev: TranscriptEvent) => void;
type WorkflowStepListener = (step: WorkflowStep) => void;
type WorkflowListener = (wf: Workflow) => void;

/** Live state of one server in the fleet. */
export interface ServerStatus {
  url: string;
  name: string;
  reachable: boolean;
  /** A rejected token, not a sleeping machine. Only a human can fix it. */
  authFailed: boolean;
  socketConnected: boolean;
  lastOkAt: string;
  lastError: string;
}

interface NeonCoreValue {
  /**
   * The PRIMARY server — the one this phone was set up with.
   *
   * Kept so the workflow screens keep working unchanged: workflows, confers and templates
   * are single-server concerns by design, since a shared queue would imply a hub and the
   * topology is built on servers being independent.
   */
  baseUrl: string;
  connected: boolean;
  agents: Agent[];
  permissions: PermissionRequest[];
  confers: ConferSession[];
  refresh: () => Promise<void>;
  dismissAgent: (agentId: string) => Promise<void>;
  restoreAgent: (agentId: string) => Promise<void>;
  onTranscript: (agentId: string, cb: TranscriptListener) => () => void;
  onWorkflowStep: (cb: WorkflowStepListener) => () => void;
  onWorkflowUpdate: (cb: WorkflowListener) => () => void;

  // ─── Fleet ───
  servers: ServerEntry[];
  serverStatuses: ServerStatus[];
  /**
   * Which server owns this agent. Ids are unique per DATABASE, not across the fleet, so
   * without this a command goes to whichever server is tried first and, on the wrong one,
   * silently does nothing at all.
   */
  urlForAgent: (agentId: string) => string;
  urlForPermission: (permissionId: string) => string;
  addServer: (url: string, token?: string | null) => Promise<void>;
  forgetServer: (url: string) => Promise<void>;
  hideServer: (url: string, hidden: boolean) => Promise<void>;
  setToken: (token: string | null) => Promise<void>;
}

const Ctx = createContext<NeonCoreValue | null>(null);

export function useNeonCore(): NeonCoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNeonCore must be used within NeonCoreProvider');
  return v;
}

/** Origin is stamped on arrival so every downstream write can be routed. */
type Tagged<T> = T & { origin: string; originName: string };

export function NeonCoreProvider({
  servers: initialServers,
  onServersChange,
  children,
}: {
  servers: ServerEntry[];
  onServersChange?: (servers: ServerEntry[]) => void;
  children: React.ReactNode;
}) {
  const [servers, setServersState] = useState<ServerEntry[]>(initialServers);
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>({});

  // Per-server slices, merged at read time so one server's failure cannot touch another's
  // data. A phone loses servers constantly — this is the normal case, not the edge case.
  const [agentsByServer, setAgentsByServer] = useState<Record<string, Agent[]>>({});
  const [permsByServer, setPermsByServer] = useState<Record<string, PermissionRequest[]>>({});
  const [confersByServer, setConfersByServer] = useState<Record<string, ConferSession[]>>({});

  const listeners = useRef<Map<string, Set<TranscriptListener>>>(new Map());
  const stepListeners = useRef<Set<WorkflowStepListener>>(new Set());
  const workflowListeners = useRef<Set<WorkflowListener>>(new Set());

  const active = useMemo(() => activeServers(servers), [servers]);
  const serversRef = useRef(active);
  serversRef.current = active;

  // Tokens live in the api module; keep them in sync with the roster.
  useEffect(() => {
    for (const s of servers) setServerToken(s.url, s.token);
  }, [servers]);

  const persist = useCallback((next: ServerEntry[]) => {
    setServersState(next);
    saveServers(next).catch(() => {});
    onServersChange?.(next);
  }, [onServersChange]);

  const primary = active[0]?.url ?? servers[0]?.url ?? '';

  /** Refresh ONE server. Independent by design: an asleep laptop must not blank the list. */
  const refreshServer = useCallback(async (server: ServerEntry) => {
    const url = server.url;
    const [a, p, c] = await Promise.allSettled([
      api.listAgents(url),
      api.pendingPermissions(url),
      api.listConfers(url),
    ]);

    if (a.status === 'fulfilled') setAgentsByServer((prev) => ({ ...prev, [url]: a.value }));
    if (p.status === 'fulfilled') setPermsByServer((prev) => ({ ...prev, [url]: p.value }));
    if (c.status === 'fulfilled') setConfersByServer((prev) => ({ ...prev, [url]: c.value }));

    const failure = a.status === 'rejected' ? a.reason : null;
    const err = failure instanceof ApiError ? failure : null;

    setStatuses((prev) => ({
      ...prev,
      [url]: {
        url,
        name: server.name || fallbackName(url),
        reachable: !failure,
        authFailed: err?.kind === 'auth',
        socketConnected: prev[url]?.socketConnected ?? false,
        // Preserved across a failure so the UI can say "showing last known data" rather
        // than pretending the cartridges never existed.
        lastOkAt: failure ? (prev[url]?.lastOkAt ?? '') : new Date().toISOString(),
        lastError: failure ? (err?.message ?? String(failure)) : '',
      },
    }));
  }, []);

  const refresh = useCallback(async () => {
    await Promise.allSettled(serversRef.current.map((s) => refreshServer(s)));
  }, [refreshServer]);

  // ─── Discovery ────────────────────────────────────────────────────────────
  // Point the phone at one server and the rest of the fleet appears by itself.
  useEffect(() => {
    let cancelled = false;
    const discover = async () => {
      const results = await Promise.allSettled(
        serversRef.current.map(async (s) => ({ from: s, roster: await api.getPeers(s.url) })),
      );
      if (cancelled) return;

      setServersState((prev) => {
        let next = prev;
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const { from, roster } = r.value;
          next = next.map((s) =>
            s.url === from.url
              ? { ...s, serverId: roster.self.serverId || s.serverId, name: s.manual && s.name ? s.name : roster.self.name || s.name }
              : s,
          );
          for (const peer of roster.peers) {
            next = upsertServer(next, { url: peer.url, name: peer.name, serverId: peer.serverId, manual: false });
          }
        }
        if (next !== prev) {
          saveServers(next).catch(() => {});
          onServersChange?.(next);
        }
        return next;
      });
    };

    discover();
    const interval = setInterval(discover, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [active.length, onServersChange]);

  // ─── Merge ────────────────────────────────────────────────────────────────

  const agents = useMemo<Tagged<Agent>[]>(
    () => active.flatMap((s) =>
      (agentsByServer[s.url] ?? []).map((a) => ({
        ...a, origin: s.url, originName: s.name || fallbackName(s.url),
      })),
    ),
    [active, agentsByServer],
  );

  const permissions = useMemo<Tagged<PermissionRequest>[]>(
    () => active.flatMap((s) =>
      (permsByServer[s.url] ?? []).map((p) => ({
        ...p, origin: s.url, originName: s.name || fallbackName(s.url),
      })),
    ),
    [active, permsByServer],
  );

  const confers = useMemo<ConferSession[]>(
    () => active.flatMap((s) => confersByServer[s.url] ?? []),
    [active, confersByServer],
  );

  const urlForAgent = useCallback((agentId: string): string => {
    for (const s of serversRef.current) {
      if ((agentsByServer[s.url] ?? []).some((a) => a.id === agentId)) return s.url;
    }
    return primary;
  }, [agentsByServer, primary]);

  const urlForPermission = useCallback((permissionId: string): string => {
    for (const s of serversRef.current) {
      if ((permsByServer[s.url] ?? []).some((p) => p.id === permissionId)) return s.url;
    }
    return primary;
  }, [permsByServer, primary]);

  // ─── Writes ───────────────────────────────────────────────────────────────

  const patchAgentLocal = useCallback((url: string, agentId: string, patch: Partial<Agent>) => {
    setAgentsByServer((prev) => ({
      ...prev,
      [url]: (prev[url] ?? []).map((a) => (a.id === agentId ? { ...a, ...patch } : a)),
    }));
  }, []);

  const dismissAgent = useCallback(async (agentId: string) => {
    const url = urlForAgent(agentId);
    patchAgentLocal(url, agentId, { dismissedAt: new Date().toISOString() });
    try {
      await api.dismissAgent(url, agentId);
    } catch {
      refresh();
    }
  }, [urlForAgent, patchAgentLocal, refresh]);

  const restoreAgent = useCallback(async (agentId: string) => {
    const url = urlForAgent(agentId);
    patchAgentLocal(url, agentId, { dismissedAt: '' });
    try {
      await api.restoreAgent(url, agentId);
    } catch {
      refresh();
    }
  }, [urlForAgent, patchAgentLocal, refresh]);

  const onTranscript = useCallback((agentId: string, cb: TranscriptListener) => {
    let set = listeners.current.get(agentId);
    if (!set) { set = new Set(); listeners.current.set(agentId, set); }
    set.add(cb);
    return () => { set?.delete(cb); };
  }, []);

  const onWorkflowStep = useCallback((cb: WorkflowStepListener) => {
    stepListeners.current.add(cb);
    return () => { stepListeners.current.delete(cb); };
  }, []);

  const onWorkflowUpdate = useCallback((cb: WorkflowListener) => {
    workflowListeners.current.add(cb);
    return () => { workflowListeners.current.delete(cb); };
  }, []);

  // ─── Sockets: one per server ──────────────────────────────────────────────

  const socketKey = useMemo(
    () => active.map((s) => `${s.url}|${s.token ?? ''}`).join(','),
    [active],
  );

  useEffect(() => {
    refresh();
    const sockets: Socket[] = [];

    for (const server of active) {
      const url = server.url;
      const socket = io(url, {
        transports: ['websocket', 'polling'],
        auth: server.token ? { token: server.token } : undefined,
      });
      sockets.push(socket);

      // Re-sync on every (re)connect, not just the first.
      //
      // A phone drops its socket constantly — screen lock, backgrounding, Wi-Fi/cell
      // handoff. Any `permission_requested` emitted while we were away is gone: socket
      // events are fire-and-forget, there is no replay. Without this refetch the client
      // reconnects, cheerfully renders "live", and shows an EMPTY approvals inbox while
      // an agent sits blocked on a question. That is the whole point of the app failing.
      socket.on('connect', () => {
        setStatuses((prev) => ({
          ...prev,
          [url]: { ...(prev[url] ?? { url, name: server.name, reachable: true, authFailed: false, lastOkAt: '', lastError: '' }), socketConnected: true },
        }));
        refreshServer(server);
      });
      socket.on('disconnect', () => {
        setStatuses((prev) => (prev[url] ? { ...prev, [url]: { ...prev[url], socketConnected: false } } : prev));
      });

      const upsertAgent = (agent: Agent) =>
        setAgentsByServer((prev) => {
          const list = prev[url] ?? [];
          const i = list.findIndex((x) => x.id === agent.id);
          if (i === -1) return { ...prev, [url]: [...list, agent] };
          const next = list.slice();
          next[i] = agent;
          return { ...prev, [url]: next };
        });

      socket.on('agent_registered', upsertAgent);
      socket.on('agent_updated', upsertAgent);

      socket.on('permission_requested', (r: PermissionRequest) =>
        setPermsByServer((prev) => {
          const list = prev[url] ?? [];
          return list.some((p) => p.id === r.id) ? prev : { ...prev, [url]: [r, ...list] };
        }),
      );
      socket.on('permission_decided', (r: PermissionRequest) =>
        setPermsByServer((prev) => ({ ...prev, [url]: (prev[url] ?? []).filter((p) => p.id !== r.id) })),
      );
      socket.on('permissions_expired', () => {
        api.pendingPermissions(url)
          .then((p) => setPermsByServer((prev) => ({ ...prev, [url]: p })))
          .catch(() => {});
      });

      socket.on('transcript_event', (ev: TranscriptEvent) => {
        const set = listeners.current.get(ev.agentId);
        if (set) set.forEach((cb) => cb(ev));
      });

      socket.on('confer_updated', (session: ConferSession) =>
        setConfersByServer((prev) => {
          const list = prev[url] ?? [];
          const i = list.findIndex((c) => c.id === session.id);
          if (i === -1) return { ...prev, [url]: [session, ...list] };
          const next = list.slice();
          next[i] = session;
          return { ...prev, [url]: next };
        }),
      );

      socket.on('workflow_step_updated', (step: WorkflowStep) =>
        stepListeners.current.forEach((cb) => cb(step)),
      );
      socket.on('workflow_updated', (wf: Workflow) =>
        workflowListeners.current.forEach((cb) => cb(wf)),
      );
      socket.on('workflow_step_recovery', (d: { stepId: string; workflowId: string; status: string; recoveryStatus: string }) =>
        stepListeners.current.forEach((cb) =>
          cb({ id: d.stepId, workflowId: d.workflowId, status: d.status, recoveryStatus: d.recoveryStatus } as WorkflowStep),
        ),
      );
    }

    // Belt-and-braces: iOS can suspend the app without the socket ever firing
    // `disconnect`, so a reconnect refetch alone can miss events. Any time we come back to
    // the foreground — the exact moment you look at the phone — re-sync every server.
    const appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });

    return () => {
      appStateSub.remove();
      for (const s of sockets) { s.removeAllListeners(); s.disconnect(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketKey]);

  // ─── Fleet management ─────────────────────────────────────────────────────

  const addServer = useCallback(async (url: string, token?: string | null) => {
    persist(upsertServer(serversRef.current, { url, token, manual: true }));
  }, [persist]);

  const forgetServer = useCallback(async (url: string) => {
    persist(serversRef.current.filter((s) => s.url !== url));
  }, [persist]);

  const hideServer = useCallback(async (url: string, hidden: boolean) => {
    persist(servers.map((s) => (s.url === url ? { ...s, hidden } : s)));
  }, [persist, servers]);

  const setToken = useCallback(async (token: string | null) => {
    persist(servers.map((s) => ({ ...s, token })));
  }, [persist, servers]);

  const serverStatuses = useMemo<ServerStatus[]>(
    () => active.map((s) => statuses[s.url] ?? {
      url: s.url, name: s.name || fallbackName(s.url), reachable: false,
      authFailed: false, socketConnected: false, lastOkAt: '', lastError: '',
    }),
    [active, statuses],
  );

  // "Connected" means at least one server is live. On a phone, requiring ALL of them
  // would show a red banner permanently — some machine is always asleep.
  const connected = serverStatuses.some((s) => s.socketConnected);

  const value = useMemo<NeonCoreValue>(
    () => ({
      baseUrl: primary, connected, agents, permissions, confers, refresh,
      dismissAgent, restoreAgent, onTranscript, onWorkflowStep, onWorkflowUpdate,
      servers, serverStatuses, urlForAgent, urlForPermission,
      addServer, forgetServer, hideServer, setToken,
    }),
    [primary, connected, agents, permissions, confers, refresh, dismissAgent, restoreAgent,
      onTranscript, onWorkflowStep, onWorkflowUpdate, servers, serverStatuses,
      urlForAgent, urlForPermission, addServer, forgetServer, hideServer, setToken],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
