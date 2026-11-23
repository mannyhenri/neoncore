/**
 * BUG TRIAGE — the stages, their outcomes, and where each outcome leads (docs/plans/bug-triage.md,
 * "The state machine"). TRANSITIONS is the registry: the engine reads it, the tests iterate it.
 */

export class TriageError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const STAGES = ['intake', 'triage', 'code_check', 'reproduce', 'fix', 'pull_request', 'follow_up'] as const;
export type Stage = (typeof STAGES)[number];

export const ISSUE_STATES = ['queued', 'working', 'waiting_reporter', 'waiting_review', 'handed_over', 'labelled', 'fixed', 'released', 'paused', 'error'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/** The reporter-facing moments (messenger.ts). */
export const MOMENTS = ['received', 'needs_info', 'duplicate', 'not_a_bug', 'not_reproduced', 'solution_found', 'released'] as const;
export type Moment = (typeof MOMENTS)[number];

export interface Transition {
  /** The next stage, or null: the issue is finished with this outcome (or waits where it is). */
  next: Stage | null;
  state: IssueState;
  moment?: Moment;
  labels: string[];
}

/**
 * Every stage's outcomes. `null` next with a terminal state ends the machine; `needs_info` keeps the
 * issue at triage, waiting for the reporter; `merged` keeps it in follow-up, waiting for a release.
 * Never auto-close: duplicate / not-a-bug / works-as-designed only LABEL — a person confirms.
 */
export const TRANSITIONS: { [S in Stage]: Record<string, Transition> } = {
  intake: {
    queued: { next: 'triage', state: 'working', moment: 'received', labels: [] },
  },
  triage: {
    needs_info: { next: null, state: 'waiting_reporter', moment: 'needs_info', labels: ['ai-triaged', 'ai-needs-info'] },
    duplicate: { next: null, state: 'labelled', moment: 'duplicate', labels: ['ai-triaged', 'ai-duplicate'] },
    not_a_bug: { next: null, state: 'labelled', moment: 'not_a_bug', labels: ['ai-triaged', 'ai-not-a-bug'] },
    continue: { next: 'code_check', state: 'working', labels: ['ai-triaged'] },
  },
  code_check: {
    plausible: { next: 'reproduce', state: 'working', labels: [] },
    works_as_designed: { next: null, state: 'labelled', moment: 'not_a_bug', labels: ['ai-works-as-designed'] },
    already_fixed: { next: null, state: 'labelled', labels: ['ai-already-fixed'] },
  },
  reproduce: {
    reproduced: { next: 'fix', state: 'working', labels: ['ai-reproduced'] },
    not_reproduced: { next: null, state: 'handed_over', moment: 'not_reproduced', labels: ['ai-not-reproduced'] },
  },
  fix: {
    fix_ready: { next: 'pull_request', state: 'working', labels: [] },
    too_complex: { next: null, state: 'handed_over', labels: ['ai-handed-over'] },
  },
  pull_request: {
    awaiting_review: { next: 'follow_up', state: 'waiting_review', moment: 'solution_found', labels: ['ai-fix-proposed'] },
  },
  follow_up: {
    merged: { next: null, state: 'fixed', labels: ['ai-fix-merged'] },
    changes_requested: { next: 'fix', state: 'working', labels: [] },
    released: { next: null, state: 'released', moment: 'released', labels: ['ai-fix-released'] },
  },
};

/** The stages a cartridge works (each answers ONLY its own fields — SUBMISSION_FIELDS). */
export const AGENT_STAGES = ['triage', 'code_check', 'reproduce', 'fix'] as const;
export type AgentStage = (typeof AGENT_STAGES)[number];

/** What each stage's submission may contain — anything else is refused (a ticket cannot widen a stage). */
export const SUBMISSION_FIELDS: Record<AgentStage, readonly string[]> = {
  triage: ['classification', 'complete', 'questions', 'duplicateOf', 'reason'],
  code_check: ['verdict', 'files', 'reason', 'intended'],
  reproduce: ['reproduced', 'testFile', 'command', 'tried'],
  fix: ['fixed', 'cause', 'summary', 'handOver'],
};

export interface TriageLimits {
  maxFiles: number; maxLines: number; minutesPerIssue: number; dispatchesPerIssue: number; reviewRounds: number;
}
export const DEFAULT_LIMITS: TriageLimits = { maxFiles: 5, maxLines: 200, minutesPerIssue: 90, dispatchesPerIssue: 8, reviewRounds: 2 };

export const DEFAULT_PROTECTED_PATHS = [
  '**/auth/**', '**/authentication/**', '**/payments/**', '**/billing/**', '**/migrations/**',
  '.github/**', '.circleci/**', '.gitlab-ci.yml', '**/Jenkinsfile', '**/*.tf',
];

export interface TriageSource {
  id: string; name: string; jiraBaseUrl: string;
  authEnv: { email: string; token: string };
  projects: string[]; issueTypes: string[]; repoFor: Record<string, string>;
  reporters: 'internal' | 'external'; transitions: boolean;
  transitionNames: { inProgress?: string; inReview?: string; done?: string };
  protectedPaths: string[]; limits: TriageLimits; testCommand: string;
  pollSeconds: number; webhookSecretEnv: string; triageAgentId: string; codeAgentType: string;
  createIssues: boolean; enabled: boolean; lastPolledAt: string | null; serviceAccountId: string;
  createdAt: string; updatedAt: string;
}

export interface TriageIssue {
  id: string; sourceId: string; origin: 'jira' | 'qa'; issueKey: string; projectKey: string;
  summary: string; description: string; reporterId: string; reporterName: string; jiraCreatedAt: string | null;
  stage: Stage; state: IssueState; outcome: string;
  repoPath: string; worktreePath: string; branch: string; baseBranch: string;
  repro: { testFile?: string; command?: string }; findings: Record<string, unknown>;
  prUrl: string; prMergeCommit: string; reviewRounds: number; heldMessage: string; questionsAt: string | null;
  reopened: boolean; firstCommentAt: string | null; fixedAt: string | null; releasedAt: string | null;
  startedAt: string | null; dispatches: number; agentMinutes: number; lastCheckedAt: string | null;
  createdAt: string; updatedAt: string;
}
