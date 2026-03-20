import { useState, useMemo, useEffect } from 'react';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert } from '../types';
import { CartridgeCard } from './CartridgeCard';

const ACTIVE_WINDOW_MS = 120_000; // 2 minutes

/** Compute effective status from activity feed timestamps (mirrors CartridgeCard logic). */
function effectiveAgentStatus(
  agent: Agent,
  activities: Activity[],
  now: number,
): Agent['status'] {
  if (agent.status === 'waiting') return 'waiting';
  if (agent.status === 'offline') {
    const hasRecent = activities.some(
      (a) => now - new Date(a.timestamp).getTime() < ACTIVE_WINDOW_MS,
    );
    return hasRecent ? 'working' : 'offline';
  }
  const hasRecent = activities.some(
    (a) => now - new Date(a.timestamp).getTime() < ACTIVE_WINDOW_MS,
  );
  return hasRecent ? 'working' : agent.status;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CartridgeGridProps {
  agents: Agent[];
  activitiesByAgent: Record<string, Activity[]>;
  pendingPermissions: PermissionRequest[];
  stuckAlerts: StuckAlert[];
  onDecidePermission: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
  onSetMode: (agentId: string, mode: AgentMode) => void;
  onSendCommand: (agentId: string, text: string, includeMemory?: boolean) => void;
  onDelete: (agentId: string) => void;
  onDismissStuck: (agentId: string) => void;
  onActivityClick?: (activity: Activity) => void;
}

// ---------------------------------------------------------------------------
// Filter / sort types
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | 'working' | 'waiting' | 'idle';

// ---------------------------------------------------------------------------
// CartridgeGrid
// ---------------------------------------------------------------------------

export function CartridgeGrid({
  agents,
  activitiesByAgent,
  pendingPermissions,
  stuckAlerts,
  onDecidePermission,
  onSetMode,
  onSendCommand,
  onDelete,
  onDismissStuck,
  onActivityClick,
}: CartridgeGridProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [tick, setTick] = useState(Date.now());

  // Re-evaluate every 15s (same cadence as CartridgeCard)
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Compute effective status for every agent based on activity feed
  const agentStatuses = useMemo(() => {
    const map = new Map<string, Agent['status']>();
    for (const a of agents) {
      map.set(a.id, effectiveAgentStatus(a, activitiesByAgent[a.id] || [], tick));
    }
    return map;
  }, [agents, activitiesByAgent, tick]);

  // Only show online agents (filter out offline)
  let visible = agents.filter((a) => agentStatuses.get(a.id) !== 'offline');

  // Apply status filter
  if (statusFilter !== 'all') {
    visible = visible.filter((a) => agentStatuses.get(a.id) === statusFilter);
  }

  // Sort alphabetically by repo name / agent name
  const sorted = [...visible].sort((a, b) =>
    (a.repoName || a.name).localeCompare(b.repoName || b.name)
  );

  // Count online agents per status for filter badges
  const onlineAgents = agents.filter((a) => agentStatuses.get(a.id) !== 'offline');
  const counts = {
    all: onlineAgents.length,
    working: onlineAgents.filter((a) => agentStatuses.get(a.id) === 'working').length,
    waiting: onlineAgents.filter((a) => agentStatuses.get(a.id) === 'waiting').length,
    idle: onlineAgents.filter((a) => agentStatuses.get(a.id) === 'idle').length,
  };

  // Build a lookup for stuck alerts by agentId
  const stuckByAgent = new Map<string, StuckAlert>();
  for (const alert of stuckAlerts) {
    stuckByAgent.set(alert.agentId, alert);
  }

  if (onlineAgents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-500">
        <div className="font-pixel text-2xl text-gl-purple/40 mb-6" style={{ imageRendering: 'pixelated' }}>
          INSERT CARTRIDGE
        </div>
        <h3 className="text-lg font-medium text-gray-400 mb-2">No cartridges inserted</h3>
        <p className="text-sm text-center max-w-md text-gray-500">
          Install the NeonCore hooks on your machines to connect Claude Code agents.
          <br />
          Run{' '}
          <code className="text-gl-purple bg-white/[0.06] px-1.5 py-0.5 rounded text-xs font-mono">
            ./agent/install.sh
          </code>{' '}
          to get started.
        </p>
      </div>
    );
  }

  const filters: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'working', label: 'Working' },
    { key: 'waiting', label: 'Waiting' },
    { key: 'idle', label: 'Idle' },
  ];

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        {filters.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`text-xs px-3 py-1.5 rounded-md transition-colors font-medium ${
              statusFilter === key
                ? 'bg-gl-purple/20 text-gl-purple border border-gl-purple/40'
                : 'bg-white/[0.04] text-gray-400 border border-white/[0.06] hover:bg-white/[0.08] hover:text-gray-300'
            }`}
          >
            {label}
            {counts[key] > 0 && (
              <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                statusFilter === key ? 'bg-gl-purple/30 text-gl-purple' : 'bg-white/[0.06] text-gray-500'
              }`}>
                {counts[key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Grid */}
      {sorted.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          No {statusFilter} cartridges
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {sorted.map((agent) => (
            <CartridgeCard
              key={agent.id}
              agent={agent}
              activities={activitiesByAgent[agent.id] || []}
              permissions={pendingPermissions.filter((p) => p.agentId === agent.id)}
              stuckAlert={stuckByAgent.get(agent.id)}
              onDecidePermission={onDecidePermission}
              onSetMode={onSetMode}
              onSendCommand={onSendCommand}
              onDelete={onDelete}
              onDismissStuck={onDismissStuck}
              onActivityClick={onActivityClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
