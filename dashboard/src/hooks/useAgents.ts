import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert, VirtualCartridge, WorkflowNotification } from '../types';
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

let chimeContext: AudioContext | null = null;

function getChimeContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (chimeContext) return chimeContext;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  chimeContext = new Ctx();
  return chimeContext;
}

// Two-tone chime synthesized via Web Audio API — avoids shipping a binary asset
// and fits the Atari-themed UI. Skipped when the tab is hidden because background
// tabs queue/block audio anyway; the Web Notification path covers that case.
function playApprovalChime() {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  const ctx = getChimeContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const now = ctx.currentTime;
  const tones: { freq: number; start: number; duration: number }[] = [
    { freq: 880, start: 0, duration: 0.12 },
    { freq: 1318.51, start: 0.10, duration: 0.18 },
  ];
  for (const t of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = t.freq;
    gain.gain.setValueAtTime(0, now + t.start);
    gain.gain.linearRampToValueAtTime(0.15, now + t.start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + t.start + t.duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + t.start);
    osc.stop(now + t.start + t.duration);
  }
}

// Chrome/Firefox autoplay policy: an AudioContext created from non-gesture code
// (a socket handler) starts in 'suspended' state and resume() is a no-op outside
// a user gesture. Wake the context on the first pointer/key event so that
// subsequent chimes scheduled from socket events actually produce sound.
if (typeof window !== 'undefined') {
  const wakeChime = () => {
    const ctx = getChimeContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', wakeChime, { once: true });
  window.addEventListener('keydown', wakeChime, { once: true });
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
      // Fire OS notification so the user knows even when the tab is in the background
      const isQuestion = request.toolName === 'AskUserQuestion';
      const isPlan = request.toolName === 'ExitPlanMode';
      const notifTitle = isQuestion ? 'Agent Question' : isPlan ? 'Plan Ready for Review' : 'Approval Needed';
      const notifBody = request.description || `${request.toolName} is waiting for your response`;
      browserNotify(notifTitle, notifBody, `perm-${request.id}`);
      playApprovalChime();
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

  const dismissWorkflowNotification = useCallback((id: string) => {
    setWorkflowNotifications((prev) => prev.filter((n) => n.id !== id));
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
    loading,
    connected,
    decidePermission,
    setMode,
    sendCommand,
    deleteAgent,
    dismissStuckAlert,
    dismissWorkflowNotification,
  };
}
