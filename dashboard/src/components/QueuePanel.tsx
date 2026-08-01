import { useState, useEffect, useCallback } from 'react';
import type { QueueItem, QueueLane } from '../types';
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

/**
 * `haltedOnly` renders just the lanes that have STOPPED and need a person. Queue items
 * themselves are rows in the task list — a queued prompt is a task, and giving it a second
 * panel above the list was the duplication the user asked us to remove.
 */
export function QueuePanel({ haltedOnly = false }: { haltedOnly?: boolean } = {}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [lanes, setLanes] = useState<QueueLane[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const view = await api.getQueue();
      setItems(view.items ?? []);
      setLanes(view.lanes ?? []);
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

  const anyHalted = lanes.some((l) => l.paused || l.haltedReason);
  if (haltedOnly && !anyHalted) return null;

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

      {/* NO ENQUEUE FORM, deliberately. Work starts the way it always has — prompt a
          cartridge, start a confer, start a workflow — and the server queues it when that
          cartridge is busy (routes/commands.ts, confer.ts, workflows.ts). A second form here
          would be a second way to do the same thing, in the wrong place. This panel WATCHES. */}
      {!haltedOnly && items.length === 0 && <p className="text-[11px] text-gray-500">Nothing queued.</p>}

      {/* One block per lane — the lane IS the unit of serial execution, and the unit that halts */}
      {Object.entries(byLane)
        .filter(([lane]) => {
          // Strip mode lists ONLY stopped lanes. Showing every lane here would put the whole
          // queue back on screen next to the task cards that already render it.
          const m = laneOf(lane);
          return !haltedOnly || Boolean(m?.paused || m?.haltedReason);
        })
        .map(([lane, laneItems]) => {
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

            {/* Items are CARDS in the task list, never rows here. Rendering them in strip mode
                showed the same four items twice — once unstyled without a retry button, and
                once as a filtered card — which is the duplication the merge removed. */}
            {!haltedOnly && (
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
            )}
          </div>
        );
      })}
    </div>
  );
}
