import { useState, useMemo, useEffect } from 'react';
import type { SendOutcome } from '../lib/deliveryNotice';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert, VirtualCartridge, CommandAttachmentInput } from '../types';
import { effectiveAgentStatus } from '../lib/agentStatus';
import { useLiveWork } from '../hooks/useLiveWork';
import { cartridgeProgress } from '../lib/cartridgeProgress';
import { CartridgeCard } from './CartridgeCard';
import { VirtualCartridgeCard } from './VirtualCartridgeCard';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type StatusFilter = 'all' | 'working' | 'waiting' | 'idle';

interface CartridgeGridProps {
  agents: Agent[];
  activitiesByAgent: Record<string, Activity[]>;
  pendingPermissions: PermissionRequest[];
  stuckAlerts: StuckAlert[];
  onDecidePermission: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
  onSetMode: (agentId: string, mode: AgentMode) => void;
  onSendCommand: (agentId: string, text: string, includeMemory?: boolean, attachments?: CommandAttachmentInput[]) => void | Promise<SendOutcome | null | void>;
  onDelete: (agentId: string) => void;
  onDismiss: (agentId: string) => void;
  onRestore: (agentId: string) => void;
  onDismissStuck: (agentId: string) => void;
  onActivityClick?: (activity: Activity) => void;
  virtualCartridges?: VirtualCartridge[];
  onVirtualCartridgeUpdate?: (vc: VirtualCartridge) => void;
  onVirtualCartridgeDelete?: (id: string) => void;
  /** The status selection now lives in the command rail. The grid no longer owns
   *  the control, but it still owns the derivation — dedup, dismissal and virtual
   *  cartridges all decide who is counted, and duplicating that in App is how the
   *  chip counts would drift from the cards under them. So: filter in, counts out. */
  statusFilter?: StatusFilter;
  onStatusCounts?: (counts: Record<StatusFilter, number>) => void;
}

