import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  Agent, AgentMode, Activity, PermissionRequest, StuckAlert, VirtualCartridge,
  WorkflowNotification, Task, ServerEntry, ServerStatus,
} from '../types';
import { ApiError } from '@neoncore/client';
import { api, apiFor } from '../lib/api';
import {
  loadServers, saveServers, upsertServer, removeServer, setServerHidden,
  setFleetToken, activeServers, fallbackName, dedupeByServerId,
} from '../lib/servers';
import { useSockets } from './useSocket';

function browserNotify(title: string, body: string, tag: string) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission();
    return;
  }
  if (Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag, icon: '/favicon.ico', silent: false });
  setTimeout(() => n.close(), 10000);
}

/**
 * Activity cap PER SERVER, not across the fleet.
 *
 * A single global buffer is a silent data-loss bug once there are two servers: one chatty
 * machine emits 100 events and evicts every trace of the quiet one, whose cartridges then
 * render with empty terminals as though nothing were running. Each server gets its own
 * budget so a noisy neighbour cannot starve anyone.
 */
const MAX_ACTIVITIES_PER_SERVER = 100;
const POLL_INTERVAL_MS = 10_000;

/** The client for a given origin. '' is the server that served this page. */
function clientFor(server: ServerEntry) {
  return server.url ? apiFor(server.url, server.token) : api;
}

function sortAgents(list: Agent[]): Agent[] {
  return [...list].sort((a, b) =>
    (a.repoName || a.name).localeCompare(b.repoName || b.name) || a.id.localeCompare(b.id)
  );
}

/** Agent ids are unique per database, so a fleet-wide key needs the origin too. */
function agentKey(origin: string, id: string): string {
  return `${origin}::${id}`;
}

