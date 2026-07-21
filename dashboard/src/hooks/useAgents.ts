import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert, VirtualCartridge, WorkflowNotification, Task } from '../types';
import { api } from '../lib/api';
import { useSocket } from './useSocket';

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

const MAX_ACTIVITIES = 100;
const POLL_INTERVAL_MS = 10_000; // Poll every 10s as fallback for mobile

function sortAgents(list: Agent[]): Agent[] {
  return [...list].sort((a, b) =>
    (a.repoName || a.name).localeCompare(b.repoName || b.name) || a.id.localeCompare(b.id)
  );
}

export function useAgents(onVirtualCartridgeUpdated?: (vc: VirtualCartridge) => void) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [stuckAlerts, setStuckAlerts] = useState<Map<string, StuckAlert>>(new Map());
  const [workflowNotifications, setWorkflowNotifications] = useState<WorkflowNotification[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  // Fetch all data from server (used on mount and reconnect)
  const refreshData = useCallback(() => {
    Promise.all([
      api.getAgents(),
      api.getActivity(),
      api.getPendingPermissions(),
    ]).then(([agentData, activityData, permData]) => {
      setAgents(sortAgents(agentData));
      setActivities(activityData);
      setPendingPermissions(permData);
      setLoading(false);
    }).catch((err) => {
      console.error('Failed to load data:', err);
      setLoading(false);
    });
    // Tasks load independently so a task error never blocks core agent data.
    api.getTasks().then(setTasks).catch(() => {});
  }, []);

  // Load initial data
  useEffect(() => {
    refreshData();
  }, [refreshData]);

  // Periodic polling fallback — ensures mobile stays in sync
  // even if WebSocket silently dies
  useEffect(() => {
    const interval = setInterval(() => {
      refreshData();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshData]);

  // Reconcile stuck alerts against live agent status. A Stuck alert is orphaned
  // in the bell when its agent leaves the working/waiting set (drops to
  // idle/offline) or when a server restart wipes the server's alert state — in
  // both cases no `agent_unstuck` event ever arrives to clear it. Drop any
  // alert whose agent is gone or no longer active.
  useEffect(() => {
    setStuckAlerts((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const agentId of prev.keys()) {
        const agent = agents.find((a) => a.id === agentId);
        if (!agent || (agent.status !== 'working' && agent.status !== 'waiting')) {
          next.delete(agentId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [agents]);

  // WebSocket event handlers
  const { connected } = useSocket({
    onReconnect: refreshData,
    onAgentRegistered: (agent) => {
      setAgents((prev) => {
        const exists = prev.find((a) => a.id === agent.id);
        if (exists) return sortAgents(prev.map((a) => (a.id === agent.id ? agent : a)));
        return sortAgents([...prev, agent]);
      });
    },
    onAgentUpdated: (agent) => {
      setAgents((prev) => sortAgents(prev.map((a) => (a.id === agent.id ? agent : a))));
    },
    onActivityLogged: (activity) => {
      setActivities((prev) => [activity, ...prev].slice(0, MAX_ACTIVITIES));
    },
    onPermissionRequested: (request) => {
      setPendingPermissions((prev) => [request, ...prev]);
      // Fire OS notification so the user knows even when the tab is in the background
      const isQuestion = request.toolName === 'AskUserQuestion';
      const isPlan = request.toolName === 'ExitPlanMode';
      const notifTitle = isQuestion ? 'Agent Question' : isPlan ? 'Plan Ready for Review' : 'Approval Needed';
      const notifBody = request.description || `${request.toolName} is waiting for your response`;
      browserNotify(notifTitle, notifBody, `perm-${request.id}`);
    },
    onPermissionDecided: (request) => {
      setPendingPermissions((prev) => prev.filter((p) => p.id !== request.id));
    },
    onAgentStuck: (alert) => {
      setStuckAlerts((prev) => {
        const existing = prev.get(alert.agentId);
        // Only fire OS notification if pattern is new (avoid repeated buzzing)
        if (!existing || existing.pattern !== alert.pattern) {
          browserNotify('Agent Stuck', alert.pattern, `stuck-${alert.agentId}`);
        }
        return new Map(prev).set(alert.agentId, alert);
      });
    },
    onAgentUnstuck: ({ agentId }) => {
      setStuckAlerts((prev) => {
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
    },
    onPermissionsExpired: () => {
      api.getPendingPermissions().then(setPendingPermissions).catch(() => {});
    },
    onVirtualCartridgeUpdated,
    onWorkflowNotification: (n) => {
      setWorkflowNotifications((prev) => [n, ...prev].slice(0, 20));
      browserNotify(n.title, n.body, `wf-${n.id}`);
    },
    onTaskCreated: (task) => {
      setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]));
    },
    onTaskUpdated: (task) => {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    },
  });

  const decidePermission = useCallback(async (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => {
    await api.decidePermission(id, decision, response);
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const setMode = useCallback(async (agentId: string, mode: AgentMode) => {
    const updated = await api.setAgentMode(agentId, mode);
    setAgents((prev) => sortAgents(prev.map((a) => (a.id === updated.id ? updated : a))));
  }, []);

  const sendCommand = useCallback(async (
    agentId: string,
    text: string,
    includeMemory = true,
    attachments?: import('../types').CommandAttachmentInput[],
  ) => {
    try {
      console.log('[NeonCore] Sending command:', { agentId, text, includeMemory, attachmentCount: attachments?.length || 0 });
      await api.sendCommand(agentId, text, includeMemory, attachments);
      console.log('[NeonCore] Command sent successfully');
    } catch (err) {
      console.error('[NeonCore] Failed to send command:', err);
      alert(`Failed to send command: ${err instanceof Error ? err.message : err}`);
    }
  }, []);

  const deleteAgent = useCallback(async (agentId: string) => {
    await api.deleteAgent(agentId);
    setAgents((prev) => prev.filter((a) => a.id !== agentId));
  }, []);

  // Dismiss/restore just flips dismissedAt. The server also emits agent_updated, but we
  // patch locally so the card leaves the grid immediately rather than on the socket
  // round-trip.
  const dismissAgent = useCallback(async (agentId: string) => {
    const updated = await api.dismissAgent(agentId);
    setAgents((prev) => prev.map((a) => (a.id === agentId ? updated : a)));
  }, []);

  const restoreAgent = useCallback(async (agentId: string) => {
    const updated = await api.restoreAgent(agentId);
    setAgents((prev) => prev.map((a) => (a.id === agentId ? updated : a)));
  }, []);

  const dismissStuckAlert = useCallback((agentId: string) => {
    setStuckAlerts((prev) => {
      const next = new Map(prev);
      next.delete(agentId);
      return next;
    });
  }, []);

  const dismissWorkflowNotification = useCallback((id: string) => {
    setWorkflowNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const createTask = useCallback(async (data: { title: string; prompt?: string; projectId?: string | null; priority?: number }) => {
    const task = await api.createTask(data);
    // Optimistic insert; the task_created socket event is deduped by id.
    setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]));
    return task;
  }, []);

  const cancelTask = useCallback(async (id: string) => {
    const updated = await api.cancelTask(id);
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }, []);

  const updateTask = useCallback(async (id: string, data: { title?: string; prompt?: string; projectId?: string | null; priority?: number }) => {
    const updated = await api.updateTask(id, data);
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    return updated;
  }, []);

  const dispatchTask = useCallback(async (id: string, agentId?: string) => {
    const updated = await api.dispatchTask(id, agentId);
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    return updated;
  }, []);

  const completeTask = useCallback(async (id: string, status: 'done' | 'failed' = 'done', result?: string) => {
    const updated = await api.completeTask(id, status, result);
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    return updated;
  }, []);

  // Group activities by agent for cartridge terminal display
  const activitiesByAgent = useMemo(() => {
    const grouped: Record<string, Activity[]> = {};
    for (const a of activities) {
      if (!grouped[a.agentId]) grouped[a.agentId] = [];
      grouped[a.agentId].push(a);
    }
    return grouped;
  }, [activities]);

  // Convert stuckAlerts Map to array for CartridgeGrid
  const stuckAlertsArray = useMemo(() => Array.from(stuckAlerts.values()), [stuckAlerts]);

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
  };
}
