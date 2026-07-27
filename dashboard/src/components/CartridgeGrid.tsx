import { useState, useMemo, useEffect } from 'react';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert, VirtualCartridge, CommandAttachmentInput } from '../types';
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
  onSendCommand: (agentId: string, text: string, includeMemory?: boolean, attachments?: CommandAttachmentInput[]) => void;
  onDelete: (agentId: string) => void;
  onDismiss: (agentId: string) => void;
  onRestore: (agentId: string) => void;
  onDismissStuck: (agentId: string) => void;
  onActivityClick?: (activity: Activity) => void;
  virtualCartridges?: VirtualCartridge[];
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
  onDismiss,
  onRestore,
  virtualCartridges = [],
  onVirtualCartridgeUpdate,
  onVirtualCartridgeDelete,
  onDismissStuck,
  onActivityClick,
}: CartridgeGridProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showHidden, setShowHidden] = useState(false);
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

  // The grid shows agents that are alive AND not put away. `dismissedAt` is the user's view
  // preference; `status` is liveness. Both must be clear for a card to be on screen — but a
  // dismissed agent may well still be 'working', which is why these are two separate checks.
  const dismissed = agents.filter((a) => a.dismissedAt);
  let visible = agents.filter(
    (a) => agentStatuses.get(a.id) !== 'offline' && !a.dismissedAt,
  );

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
  const onlineAgents = agents.filter(
    (a) => agentStatuses.get(a.id) !== 'offline' && !a.dismissedAt,
  );

  // Build a lookup for stuck alerts by agentId
  const stuckByAgent = new Map<string, StuckAlert>();
  for (const alert of stuckAlerts) {
    stuckByAgent.set(alert.agentId, alert);
  }

  // Empty grid. Note the two very different reasons it can be empty — if the user simply put
  // everything away, saying "no cartridges inserted" would be a lie, and (worse) this early
  // return would render BEFORE the Hidden section, stranding them with no way to restore.
  if (onlineAgents.length === 0) {
    const allHidden = dismissed.length > 0;
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-500">
        <div className="font-pixel text-2xl text-gl-purple/40 mb-6" style={{ imageRendering: 'pixelated' }}>
          {allHidden ? 'ALL PUT AWAY' : 'INSERT CARTRIDGE'}
        </div>

        {allHidden ? (
          <>
            <h3 className="text-lg font-medium text-gray-400 mb-2">
              {dismissed.length} cartridge{dismissed.length === 1 ? '' : 's'} hidden
            </h3>
            <p className="text-sm text-center max-w-md text-gray-500 mb-5">
              They'll come back on their own the moment an agent does anything — or restore one
              now.
            </p>
            <div className="w-full max-w-md space-y-1">
              {dismissed.map((a) => {
                const live = agentStatuses.get(a.id) ?? a.status;
                return (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 px-3 py-2 rounded border border-white/[0.06] bg-white/[0.02]"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_CONFIG_DOT[live] ?? 'bg-gray-600'}`} />
                    <span className="text-sm text-gray-300 font-mono truncate flex-1">
                      {a.repoName || a.name}
                    </span>
                    {live !== 'offline' && (
                      <span className="text-[10px] text-green-500/70 font-mono shrink-0">still {live}</span>
                    )}
                    <button
                      onClick={() => onRestore(a.id)}
                      className="text-[11px] text-gl-purple hover:text-white transition-colors shrink-0"
                    >
                      restore
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
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
      {/* Status filter bar */}
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
                // Key on the CARTRIDGE (machine:repoName — the same key we grouped by), never
                // on the primary agent's id. `primary` is whichever sibling currently has the
                // best status, so a log line arriving for any tool in this repo can promote a
                // different agent. Keying on agent.id would remount the whole card on that
                // flip and wipe whatever the user was typing in CommandInput.
                key={`${agent.machine}:${agent.repoName}`}
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
                onDismiss={onDismiss}
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
              onUpdate={onVirtualCartridgeUpdate || (() => {})}
              onDelete={onVirtualCartridgeDelete || (() => {})}
            />
          ))}
        </div>
      )}

      {/* ── Hidden ─────────────────────────────────────────────────────────────
          Cartridges you put away. Kept SEPARATE from offline on purpose: offline means
          the session ended, hidden means you stopped looking at it — and a hidden agent
          is frequently still running, which is why we show its live status here. */}
      {dismissed.length > 0 && (
        <div className="mt-8">
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors font-mono"
          >
            {showHidden ? '▾' : '▸'} Hidden ({dismissed.length})
          </button>

          {showHidden && (
            <div className="mt-3 space-y-1">
              {dismissed.map((a) => {
                const live = agentStatuses.get(a.id) ?? a.status;
                const stillRunning = live !== 'offline';
                return (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 px-3 py-2 rounded border border-white/[0.06] bg-white/[0.02]"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        STATUS_CONFIG_DOT[live] ?? 'bg-gray-600'
                      }`}
                    />
                    <span className="text-sm text-gray-300 font-mono truncate flex-1">
                      {a.repoName || a.name}
                    </span>
                    <span className="text-[11px] text-gray-500 font-mono shrink-0">
                      {shortMachineName(a.machine)}
                    </span>
                    {/* The point of the separate column: this one is hidden AND alive. */}
                    {stillRunning && (
                      <span className="text-[10px] text-green-500/70 font-mono shrink-0">
                        still {live}
                      </span>
                    )}
                    <button
                      onClick={() => onRestore(a.id)}
                      className="text-[11px] text-gl-purple hover:text-white transition-colors shrink-0"
                      title="Bring this cartridge back to the grid"
                    >
                      restore
                    </button>
                  </div>
                );
              })}
              <p className="text-[11px] text-gray-600 pt-1">
                These come back on their own the moment the agent does anything, or when you
                send it a command or start a workflow.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_CONFIG_DOT: Record<string, string> = {
  working: 'bg-green-500',
  waiting: 'bg-yellow-500',
  idle: 'bg-gray-500',
  offline: 'bg-red-500/60',
};

function shortMachineName(machine: string): string {
  return machine.replace(/\.local$/, '');
}
