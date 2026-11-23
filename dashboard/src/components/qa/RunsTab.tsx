/**
 * RUNS — every run, newest first. Opening one shows each test's steps and its evidence:
 * screenshots, the trace, console errors and failed network calls, and the run's HTML report.
 */
import { useEffect, useState } from 'react';
import { evidenceUrl, reportUrl } from '../../lib/qaApi';
import type { QaRun, QaRunDetail } from './types';
import { CARD, Empty, Loading, StatusPill, when } from './ui';

const KIND_LABEL: Record<QaRun['kind'], string> = { run: 'Test run', explore: 'Exploration', generate: 'Generate from journeys' };
const LIVE = new Set(['queued', 'dispatched', 'running']);

function RunDetailView({ detail }: { detail: QaRunDetail }) {
  return (
    <div data-qa-run-detail className="space-y-3 pt-3 border-t border-white/[0.08]">
      {detail.results.length === 0 && <div className="text-[13px] text-gray-500">No test results{LIVE.has(detail.status) ? ' yet' : ''}.</div>}
      {detail.results.map((r) => (
        <div key={r.testId} data-qa-result={r.testId} className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-100">{r.testName || r.testId}</span>
            <StatusPill status={r.repaired && r.status === 'passed' ? 'passed_with_repair' : r.status} />
          </div>
          {r.error && <div className="text-[13px] text-red-200">{r.error}</div>}
          <ol className="space-y-1 text-[13px]">
            {r.steps.map((s) => (
              <li key={s.index} data-qa-step={s.status} className="flex gap-2 items-start">
                <span className={`w-4 shrink-0 ${s.status === 'passed' ? 'text-emerald-300' : s.status === 'failed' ? 'text-red-300' : 'text-gray-500'}`} aria-label={s.status}>
                  {s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '–'}
                </span>
                <span className="flex-1 text-gray-300">{s.sentence}{s.error && <span className="block text-red-200/90 font-mono text-[12px]">{s.error}</span>}</span>
                {s.screenshot && (
                  <a href={evidenceUrl(detail.id, s.screenshot)} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={evidenceUrl(detail.id, s.screenshot)} alt={`Screenshot of step ${s.index + 1}`} className="w-24 h-14 object-cover rounded-md border border-white/[0.1]" />
                  </a>
                )}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2 text-[12px]">
            {r.evidence.screenshots.map((f) => (
              <a key={f} href={evidenceUrl(detail.id, f)} target="_blank" rel="noreferrer" data-qa-evidence="screenshot">
                <img src={evidenceUrl(detail.id, f)} alt="Screenshot" className="w-28 h-16 object-cover rounded-md border border-white/[0.1]" />
              </a>
            ))}
            {r.evidence.trace && <a data-qa-evidence="trace" className="text-neon-300 underline self-center" href={evidenceUrl(detail.id, r.evidence.trace)}>Trace</a>}
          </div>
          {r.evidence.console.length > 0 && (
            <details data-qa-evidence="console" className="text-[12px]">
              <summary className="cursor-pointer text-gray-400">Console errors · {r.evidence.console.length}</summary>
              <pre className="mt-1 rounded-[10px] bg-gl-code p-2 font-mono text-red-200/90 whitespace-pre-wrap">{r.evidence.console.join('\n')}</pre>
            </details>
          )}
          {r.evidence.network.length > 0 && (
            <details data-qa-evidence="network" className="text-[12px]">
              <summary className="cursor-pointer text-gray-400">Failed network calls · {r.evidence.network.length}</summary>
              <ul className="mt-1 rounded-[10px] bg-gl-code p-2 font-mono text-gray-300 space-y-0.5">
                {r.evidence.network.map((n, i) => <li key={i}>{n.method} {n.status} {n.url}</li>)}
              </ul>
            </details>
          )}
        </div>
      ))}
      {detail.repairs.length > 0 && <div className="text-[13px] text-ember-300">{detail.repairs.length} repair{detail.repairs.length === 1 ? '' : 's'} to review in Repairs.</div>}
      {detail.findings.length > 0 && <div className="text-[13px] text-neon-200">{detail.findings.length} finding{detail.findings.length === 1 ? '' : 's'} — see Findings.</div>}
    </div>
  );
}

export function RunsTab({ runs, loadDetail }: {
  runs: QaRun[] | undefined;
  loadDetail: (id: string) => Promise<QaRunDetail>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<QaRunDetail | null>(null);
  const openRun = runs?.find((r) => r.id === open);
  const openSig = openRun ? `${openRun.id}:${openRun.status}:${openRun.aiCalls}` : '';

  useEffect(() => {
    if (!open) { setDetail(null); return; }
    let live = true;
    loadDetail(open).then((d) => live && setDetail(d)).catch(() => live && setDetail(null));
    return () => { live = false; };
    // Re-read when the open run changes status (a socket update arrived).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openSig]);

  if (runs === undefined) return <Loading what="runs" />;
  if (runs.length === 0) {
    return <Empty art="module-runner" title="No runs yet"><p>Run a test from Tests, start an exploration from Findings, or generate tests from Journeys.</p></Empty>;
  }
  return (
    <ul className="space-y-3">
      {runs.map((r) => (
        <li key={r.id} data-qa-run={r.id} className={`${CARD} ${LIVE.has(r.status) ? 'panel-live' : ''}`}>
          <button className="w-full flex items-center gap-3 flex-wrap text-left" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
            <StatusPill status={r.status} />
            <span className="font-semibold text-gray-100">{KIND_LABEL[r.kind] ?? r.kind}</span>
            {r.goal && <span className="text-[13px] text-gray-400 truncate max-w-[40ch]">“{r.goal}”</span>}
            <span className="flex-1" />
            <span data-qa-ai-calls={r.aiCalls} className="text-[12px] text-gray-400">{r.aiCalls} AI call{r.aiCalls === 1 ? '' : 's'}</span>
            <span className="font-mono text-[12px] text-gray-500">{when(r.startedAt)}</span>
          </button>
          {r.summary && <div className="mt-2 text-[13px] text-gray-300">{r.summary}</div>}
          <div className="mt-2 text-[12px]">
            <a className="text-neon-300 underline" href={reportUrl(r.id)} target="_blank" rel="noreferrer" data-qa-report>HTML report</a>
          </div>
          {open === r.id && (detail && detail.id === r.id ? <RunDetailView detail={detail} /> : <div className="pt-3 text-[13px] text-gray-500">Loading…</div>)}
        </li>
      ))}
    </ul>
  );
}
