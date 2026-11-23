/**
 * THE SCOPE'S MEASURES OF SUCCESS (§10), from the issues and their audit log.
 */
import db from '../../db.js';
import { listIssues } from './store.js';

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const minutesBetween = (a: string | null, b: string | null) => (a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 60_000) : null);

export interface TriageMetrics {
  issues: number;
  /** Share of issues that reached an outcome with no person stepping in (no hand-over, no human event). */
  triagedWithoutHumans: number | null;
  /** Share of the agent's merged PRs that needed no review round. */
  mergedWithoutRework: number | null;
  /** Share of "not a bug" / duplicate / works-as-designed labels a person reopened. */
  falseNotABug: number | null;
  /** Minutes from the report to the first comment, and to the fix released. */
  minutesToFirstResponse: number | null;
  minutesToRelease: number | null;
  /** Agent minutes per issue (the cost proxy: what the cartridges spent). */
  agentMinutesPerIssue: number | null;
  byState: Record<string, number>;
}

export function triageMetrics(sourceId?: string): TriageMetrics {
  const issues = listIssues({ sourceId });
  const humanIds = new Set((db.prepare(`SELECT DISTINCT issue_id FROM triage_events WHERE kind = 'human'`).all() as { issue_id: string }[]).map((r) => r.issue_id));
  const decided = issues.filter((i) => i.state !== 'queued' && i.state !== 'working' && i.outcome);
  const merged = issues.filter((i) => i.fixedAt);
  const labelled = issues.filter((i) => ['duplicate', 'not_a_bug', 'works_as_designed'].includes(i.outcome) || i.reopened);
  const byState: Record<string, number> = {};
  for (const i of issues) byState[i.state] = (byState[i.state] ?? 0) + 1;
  const reported = (i: (typeof issues)[number]) => i.jiraCreatedAt ?? i.createdAt;
  return {
    issues: issues.length,
    triagedWithoutHumans: decided.length ? decided.filter((i) => i.state !== 'handed_over' && !humanIds.has(i.id)).length / decided.length : null,
    mergedWithoutRework: merged.length ? merged.filter((i) => i.reviewRounds === 0).length / merged.length : null,
    falseNotABug: labelled.length ? labelled.filter((i) => i.reopened).length / labelled.length : null,
    minutesToFirstResponse: avg(issues.map((i) => minutesBetween(reported(i), i.firstCommentAt)).filter((x): x is number => x !== null)),
    minutesToRelease: avg(issues.map((i) => minutesBetween(reported(i), i.releasedAt)).filter((x): x is number => x !== null)),
    agentMinutesPerIssue: avg(issues.filter((i) => i.dispatches > 0).map((i) => i.agentMinutes)),
    byState,
  };
}
