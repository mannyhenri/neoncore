import { useEffect, useRef, useState } from 'react';
import type { ServerStatus } from '../types';
import { useEscapeKey } from '../hooks/useEscapeKey';

/**
 * Is this dashboard connected to its server — and the fleet token it uses.
 *
 * It used to manage a fleet of servers (add, hide, forget, ones found through gossip). NeonCore
 * no longer links servers, so the pill answers one question: live or not. A rejected token is
 * called out apart from an unreachable server — they look identical otherwise, and only one of
 * them is fixed by waiting.
 */
interface Props {
  statuses: ServerStatus[];
  onSetToken: (token: string | null) => void;
}

export function ServerPicker({ statuses, onSetToken }: Props) {
  const [open, setOpen] = useState(false);
  useEscapeKey(() => setOpen(false), open);
  // Close on a click outside — not a full-window catcher, which would sit inside the top bar's
  // layer and miss clicks on anything painted above it.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const status = statuses[0];
  const authFailed = !!status?.authFailed;
  const live = !!status?.reachable && !authFailed;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`btn-ghost flex items-center gap-2 h-10 px-3 rounded-[10px] text-[13px] whitespace-nowrap transition-colors ${
          authFailed ? 'text-amber-200' : live ? 'text-gray-300' : 'text-red-300'
        }`}
        title="Connection to this machine's NeonCore server"
      >
        <span
          className={`w-2 h-2 rounded-full ${
            authFailed ? 'bg-amber-400 shadow-[0_0_8px_#FFC44D]' : live ? 'bg-emerald-400 gl-glow-online' : 'bg-red-400 animate-pulse shadow-[0_0_8px_#FF6B6B]'
          }`}
        />
        {live ? 'Live' : authFailed ? 'Token rejected' : 'Polling'}
      </button>

      {open && (
        <>
          <div className="absolute right-0 mt-2 w-[320px] z-40 glass-dark rounded-[20px] shadow-[0_30px_80px_rgba(0,0,0,0.55)] p-5">
            <div className="font-display text-lg font-semibold text-gray-100 mb-1">This machine</div>
            <p className="text-[13px] text-gray-400">
              {authFailed ? 'The server rejected the fleet token — not a network problem.'
                : live ? 'Connected to the NeonCore server on this machine.'
                : status?.lastOkAt ? 'Not reachable right now — showing the last known data.'
                : 'Not reachable right now.'}
            </p>
            <button
              onClick={() => {
                const next = window.prompt('Fleet token for this server (blank to clear):');
                if (next !== null) onSetToken(next.trim() || null);
              }}
              className="mt-3 w-full text-[13px] text-neon-400 hover:text-neon-200 text-left"
            >
              Set fleet token…
            </button>
          </div>
        </>
      )}
    </div>
  );
}
