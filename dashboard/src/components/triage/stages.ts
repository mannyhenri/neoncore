/**
 * THE BOARD'S COLUMNS. Seven stage columns (the state machine, docs/plans/bug-triage.md) for the
 * issues still moving, then four columns for where an issue rests: waiting on its reporter,
 * labelled (duplicate / not a bug / works as designed — never closed, a person confirms), handed
 * over to a person, and fixed or released. Every issue is in exactly one column (`columnFor`).
 *
 * Both lists are registries: the tests iterate them, so a stage cannot be added without a column.
 */
import type { TriageArtName } from './art';
import type { TriageIssue, TriageStage } from './types';

export const TRIAGE_STAGES = [
  { key: 'intake', label: 'Intake', art: 'stage-intake', hint: 'Received from Jira, queued for triage' },
  { key: 'triage', label: 'Triage', art: 'stage-triage', hint: 'Complete? A duplicate? A bug at all?' },
  { key: 'code_check', label: 'Code check', art: 'stage-code-check', hint: 'Can the code do what the report says?' },
  { key: 'reproduce', label: 'Reproduce', art: 'stage-reproduce', hint: 'A failing test, failing twice in a row' },
  { key: 'fix', label: 'Fix', art: 'stage-fix', hint: 'The smallest change that turns it green' },
  { key: 'pull_request', label: 'Pull request', art: 'stage-pr', hint: 'Opened for review — never merged here' },
  { key: 'follow_up', label: 'Follow-up', art: 'stage-follow-up', hint: 'Watching the PR until it is merged and released' },
] as const satisfies readonly { key: Exclude<TriageStage, 'done'>; label: string; art: TriageArtName; hint: string }[];

export const TRIAGE_REST_COLUMNS = [
  { key: 'waiting_reporter', label: 'Waiting on reporter', hint: 'Asked for more information; resumes when they answer' },
  { key: 'labelled', label: 'Labelled', hint: 'Duplicate, not a bug, or works as designed — a person confirms' },
  { key: 'handed_over', label: 'Handed over', hint: 'Stopped where it could not go on with confidence' },
  { key: 'resolved', label: 'Fixed / released', hint: 'Merged, or live' },
] as const;

export type TriageColumnKey = (typeof TRIAGE_STAGES)[number]['key'] | (typeof TRIAGE_REST_COLUMNS)[number]['key'];
export const TRIAGE_COLUMN_KEYS: readonly TriageColumnKey[] = [...TRIAGE_STAGES.map((s) => s.key), ...TRIAGE_REST_COLUMNS.map((c) => c.key)];

export const stageLabel = (stage: string) =>
  TRIAGE_STAGES.find((s) => s.key === stage)?.label ?? (stage === 'done' ? 'Done' : stage.replace(/_/g, ' '));

/** The one column an issue sits in. */
export function columnFor(issue: Pick<TriageIssue, 'stage' | 'state'>): TriageColumnKey {
  switch (issue.state) {
    case 'waiting_reporter': return 'waiting_reporter';
    case 'labelled': return 'labelled';
    case 'handed_over': return 'handed_over';
    case 'fixed': case 'released': return 'resolved';
    default:
      if (issue.stage === 'done') return 'resolved';
      return (TRIAGE_STAGES.some((s) => s.key === issue.stage) ? issue.stage : 'intake') as TriageColumnKey;
  }
}

/** The words for a state, as a pill shows them. */
export const STATE_LABEL: Record<string, string> = {
  queued: 'Queued', working: 'Working', waiting_reporter: 'Waiting on reporter', waiting_review: 'Waiting for review',
  handed_over: 'Handed over', labelled: 'Labelled', fixed: 'Fixed', released: 'Released', paused: 'Paused', error: 'Error',
};
