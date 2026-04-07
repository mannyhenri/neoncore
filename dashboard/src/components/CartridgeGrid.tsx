import { useState, useMemo, useEffect } from 'react';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert, VirtualCartridge, McpServer } from '../types';
import { CartridgeCard } from './CartridgeCard';
import { VirtualCartridgeCard } from './VirtualCartridgeCard';

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
  virtualCartridges?: VirtualCartridge[];
  mcpServers?: McpServer[];
  onVirtualCartridgeUpdate?: (vc: VirtualCartridge) => void;
  onVirtualCartridgeDelete?: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Filter / sort types
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | 'working' | 'waiting' | 'idle';
const STATUS_PRIORITY: Record<string, number> = { working: 0, waiting: 1, idle: 2, offline: 3 };

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
  virtualCartridges = [],
  mcpServers = [],
  onVirtualCartridgeUpdate,
  onVirtualCartridgeDelete,
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

  // Group agents by machine:repoName → one cartridge per group.
  // Pick the agent with the best status as the primary; the rest are siblings.
  const { dedupedSorted, siblingMap } = useMemo(() => {
    // Group visible agents by machine:repoName
    const groups = new Map<string, Agent[]>();
    for (const a of sorted) {
      const key = `${a.machine}:${a.repoName}`;
      const list = groups.get(key) || [];
      list.push(a);
      groups.set(key, list);
    }

    const primaries: Agent[] = [];
    const siblings = new Map<string, string[]>();

    for (const [, group] of groups) {
      // Sort by status priority — best status becomes primary
      group.sort((a, b) => {
        const aPri = STATUS_PRIORITY[agentStatuses.get(a.id) || 'offline'] ?? 3;
        const bPri = STATUS_PRIORITY[agentStatuses.get(b.id) || 'offline'] ?? 3;
        return aPri - bPri;
      });
      const primary = group[0];
      primaries.push(primary);
      const siblingIds = group.slice(1).map((a) => a.id);
      if (siblingIds.length > 0) siblings.set(primary.id, siblingIds);
    }

    // Re-sort primaries alphabetically
    primaries.sort((a, b) => (a.repoName || a.name).localeCompare(b.repoName || b.name));

    return { dedupedSorted: primaries, siblingMap: siblings };
  }, [sorted, agentStatuses]);

  // Count deduplicated cartridges (groups) per status for filter badges
  const counts = {
    all: dedupedSorted.length,
    working: dedupedSorted.filter((a) => agentStatuses.get(a.id) === 'working').length,
    waiting: dedupedSorted.filter((a) => agentStatuses.get(a.id) === 'waiting').length,
    idle: dedupedSorted.filter((a) => agentStatuses.get(a.id) === 'idle').length,
  };
  const onlineAgents = agents.filter((a) => agentStatuses.get(a.id) !== 'offline');

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
              <span className={`ml-1.5 text-[13px] px-1.5 py-0.5 rounded-full ${
                statusFilter === key ? 'bg-gl-purple/30 text-gl-purple' : 'bg-white/[0.06] text-gray-500'
              }`}>
                {counts[key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Grid */}
      {dedupedSorted.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          No {statusFilter} cartridges
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {dedupedSorted.map((agent) => {
            const siblingIds = siblingMap.get(agent.id) || [];
            const allIds = [agent.id, ...siblingIds];

            // Merge activities from all agents in this group
            const mergedActivities = allIds
              .flatMap((id) => activitiesByAgent[id] || [])
              .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

            // Merge permissions and stuck alerts from all agents in this group
            const mergedPermissions = pendingPermissions.filter((p) => allIds.includes(p.agentId));
            const mergedStuck = allIds.map((id) => stuckByAgent.get(id)).find(Boolean);

            return (
              <CartridgeCard
                key={agent.id}
                agent={agent}
                siblingAgents={siblingIds.map((id) => agents.find((a) => a.id === id)!).filter(Boolean)}
                allAgents={agents}
                activities={mergedActivities}
                permissions={mergedPermissions}
                stuckAlert={mergedStuck}
                onDecidePermission={onDecidePermission}
                onSetMode={onSetMode}
                onSendCommand={onSendCommand}
                onDelete={onDelete}
                onDismissStuck={onDismissStuck}
                onActivityClick={onActivityClick}
              />
            );
          })}

          {/* Virtual Cartridges */}
          {virtualCartridges.map((vc) => (
            <VirtualCartridgeCard
              key={vc.id}
              cartridge={vc}
              mcpServers={mcpServers}
              onUpdate={onVirtualCartridgeUpdate || (() => {})}
              onDelete={onVirtualCartridgeDelete || (() => {})}
            />
          ))}
        </div>
      )}
    </div>
  );
}
