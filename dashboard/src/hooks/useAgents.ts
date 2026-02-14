import { useState, useEffect, useCallback } from 'react';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert } from '../types';
import { api } from '../lib/api';
import { useSocket } from './useSocket';

const MAX_ACTIVITIES = 100;
const POLL_INTERVAL_MS = 10_000; // Poll every 10s as fallback for mobile

function sortAgents(list: Agent[]): Agent[] {
  return [...list].sort((a, b) =>
    (a.repoName || a.name).localeCompare(b.repoName || b.name) || a.id.localeCompare(b.id)
  );
}

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [stuckAlerts, setStuckAlerts] = useState<Map<string, StuckAlert>>(new Map());

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
    },
    onPermissionDecided: (request) => {
      setPendingPermissions((prev) => prev.filter((p) => p.id !== request.id));
    },
    onAgentStuck: (alert) => {
      setStuckAlerts((prev) => new Map(prev).set(alert.agentId, alert));
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
  });

  const decidePermission = useCallback(async (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => {
    await api.decidePermission(id, decision, response);
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const setMode = useCallback(async (agentId: string, mode: AgentMode) => {
    const updated = await api.setAgentMode(agentId, mode);
    setAgents((prev) => sortAgents(prev.map((a) => (a.id === updated.id ? updated : a))));
  }, []);

  const sendCommand = useCallback(async (agentId: string, text: string, includeMemory = true) => {
    try {
      console.log('[NeonCore] Sending command:', { agentId, text, includeMemory });
      await api.sendCommand(agentId, text, includeMemory);
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

  const dismissStuckAlert = useCallback((agentId: string) => {
    setStuckAlerts((prev) => {
      const next = new Map(prev);
      next.delete(agentId);
      return next;
    });
  }, []);

  return {
    agents,
    activities,
    pendingPermissions,
    stuckAlerts,
    loading,
    connected,
    decidePermission,
    setMode,
    sendCommand,
    deleteAgent,
    dismissStuckAlert,
  };
}
