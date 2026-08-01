import { useState, useEffect, useCallback } from 'react';
import type { Agent, QueueItem, QueueLane, QueueKind } from '../types';
import { api } from '../lib/api';

/**
 * The queue surface.
 *
 * Built because the queue shipped with seven mounted routes and no client on any surface —
 * an API nobody could reach. The panel exists to make it reachable, so it deliberately
 * shows LANE and HALT REASON rather than only item status: every failure mode in the runner
 * halts a lane with a reason, and a UI that says "failed" without saying which lane stopped
 * and why makes the safety property invisible. A user who cannot see why it stopped learns
 * to distrust it and switches it off, which costs more than the failure did.
 */

const STATUS_STYLE: Record<string, string> = {
  queued: 'bg-white/[0.06] text-gray-400',
  running: 'bg-sky-900/60 text-sky-300',
  done: 'bg-emerald-900/50 text-emerald-300',
  failed: 'bg-red-900/60 text-red-300',
  blocked: 'bg-amber-900/60 text-amber-300',
  cancelled: 'bg-white/[0.04] text-gray-500',
};

export function QueuePanel({ agents }: { agents: Agent[] }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [lanes, setLanes] = useState<QueueLane[]>([]);
  // The server tells us which kinds it accepts (GET /api/queue -> kinds). Re-declaring them
  // here would be a fourth hand-maintained copy of a registry that already ships.
  const [kinds, setKinds] = useState<QueueKind[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [kind, setKind] = useState<QueueKind>('prompt');
  const [text, setText] = useState('');
  const [targets, setTargets] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const view = await api.getQueue();
      setItems(view.items ?? []);
      setLanes(view.lanes ?? []);
      setKinds(view.kinds ?? []);
      setError('');
    } catch (err) {
      // A 404 here means the SERVER PROCESS predates the queue — the SPA catch-all returns
      // index.html for unmatched routes, so this surfaces as an unactionable "Not Found".
      // The one thing the user needs to know is the one thing that message omits.
      const msg = err instanceof Error ? err.message : String(err);
      setError(/not found/i.test(msg)
        ? 'This server is running a build without the queue — rebuild and restart it (npm run build, then restart NeonCore).'
        : msg || 'could not read the queue');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await refresh(); } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally { setBusy(false); }
  }

  async function submit() {
    if (!text.trim() || targets.length === 0) return;
    const payload = kind === 'prompt' ? { text: text.trim() } : { repoPath: text.trim() };
    // POST returns the created item (201). A rejection is a 400, which the client throws —
    // so failure arrives as an exception and is caught by run(), not as a field on the
    // response. Branching on `res.ok` here reported "rejected" on every success.
    await api.enqueueItem({ kind, payload, targets });
    setText('');
    setError('');
  }

  const laneOf = (name: string) => lanes.find((l) => l.lane === name);
  const byLane = items.reduce<Record<string, QueueItem[]>>((acc, i) => {
    (acc[i.lane] ||= []).push(i);
    return acc;
  }, {});

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-200">
          Queue <span className="text-gray-500">· {items.length} item{items.length === 1 ? '' : 's'}</span>
        </h2>
        <button
          onClick={() => void run(() => api.tickQueue())}
          disabled={busy}
          className="px-2 py-1 text-[11px] rounded bg-white/[0.06] text-gray-300 hover:bg-white/10 disabled:opacity-40"
          title="Drain now instead of waiting for the next 15s tick"
        >
          Tick now
        </button>
      </div>

      {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

      {/* Enqueue */}
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as QueueKind)}
          className="bg-white/[0.06] text-xs text-gray-200 rounded px-2 py-1 border border-white/10"
        >
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={kind === 'prompt' ? 'prompt text…' : 'repo path…'}
          className="flex-1 min-w-[14rem] bg-white/[0.06] text-xs text-gray-200 rounded px-2 py-1 border border-white/10"
        />
        <select
          multiple
          value={targets}
          onChange={(e) => setTargets([...e.target.selectedOptions].map((o) => o.value))}
          className="bg-white/[0.06] text-xs text-gray-200 rounded px-2 py-1 border border-white/10 min-w-[10rem]"
        >
          {agents.filter((a) => a.status !== 'offline').map((a) => (
            <option key={a.id} value={a.id}>{a.name || a.id.slice(0, 8)}</option>
          ))}
        </select>
        <button
          onClick={() => void run(submit)}
          disabled={busy || !text.trim() || targets.length === 0}
          className="px-3 py-1 text-xs rounded bg-violet-900/60 text-violet-200 hover:bg-violet-900 disabled:opacity-40"
        >
          Queue it
        </button>
      </div>

      {items.length === 0 && <p className="text-[11px] text-gray-500">Nothing queued.</p>}

      {/* One block per lane — the lane IS the unit of serial execution, and the unit that halts */}
      {Object.entries(byLane).map(([lane, laneItems]) => {
        const meta = laneOf(lane);
        const halted = Boolean(meta?.paused || meta?.haltedReason);
        return (
          <div key={lane} className="mb-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] text-gray-400 font-mono">{lane}</span>
              {halted && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300">
                  HALTED
                </span>
              )}
              <button
                onClick={() => void run(() => halted ? api.resumeQueueLane(lane) : api.pauseQueueLane(lane))}
                disabled={busy}
                className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-gray-400 hover:text-gray-200 disabled:opacity-40"
              >
                {halted ? 'resume' : 'pause'}
              </button>
            </div>

            {/* WHY it stopped, not just that it did. Without this the halt looks like a bug. */}
            {meta?.haltedReason && (
              <p className="text-[11px] text-amber-400/90 mb-1 pl-1">{meta.haltedReason}</p>
            )}

            <ul className="space-y-1">
              {laneItems.map((i) => (
                <li key={i.id} className="flex items-start gap-2 text-[11px]">
                  <span className={`px-1.5 py-0.5 rounded shrink-0 ${STATUS_STYLE[i.status] ?? ''}`}>
                    {i.status}
                  </span>
                  <span className="text-gray-500 shrink-0">{i.kind}</span>
                  <span className="text-gray-300 truncate flex-1">
                    {String(i.payload?.text ?? i.payload?.repoPath ?? i.id.slice(0, 8))}
                  </span>
                  {i.error && <span className="text-red-400/90 truncate max-w-[16rem]">{i.error}</span>}
                  {(i.status === 'queued' || i.status === 'running') && (
                    <button
                      onClick={() => void run(() => api.cancelQueueItem(i.id))}
                      disabled={busy}
                      className="text-gray-500 hover:text-red-400 shrink-0 disabled:opacity-40"
                    >
                      cancel
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
