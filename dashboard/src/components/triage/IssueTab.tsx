/**
 * ONE ISSUE, END TO END: its audit trail as a timeline — every stage, every decision and why, every
 * request to a cartridge, every message to the reporter, every verification run (pass/fail),
 * every guardrail refusal. Links to Jira and the PR; Retry / Hand over / Reopen.
 */
import { useEffect, useState } from 'react';
import type { TriageEvent, TriageEventKind, TriageIssue, TriageIssueDetail } from './types';
import { stageLabel } from './stages';
import { BTN_GHOST, CARD, Empty, ErrorNote, Loading, StatePill, since, agentMin, when } from './ui';

const KIND: Record<TriageEventKind, { label: string; dot: string }> = {
  stage: { label: 'Stage', dot: 'bg-neon-400' },
  decision: { label: 'Decision', dot: 'bg-[#2EE6D6]' },
  dispatch: { label: 'Agent request', dot: 'bg-gray-300' },
  message: { label: 'To the reporter', dot: 'bg-ember-400' },
  verify: { label: 'Verification', dot: 'bg-emerald-400' },
  guardrail: { label: 'Guardrail', dot: 'bg-yellow-300' },
  error: { label: 'Error', dot: 'bg-red-400' },
  note: { label: 'Note', dot: 'bg-gray-500' },
};

export function Timeline({ events }: { events: TriageEvent[] }) {
  if (events.length === 0) return <div className="text-[13px] text-gray-500">Nothing recorded yet.</div>;
  return (
    <ol data-triage-timeline className="relative space-y-3 pl-5 before:absolute before:left-[5px] before:top-1 before:bottom-1 before:w-px before:bg-white/[0.1]">
      {events.map((e) => {
        const k = KIND[e.kind];
        const dot = e.kind === 'verify' && e.ok === false ? 'bg-red-400' : k.dot;
        return (
          <li key={e.id} data-triage-event={e.kind} data-ok={e.ok === undefined ? undefined : String(e.ok)} className="relative">
            <span className={`absolute -left-5 top-1.5 w-[11px] h-[11px] rounded-full border-2 border-gl-surface ${dot}`} aria-hidden="true" />
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-gray-500">
              <span className="uppercase tracking-wide font-semibold text-gray-400">{k.label}</span>
              {e.stage && <span>· {stageLabel(e.stage)}</span>}
              {e.kind === 'verify' && e.ok !== undefined && (
                <span className={e.ok ? 'text-emerald-300' : 'text-red-300'}>{e.ok ? 'passed' : 'failed'}</span>
              )}
              <span className="flex-1" />
              {e.agentMinutes > 0 && <span>{agentMin(e.agentMinutes)}</span>}
              <span title={e.at}>{when(e.at)}</span>
            </div>
            <div className={`text-[14px] ${e.kind === 'guardrail' || e.kind === 'error' ? 'text-yellow-100' : 'text-gray-100'}`}>{e.title}</div>
            {e.reason && <div className="text-[13px] text-gray-400">{e.reason}</div>}
            {e.detail && (
              <pre className={`mt-1 rounded-[10px] bg-gl-code border border-white/[0.08] p-2.5 text-[12px] whitespace-pre-wrap ${e.kind === 'message' ? 'font-sans text-gray-200' : 'font-mono text-gray-300'}`}>{e.detail}</pre>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function IssueTab({ issues, selectedId, loadDetail, busy, onRetry, onHandover, onReopen, refreshKey }: {
  issues: TriageIssue[] | undefined;
  selectedId: string;
  loadDetail: (id: string) => Promise<TriageIssueDetail>;
  busy: boolean;
  onRetry: (id: string) => void;
  onHandover: (id: string) => void;
  onReopen: (id: string) => void;
  /** Bumped by a socket event for this issue: re-read it. */
  refreshKey?: number;
}) {
  const id = selectedId || issues?.[0]?.id || '';
  const [detail, setDetail] = useState<TriageIssueDetail | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    loadDetail(id).then((d) => { if (alive) { setDetail(d); setError(null); } }, (e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [id, loadDetail, refreshKey]);

  if (issues === undefined) return <Loading what="issues" />;
  if (!id) return <Empty art="stage-intake" title="No issue to show"><p>Pick an issue on the Board to see everything that happened to it.</p></Empty>;
  if (!detail || detail.id !== id) return error ? <ErrorNote error={error} /> : <Loading what="the issue" />;

  const handed = detail.state === 'handed_over';
  const resting = ['labelled', 'handed_over', 'error', 'paused'].includes(detail.state);
  return (
    <div data-triage-detail={detail.id} className="space-y-4">
      <div className={`${CARD} space-y-3`}>
        <div className="flex items-center gap-3 flex-wrap">
          {detail.jiraUrl
            ? <a href={detail.jiraUrl} target="_blank" rel="noreferrer" className="font-mono text-[14px] text-neon-200 hover:underline">{detail.jiraKey}</a>
            : <span className="font-mono text-[14px] text-neon-200">{detail.jiraKey}</span>}
          <StatePill state={detail.state} />
          <span className="text-[12px] text-gray-400">{stageLabel(detail.stage)}{detail.outcome ? ` · ${detail.outcome.replace(/_/g, ' ')}` : ''}</span>
          <span className="flex-1" />
          {detail.prUrl && <a href={detail.prUrl} target="_blank" rel="noreferrer" className={BTN_GHOST + ' inline-flex items-center'}>Pull request</a>}
        </div>
        <h2 className="font-display text-xl text-gray-50">{detail.summary}</h2>
        <div className="flex gap-4 flex-wrap text-[12px] text-gray-400">
          {detail.reporter && <span>Reported by {detail.reporter}</span>}
          {detail.reportedAt && <span title={detail.reportedAt}>{since(detail.reportedAt)}</span>}
          {detail.firstResponseAt && <span>First reply {when(detail.firstResponseAt)}</span>}
          <span>{detail.dispatches} agent request(s) · {agentMin(detail.agentMinutes)}</span>
          {detail.labels.length > 0 && <span className="font-mono">{detail.labels.join(' · ')}</span>}
        </div>
        <ErrorNote error={error} />
        <div className="flex gap-2 flex-wrap">
          <button className={BTN_GHOST} disabled={busy} onClick={() => onRetry(detail.id)}>Retry</button>
          <button className={BTN_GHOST} disabled={busy || handed} onClick={() => onHandover(detail.id)}>Hand over</button>
          <button className={BTN_GHOST} disabled={busy || !resting} onClick={() => onReopen(detail.id)}>Reopen</button>
        </div>
      </div>
      <div className={CARD}>
        <h3 className="text-[13px] font-semibold text-gray-300 mb-3">Audit trail</h3>
        <Timeline events={detail.events} />
      </div>
    </div>
  );
}
