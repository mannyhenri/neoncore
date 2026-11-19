import { useState } from 'react';
import type { ServerEntry, ServerStatus } from '../types';
import { serverAddIssue } from '../lib/servers';
import { useEscapeKey } from '../hooks/useEscapeKey';

/**
 * Fleet status and server management.
 *
 * The collapsed pill is the important part: it answers "is my fleet healthy?" at a glance,
 * because with several servers the interesting failure is partial — three up, one asleep —
 * and a single global "Live / Polling" indicator cannot express that.
 *
 * Auth failures are called out separately from unreachable ones. They look identical to a
 * user otherwise, and only one of them is fixed by waiting.
 */

interface Props {
  servers: ServerEntry[];
  statuses: ServerStatus[];
  onAdd: (url: string, token?: string | null) => void;
  onForget: (url: string) => void;
  onHide: (url: string, hidden: boolean) => void;
  onSetToken: (token: string | null) => void;
}

export function ServerPicker({ servers, statuses, onAdd, onForget, onHide, onSetToken }: Props) {
  const [open, setOpen] = useState(false);
  useEscapeKey(() => setOpen(false), open);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const reachable = statuses.filter((s) => s.reachable).length;
  const total = statuses.length;
  const anyAuthFailed = statuses.some((s) => s.authFailed);
  const allHealthy = reachable === total && total > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    // Decide BEFORE dispatching. The old check compared servers.length after a
    // setTimeout(0), but `servers` is captured in this render's closure, so it always read
    // the pre-add value and reported "Not added" even when the add had worked.
    const issue = serverAddIssue(servers, trimmed);
    if (issue) { setError(issue); return; }
    onAdd(trimmed, token.trim() || undefined);
    setError('');
    setUrl('');
    setToken('');
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`btn-ghost flex items-center gap-2 h-10 px-3 rounded-[10px] text-[13px] whitespace-nowrap transition-colors ${
          anyAuthFailed ? 'text-amber-200' : allHealthy ? 'text-gray-300' : 'text-red-300'
        }`}
        title="Servers in this fleet"
      >
        <span
          className={`w-2 h-2 rounded-full ${
            anyAuthFailed ? 'bg-amber-400 shadow-[0_0_8px_#FFC44D]' : allHealthy ? 'bg-emerald-400 gl-glow-online' : 'bg-red-400 animate-pulse shadow-[0_0_8px_#FF6B6B]'
          }`}
        />
        {total <= 1 ? (allHealthy ? 'Live' : 'Polling') : allHealthy ? `Live · ${total} servers` : `${reachable}/${total} servers`}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-[360px] z-40 glass-dark rounded-[20px] shadow-[0_30px_80px_rgba(0,0,0,0.55)] p-5">
            <div className="font-display text-lg font-semibold text-gray-100 mb-3">Fleet</div>

            <div className="space-y-2 mb-3 max-h-72 overflow-y-auto">
              {servers.map((server) => {
                const status = statuses.find((s) => s.url === server.url);
                const isLocal = !server.url;
                return (
                  <div key={server.url || 'local'} className="flex items-center gap-3 text-[13px] p-3 rounded-xl bg-gl-code border border-white/[0.08]">
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        status?.authFailed ? 'bg-amber-400'
                          : status?.reachable ? 'bg-[#00ff88]'
                          : 'bg-red-400'
                      }`}
                      title={status?.lastError || (status?.reachable ? 'Reachable' : 'Unreachable')}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-gray-100 font-mono">
                        {server.name}
                        {isLocal && <span className="text-gray-600 ml-1">(local)</span>}
                        {server.manual === false && <span className="text-gray-600 ml-1">(found)</span>}
                      </div>
                      {server.url && <div className="truncate text-gray-600">{server.url}</div>}
                      {status?.authFailed && (
                        <div className="text-xs text-amber-200">Token rejected — not a network problem</div>
                      )}
                      {!status?.reachable && !status?.authFailed && status?.lastOkAt && (
                        <div className="text-gray-600">Showing last known data</div>
                      )}
                    </div>
                    {!isLocal && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => onHide(server.url, !server.hidden)}
                          className="h-9 px-2.5 text-xs font-semibold rounded-lg border border-white/[0.12] text-gray-300 hover:text-gray-100"
                          title={server.hidden ? 'Show in grid' : 'Hide from grid'}
                        >
                          {server.hidden ? 'show' : 'hide'}
                        </button>
                        <button
                          onClick={() => onForget(server.url)}
                          className="w-9 h-9 rounded-lg border border-white/[0.12] text-gray-300 hover:text-red-300"
                          title="Forget this server"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <form onSubmit={submit} className="space-y-2 border-t border-white/[0.08] pt-3">
              <input
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(''); }}
                placeholder="studio.local:4040"
                className="glass-input w-full h-[42px] rounded-[10px] px-3 text-sm text-gray-100 placeholder-gray-500"
              />
              <div className="flex gap-1.5">
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="fleet token (optional)"
                  className="glass-input flex-1 h-[42px] rounded-[10px] px-3 text-sm text-gray-100 placeholder-gray-500"
                />
                <button type="submit" className="btn-primary h-[42px] px-4 rounded-[10px] text-[13px] font-semibold">
                  Add
                </button>
              </div>
              {error && <div className="text-xs text-red-400">{error}</div>}
            </form>

            <button
              onClick={() => {
                const next = window.prompt('Fleet token — applied to every server (blank to clear):');
                if (next !== null) onSetToken(next.trim() || null);
              }}
              className="mt-3 w-full text-[13px] text-neon-400 hover:text-neon-200 text-left"
            >
              Set fleet token for all servers…
            </button>

            <p className="mt-2 text-[11px] leading-snug text-gray-500">
              Servers found through gossip appear automatically. Forgetting one only hides it
              until the next discovery — use hide to keep it out of the grid.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
