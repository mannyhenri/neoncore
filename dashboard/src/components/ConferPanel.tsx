import { useEffect, useState } from 'react';
import type { Agent, ConferSession } from '../types';
import { api } from '../lib/api';
import { SegMeter } from './SectionTitle';

const STATUS_TEXT: Record<string, string> = {
  running: 'text-neon-300',
  completed: 'text-emerald-300',
  failed: 'text-red-300',
  cancelled: 'text-gray-400',
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

  // Overall progress: finished milestones, plus the active one's share of done signals.
  const doneCount = milestones.filter((m) => m.status === 'done').length;
  const active = milestones.find((m) => m.status === 'active');
  const activeShare = active && participants > 0 ? active.doneIds.length / participants : 0;
  const pct = milestones.length > 0 ? Math.round(((doneCount + activeShare) / milestones.length) * 100) : 0;
  const live = c.status === 'running';

  return (
    <article className={`${live ? 'panel-live' : 'glass-light'} rounded-[18px] p-[18px] space-y-3`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex flex-col gap-0.5">
          <span className="text-[15px] font-semibold text-gray-100 truncate" title={c.task}>
            Confer · {c.taskLabel || c.task}
          </span>
          <span className="text-[13px] text-gray-400 truncate">
            {c.repoName || '—'} · {c.participantIds.map(typeOf).join(' + ')}
          </span>
        </div>
        <span className={`text-[11px] font-bold tracking-[0.08em] shrink-0 ${STATUS_TEXT[c.status] || 'text-gray-400'}`}>
          {c.status.toUpperCase()}
        </span>
      </div>

      {live && (
        <div className="flex items-baseline justify-between font-display">
          <span className="text-[15px] font-semibold neon-text truncate">
            {active?.name ?? 'Starting'}<span className="text-gray-600">....</span>
          </span>
          <span className="text-[22px] font-bold neon-text">{pct}%</span>
        </div>
      )}

      {/* Milestones, each with its own segmented meter. */}
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, milestones.length)}, minmax(0, 1fr))` }}>
        {milestones.map((m) => {
          const done = m.status === 'done';
          const isActive = m.status === 'active';
          const signalled = m.doneIds.length;
          const mPct = done ? 100 : isActive && participants > 0 ? Math.max(8, (signalled / participants) * 100) : 0;
          return (
            <div key={m.id} className="flex flex-col gap-1.5 min-w-0" title={isActive ? `${signalled}/${participants} agents signalled done` : m.status}>
              <SegMeter pct={mPct} cells={5} height={12} label={`${m.name} ${m.status}`} className="!p-[3px] !gap-[2px] shadow-none" />
              <span className={`text-[12px] font-semibold truncate ${isActive ? 'text-neon-300' : done ? 'text-gray-100' : 'text-gray-500'}`}>
                {m.name}{done && ' ✓'}
              </span>
              {isActive && <span className="font-mono text-[11px] text-gray-400">{signalled}/{participants}</span>}
            </div>
          );
        })}
      </div>

      {cancelError && <div className="text-[12px] text-red-300">{cancelError}</div>}
      {c.error && <p className="text-[12px] text-ember-300">{c.error}</p>}
      {c.status === 'completed' && <p className="text-[12px] text-emerald-300">All milestones complete.</p>}
      {c.status === 'failed' && <p className="text-[12px] text-red-300">Confer failed — a milestone stalled.</p>}

      {(c.status === 'running' || c.status === 'failed') && (
        <div className="flex gap-2">
          {c.status === 'running' && (
            cancelPhase === 'cancelling' ? (
              <span className="flex-1 h-10 flex items-center justify-center text-[13px] text-gray-400">Cancelling…</span>
            ) : cancelPhase === 'confirm' ? (
              <>
                <button
                  onClick={doCancel}
                  className="flex-1 h-10 rounded-[10px] text-[13px] font-semibold border border-red-400/50 bg-red-500/15 text-red-200"
                >
                  Cancel confer
                </button>
                <button
                  onClick={() => setCancelPhase('idle')}
                  className="flex-1 h-10 rounded-[10px] text-[13px] font-semibold btn-ghost"
                >
                  keep
                </button>
              </>
            ) : (
              <button
                onClick={() => setCancelPhase('confirm')}
                className="flex-1 h-10 rounded-[10px] text-[13px] font-semibold border border-red-400/40 text-red-200 hover:bg-red-500/10"
              >
                Cancel
              </button>
            )
          )}
          {c.status === 'failed' && (
            <button onClick={doResume} disabled={resuming}
              className="flex-1 h-10 rounded-[10px] text-[13px] font-semibold border border-ember-500/50 text-ember-300 disabled:opacity-50">
              {resuming ? 'Resuming…' : 'Resume confer'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
