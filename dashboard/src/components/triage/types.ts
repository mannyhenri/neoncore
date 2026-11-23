/**
 * THE TRIAGE SECTION'S RECORDS — the shapes of docs/plans/bug-triage.md, as the dashboard reads
 * them. lib/triageApi.ts normalises every response into these, so a field the server leaves out is
 * its empty value here, never `undefined` in the middle of a render.
 */

/** The state machine's stages, in order (one per issue). `done` ends it. */
export type TriageStage = 'intake' | 'triage' | 'code_check' | 'reproduce' | 'fix' | 'pull_request' | 'follow_up' | 'done';

/** Where an issue stands right now (`triage_issues.state`). */
export type TriageIssueState =
  | 'queued' | 'working' | 'waiting_reporter' | 'waiting_review' | 'handed_over'
  | 'labelled' | 'fixed' | 'released' | 'paused' | 'error';
export const TRIAGE_ISSUE_STATES: readonly TriageIssueState[] = [
  'queued', 'working', 'waiting_reporter', 'waiting_review', 'handed_over', 'labelled', 'fixed', 'released', 'paused', 'error',
];

/** The limits a source puts on each issue (the scope's guardrails 4 and 6). */
export interface TriageLimits {
  maxFiles: number;
  maxLines: number;
  minutesPerIssue: number;
  dispatchesPerIssue: number;
  reviewRounds: number;
}

/**
 * A SOURCE: a Jira site, its projects and where their code lives. The Jira login is the NAMES of
 * environment variables (JIRA_EMAIL, JIRA_API_TOKEN) — never the values.
 */
export interface TriageSource {
  id: string;
  name: string;
  jiraBaseUrl: string;
  authEnv: { email: string; token: string };
  projects: string[];
  issueTypes: string[];
  /** Jira project key → the repository path its bugs are fixed in. */
  repoFor: Record<string, string>;
  /** `external` holds the "solution found" message until a person approves the PR. */
  reporters: 'internal' | 'external';
  /** Whether the agent may move an issue's status. Off: it only comments and labels. */
  transitions: boolean;
  protectedPaths: string[];
  limits: TriageLimits;
  pollSeconds: number;
  /** The NAME of the env var holding the webhook's HMAC secret. */
  webhookSecretEnv: string;
  /** The cartridge that does the cheap triage work. */
  triageAgentId: string;
  /** The engine launched per issue for code work. */
  codeAgentType: string;
}

export interface TriageIssue {
  id: string;
  sourceId: string;
  jiraKey: string;
  jiraUrl: string;
  summary: string;
  reporter: string;
  stage: TriageStage;
  state: TriageIssueState;
  /** The last stage's outcome (plausible, duplicate, fix_ready, …). */
  outcome: string;
  labels: string[];
  prUrl: string;
  /** When the reporter filed it. */
  reportedAt: string;
  updatedAt: string;
  firstResponseAt: string;
  agentMinutes: number;
  dispatches: number;
}

/** One line of the audit trail. */
export type TriageEventKind = 'stage' | 'decision' | 'dispatch' | 'message' | 'verify' | 'guardrail' | 'error' | 'note';
export const TRIAGE_EVENT_KINDS: readonly TriageEventKind[] = ['stage', 'decision', 'dispatch', 'message', 'verify', 'guardrail', 'error', 'note'];

export interface TriageEvent {
  id: string;
  issueId: string;
  at: string;
  stage: TriageStage | '';
  kind: TriageEventKind;
  title: string;
  reason: string;
  detail: string;
  /** A verification run: did it pass? */
  ok?: boolean;
  /** A reporter message: which template (received, needs_info, …). */
  template: string;
  agentMinutes: number;
}

export interface TriageRequest {
  id: string;
  kind: string;
  status: string;
  agentId: string;
  createdAt: string;
  completedAt: string;
  error: string;
}

export interface TriageIssueDetail extends TriageIssue {
  events: TriageEvent[];
  requests: TriageRequest[];
}

export interface TriageSettings {
  paused: boolean;
  dailyDispatchCap: number;
  /** Dispatches used today, when the server reports it. */
  dispatchesToday: number;
}

/** The scope's §10 measures. A share is 0–1; `null` = not enough data yet. */
export interface TriageMetrics {
  issues: number;
  triagedNoHuman: number | null;
  prsOpened: number;
  mergedWithoutRework: number | null;
  falseNotABug: number | null;
  firstResponseMinutes: number | null;
  fixReleasedHours: number | null;
  agentMinutesPerIssue: number | null;
}

/** Socket payloads: the record itself, or at least its ids. */
export interface TriageSocketEvent { id?: string; issueId?: string; sourceId?: string }
