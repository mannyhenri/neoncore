import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { EpicQaRunSummary } from '../types';

/**
 * EPIC QA ON AN EPIC — the run for its current finish, why Passed QA is refused, a way to run it.
 *
 * When an epic's last feature is done, the server runs every feature's locked acceptance tests,
 * the project's QA command and (if any) browser QA together (server lib/qa/epic-acceptance.ts).
 * A failed run BLOCKS Passed QA (setEpicQa → 409); this says why before you press it. Passed QA
 * itself stays the person's: nothing here presses it.
 *
 * Used by every surface that offers Passed QA (the route's epic card, the Board's QA column), so
 * the rule is drawn once. A surface that has the run (RoadmapEpic.qaRun) passes it; one that does
 * not lets this fetch it. While a run is going it polls.
 */

type EpicQa = 'none' | 'open' | 'waiting' | 'passed';

/** Same words as the server's refusal when QA has not run since the epic finished. */
export const NOT_RUN_REASON = 'QA has not run since the epic finished — run QA first.';

/** Why Passed QA is refused for this run — null when it is allowed (passed, or nothing to test). */
export function passQaBlock(run: EpicQaRunSummary | null): string | null {
  if (!run) return NOT_RUN_REASON;
  if (run.status === 'passed' || run.status === 'no-tests') return run.blockedReason;
  return run.blockedReason || (run.status === 'running' ? 'QA is still running.' : `QA ${run.status}.`);
}

export function epicQaChip(run: EpicQaRunSummary | null): { text: string; cls: string } {
  if (!run) return { text: 'QA not run yet', cls: 'bg-white/[0.06] text-gray-300' };
  switch (run.status) {
    case 'running': return { text: 'QA running…', cls: 'bg-neon-500/15 text-neon-200' };
    case 'passed': return { text: `QA passed ${run.passing}/${run.total}`, cls: 'bg-emerald-500/12 text-emerald-200' };
    case 'failed': return { text: `QA failed ${run.passing}/${run.total}`, cls: 'bg-red-500/15 text-red-200' };
    case 'error': return { text: 'QA could not run', cls: 'bg-red-500/15 text-red-200' };
    case 'no-tests': return { text: 'No tests to run', cls: 'bg-amber-400/12 text-amber-200' };
  }
}

export function EpicQaControls({ epicId, epicName, qa, run, onPassQa, onChanged, busy, compact }: {
  epicId: string;
  epicName: string;
  qa: EpicQa;
  /** The run for the epic's current finish; `undefined` = this surface does not have it, fetch it. */
  run?: EpicQaRunSummary | null;
  onPassQa: () => void;
  onChanged?: () => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const [fetched, setFetched] = useState<EpicQaRunSummary | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState('');
  const current = fetched !== undefined ? fetched : run !== undefined ? run : null;
  const needsFetch = run === undefined || current?.status === 'running';

  useEffect(() => { setFetched(undefined); }, [run]);
  useEffect(() => {
    if (qa !== 'waiting' || !needsFetch) return;
    let live = true;
    const load = () => api.getEpicQa(epicId).then((r) => { if (live) setFetched(r.current); }).catch(() => {});
    if (run === undefined && fetched === undefined) void load();
    const poll = current?.status === 'running' ? setInterval(() => void load(), 5000) : null;
    return () => { live = false; if (poll) clearInterval(poll); };
  }, [epicId, qa, needsFetch, current?.status, run, fetched]);

  if (qa === 'passed') {
    return <span data-epic-pill="qa" className="px-2.5 h-7 inline-flex items-center rounded-full text-[13px] bg-emerald-500/10 text-emerald-300">✓ QA passed</span>;
  }
  if (qa !== 'waiting') return null;

  const chip = epicQaChip(current);
  const block = passQaBlock(current);
  const runQa = async () => {
    setErr('');
    setStarting(true);
    try {
      await api.runEpicQa(epicId);
      setFetched({ ...(current ?? { id: '', passing: 0, total: 0, at: new Date().toISOString(), finishedAt: '', failing: [] }), status: 'running', blockedReason: 'QA is still running.' } as EpicQaRunSummary);
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start QA.');
    } finally { setStarting(false); }
  };
  const pill = compact ? 'h-7 px-2.5 rounded-[8px] text-[11px]' : 'h-7 px-2.5 rounded-full text-[13px]';

  return (
    <div data-epic-qa-controls={epicId} className="flex flex-col gap-1.5 min-w-0" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span data-epic-pill="qa" data-qa-status={current?.status ?? 'not-run'} className={`${pill} inline-flex items-center font-semibold ${chip.cls}`}>🧪 {chip.text}</span>
        {current?.status !== 'running' && (
          <button type="button" disabled={starting} onClick={() => void runQa()}
            title={`Run every acceptance test of ${epicName}'s features, and the project's QA command`}
            className={`${pill} inline-flex items-center border border-neon-500/45 font-semibold text-neon-200 hover:bg-neon-500/10 disabled:opacity-40`}>
            {current ? 'Run QA again' : 'Run QA'}
          </button>
        )}
        <button type="button" data-epic-pass-qa disabled={busy || block !== null} onClick={onPassQa}
          title={block ?? `Every feature of ${epicName} is done and QA passed — they move to Done`}
          className={`${pill} inline-flex items-center border border-emerald-400/50 font-semibold text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-35 disabled:cursor-not-allowed`}>
          Passed QA ✓
        </button>
      </div>
      {block && <p data-pass-qa-blocked className="text-[12px] text-gray-400">{block}</p>}
      {current?.status === 'failed' && current.failing.length > 0 && (
        <ul data-qa-failing className="text-[12px] text-red-200/90 space-y-0.5">
          {current.failing.slice(0, 6).map((f, i) => (
            <li key={i} className="truncate" title={f.text}>✕ {f.feature} · {f.criterionId} · {f.text}</li>
          ))}
          {current.failing.length > 6 && <li className="text-gray-400">…and {current.failing.length - 6} more — see QA</li>}
        </ul>
      )}
      {err && <p className="text-[12px] text-red-300">{err}</p>}
    </div>
  );
}