export function useAgents(onVirtualCartridgeUpdated?: (vc: VirtualCartridge) => void) {
  const [servers, setServersState] = useState<ServerEntry[]>(() => loadServers());
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>({});
  const [loading, setLoading] = useState(true);

  // Per-server slices. Merging happens at read time (useMemo below) so one server's
  // failure can never mutate another's data.
  const [agentsByServer, setAgentsByServer] = useState<Record<string, Agent[]>>({});
  const [activitiesByServer, setActivitiesByServer] = useState<Record<string, Activity[]>>({});
  const [permissionsByServer, setPermissionsByServer] = useState<Record<string, PermissionRequest[]>>({});
  const [tasksByServer, setTasksByServer] = useState<Record<string, Task[]>>({});

  const [stuckAlerts, setStuckAlerts] = useState<Map<string, StuckAlert>>(new Map());
  const [workflowNotifications, setWorkflowNotifications] = useState<WorkflowNotification[]>([]);

  const setServers = useCallback((next: ServerEntry[]) => {
    setServersState(next);
    saveServers(next);
  }, []);

  const active = useMemo(() => activeServers(servers), [servers]);
  // Kept in a ref so callbacks can route a write without being rebuilt on every change.
  const serversRef = useRef(active);
  serversRef.current = active;

  /**
   * Refresh ONE server, independently.
   *
   * Deliberately per-server rather than a fleet-wide Promise.all: a single asleep laptop
   * must not blank the grid. On failure we keep that server's last-known-good data and
   * mark it unreachable — a stale cartridge you can still read beats an empty screen.
   */
  const refreshServer = useCallback(async (server: ServerEntry) => {
    const origin = server.url;
    const client = clientFor(server);

    const [agentsRes, activityRes, permsRes] = await Promise.allSettled([
      client.getAgents(),
      client.getActivity(),
      client.getPendingPermissions(),
    ]);

    if (agentsRes.status === 'fulfilled') {
      setAgentsByServer((prev) => ({ ...prev, [origin]: agentsRes.value }));
    }
    if (activityRes.status === 'fulfilled') {
      setActivitiesByServer((prev) => ({
        ...prev,
        [origin]: activityRes.value.slice(0, MAX_ACTIVITIES_PER_SERVER),
      }));
    }
    if (permsRes.status === 'fulfilled') {
      setPermissionsByServer((prev) => ({ ...prev, [origin]: permsRes.value }));
    }

    // Agents is the health signal: without it there is nothing to show for this server.
    const failure = agentsRes.status === 'rejected' ? agentsRes.reason : null;
    const err = failure instanceof ApiError ? failure : null;

    setStatuses((prev) => ({
      ...prev,
      [origin]: {
        url: origin,
        serverId: prev[origin]?.serverId ?? server.serverId ?? '',
        name: server.name || fallbackName(origin),
        reachable: !failure,
        // A rejected token is NOT a network problem. Surfacing it as "unreachable" is how
        // a one-line token fix turns into an afternoon of debugging the LAN.
        authFailed: err?.kind === 'auth',
        lastOkAt: failure ? (prev[origin]?.lastOkAt ?? '') : new Date().toISOString(),
        lastError: failure ? (err?.message ?? String(failure)) : '',
        socketConnected: prev[origin]?.socketConnected ?? false,
      },
    }));

    // Tasks load separately so a task failure never costs us the agent data.
    client.getTasks()
      .then((t) => setTasksByServer((prev) => ({ ...prev, [origin]: t })))
      .catch(() => {});
  }, []);

  const refreshData = useCallback(() => {
    const list = serversRef.current;
    // allSettled, never all: one rejection must not cancel the others.
    Promise.allSettled(list.map((s) => refreshServer(s))).finally(() => setLoading(false));
  }, [refreshServer]);

  useEffect(() => { refreshData(); }, [refreshData, active.length]);

  useEffect(() => {
    const interval = setInterval(refreshData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshData]);

  /**
   * Learn about peers from every server we can reach, and adopt them automatically.
   *
   * This is what makes federation feel like one system: point the app at one server and
   * the rest of the fleet appears. Discovered servers are marked non-manual so the UI can
   * distinguish "I added this" from "this was found".
   */
  useEffect(() => {
    let cancelled = false;
    const discover = async () => {
      const results = await Promise.allSettled(
        serversRef.current.map(async (s) => ({ from: s, roster: await clientFor(s).getPeers() })),
      );
      if (cancelled) return;

      setServersState((prev) => {
        let next = prev;

        // PASS 1 — record what each server says its own identity is.
        //
        // This must complete before any peer is merged. A peer's roster names the other
        // servers by whatever URL they advertise, which for THIS server is usually not
        // the URL the browser is using (`Mac.local` vs `localhost`). Until we know our
        // own serverId there is nothing to recognise that alias against, and we adopt
        // ourselves a second time — doubling every cartridge in the grid.
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const { from, roster } = r.value;
          next = next.map((s) =>
            s.url === from.url
              ? {
                  ...s,
                  serverId: roster.self.serverId || s.serverId,
                  name: s.manual && s.name ? s.name : roster.self.name || s.name,
                }
              : s,
          );
        }

        // PASS 2 — merge peers, now that every known serverId is in hand.
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          for (const peer of r.value.roster.peers) {
            next = upsertServer(next, {
              url: peer.url,
              name: peer.name,
              serverId: peer.serverId,
              manual: false,
            });
          }
        }

        // Belt-and-braces: collapse any alias that slipped in before its id was known
        // (e.g. added by hand, then identified on the next tick).
        next = dedupeByServerId(next);

        if (next !== prev) saveServers(next);
        return next;
      });
    };

    discover();
    const interval = setInterval(discover, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [active.length]);

  // Reconcile stuck alerts against live agents (unchanged behaviour, now fleet-wide).
  const allAgentsRaw = useMemo(
    () => active.flatMap((s) => (agentsByServer[s.url] ?? []).map((a) => ({ a, origin: s.url }))),
    [active, agentsByServer],
  );

  useEffect(() => {
    setStuckAlerts((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const key of prev.keys()) {
        const found = allAgentsRaw.find(({ a, origin }) => agentKey(origin, a.id) === key);
        if (!found || (found.a.status !== 'working' && found.a.status !== 'waiting')) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [allAgentsRaw]);

  const patchAgent = useCallback((origin: string, agent: Agent, mode: 'upsert' | 'update') => {
    setAgentsByServer((prev) => {
      const list = prev[origin] ?? [];
      const exists = list.some((a) => a.id === agent.id);
      if (!exists && mode === 'update') return prev;
      const next = exists ? list.map((a) => (a.id === agent.id ? agent : a)) : [...list, agent];
      return { ...prev, [origin]: next };
    });
  }, []);

  const { connectedOrigins } = useSockets(active, {
    onReconnect: (origin) => {
      const server = serversRef.current.find((s) => s.url === origin);
      if (server) refreshServer(server);
    },
    onAgentRegistered: (agent, origin) => patchAgent(origin, agent, 'upsert'),
    onAgentUpdated: (agent, origin) => patchAgent(origin, agent, 'update'),
    onActivityLogged: (activity, origin) => {
      setActivitiesByServer((prev) => ({
        ...prev,
        [origin]: [activity, ...(prev[origin] ?? [])].slice(0, MAX_ACTIVITIES_PER_SERVER),
      }));
    },
    onPermissionRequested: (request, origin) => {
      setPermissionsByServer((prev) => ({ ...prev, [origin]: [request, ...(prev[origin] ?? [])] }));
      const isQuestion = request.toolName === 'AskUserQuestion';
      const isPlan = request.toolName === 'ExitPlanMode';
      const title = isQuestion ? 'Agent Question' : isPlan ? 'Plan Ready for Review' : 'Approval Needed';
      // Name the server: with a fleet, "which machine is asking?" is the first question.
      const server = serversRef.current.find((s) => s.url === origin);
      const where = server && server.url ? ` (${server.name})` : '';
      browserNotify(title + where, request.description || `${request.toolName} is waiting`, `perm-${request.id}`);
    },
    onPermissionDecided: (request, origin) => {
      setPermissionsByServer((prev) => ({
        ...prev,
        [origin]: (prev[origin] ?? []).filter((p) => p.id !== request.id),
      }));
    },
    onAgentStuck: (alert, origin) => {
      const key = agentKey(origin, alert.agentId);
      setStuckAlerts((prev) => {
        const existing = prev.get(key);
        if (!existing || existing.pattern !== alert.pattern) {
          browserNotify('Agent Stuck', alert.pattern, `stuck-${key}`);
        }
        return new Map(prev).set(key, alert);
      });
    },
    onAgentUnstuck: ({ agentId }, origin) => {
      setStuckAlerts((prev) => {
        const next = new Map(prev);
        next.delete(agentKey(origin, agentId));
        return next;
      });
    },
    onPermissionsExpired: (_data, origin) => {
      const server = serversRef.current.find((s) => s.url === origin);
      if (!server) return;
      clientFor(server).getPendingPermissions()
        .then((p) => setPermissionsByServer((prev) => ({ ...prev, [origin]: p })))
        .catch(() => {});
    },
    onVirtualCartridgeUpdated: (vc) => onVirtualCartridgeUpdated?.(vc),
    onWorkflowNotification: (n) => {
      setWorkflowNotifications((prev) => [n, ...prev].slice(0, 20));
      browserNotify(n.title, n.body, `wf-${n.id}`);
    },
    onTaskCreated: (task, origin) => {
      setTasksByServer((prev) => {
        const list = prev[origin] ?? [];
        return list.some((t) => t.id === task.id) ? prev : { ...prev, [origin]: [task, ...list] };
      });
    },
    onTaskUpdated: (task, origin) => {
      setTasksByServer((prev) => ({
        ...prev,
        [origin]: (prev[origin] ?? []).map((t) => (t.id === task.id ? task : t)),
      }));
    },
  });

  useEffect(() => {
    setStatuses((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [origin, isConnected] of Object.entries(connectedOrigins)) {
        if (next[origin] && next[origin].socketConnected !== isConnected) {
          next[origin] = { ...next[origin], socketConnected: isConnected };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [connectedOrigins]);

  // ─── Merge ────────────────────────────────────────────────────────────────
  // Origin is stamped on every record here, at read time. Everything downstream — the
  // grid, the routing of writes, the origin badge — depends on it being present.

  const agents = useMemo(() => {
    const merged = active.flatMap((s) =>
      (agentsByServer[s.url] ?? []).map((a) => ({
        ...a,
        origin: s.url,
        originName: s.name || fallbackName(s.url),
      })),
    );
    return sortAgents(merged) as (Agent & { origin: string; originName: string })[];
  }, [active, agentsByServer]);

  const activities = useMemo(() => {
    const merged = active.flatMap((s) =>
      (activitiesByServer[s.url] ?? []).map((a) => ({ ...a, origin: s.url })),
    );
    // Interleave by time so the feed reads chronologically rather than server-by-server.
    return merged.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  }, [active, activitiesByServer]);

  const pendingPermissions = useMemo(
    () => active.flatMap((s) => (permissionsByServer[s.url] ?? []).map((p) => ({ ...p, origin: s.url }))),
    [active, permissionsByServer],
  );

  const tasks = useMemo(
    () => active.flatMap((s) => (tasksByServer[s.url] ?? []).map((t) => ({ ...t, origin: s.url }))),
    [active, tasksByServer],
  );

  /**
   * Resolve which server owns an agent, so a write lands where the agent actually lives.
   *
   * This is the routing that makes a merged grid safe. Without it, "send this command to
   * agent X" goes to whichever server the client happens to try first, and on the wrong
   * one it silently does nothing at all.
   */
  const serverForAgent = useCallback((agentId: string): ServerEntry | null => {
    for (const s of serversRef.current) {
      if ((agentsByServer[s.url] ?? []).some((a) => a.id === agentId)) return s;
    }
    return null;
  }, [agentsByServer]);

  const clientForAgent = useCallback((agentId: string) => {
    const server = serverForAgent(agentId);
    if (!server) throw new Error(`No server owns agent ${agentId} — it may have gone offline`);
    return { client: clientFor(server), origin: server.url };
  }, [serverForAgent]);

  // ─── Writes (all routed to the owning server) ─────────────────────────────

  const decidePermission = useCallback(async (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => {
    // Permissions carry their own origin; find the server holding this request.
    let target: ServerEntry | null = null;
    for (const s of serversRef.current) {
      if ((permissionsByServer[s.url] ?? []).some((p) => p.id === id)) { target = s; break; }
    }
    const client = target ? clientFor(target) : api;
    await client.decidePermission(id, decision, response);
    if (target) {
      setPermissionsByServer((prev) => ({
        ...prev,
        [target!.url]: (prev[target!.url] ?? []).filter((p) => p.id !== id),
      }));
    }
  }, [permissionsByServer]);

  const setMode = useCallback(async (agentId: string, mode: AgentMode) => {
    const { client, origin } = clientForAgent(agentId);
    const updated = await client.setAgentMode(agentId, mode);
    patchAgent(origin, updated, 'update');
  }, [clientForAgent, patchAgent]);

  const sendCommand = useCallback(async (
    agentId: string,
    text: string,
    includeMemory = true,
    attachments?: import('../types').CommandAttachmentInput[],
  ) => {
    try {
      const { client, origin } = clientForAgent(agentId);
      console.log('[NeonCore] Sending command:', { agentId, origin: origin || 'local', includeMemory });
      await client.sendCommand(agentId, text, includeMemory, attachments);
    } catch (err) {
      console.error('[NeonCore] Failed to send command:', err);
      alert(`Failed to send command: ${err instanceof Error ? err.message : err}`);
    }
  }, [clientForAgent]);

  const deleteAgent = useCallback(async (agentId: string) => {
    const { client, origin } = clientForAgent(agentId);
    await client.deleteAgent(agentId);
    setAgentsByServer((prev) => ({ ...prev, [origin]: (prev[origin] ?? []).filter((a) => a.id !== agentId) }));
  }, [clientForAgent]);

  const dismissAgent = useCallback(async (agentId: string) => {
    const { client, origin } = clientForAgent(agentId);
    patchAgent(origin, await client.dismissAgent(agentId), 'update');
  }, [clientForAgent, patchAgent]);

  const restoreAgent = useCallback(async (agentId: string) => {
    const { client, origin } = clientForAgent(agentId);
    patchAgent(origin, await client.restoreAgent(agentId), 'update');
  }, [clientForAgent, patchAgent]);

  const dismissStuckAlert = useCallback((agentId: string) => {
    setStuckAlerts((prev) => {
      const next = new Map(prev);
      for (const key of prev.keys()) if (key.endsWith(`::${agentId}`)) next.delete(key);
      return next;
    });
  }, []);

  const dismissWorkflowNotification = useCallback((id: string) => {
    setWorkflowNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // Tasks are created on the LOCAL server: a task with no agent yet has no owning server
  // to infer, and the machine you are sitting at is the only defensible default.
  const createTask = useCallback(async (data: { title: string; prompt?: string; projectId?: string | null; priority?: number }) => {
    const task = await api.createTask(data);
    setTasksByServer((prev) => {
      const list = prev[''] ?? [];
      return list.some((t) => t.id === task.id) ? prev : { ...prev, ['']: [task, ...list] };
    });
    return task;
  }, []);

  const taskServer = useCallback((id: string): ServerEntry => {
    for (const s of serversRef.current) {
      if ((tasksByServer[s.url] ?? []).some((t) => t.id === id)) return s;
    }
    return serversRef.current[0];
  }, [tasksByServer]);

  const patchTask = useCallback((origin: string, task: Task) => {
    setTasksByServer((prev) => ({
      ...prev,
      [origin]: (prev[origin] ?? []).map((t) => (t.id === task.id ? task : t)),
    }));
  }, []);

  const cancelTask = useCallback(async (id: string) => {
    const s = taskServer(id);
    patchTask(s.url, await clientFor(s).cancelTask(id));
  }, [taskServer, patchTask]);

  const updateTask = useCallback(async (id: string, data: { title?: string; prompt?: string; projectId?: string | null; priority?: number }) => {
    const s = taskServer(id);
    const updated = await clientFor(s).updateTask(id, data);
    patchTask(s.url, updated);
    return updated;
  }, [taskServer, patchTask]);

  const dispatchTask = useCallback(async (id: string, agentId?: string) => {
    const s = taskServer(id);
    const updated = await clientFor(s).dispatchTask(id, agentId);
    patchTask(s.url, updated);
    return updated;
  }, [taskServer, patchTask]);

  const completeTask = useCallback(async (id: string, status: 'done' | 'failed' = 'done', result?: string) => {
    const s = taskServer(id);
    const updated = await clientFor(s).completeTask(id, status, result);
    patchTask(s.url, updated);
    return updated;
  }, [taskServer, patchTask]);

  // ─── Server management (exposed for the picker UI) ────────────────────────

  const addServer = useCallback((url: string, token?: string | null) => {
    setServers(upsertServer(serversRef.current, { url, token, manual: true }));
  }, [setServers]);

  const forgetServer = useCallback((url: string) => {
    setServers(removeServer(serversRef.current, url));
  }, [setServers]);

  const hideServer = useCallback((url: string, hidden: boolean) => {
    setServers(setServerHidden(serversRef.current, url, hidden));
  }, [setServers]);

  const applyFleetToken = useCallback((token: string | null) => {
    setServers(setFleetToken(loadServers(), token));
  }, [setServers]);

  const activitiesByAgent = useMemo(() => {
    const grouped: Record<string, Activity[]> = {};
    for (const a of activities) {
      if (!grouped[a.agentId]) grouped[a.agentId] = [];
      grouped[a.agentId].push(a);
    }
    return grouped;
  }, [activities]);

  const stuckAlertsArray = useMemo(() => Array.from(stuckAlerts.values()), [stuckAlerts]);

  const serverStatuses = useMemo(
    () => active.map((s) => statuses[s.url] ?? {
      url: s.url, serverId: s.serverId, name: s.name || fallbackName(s.url),
      reachable: false, authFailed: false, lastOkAt: '', lastError: '', socketConnected: false,
    }),
    [active, statuses],
  );

  // "Connected" for the whole app means the local server is up. A remote peer being
  // asleep is a per-server condition shown on its own cartridges, not an app-wide outage.
  const connected = connectedOrigins[''] ?? false;

  return {
    agents,
    activities,
    activitiesByAgent,
    pendingPermissions,
    stuckAlerts,
    stuckAlertsArray,
    workflowNotifications,
    tasks,
    loading,
    connected,
    decidePermission,
    setMode,
    sendCommand,
    deleteAgent,
    dismissAgent,
    restoreAgent,
    dismissStuckAlert,
    dismissWorkflowNotification,
    createTask,
    cancelTask,
    updateTask,
    dispatchTask,
    completeTask,
    // Federation
    servers,
    serverStatuses,
    addServer,
    forgetServer,
    hideServer,
    applyFleetToken,
    refreshData,
  };
}
