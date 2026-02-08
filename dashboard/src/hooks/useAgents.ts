import { useState, useEffect, useCallback } from 'react';
import type { Agent, AgentMode, Activity, PermissionRequest } from '../types';
import { api } from '../lib/api';
import { useSocket } from './useSocket';

const MAX_ACTIVITIES = 100;

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch all data from server (used on mount and reconnect)
  const refreshData = useCallback(() => {
    Promise.all([
      api.getAgents(),
      api.getActivity(),
      api.getPendingPermissions(),
    ]).then(([agentData, activityData, permData]) => {
      setAgents(agentData);
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

  // WebSocket event handlers
  useSocket({
    onReconnect: refreshData,
    onAgentRegistered: (agent) => {
      setAgents((prev) => {
        const exists = prev.find((a) => a.id === agent.id);
        if (exists) return prev.map((a) => (a.id === agent.id ? agent : a));
        return [agent, ...prev];
      });
    },
    onAgentUpdated: (agent) => {
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? agent : a)));
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
  });

  const decidePermission = useCallback(async (id: string, decision: 'allowed' | 'denied') => {
    await api.decidePermission(id, decision);
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const setMode = useCallback(async (agentId: string, mode: AgentMode) => {
    const updated = await api.setAgentMode(agentId, mode);
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }, []);

  const sendCommand = useCallback(async (agentId: string, text: string) => {
    try {
      console.log('[NeonCore] Sending command:', { agentId, text });
      await api.sendCommand(agentId, text);
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

  return {
    agents,
    activities,
    pendingPermissions,
    loading,
    decidePermission,
    setMode,
    sendCommand,
    deleteAgent,
  };
}
