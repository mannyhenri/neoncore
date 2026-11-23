/**
 * The QA section's records, as the server sends them (docs/plans/qa-section.md is the contract).
 * Everything the server might omit is optional here and defaulted in lib/qaApi.ts, so a field the
 * server adds later, or leaves out, never crashes a tab.
 */

export type QaLocator = { role?: string; name?: string; label?: string; text?: string; placeholder?: string; testId?: string; css?: string };

export type QaAction =
  | { do: 'goto'; path: string }
  | { do: 'click'; target: QaLocator }
  | { do: 'fill'; target: QaLocator; value?: string; valueEnv?: string }
  | { do: 'select'; target: QaLocator; option: string }
  | { do: 'check'; target: QaLocator; checked: boolean }
  | { do: 'press'; key: string }
  | { do: 'wait'; ms: number }
  | { do: 'expect'; kind: 'visible' | 'hidden' | 'text' | 'url' | 'value' | 'count'; target?: QaLocator; equals?: string | number; contains?: string };

/** A role's login, as the NAMES of the environment variables that hold it — never the values. */
export interface QaCredentialEnv { user: string; pass: string }

export interface QaTarget {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  allowHosts: string[];
  denyActions: string[];
  credentialsEnv: Record<string, QaCredentialEnv>;
  productionAllowed: boolean;
  budgets: { steps: number; minutes: number };
  /** The cartridge that does this target's AI work (writing actions, repairs, exploring). */
  agentId: string;
  /** The recorder's own key for this target (server lib/qa/recorder.ts) — never the fleet token. */
  recorderKey?: string;
}

export type QaTestSource = 'manual' | 'explorer' | 'recorder' | 'feature';
export const QA_TEST_SOURCES: readonly QaTestSource[] = ['manual', 'explorer', 'recorder', 'feature'];

/** QA per feature (server lib/qa/feature-link.ts): a feature's criteria are its test, run by itself. */
export type QaCriterionStatus = 'passed' | 'failed' | 'running' | 'not-run';
export type QaFeatureState = 'no-target' | 'no-criteria' | 'waiting-for-build' | 'not-run' | 'running' | 'passed' | 'failed' | 'error';
export interface QaFeature {
  goalId: string; name: string; phase: string; state: QaFeatureState; note: string;
  criteria: { id: string; text: string; expect: string; status: QaCriterionStatus; error: string; screenshot: string }[];
  passed: number; total: number; runId: string; runAt: string; repaired: boolean; reportUrl: string;
}
export interface QaProjectFeatures {
  projectId: string; name: string; color: string;
  target: { id: string; name: string; baseUrl: string; hasCartridge: boolean } | null;
  features: QaFeature[]; passed: number; total: number; featuresPassing: number;
}

export interface QaTest {
  id: string;
  targetId: string;
  name: string;
  sentences: string[];
  source: QaTestSource;
  journeySig?: string;
  /** The cached actions, one list per sentence — null until a cartridge has written them. */
  cache: QaAction[][] | null;
  createdAt?: string;
}

export type QaRunKind = 'run' | 'explore' | 'generate';
// The server's run statuses (server/src/lib/qa): `waiting` = a request is with the cartridge;
// `completed` = an exploration or a generation finished (they have no pass/fail).
export type QaRunStatus = 'queued' | 'dispatched' | 'running' | 'waiting' | 'passed' | 'passed_with_repair' | 'failed' | 'completed' | 'error';
export const QA_RUN_STATUSES: readonly QaRunStatus[] = ['queued', 'dispatched', 'running', 'waiting', 'passed', 'passed_with_repair', 'failed', 'completed', 'error'];

export interface QaRun {
  id: string;
  targetId: string;
  kind: QaRunKind;
  testIds: string[];
  status: QaRunStatus;
  aiCalls: number;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  goal?: string;
}

export interface QaStep { index: number; sentence: string; status: 'passed' | 'failed' | 'skipped'; error?: string; screenshot?: string }

export interface QaEvidence {
  screenshots: string[];
  trace?: string;
  console: string[];
  network: { url: string; status: number; method: string }[];
}

export interface QaResult {
  runId: string;
  testId: string;
  testName?: string;
  status: string;
  failedStep?: number;
  error?: string;
  repaired: boolean;
  steps: QaStep[];
  evidence: QaEvidence;
}

export type QaSeverity = 'critical' | 'high' | 'medium' | 'low';
export const QA_SEVERITIES: readonly QaSeverity[] = ['critical', 'high', 'medium', 'low'];

export interface QaFinding {
  id: string;
  runId: string;
  targetId: string;
  signature: string;
  severity: QaSeverity;
  kind: string;
  title: string;
  detail: string;
  page: string;
  steps: string[];
  screenshot?: string;
  sentences: string[];
  reproTestId?: string;
  status: 'open' | 'dismissed';
  seenCount: number;
}

export interface QaRepair {
  id: string;
  runId: string;
  testId: string;
  testName?: string;
  stepIndex: number;
  sentence: string;
  before: QaAction[];
  after: QaAction[];
  status: 'pending' | 'accepted' | 'rejected';
  createdAt?: string;
}

export interface QaRunDetail extends QaRun {
  results: QaResult[];
  repairs: QaRepair[];
  findings: QaFinding[];
}

export interface QaJourney {
  sig: string;
  steps: string[];
  count: number;
  covered: boolean;
  testId?: string;
}

export interface QaJourneys {
  journeys: QaJourney[];
  coverage: { covered: number; total: number };
  sessions: number;
}

/** Socket payloads: the record itself, or at least its id and target. */
export interface QaSocketEvent { id?: string; targetId?: string; runId?: string }
