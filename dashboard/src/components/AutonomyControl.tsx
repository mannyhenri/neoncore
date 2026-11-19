import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { useEscapeKey } from '../hooks/useEscapeKey';

/**
 * The automate control — how much a run may settle for itself while you are away.
 *
 * ASKED FOR AS A BUTTON: a chat command is fine on a phone and useless at the desk, where you
 * are looking at the run you want to raise.
 *
 * RAISING ALWAYS CARRIES A DURATION. There is no untimed grant in this UI, because "I'm willing
 * to take the risk" is nearly always bounded risk and a mode you forget to flip back is not
 * bounded. Dropping back to Manual needs no window — lowering is always safe.
 *
 * What each level may settle lives in server/src/lib/autonomy.ts and is deliberately NOT
 * restated here: a second copy of that table in the UI is one that goes stale silently and
 * tells you the run is doing something it is not.
 */

const LEVELS = [
  { key: 'manual', label: 'Manual', hint: 'Every gate waits for you.', color: 'text-gray-400' },
  { key: 'advance', label: 'Advance', hint: 'Releases finished steps. Decides nothing.', color: 'text-neon-300' },
  { key: 'full', label: 'Full', hint: 'Also takes decision gates by their recommendation. Holds when there is none.', color: 'text-ember-300' },
] as const;

const DURATIONS = [
  { label: '1h', ms: 3_600_000 },
  { label: '4h', ms: 4 * 3_600_000 },
  { label: '12h', ms: 12 * 3_600_000 },
];

interface State {
  level: string;
  source: string;
  expiresAt: string | null;
  resolutions: { stepId: string; reason: string; chose: string; autonomy: string }[];
}

export function AutonomyControl({ workflowId }: { workflowId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  useEscapeKey(() => setOpen(false), open);
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    api.getWorkflowAutonomy(workflowId).then((s) => setState(s as State)).catch(() => {});
  };

  useEffect(() => {
    load();
    // Expiry is the whole point of the time-box: the badge must stop claiming a level the run
    // no longer has. A minute is finer than any duration offered here.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  async function set(level: string, durationMs?: number) {
    setBusy(true); setError('');
    try {
      await api.setWorkflowAutonomy(workflowId, level, durationMs);
      load();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change autonomy.');
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  const current = LEVELS.find((l) => l.key === state.level) ?? LEVELS[0];
  const raised = state.level !== 'manual';

  return (
    <div className="relative">
      <button
        ref={btn}
        onClick={() => {
          // Measured at open time, not on every render: the rail scrolls independently, so a
          // position captured once would drift away from its button.
          const r = btn.current?.getBoundingClientRect();
          // 360px panel, kept on screen: start at the chip, slide left only if it would overflow.
          if (r) setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 368)) });
          setOpen((o) => !o);
        }}
        className={`text-[12px] font-semibold px-2.5 py-0.5 rounded-full transition-colors ${current.color} ${
          raised ? 'bg-neon-500/15 hover:bg-neon-500/25' : 'bg-white/[0.06] hover:bg-white/[0.1]'
        }`}
        title={
          `Autonomy: ${state.level} (${state.source})` +
          (state.expiresAt ? `\nEnds ${new Date(state.expiresAt).toLocaleString()}` : '') +
          `\n${current.hint}` +
          (state.resolutions.length ? `\n\n${state.resolutions.length} auto-resolution(s) so far` : '')
        }
      >
        ⚡ {current.label}
        {state.expiresAt && raised && (
          <span className="opacity-80"> · {Math.max(1, Math.round((new Date(state.expiresAt).getTime() - Date.now()) / 3_600_000))}h</span>
        )}
        {state.resolutions.length > 0 && (
          <span className="ml-1 text-[11px] text-gray-400">{state.resolutions.length}</span>
        )}
      </button>

      {/*
        PORTALED OUT OF THE RAIL. The command rail is `lg:sticky`, and position:sticky always
        creates a stacking context — so an `absolute z-50` panel is not "above the page", it is
        above the RAIL, which paints before <main>. Reported as the dropdown appearing behind
        the runs listed beneath it. No z-index can win against a sibling stacking context that
        paints later; the panel has to leave the subtree. Same fix, and same reason, as
        WorkflowPanel's deferred popup and the canvas editor's overlays.
      */}
      {open && at && createPortal(
        <>
          {/* Click-away. Inside the portal so it covers the page rather than the rail. */}
          <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[91] w-[360px] glass-dark rounded-[20px] shadow-[0_30px_80px_rgba(0,0,0,0.5)] p-5 space-y-3"
            style={{ top: at.top, left: at.left }}
          >
          <h3 className="font-display text-lg font-semibold text-gray-100">⚡ Autonomy</h3>
          {LEVELS.map((l) => (
            <div
              key={l.key}
              className={`flex items-center gap-3 rounded-xl p-3 border ${
                state.level === l.key ? 'bg-neon-500/10 border-neon-500/50' : 'bg-[rgba(4,8,20,0.6)] border-white/[0.08]'
              }`}
            >
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-gray-100">{l.label}</span>
                <p className="text-[13px] text-gray-400">{l.hint}</p>
              </div>
              <div className="shrink-0">
                {l.key === 'manual' ? (
                  <button
                    disabled={busy}
                    onClick={() => set('manual')}
                    className="h-9 min-w-[44px] px-2.5 rounded-lg border border-white/[0.18] text-[12px] font-semibold text-gray-200 hover:border-neon-500/60 disabled:opacity-40"
                  >
                    Set
                  </button>
                ) : (
                  // No untimed option, deliberately. Every raise expires.
                  <div className="flex gap-1.5">
                    {DURATIONS.map((d) => (
                      <button
                        key={d.label}
                        disabled={busy}
                        onClick={() => set(l.key, d.ms)}
                        className="h-9 min-w-[44px] px-2.5 rounded-lg border border-white/[0.18] text-[12px] font-semibold text-gray-200 hover:border-neon-500/60 hover:bg-neon-500/10 disabled:opacity-40"
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          <p className="text-[12px] text-gray-400">
            {state.expiresAt
              ? `Ends ${new Date(state.expiresAt).toLocaleString()}.`
              : 'Raising always expires. Failed and interrupted steps are never auto-resolved.'}
          </p>
          {error && <p className="text-[12px] text-red-300">{error}</p>}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
