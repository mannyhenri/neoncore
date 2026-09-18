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
 * A single milestone-driven confer session card. Purely presentational — the parent
 * (WorkflowPanel) owns the confer polling so running confers can sit under Active Runs
 * and finished ones under Recent Runs.
 */
export function ConferCard({ confer: c, agents }: { confer: ConferSession; agents: Agent[] }) {
  const typeOf = (id: string) => agents.find((a) => a.id === id)?.agentType || 'agent';
  const participants = c.participantIds.length;
  const milestones = c.milestones || [];

  // Two-step cancel with real feedback. The old one-line link swallowed errors and gave no
  // sign anything happened; a stuck confer looked un-cancellable. 'confirm' is the armed state.
  const [cancelPhase, setCancelPhase] = useState<'idle' | 'confirm' | 'cancelling'>('idle');
  const [cancelError, setCancelError] = useState('');
  const [resuming, setResuming] = useState(false);
  useEffect(() => { if (c.status !== 'failed') setResuming(false); }, [c.status]);
  const doCancel = async () => {
    setCancelPhase('cancelling');
    setCancelError('');
    try {
      await api.cancelConfer(c.id);
      // Leave 'cancelling' showing — the parent's confer poll (or the confer_updated socket)
      // will replace this card with the cancelled state within a couple of seconds.
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Cancel failed');
      setCancelPhase('idle');
    }
  };
  const doResume = async () => {
    setResuming(true);
    setCancelError('');
    try {
      await api.resumeConfer(c.id);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Resume failed');
      setResuming(false);
    }
  };

  return (
    <div className="glass rounded-lg border border-white/[0.08] px-3 py-2.5">
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[c.status] || 'bg-gray-500'}`} />
        <span className="text-xs font-semibold text-gray-200">Confer</span>
        <span className="text-[11px] text-gray-500">{c.repoName || '—'}</span>
        <span className="text-[11px] text-gray-600">·</span>
        <span className="text-[11px] text-gray-500">{c.participantIds.map(typeOf).join(' + ')}</span>
        <span className="text-[11px] text-gray-600 truncate flex-1" title={c.task}>— {c.taskLabel || c.task}</span>
        {c.status === 'running' && (
          cancelPhase === 'cancelling' ? (
            <span className="text-[11px] text-gray-500 shrink-0">Cancelling…</span>
          ) : cancelPhase === 'confirm' ? (
            <span className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={doCancel}
                className="text-[11px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
              >
                Cancel confer
              </button>
              <button
                onClick={() => setCancelPhase('idle')}
                className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              >
                keep
              </button>
            </span>
          ) : (
            <button
              onClick={() => setCancelPhase('confirm')}
              className="text-[11px] px-1.5 py-0.5 rounded border border-white/10 text-gray-400 hover:text-red-300 hover:border-red-500/40 transition-colors shrink-0"
            >
              Cancel
            </button>
          )
        )}
        {c.status === 'failed' && (
          <button onClick={doResume} disabled={resuming}
            className="text-[11px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 disabled:opacity-50">
            {resuming ? 'Resuming…' : 'Resume confer'}
          </button>
        )}
      </div>
      {cancelError && <div className="text-[11px] text-red-400 mb-1.5">{cancelError}</div>}

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
}
