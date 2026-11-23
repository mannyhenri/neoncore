/**
 * EVERY COMMENT SENT TO A REPORTER, by issue — what each person was told, and when. Read from each
 * issue's audit trail (events of kind `message`); one comment per stage change.
 */
import { useEffect, useState } from 'react';
import type { TriageIssue, TriageIssueDetail, TriageEvent } from './types';
import { CARD, Empty, Loading, when } from './ui';

const TEMPLATE_LABEL: Record<string, string> = {
  received: 'Report received', needs_info: 'More information needed', duplicate: 'Duplicate', not_a_bug: 'Not a bug',
  not_reproduced: 'Could not reproduce', solution_found: 'Solution found', released: 'Fix released',
};

export function MessagesTab({ issues, loadDetail, refreshKey }: {
  issues: TriageIssue[] | undefined;
  loadDetail: (id: string) => Promise<TriageIssueDetail>;
  refreshKey?: number;
}) {
  const [byIssue, setByIssue] = useState<{ issue: TriageIssue; messages: TriageEvent[] }[] | undefined>(undefined);

  useEffect(() => {
    if (!issues) return;
    let alive = true;
    // Newest issues first; the audit trail is per issue, so read the ones on screen.
    const recent = [...issues].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50);
    Promise.all(recent.map((i) => loadDetail(i.id).then((d) => ({ issue: i, messages: d.events.filter((e) => e.kind === 'message') }), () => ({ issue: i, messages: [] as TriageEvent[] }))))
      .then((all) => { if (alive) setByIssue(all.filter((x) => x.messages.length > 0)); });
    return () => { alive = false; };
  }, [issues, loadDetail, refreshKey]);

  if (issues === undefined || (issues.length > 0 && byIssue === undefined)) return <Loading what="messages" />;
  if (!byIssue || byIssue.length === 0) {
    return (
      <Empty art="stage-follow-up" title="No messages sent yet">
        <p>Every reporter hears from the agent as their bug moves: received, questions, duplicate, not a bug, could not reproduce, solution found, released. Each comment mentions them, so Jira notifies them.</p>
      </Empty>
    );
  }
  return (
    <div className="space-y-3">
      {byIssue.map(({ issue, messages }) => (
        <section key={issue.id} data-triage-messages={issue.id} className={`${CARD} space-y-3`}>
          <header className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-neon-200">{issue.jiraKey}</span>
            <span className="text-[13px] text-gray-200 truncate">{issue.summary}</span>
            <span className="flex-1" />
            {issue.reporter && <span className="text-[12px] text-gray-400">to {issue.reporter}</span>}
          </header>
          <ol className="space-y-2">
            {messages.map((m) => (
              <li key={m.id} data-triage-message={m.template || m.id} className="rounded-[10px] bg-gl-code border border-white/[0.08] p-3 space-y-1">
                <div className="flex items-center gap-2 text-[11px] text-gray-500">
                  <span className="uppercase tracking-wide font-semibold text-ember-300">{TEMPLATE_LABEL[m.template] ?? (m.title || 'Comment')}</span>
                  <span className="flex-1" />
                  <span title={m.at}>{when(m.at)}</span>
                </div>
                <p className="text-[14px] text-gray-100 whitespace-pre-wrap">{m.detail || m.title}</p>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
