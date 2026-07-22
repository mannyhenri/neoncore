import { useEffect, useState } from 'react';
import type { Agent, ConferSession } from '../types';
import { api } from '../lib/api';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-emerald-400 animate-pulse',
  completed: 'bg-blue-400',
  failed: 'bg-red-400',
  cancelled: 'bg-gray-500',
};

/**
 * Live view of milestone-driven confer sessions. Polls the conductor so the milestone
 * progress reflects agents signalling done, even without a socket subscription.
 */
export function ConferPanel({ agents }: { agents: Agent[] }) {
  const [confers, setConfers] = useState<ConferSession[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => api.getConfers().then((c) => { if (alive) setConfers(c); }).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Show active confers, plus any that finished in the last 10 minutes (so a completion is visible).
  const now = Date.now();
  const visible = confers.filter(
    (c) => c.status === 'running' ||
      (c.completedAt && now - new Date(c.completedAt).getTime() < 10 * 60 * 1000),
  );
  if (visible.length === 0) return null;

  const typeOf = (id: string) => agents.find((a) => a.id === id)?.agentType || 'agent';

  return (
    <div className="space-y-2">
      {visible.map((c) => {
        const participants = c.participantIds.length;
        const milestones = c.milestones || [];
        return (
          <div key={c.id} className="glass rounded-lg border border-white/[0.08] px-3 py-2.5">
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[c.status] || 'bg-gray-500'}`} />
              <span className="text-xs font-semibold text-gray-200">Confer</span>
              <span className="text-[11px] text-gray-500">{c.repoName || '—'}</span>
              <span className="text-[11px] text-gray-600">·</span>
              <span className="text-[11px] text-gray-500">{c.participantIds.map(typeOf).join(' + ')}</span>
              <span className="text-[11px] text-gray-600 truncate flex-1" title={c.task}>— {c.task}</span>
              {c.status === 'running' && (
                <button
                  onClick={() => api.cancelConfer(c.id).catch(() => {})}
                  className="text-[11px] text-gray-500 hover:text-red-400 transition-colors shrink-0"
                >
                  cancel
                </button>
              )}
            </div>

            {/* Milestone stepper */}
            <div className="flex items-center gap-1 flex-wrap">
              {milestones.map((m, i) => {
                const done = m.status === 'done';
                const active = m.status === 'active';
                const signalled = m.doneIds.length;
                return (
                  <div key={m.id} className="flex items-center gap-1">
                    <div
                      className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                        done
                          ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/40'
                          : active
                            ? 'bg-amber-900/50 text-amber-200 border-amber-600/50'
                            : 'bg-white/[0.03] text-gray-500 border-white/[0.06]'
                      }`}
                      title={active ? `${signalled}/${participants} agents signalled done` : m.status}
                    >
                      {m.name}
                      {active && <span className="ml-1 text-amber-300/80">{signalled}/{participants}</span>}
                      {done && <span className="ml-1">✓</span>}
                    </div>
                    {i < milestones.length - 1 && <span className="text-gray-700 text-[10px]">→</span>}
                  </div>
                );
              })}
            </div>

            {c.error && <p className="text-[11px] text-amber-400 mt-1.5">{c.error}</p>}
            {c.status === 'completed' && <p className="text-[11px] text-blue-400 mt-1.5">All milestones complete.</p>}
            {c.status === 'failed' && <p className="text-[11px] text-red-400 mt-1.5">Confer failed — a milestone stalled.</p>}
          </div>
        );
      })}
    </div>
  );
}
