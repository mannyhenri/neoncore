import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';

/**
 * The automate control — how much a run may settle for itself while you are away.
 *
 * ASKED FOR AS A BUTTON, and it was a Discord command only. `!autonomy` is fine on a phone and
 * useless at the desk, where you are looking at the run you want to raise.
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
  { key: 'advance', label: 'Advance', hint: 'Releases finished steps. Decides nothing.', color: 'text-blue-300' },
  { key: 'full', label: 'Full', hint: 'Also takes decision gates by their recommendation. Holds when there is none.', color: 'text-violet-300' },
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
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
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
          if (r) setAt({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
          setOpen((o) => !o);
        }}
        className={`text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors ${current.color} ${
          raised ? 'border border-current/30' : ''
        }`}
        title={
          `Autonomy: ${state.level} (${state.source})` +
          (state.expiresAt ? `\nEnds ${new Date(state.expiresAt).toLocaleString()}` : '') +
          `\n${current.hint}` +
          (state.resolutions.length ? `\n\n${state.resolutions.length} auto-resolution(s) so far` : '')
        }
      >
        ⚡ {current.label}
        {state.resolutions.length > 0 && (
          <span className="ml-1 text-[10px] text-gray-500">{state.resolutions.length}</span>
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
            className="fixed z-[91] w-72 bg-[#0d0f12] border border-white/[0.08] rounded-lg shadow-2xl p-2 space-y-1"
            style={{ top: at.top, right: at.right }}
          >
          {LEVELS.map((l) => (
            <div key={l.key} className="rounded hover:bg-white/[0.04] p-2">
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs font-medium ${l.color}`}>{l.label}</span>
                {l.key === 'manual' ? (
                  <button
                    disabled={busy}
                    onClick={() => set('manual')}
                    className="text-[11px] px-2 py-0.5 rounded border border-white/10 text-gray-400 hover:text-white disabled:opacity-40"
                  >
                    Set
                  </button>
                ) : (
                  // No untimed option, deliberately. Every raise expires.
                  <div className="flex gap-1">
                    {DURATIONS.map((d) => (
                      <button
                        key={d.label}
                        disabled={busy}
                        onClick={() => set(l.key, d.ms)}
                        className="text-[11px] px-1.5 py-0.5 rounded border border-white/10 text-gray-400 hover:text-white disabled:opacity-40"
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-[11px] text-gray-600 mt-0.5">{l.hint}</p>
            </div>
          ))}

          <p className="text-[11px] text-gray-600 px-2 pt-1 border-t border-white/[0.06]">
            {state.expiresAt
              ? `Ends ${new Date(state.expiresAt).toLocaleString()}.`
              : 'Raising always expires. Failed and interrupted steps are never auto-resolved.'}
          </p>
          {error && <p className="text-[11px] text-red-400 px-2">{error}</p>}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