// ---------------------------------------------------------------------------
// Filter / sort types
// ---------------------------------------------------------------------------

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
  statusFilter: statusFilterProp,
  onStatusCounts,
  onDismissStuck,
  onActivityClick,
}: CartridgeGridProps) {
  const statusFilter = statusFilterProp ?? 'all';
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
  // The work each cartridge is part of — confers and live runs — so its meter shows real progress
  // (lib/cartridgeProgress). Polled: both change on the server's clock, not on agent events.
  const { confers, runs } = useLiveWork();

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

  // Report the counts up to whoever renders the chips. Declared BEFORE the empty-grid
  // early return below, so the hook order never changes between renders. Depends on the
  // four numbers rather than the object, which is re-created every render.
  useEffect(() => {
    onStatusCounts?.({ all: counts.all, working: counts.working, waiting: counts.waiting, idle: counts.idle });
  }, [counts.all, counts.working, counts.waiting, counts.idle, onStatusCounts]);


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
      <div className="flex flex-col items-center justify-center text-center px-6 py-16 rounded-[18px] border border-dashed border-neon-500/40 text-gray-400">
        <div aria-hidden="true" className="flex gap-1 mb-4">
          <span className="w-3.5 h-[30px] rounded-[2px] border border-neon-500/60" />
          <span className="w-3.5 h-[30px] rounded-[2px] border border-neon-500/60" />
          <span className="w-3.5 h-[30px] rounded-[2px] border border-neon-500/60" />
        </div>
        <div className="font-display font-bold tracking-[0.12em] text-lg text-neon-200 mb-3">
          {allHidden ? 'ALL PUT AWAY' : 'INSERT CARTRIDGE'}
        </div>

        {allHidden ? (
          <>
            <h3 className="text-base font-semibold text-gray-200 mb-2">
              {dismissed.length} cartridge{dismissed.length === 1 ? '' : 's'} hidden
            </h3>
            <p className="text-[13px] text-center max-w-md text-gray-400 leading-relaxed mb-5">
              They'll come back on their own the moment an agent does anything — or restore one
              now.
            </p>
            <div className="w-full max-w-md space-y-1.5 text-left">
              {dismissed.map((a) => {
                const live = agentStatuses.get(a.id) ?? a.status;
                return (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-white/[0.1] bg-[rgba(14,20,36,0.62)]"
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_CONFIG_DOT[live] ?? 'bg-gray-600'}`} />
                    <span className="text-[14px] text-gray-200 font-mono truncate flex-1">
                      {a.repoName || a.name}
                    </span>
                    {live !== 'offline' && (
                      <span className="text-[11px] text-neon-300 font-semibold shrink-0">still {live}</span>
                    )}
                    <button
                      onClick={() => onRestore(a.id)}
                      className="h-8 px-3 rounded-lg border border-neon-500/45 bg-neon-500/10 text-[12px] font-semibold text-neon-200 hover:bg-neon-500/20 transition-colors shrink-0"
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
            <h3 className="sr-only">No cartridges inserted</h3>
            <p className="text-[13px] text-center max-w-md text-gray-400 leading-relaxed">
              No cartridges inserted.{' '}
              Install the NeonCore hooks on your machines to connect Claude Code agents.
              <br />
              Run{' '}
              <code className="text-neon-200 bg-white/[0.06] px-1.5 py-0.5 rounded text-xs font-mono">
                ./agent/install.sh
              </code>{' '}
              to get started.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Grid. It now lives in a 2/3 column, so lg:3 would squeeze a card to ~210px —
          three across is only earned back at 2xl, where the column is wide enough. */}
      {dedupedSorted.length === 0 ? (
        <div className="text-center py-12 rounded-[18px] border border-dashed border-white/[0.14] text-gray-400 text-sm">
          No {statusFilter} cartridges
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,330px),1fr))] gap-[18px]">
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
                progress={cartridgeProgress(agent, siblingIds, confers, runs)}
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
        <div className="mt-4">
          <button
            onClick={() => setShowHidden((v) => !v)}
            aria-expanded={showHidden}
            className="h-10 px-3.5 rounded-[10px] border border-dashed border-white/[0.25] text-[13px] font-semibold text-gray-400 hover:text-gray-200 transition-colors"
          >
            {showHidden ? '▾' : '▸'} Hidden ({dismissed.length})
          </button>

          {showHidden && (
            <div className="mt-3 space-y-1.5">
              {dismissed.map((a) => {
                const live = agentStatuses.get(a.id) ?? a.status;
                const stillRunning = live !== 'offline';
                return (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-white/[0.1] bg-[rgba(14,20,36,0.62)]"
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        STATUS_CONFIG_DOT[live] ?? 'bg-gray-600'
                      }`}
                    />
                    <span className="text-[14px] text-gray-200 font-mono truncate flex-1">
                      {a.repoName || a.name}
                    </span>
                    <span className="text-[12px] text-gray-500 shrink-0">
                      {shortMachineName(a.machine)}
                    </span>
                    {/* The point of the separate column: this one is hidden AND alive. */}
                    {stillRunning && (
                      <span className="text-[11px] text-neon-300 font-semibold shrink-0">
                        still {live}
                      </span>
                    )}
                    <button
                      onClick={() => onRestore(a.id)}
                      className="h-8 px-3 rounded-lg border border-neon-500/45 bg-neon-500/10 text-[12px] font-semibold text-neon-200 hover:bg-neon-500/20 transition-colors shrink-0"
                      title="Bring this cartridge back to the grid"
                    >
                      restore
                    </button>
                  </div>
                );
              })}
              <p className="text-[12px] text-gray-500 pt-1">
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
  working: 'bg-neon-500 shadow-[0_0_8px_#5AAEFF]',
  waiting: 'bg-[#FF8A3D] shadow-[0_0_8px_#FF8A3D]',
  idle: 'bg-gray-500',
  offline: 'bg-red-400/70',
};

function shortMachineName(machine: string): string {
  return machine.replace(/\.local$/, '');
}
