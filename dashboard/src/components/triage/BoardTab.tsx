/**
 * THE BOARD: every issue in the one column it sits in (stages.ts columnFor) — the seven stages for
 * what is still moving, then waiting on the reporter, labelled, handed over, fixed/released.
 */
import { useMemo, useState } from 'react';
import { TriageArt } from './art';
import { TRIAGE_REST_COLUMNS, TRIAGE_STAGES, columnFor, type TriageColumnKey } from './stages';
import type { TriageIssue } from './types';
import { CARD, Empty, Loading, StatePill, since, agentMin } from './ui';

export function IssueCard({ issue, onOpen }: { issue: TriageIssue; onOpen: (id: string) => void }) {
  return (
    <button data-triage-issue={issue.id} onClick={() => onOpen(issue.id)}
      className="w-full text-left rounded-[14px] bg-gl-code border border-white/[0.08] hover:border-neon-500/50 p-3 space-y-2 transition-colors">
      <div className="flex items-center gap-2">
        {issue.jiraUrl
          ? <a href={issue.jiraUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="font-mono text-[12px] text-neon-200 hover:underline">{issue.jiraKey}</a>
          : <span className="font-mono text-[12px] text-neon-200">{issue.jiraKey}</span>}
        <span className="flex-1" />
        <span className="text-[11px] text-gray-500" title={issue.reportedAt}>{since(issue.reportedAt)}</span>
      </div>
      <div className="text-[13px] text-gray-100 line-clamp-2">{issue.summary || '(no summary)'}</div>
      <div className="flex items-center gap-2 flex-wrap">
        <StatePill state={issue.state} />
        {issue.reporter && <span className="text-[11px] text-gray-400 truncate max-w-[120px]">{issue.reporter}</span>}
        <span className="flex-1" />
        <span className="text-[11px] text-gray-400" title={`${issue.dispatches} agent request(s)`}>{agentMin(issue.agentMinutes)}</span>
      </div>
    </button>
  );
}

export function BoardTab({ issues, onOpen }: { issues: TriageIssue[] | undefined; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const byColumn = useMemo(() => {
    const m = new Map<TriageColumnKey, TriageIssue[]>();
    const q = filter.trim().toLowerCase();
    for (const i of issues ?? []) {
      if (q && !`${i.jiraKey} ${i.summary} ${i.reporter}`.toLowerCase().includes(q)) continue;
      const c = columnFor(i);
      m.set(c, [...(m.get(c) ?? []), i]);
    }
    return m;
  }, [issues, filter]);

  if (issues === undefined) return <Loading what="issues" />;
  if (issues.length === 0) {
    return (
      <Empty art="empty-board" title="No bugs yet">
        <p>New bugs filed in this source's projects appear here within a poll interval. Each one gets a first comment within minutes.</p>
      </Empty>
    );
  }

  const column = (key: TriageColumnKey, label: string, hint: string, art?: (typeof TRIAGE_STAGES)[number]['art']) => {
    const list = byColumn.get(key) ?? [];
    return (
      <section key={key} data-triage-column={key} className={`${CARD} p-3 w-[248px] shrink-0 space-y-2`}>
        <header className="flex items-center gap-2" title={hint}>
          {art && <TriageArt name={art} className="w-9 shrink-0 rounded-[10px]" />}
          <h3 className="text-[13px] font-semibold text-gray-100 flex-1">{label}</h3>
          <span className="rounded-full bg-white/[0.06] px-2 text-[11px] text-gray-300">{list.length}</span>
        </header>
        <div className="space-y-2">
          {list.map((i) => <IssueCard key={i.id} issue={i} onOpen={onOpen} />)}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-3">
      <input className="glass-input w-full max-w-sm rounded-[10px] bg-gl-code border border-white/[0.1] px-3 h-9 text-[13px] text-gray-100 placeholder:text-gray-500"
        placeholder="Filter by key, summary or reporter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter issues" />
      <div data-triage-board className="flex gap-3 overflow-x-auto pb-2">
        {TRIAGE_STAGES.map((s) => column(s.key, s.label, s.hint, s.art))}
        <div className="w-px bg-white/[0.08] shrink-0" aria-hidden="true" />
        {TRIAGE_REST_COLUMNS.map((c) => column(c.key, c.label, c.hint))}
      </div>
    </div>
  );
}
