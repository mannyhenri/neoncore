export type AgentMode = 'manual' | 'trust' | 'plan';
export type AgentType = 'claude' | 'codex';
/**
 * The engines a person can CHOOSE — every engine picker in the web and phone apps offers these.
 */
export const SELECTABLE_ENGINES = ['claude', 'codex'] as const satisfies readonly AgentType[];
export const ENGINE_NAME: Record<AgentType, string> = { claude: 'Claude', codex: 'Codex' };

/** A directory a machine runner is allowed to launch a cartridge in. */
export interface MachineRepo {
  path: string;
  name: string;
}

/** A machine running the runner daemon — a remote launch target. */
export interface Machine {
  id: string;
  hostname: string;
  platform: string;
  arch: string;
  repos: MachineRepo[];
  status: 'online' | 'offline';
  lastSeen: string;
}

export interface Agent {
  /**
   * Which server this agent was fetched from. '' is the server that served the app;
   * undefined means it was never stamped (a single-server code path).
   *
   * Ids are unique per DATABASE, not across the fleet, so this is what makes a write
   * addressable once more than one server is in the grid.
   */
  origin?: string;
  /** Display name of that server, for the grid badge. */
  originName?: string;
  id: string;
  name: string;
  machine: string;
  repoPath: string;
  repoName: string;
  branch: string;
  currentTask: string;
  status: 'working' | 'idle' | 'waiting' | 'offline';
  trustMode: boolean;
  plansIncluded: boolean;
  mode: AgentMode;
  agentType: AgentType;
  lastSeen: string;
  sessionId: string;
  lastMessage: string;
  pendingQuestion: string;
  /**
   * Ordinary cartridge recovery state. Workflow recovery is tracked per step;
   * these fields support ad hoc terminal sessions that shut down mid-task.
   */
  recoveryStatus: '' | 'interrupted' | 'recovered' | 'recovery_failed' | 'dismissed';
  interruptedAt: string;
  activeObjective: string;
  /**
   * Work-standard gate state (docs/WORK-STANDARD.md). 'needs_review' = the agent stopped
   * without filing a completion report, so the task is probably half-done.
   *
   * Optional on purpose: a federated peer running an older server build will not send this
   * field at all, and a missing field must read as "fine", not as a type error.
   */
  standardState?: '' | 'needs_review';
  /**
   * Which model this cartridge runs, as the capability router keys on it. Reported by
   * the engine in its trouble-signal payload, NOT at registration — the relay registers
   * every cartridge and does not know the model.
   */
  model?: string;
  /**
   * When the user put this cartridge away ('' = visible). Orthogonal to `status`: a
   * dismissed agent is often still alive and working. Any activity from the session
   * clears it, so it comes back the moment it's used again.
   */
  dismissedAt: string;
}

export interface Activity {
  id: string;
  agentId: string;
  eventType: string;
  toolName: string;
  toolInput: string;
  toolResult: string;
  timestamp: string;
}

export interface PermissionRequest {
  id: string;
  agentId: string;
  toolName: string;
  toolInput: string;
  description: string;
  status: 'pending' | 'allowed' | 'denied' | 'timeout';
  createdAt: string;
  decidedAt: string | null;
  response: string; // JSON string — answers for AskUserQuestion, feedback for ExitPlanMode
}

/**
 * Every way a dispatch can leave the server. `delivered` alone cannot tell a
 * relay websocket from an addressed inbox socket from a keystroke into whatever
 * window was frontmost — and for `inbox-socket`, which resolves asynchronously,
 * `delivered: false` means "handed over, answer pending" rather than "nothing
 * was listening". Only the transport name separates those.
 */
export type DeliveryTransport =
  | 'primary-socket'
  | 'agent-room'
  | 'inbox-socket'
  | 'no-channel';

export interface Command {
  id: string;
  agentId: string;
  text: string;
  source: 'dashboard';
  status: 'pending' | 'delivered' | 'failed';
  createdAt: string;
  deliveredAt: string | null;
  /**
   * Whether it reached a live channel at dispatch time. Not persisted — the
   * server answers it once, in the send response. `false` alongside
   * `transport: 'inbox-socket'` means "handed over, answer pending", which is a
   * different thing from `false` alongside `'no-channel'`.
   */
  delivered?: boolean;
  /** Which transport carried it, when the server reports one. */
  transport?: DeliveryTransport;
}

/** A cartridge's full final answer (server lib/final-answer.ts). `complete` is false while its turn still runs. */
export interface FinalAnswer { text: string; complete: boolean; sessionId: string; at: string }

/** A running or paused feature, as the world map draws it (server lib/active-features.ts). */
export interface ActiveFeature {
  pilotId: string;
  goalId: string;
  projectId: string;
  name: string;
  phase: string;
  stage: { position: number; total: number; title: string } | null;
  /** Why it waits on a person; '' when it does not. */
  needsYou: string;
  agentIds: string[];
  /** For a feature on its own branch: each worktree and the repo it is a worktree of. */
  worktrees: { worktreePath: string; repoPath: string }[];
  branch: string;
}

/** A feature that runs on its own branch (server lib/feature-workspace.ts). */
export interface FeatureWorkspace {
  branch: string;
  repos: {
    repoPath: string;
    worktreePath: string;
    agentType: string;
    base: string;
    pr: { url: string; number: number; state: string } | null;
    error: string;
    removed: boolean;
  }[];
  prsAt: string | null;
}

/** A file attached to a feature (server lib/feature-files.ts). */
export interface FeatureFile { id: string; goalId: string; name: string; mimeType: string; size: number; createdAt: string }

export interface CommandAttachmentInput {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

export interface StuckAlert {
  agentId: string;
  pattern: string;
  severity: 'high' | 'medium';
  suggestion: string;
  detectedAt: string;
}

export interface AgentMemory {
  id: string;
  agentId: string;
  project: string;
  category: string;
  content: string;
  source: 'auto' | 'manual';
  active: boolean;
  createdAt: string;
}

// Session journal types
export interface Session {
  id: string;
  agentId: string;
  sessionId: string;
  project: string;
  repoPath: string;
  machine: string;
  branch: string;
  startedAt: string;
  endedAt: string | null;
  status: 'active' | 'ended' | 'summarized';
  activityCount: number;
  summary: string;
}

export interface ProjectKnowledge {
  id: string;
  project: string;
  filename: string;
  content: string;
  updatedAt: string;
}

// Workflow types
export type WorkflowPhase = 'research' | 'coding' | 'review';
export type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type PlayerRole = 'research' | 'coding' | 'review';
export type PlayerType = 'vscode-agent';

export interface WorkflowPlayer {
  id: string;
  name: string;
  playerType: PlayerType;
  modelId?: string;
  roles: PlayerRole[];
  agentId?: string;
}

export interface PhaseResult {
  playerId: string;
  playerName: string;
  phase: WorkflowPhase;
  round: number;
  output: string;
  completedAt: string;
  error?: string;
  fallbackModel?: string;
}

export interface WorkflowPhaseState {
  phase: WorkflowPhase;
  status: WorkflowStatus;
  currentRound: number;
  startedAt: string;
  completedAt: string;
  playerResults: PhaseResult[];
}

export interface StepSummary {
  total: number;
  completed: number;
  running: number;
  failed: number;
  pending: number;
  /** Brief list of step names for at-a-glance identification */
  stepNames?: string[];
  /** Deduplicated list of project/repo names for assigned executor agents */
  projects?: string[];
}

export interface Workflow {
  id: string;
  name: string;
  jiraTaskId: string;
  /** Short human subject for the run, derived from `initialContext` at write time. */
  contextLabel: string;
  description: string;
  players: WorkflowPlayer[];
  phases: WorkflowPhaseState[];
  status: WorkflowStatus;
  currentPhase: number;
  iteration: number;
  maxIterations: number;
  sharedContext: string;
  initialContext: string;
  /** Set when the run cannot advance without a person. Derived from step state on every read. */
  needsAttention?: {
    reason: AttentionReason;
    stepId: string;
    stepName: string;
    detail: string;
  } | null;
  /**
   * Where a task-list run has got to — done/total (from its latest coverage check, or estimated
   * from dispatch claims) and its progress document. Null for a run that tracks no task list.
   */
  progress?: {
    done: number;
    total: number | null;
    blocked: number;
    basis: 'coverage' | 'claims';
    docPath: string;
    updatedAt: string;
  } | null;
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
  error: string;
  templateId: string | null;
  runNumber: number;
  stepSummary?: StepSummary;
}

export interface VirtualCartridge {
  id: string;
  name: string;
  directoryPath: string;
  iconIndex: number;
  color: string;
  createdAt: string;
  updatedAt: string;
}

// Command templates
export interface CommandTemplate {
  id: string;
  name: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

// Goal Cascade types
/**
 * Why a run (or a goal) is waiting on a person, ordered most urgent first on the server.
 * Named once here so the run badge and the goal rollup cannot describe the same state
 * with two different vocabularies.
 */
export type AttentionReason = 'failed' | 'interrupted' | 'decision' | 'tasks-outstanding' | 'agent-waiting' | 'manual-advance';

/** Derived completion for a goal. See server/src/lib/goal-progress.ts. */
export interface GoalProgress {
  completedSteps: number;
  totalSteps: number;
  /**
   * null means there is NOTHING TO MEASURE — no projects, no runs, or only cancelled ones.
   * It is not 0. Rendering it as 0% claims work started and got nowhere, which is the exact
   * "empty looks identical to populated" failure the Goals epic exists to fix.
   */
  fraction: number | null;
  runsCounted: number;
}

/** The worst blockage across a goal's runs. See server/src/lib/goal-health.ts. */
export interface GoalHealth {
  reason: AttentionReason;
  runId: string;
  runName: string;
  stepName: string;
  detail: string;
  /** How many of the goal's runs need attention — one is a task, several is a stalled goal. */
  blockedRuns: number;
}

/** One field the authoring assistant can propose. Mirrors DRAFTABLE_FIELDS on the server. */
export interface DraftableField {
  key: string;
  label: string;
  guidance: string;
  kind: 'text' | 'keyResults';
}

/**
 * A PROPOSAL for a goal's intent, produced by a cartridge. Never goal state.
 *
 * `appliedAt` is null until a person accepts specific fields — which is the whole safety
 * property, since intent reaches working agents at dispatch through the goal brief.
 */
export interface GoalDraft {
  id: string;
  goalId: string | null;
  seed: string;
  status: 'pending' | 'ready' | 'failed';
  agentId: string;
  source: string;
  fields: Record<string, string | { metric: string; baseline?: string; target?: string; measure?: string }[]>;
  error: string;
  createdAt: string;
  completedAt: string | null;
  appliedAt: string | null;
  appliedFields: string[];
}

/** One task in a proposed decomposition. Not a real task until accepted. */
export interface ProposedTask {
  key: string;
  title: string;
  prompt: string;
  size: 'S' | 'M' | 'L';
  /** Keys of tasks in the same proposal that must finish first. */
  dependsOn: string[];
  /**
   * A workflow template to RUN for this item, by name, or '' for a plain task. Accepting a
   * template-backed item launches the whole workflow against the project.
   */
  template: string;
}

export interface ProposedProject {
  key: string;
  name: string;
  description: string;
  primaryRepo: string;
  tasks: ProposedTask[];
}

/**
 * A PROPOSED breakdown of a goal into projects and tasks.
 *
 * `acceptedAt` is null until a person picks items; nothing exists in `projects` or `tasks`
 * before that. `notes` records what validation dropped — a silently truncated plan presented
 * as the model's actual output would be the worst possible lie in a review surface.
 */
export interface GoalDecomposition {
  id: string;
  goalId: string;
  seed: string;
  status: 'pending' | 'ready' | 'failed';
  agentId: string;
  proposal: { projects: ProposedProject[] };
  notes: string[];
  error: string;
  createdAt: string;
  completedAt: string | null;
  acceptedAt: string | null;
  createdProjects: string[];
  createdTasks: string[];
}

/** What the server's desktop-notification channel can do on its machine (lib/channels/desktop.ts). */
export interface DesktopNotificationStatus {
  mode: 'action' | 'all' | 'off';
  available: boolean;
  /** The OS tool used: terminal-notifier, osascript, notify-send or powershell. */
  notifier: string;
  /** Why it is unavailable, when it is. */
  reason: string;
  /** NEONCORE_DESKTOP_NOTIFY is set on the server and wins over the stored mode. */
  envOverride?: boolean;
}

// ── Goal Pilot (server/src/lib/goal-pilot.ts) ────────────────────────────────────

export interface PilotChoiceOption { value: string; label: string; hint: string }

/** One of the general questions the guided goal form asks. */
export interface PilotIntakeQuestion {
  key: string;
  label: string;
  help: string;
  kind: 'text' | 'textarea' | 'choice' | 'date' | 'number';
  required: boolean;
  placeholder?: string;
  options?: PilotChoiceOption[];
}

export interface GoalPilotMeta {
  intakeQuestions: PilotIntakeQuestion[];
  involvementLevels: PilotChoiceOption[];
  workTypes: PilotChoiceOption[];
  briefFields: { key: keyof PilotBrief; label: string; guidance: string; onGoal: boolean }[];
  engines: string[];
  limits: { maxScopeRounds: number; maxQuestionsPerRound: number; maxStages: number; maxCriteria: number };
  templates: { name: string; description: string }[];
  /** How a criterion is checked: an automated test written before the work, or a checklist item. */
  verifyMethods: { value: VerifyMethod; label: string; hint: string }[];
  /** The method each work type's criteria default to. */
  defaultVerify: Record<string, VerifyMethod>;
  /** Stage keys of the contract's own stages, assignable to a repo at staffing. */
  contractStageKeys: { acceptance: string; review: string };
  /** Workflows worked by several cartridges together (Confer): staffed with two or more repos. */
  teamTemplates?: string[];
}

// ── the acceptance contract (server/src/lib/acceptance-contract.ts) ───────────────

export type VerifyMethod = 'test' | 'checklist';

/** A numbered acceptance criterion — frozen when the plan is accepted. */
export interface PilotCriterion {
  id: string;
  text: string;
  /** EXACTLY what is expected: inputs → result. */
  expect: string;
  verify: VerifyMethod;
}

export interface ContractTestFile { path: string; sha256: string; bytes: number; content: string }
export interface ContractTest { criterionId: string; command: string; files: ContractTestFile[] }

export interface ContractCheckResult {
  criterionId: string; command: string; exitCode: number | null; passed: boolean; timedOut: boolean;
  output: string; durationMs: number; at: string;
}

export interface ContractVerification {
  id: string; stageId: string; stagePosition: number; stageTitle: string; at: string; version: number;
  status: 'passed' | 'partial' | 'failed' | 'tampered' | 'error';
  passing: number; total: number; filesChecked: number; results: ContractCheckResult[];
  tampered: { path: string; criterionId: string; expected: string; actual: string | null }[];
  error: string;
}

export interface ContractAmendment {
  at: string;
  kind: 'changes-requested' | 'unlock' | 'restore' | 'accept-change' | 'waive';
  criterionIds: string[];
  reason: string;
  before?: { text: string; expect: string };
  after?: { text: string; expect: string };
  paths?: string[];
  version: number;
}

export type CriterionOutcome = 'pass' | 'fail' | 'not-run' | 'met' | 'not-met' | 'unconfirmed' | 'not-checked' | 'waived';

/** A criterion with its current evidence. */
export interface CriterionState extends PilotCriterion {
  outcome: CriterionOutcome;
  test: { command: string; files: string[] } | null;
  last: ContractCheckResult | null;
  lastStage: string;
  baseline: ContractCheckResult | null;
  verdict: { criterionId: string; verdict: 'met' | 'not-met'; evidence: string } | null;
  confirmation: { accepted: boolean; note: string; at: string } | null;
  reviewer: string;
}

/** The goal's acceptance contract as the dashboard reads it. */
export interface AcceptanceContract {
  id: string;
  pilotId: string;
  goalId: string;
  repoPath: string;
  agentType: string;
  status: 'drafting' | 'review' | 'locked' | 'waived';
  version: number;
  criteria: PilotCriterion[];
  criteriaHash: string;
  draftTests: ContractTest[];
  tests: ContractTest[];
  testNotes: string;
  feedback: string;
  amending: { criterionIds: string[]; reason: string } | null;
  approval: { requestedAt: string; confirmPassing: boolean; blocked: string } | null;
  baseline: { testsHash: string; at: string; results: ContractCheckResult[]; error: string } | null;
  verifications: ContractVerification[];
  checklist: {
    requestId: string; reviewerAgentId: string; reviewerName: string; at: string; independent: boolean;
    verdicts: { criterionId: string; verdict: 'met' | 'not-met'; evidence: string }[];
    confirmations: Record<string, { accepted: boolean; note: string; at: string }>;
    confirmedAt: string | null;
  } | null;
  amendments: ContractAmendment[];
  tamper: { stageId: string; verificationId: string; files: { path: string; criterionId: string; expected: string; actual: string | null }[] } | null;
  requestId: string;
  waitReason: string;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Resolved evidence per criterion, and what is running right now. */
  states: CriterionState[];
  passing: number;
  total: number;
  activity: { kind: 'baseline' | 'verify' | 'restore'; done: number; total: number; stageId: string } | null;
  baselineFresh: boolean;
  request: { status: string; error: string; agentId: string } | null;
}

/** A question the planner asked. `suggested` is what "let the agents decide" resolves to. */
export interface PilotQuestion {
  id: string;
  text: string;
  why: string;
  kind: 'choice' | 'multi' | 'text' | 'boolean';
  options: string[];
  suggested: string;
  required: boolean;
}

export interface PilotAnswer { value: string | string[]; delegated?: boolean }

export interface PilotRound {
  round: number;
  requestId: string;
  message: string;
  questions: PilotQuestion[];
  answers: Record<string, PilotAnswer>;
  askedAt: string;
  answeredAt: string | null;
}

export interface PilotBrief {
  slug: string;
  summary: string;
  successMetric: string;
  inScope: string;
  acceptanceCriteria: string;
  invariants: string;
  outOfScope: string;
  rabbitHoles: string;
  assumptions: string;
}

export interface PilotProposedStage {
  key: string;
  template: string;
  title: string;
  why: string;
  focus: string;
  optional: boolean;
  /** Steps of the workflow this stage leaves out — not its job on this feature. */
  skipSteps?: string[];
}

export interface PilotRequest {
  id: string;
  pilotId: string;
  kind: 'scope' | 'pipeline' | 'report' | 'tests' | 'review';
  round: number;
  status: 'pending' | 'ready' | 'failed' | 'superseded';
  agentId: string;
  notes: string[];
  error: string;
  queued: boolean;
  createdAt: string;
  completedAt: string | null;
}

export type PilotPhase =
  | 'scoping' | 'clarifying' | 'planning' | 'proposed' | 'staffing'
  | 'running' | 'paused' | 'completed' | 'cancelled';

export interface PilotStage {
  id: string;
  position: number;
  /** workflow | acceptance (write the acceptance tests) | review (independent checklist review). */
  kind: 'workflow' | 'acceptance' | 'review';
  key: string;
  templateId: string;
  template: string;
  title: string;
  why: string;
  focus: string;
  repoPath: string;
  agentType: string;
  /** A stage worked by several cartridges together (Confer): every participant. Empty = one cartridge. */
  participants?: { repoPath: string; agentType: string }[];
  /** Steps of the workflow this stage leaves out, as planned. */
  skipSteps?: string[];
  projectId: string;
  runId: string;
  agentId: string;
  status: 'pending' | 'waiting' | 'running' | 'review' | 'verifying' | 'completed' | 'failed' | 'skipped' | 'cancelled';
  waitReason: string;
  resultSummary: string;
  attempts: number;
  /** After a workflow stage: NeonCore's check of its work against the locked tests. */
  verifyState: '' | 'pending' | 'tampered' | 'error' | 'done';
  requestId: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Live: the run's own status, its step progress, and whether it is waiting on a person. */
  runStatus: string;
  progress: { completed: number; total: number } | null;
  attention: { reason: string; stepId: string; stepName: string; detail: string } | null;
  agentName: string;
}

/**
 * A goal run as a managed pipeline: intake → scoping questions → brief → proposed workflows →
 * accepted plan → repos/cartridges → stages run in order.
 */
export interface GoalPilot {
  id: string;
  goalId: string;
  goalName: string;
  /** The project the feature belongs to ('' for an old-style goal not filed under one). */
  projectId?: string;
  projectName?: string;
  phase: PilotPhase;
  plannerAgentId: string;
  plannerName: string;
  intake: Record<string, string>;
  rounds: PilotRound[];
  brief: PilotBrief | null;
  /** The planner's numbered acceptance criteria, proposed with the brief. */
  criteria: PilotCriterion[] | null;
  proposal: { message: string; stages: PilotProposedStage[]; alternatives: { template: string; why: string }[] } | null;
  plan: { brief: PilotBrief; stages: PilotProposedStage[]; criteria?: PilotCriterion[] } | null;
  staffing: { repos: { repoPath: string; agentType: string }[] } | null;
  /** The project's repos this feature involves, chosen when it started ([] = all). */
  featureRepos?: string[];
  /** Its own branch: a worktree + cartridge per repo, and the PRs (server lib/feature-workspace.ts). */
  workspace?: FeatureWorkspace | null;
  involvement: string;
  currentRequestId: string;
  currentRequest: PilotRequest | null;
  requests: PilotRequest[];
  attention: string;
  stages: PilotStage[];
  /** The acceptance contract, once the pipeline has started. */
  acceptance: AcceptanceContract | null;
  createdAt: string;
  updatedAt: string;
  planAcceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Built when the last stage finishes (or on request for a pipeline stopped part-way). */
  report: GoalReport | null;
  reportAt: string | null;
}

/** One stage of a goal report, with its run's own completion report when it filed one. */
export interface GoalReportStage {
  position: number;
  kind?: string;
  title: string;
  template: string;
  repo: string;
  engine: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  minutes: number | null;
  steps: { completed: number; total: number };
  produced: string;
  runId: string;
  runReport: {
    status: string; executiveSummary: string; whatChanged: string[];
    issues: { severity: string; description: string; status: string }[]; nextSteps: string[];
    testsPassed: number | null; testsTotal: number | null;
  } | null;
}

/** What a piloted goal did — server/src/lib/goal-pilot-report.ts. */
export interface GoalReport {
  version: 1;
  generatedAt: string;
  goal: { id: string; name: string; successMetric: string };
  pilotId: string;
  /** With criteria: SUCCESS only when every criterion passes on NeonCore's own evidence. */
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'INCOMPLETE';
  involvement: string;
  startedAt: string | null;
  finishedAt: string | null;
  minutes: number | null;
  costUsd: number;
  outcome: {
    stagesCompleted: number; stagesTotal: number; stagesSkipped: number;
    stepsCompleted: number; stepsTotal: number; testsPassed: number; testsTotal: number; issues: number;
  };
  summary: { text: string; highlights: string[]; followUps: string[]; source: 'planner' | 'compiled' };
  acceptance: GoalReportAcceptance | null;
  brief: PilotBrief | null;
  decisions: { question: string; answer: string; delegated: boolean }[];
  stages: GoalReportStage[];
  learnings: { workflow: string; content: string }[];
  openItems: string[];
  files: { html: string; markdown: string; json: string } | null;
}

export interface GoalReportCriterion {
  id: string; text: string; expect: string; verify: VerifyMethod; outcome: CriterionOutcome;
  command: string; files: string[]; exitCode: number | null; output: string; checkedAt: string | null; checkedAfter: string;
  baseline: { exitCode: number | null; passed: boolean } | null;
  verdict: string; evidence: string; reviewer: string; confirmed: boolean | null; note: string;
}

export interface GoalReportAcceptance {
  version: number; lockedAt: string | null; contractStatus: string; total: number; passing: number;
  criteria: GoalReportCriterion[]; checks: number; testsUnchanged: boolean;
  tamperEvents: { at: string; stage: string; paths: string[]; resolution: 'restored' | 'accepted' | 'open' }[];
  amendments: ContractAmendment[]; reviewIndependent: boolean | null; note: string;
}

/** A repo a pipeline can run in, with the engines NeonCore has seen there. */
export interface PilotCandidateRepo {
  repoPath: string;
  repoName: string;
  machine: string;
  /** Already owned by one of this goal's projects. */
  owned: boolean;
  engines: { agentType: string; agentId: string; status: string; name: string }[];
}

/** One line about a feature's pipeline, for the feature list. See server routes/goals.ts pilotSummary. */
export interface FeaturePilotSummary {
  id: string;
  phase: 'scoping' | 'clarifying' | 'planning' | 'proposed' | 'staffing' | 'running' | 'paused' | 'completed' | 'cancelled';
  attention: string;
  stagesDone: number;
  stagesTotal: number;
  /** A stage is waiting on the person (approve the acceptance tests, confirm verdicts). */
  awaitingReview: boolean;
  /** The planner did not answer its last request. */
  plannerFailed: boolean;
}

export interface Goal {
  id: string;
  /**
   * PROJECT → FEATURES. A goal row is a FEATURE of the project it is filed under; null for an
   * old-style goal that is not filed under one yet. `position` is its place in the project's list.
   */
  projectId?: string | null;
  position?: number;
  /** 'imported' = it already existed when the project was taken on (generated from the codebase — "✦ Generate with AI"). */
  origin?: 'imported' | '';
  /** When it was marked done ('' while it is not). */
  doneAt?: string;
  /** Where the person placed it on the roadmap: '' = automatic, else 'now' | 'next' | 'later'. */
  roadmapLane?: '' | 'now' | 'next' | 'later';
  /** Its capability group on the spec: '<group> · <sub-area>', '<group>', or '' (unsorted). */
  area?: string;
  /** Where the feature's pipeline stands (its latest pilot); null when it was never started. */
  pilot?: FeaturePilotSummary | null;
  name: string;
  description: string;
  successMetric: string;
  /** EARS-form statements — what "done" is judged against. Reaches the agent at dispatch. */
  acceptanceCriteria: string;
  /** Explicitly out of scope. The field that fights agent over-reach. */
  noGos: string;
  rabbitHoles: string;
  invariants: string;
  keyResults: { metric: string; baseline?: string; target?: string; measure?: string }[];
  tokenBudget: number | null;
  budgetUsd: number | null;
  status: 'active' | 'achieved' | 'paused';
  createdAt: string;
  updatedAt: string;
  projectCount?: number;
  /** Cartridges this goal actually reaches. 0 means the brief injects nothing and cost is 0. */
  reach?: number;
  runCount?: number;
  tokensUsed?: number;
  costUsd?: number;
  /** Derived from step statuses across this goal's runs. Absent on writes, present on reads. */
  progress?: GoalProgress;
  /** null when nothing under this goal is waiting on a human. */
  health?: GoalHealth | null;
  /**
   * PM surface (Phase 7). '' means UNSET in every case — an autonomy posture nobody chose must
   * not grant latitude, and a goal with no target date has no schedule rather than being "on time".
   */
  targetDate?: string;
  owner?: string;
  investmentCategory?: string;
  autonomy?: string;
  schedule?: GoalSchedule | null;
}

/** Where a goal stands against its target date. See server/src/lib/goal-pm.ts. */
export interface GoalSchedule {
  targetDate: string;
  daysRemaining: number;
  state: 'overdue' | 'due-soon' | 'on-time' | 'met';
  detail: string;
}

export interface CategorySpend {
  category: string;
  label: string;
  costUsd: number;
  goalCount: number;
}

/** Cross-goal summary. Only rendered above more than one goal — see shouldShowPortfolio. */
export interface PortfolioSummary {
  goalCount: number;
  activeCount: number;
  totalCostUsd: number;
  needsAttentionCount: number;
  overdueCount: number;
  fraction: number | null;
  byCategory: CategorySpend[];
}

export interface Project {
  id: string;
  goalId: string | null;
  goalName?: string;
  name: string;
  description: string;
  primaryRepo: string;
  /** Repos this project owns. Work done in any of them is the project's work — replaces
   *  hanging a project_id on individual tasks, which only counted work someone tagged. */
  cartridges?: string[];
  color: string;
  createdAt: string;
  updatedAt: string;
  runCount?: number;
  tokensUsed?: number;
  costUsd?: number;
  lastRunStatus?: string | null;
  lastRunAt?: string | null;
  activeRunCount?: number;
  /** How the product is built (markdown) — read by the planner when it scopes each feature. */
  architecture?: string;
  /** The project has an architecture page (served at /docs/architecture?format=html, shown in the Architecture tab). */
  hasArchitecturePage?: boolean;
  /** Rewrite docs/product/ in the main repo whenever a feature changes. */
  docsAutoPublish?: boolean;
  /** When docs/product/ was last written ('' = never), and why the last attempt failed. */
  docsPublishedAt?: string;
  docsPublishError?: string;
  /** PROJECT → FEATURES: how many features the project lists, and how far along they are. */
  featureCount?: number;
  /** Features that already existed when the project was taken on (imported) — not counted above. */
  featuresExisting?: number;
  featuresDone?: number;
  featuresActive?: number;
  featuresNeedYou?: number;
}

export interface Heartbeat {
  id: string;
  projectId: string | null;
  templateId: string;
  templateName: string | null;
  agentId: string;
  agentName: string | null;
  /** A scheduled confer: every cartridge that works it. Empty for an ordinary schedule. */
  conferAgentIds?: string[];
  conferMode?: string;
  conferIsolation?: string;
  /**
   * Mirrors SCHEDULE_TYPES (server/src/lib/heartbeat-scheduler.ts), all SIX of them.
   *
   * This union used to read 'hourly' | 'daily' | 'weekly'. The server has grown `once`,
   * `monthly` and `quarterly` since, and a hand-copied union that drifts STRICTER than the
   * server does not fail the build — it quietly removes the cases, so a monthly schedule is
   * not merely unrendered, it is unrepresentable. `dayOfMonth` was missing for the same reason.
   */
  schedule: {
    type: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'quarterly';
    time?: string;
    day?: number;
    dayOfMonth?: number;
  };
  scheduleLabel: string;
  label: string;
  active: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
}

export interface ProjectLearning {
  id: string;
  projectId: string | null;
  workflowId: string;
  workflowName: string;
  content: string;
  tags: string[];
  createdAt: string;
}

// Workflow Step types (V2 canvas workflows)
export type StepExecutorType = 'claude-code' | 'review-gate' | 'deliberation' | 'confer' | 'quality-gate' | 'command' | 'connector' | 'decision';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowStep {
  id: string;
  workflowId: string;
  name: string;
  description: string;
  positionX: number;
  positionY: number;
  executorType: StepExecutorType;
  executorId: string;
  executorConfig: Record<string, unknown>;
  autoAdvance: boolean;
  status: StepStatus;
  result: string;
  error: string;
  dispatchedPrompt: string;
  dependsOn: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  recoveryStatus: string; // '' | 'interrupted' | 'recovering' | 'recovered' | 'recovery_failed'
  interruptedAt: string | null;
  recoveryAttempts: number;
  /**
   * Why this step ran somewhere other than where it was pinned — a capability-routing
   * substitution, or a missing cartridge. Deliberately NOT `error`: the step ran correctly,
   * and the UI paints `error` red, so recording it there makes working behaviour look
   * broken and erodes trust in the routing we want left enabled.
   */
  routingNote: string;
}

// Workflow step execution log
export type StepLogType = 'info' | 'success' | 'error' | 'warn' | 'llm';

export interface WorkflowStepLog {
  workflowId: string;
  stepId: string;
  stepName: string;
  message: string;
  type: StepLogType;
  timestamp: string;
}

// Workflow completion notification (fired by system-notify connector step)
export interface WorkflowNotification {
  id: string;
  workflowId: string;
  workflowName: string;
  title: string;
  body: string;
  projects: string[];
  timestamp: string;
}

// Agent task queue
export type TaskStatus = 'queued' | 'claimed' | 'in_progress' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  title: string;
  prompt: string;
  projectId: string | null;
  status: TaskStatus;
  assignedAgentId: string | null;
  priority: number;
  result: string;
  error: string;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

// Confer (standalone multi-agent collaboration)
export type ConferStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ConferMilestone {
  id: string;
  sessionId: string;
  idx: number;
  key: string;
  name: string;
  /** Which build round this is (1 for every non-repeated milestone). */
  round: number;
  status: 'pending' | 'active' | 'done';
  doneIds: string[];
  dispatchedAt: string | null;
  completedAt: string | null;
}

export type ConferMode = 'collaborate' | 'divide';
export type ConferIsolation = 'shared' | 'worktree';

export interface ConferSession {
  id: string;
  repoName: string;
  repoPath: string;
  task: string;
  /** Short human subject for the confer, derived from `task`. Same rule as a run's label. */
  taskLabel: string;
  participantIds: string[];
  status: ConferStatus;
  currentMilestone: number;
  error: string;
  createdAt: string;
  completedAt: string | null;
  mode: ConferMode;
  /** How many times the build/fix milestone runs (1 = the classic single build). */
  buildRounds: number;
  isolation: ConferIsolation;
  worktrees?: Record<string, { path: string; branch: string }>;
  milestones?: ConferMilestone[];
  /**
   * The run whose step created this confer, or null when it was started on its own.
   *
   * A workflow's confer is already represented by its run, so every list that shows runs and
   * confers together must drop the owned ones or it counts one confer twice. Use
   * `standaloneConfers` (confer-view.ts) rather than reading this field at each surface.
   */
  workflowId?: string | null;
  /** The step that created it, for the same reason. Null when standalone. */
  stepId?: string | null;
}

// Git types
export interface Worktree {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Federation
// ─────────────────────────────────────────────────────────────────────────────

/** A peer server as reported by GET /api/peers. */
export interface Peer {
  url: string;
  serverId: string;
  name: string;
  version: string;
  lastOkAt: string;
  lastError: string;
  consecutiveFailures: number;
  addedAt: string;
  stale: boolean;
}

/** One NeonCore server the client talks to. */
export interface ServerEntry {
  /** Origin, e.g. "http://studio.local:4040". Empty string is the server that served this app. */
  url: string;
  /** Stable id reported by the server. Empty until first contact. */
  serverId: string;
  /** Display label. Falls back to the URL host until the server tells us its name. */
  name: string;
  /**
   * Fleet token for this server. Null while the fleet is permissive.
   *
   * On web this lives in localStorage, which means any script running on the page can
   * read it. That is the accepted trade for a LAN tool with one shared secret; it is not
   * suitable for a token that grants anything beyond this fleet.
   */
  token?: string | null;
  /**
   * False for a server discovered through gossip rather than added by hand. Discovered
   * servers can be hidden without being forgotten — deleting one is pointless when the
   * next gossip tick re-learns it.
   */
  manual?: boolean;
  /** User has hidden this server from the grid without removing it. */
  hidden?: boolean;
}

/**
 * Live connection state for one server.
 *
 * `lastOkAt` is what makes a degraded fleet usable: when a server drops out we keep
 * rendering its last-known-good cartridges rather than blanking them, and mark them
 * stale. A grid that empties itself the moment a laptop sleeps is worse than one that
 * admits it is showing you something slightly old.
 */
export interface ServerStatus {
  url: string;
  serverId: string;
  name: string;
  reachable: boolean;
  /** Set when the failure needs a human — a rejected token, not a sleeping machine. */
  authFailed: boolean;
  lastOkAt: string;
  lastError: string;
  socketConnected: boolean;
}

// ---------------------------------------------------------------------------
// Queue — ordered heterogeneous work that drains unattended
// ---------------------------------------------------------------------------

/**
 * Kinds a queue item can be. Mirrors KIND_IDS in server/src/lib/queue-kinds.ts.
 *
 * This lives in the shared package rather than being copied per client for a reason this
 * repo has paid for four times: every hand-maintained copy of a contract here has drifted
 * (two AgentType copies, two WorkflowStep copies), and mobile/src/types.ts still declared
 * six engines a day after the removal landed. A comment saying "keep in sync" is not a
 * mechanism.
 */
export type QueueKind = 'prompt' | 'workflow' | 'confer';

export type QueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';

export interface QueueItem {
  /** Parked by a human. Still queued, but skipped so the rest of the lane keeps draining. */
  paused?: boolean;
  id: string;
  kind: QueueKind;
  payload: Record<string, unknown>;
  /** Cartridge ids (prompt) or a single repo path (workflow/confer). */
  targets: string[];
  /** Serial execution unit — one cartridge runs one thing at a time. */
  lane: string;
  status: QueueStatus;
  position: number;
  /** Workflow run id / confer session id; '' for a prompt. */
  handle: string;
  result: string;
  /** Why it failed or halted. Surfacing this is the difference between a queue a user
   *  trusts overnight and one they switch off. */
  error: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Consecutive dispatch failures. A blip is retried; an exhausted budget halts the lane. */
  attempts: number;
  /** Consecutive ticks a running item's target has been unreachable. */
  stallTicks: number;
  /** The persisted row could not be deserialized — quarantined, never silently skipped. */
  corrupt: boolean;
  /**
   * What this item IS, in words — "Epic: Task by Task #11 · GRD-3665", not a uuid fragment.
   * Derived by the server on every read from the kind's own describer, so it stays true when the
   * thing it points at is renamed while the item waits in the lane. Absent on the responses that
   * return a bare row (enqueue, cancel), hence optional.
   */
  description?: string;
}

/** A lane can be paused by a human or halted by the runner, and the reason must be visible. */
export interface QueueLane {
  lane: string;
  paused: boolean;
  haltedReason: string;
}

export interface QueueView {
  items: QueueItem[];
  lanes: QueueLane[];
  /**
   * Which kinds this server accepts. Sent by GET /api/queue so a client never has to
   * re-declare the registry — dropping this field from the type is how the portal ended up
   * hardcoding three <option> tags against a server that was already telling it the answer.
   */
  kinds: QueueKind[];
}

/**
 * A run's completion report, as it comes back from the cartridge that produced it.
 *
 * `report` is the verbatim `workflow-report.json` the agent wrote — the HTML it also rendered
 * is derived from this same object, which is why it is stored whole rather than summarised.
 */
export interface WorkflowReport {
  id: string;
  project: string;
  workflowId: string;
  stepId: string;
  workflowName: string;
  runNumber: number;
  status: string;
  createdAt: string;
  report: Record<string, unknown>;
  /**
   * Where the app can OPEN the rendered report, or '' when none was recorded.
   *
   * A server URL, not the file:// path on the cartridge — a browser refuses to follow one of
   * those from an http page, which is how a finished report could sit on disk unreachable.
   */
  htmlUrl?: string;
}

/** One thing the engine saw a task-list run do (server lib/run-progress.ts). */
export interface WorkflowProgressEvent {
  at: string;
  stepName: string;
  /** `task`: a loop dispatch's claim. `coverage`: a coverage check and what the engine did. */
  kind: 'task' | 'coverage';
  taskId: string;
  /** task: DONE | BLOCKED | SKIPPED · coverage: complete | loop-back | held | accepted | continued */
  verdict: string;
  remaining: number | null;
  done: number | null;
  total: number | null;
  detail: string;
}

export interface WorkflowProgress {
  summary: NonNullable<Workflow['progress']> | null;
  events: WorkflowProgressEvent[];
  /** The progress document — its text when the server can read it, else why not. */
  doc: { path: string; content: string | null; unavailable: string } | null;
}

// ── The project as the single place: spec, roadmap, changelog, import (server lib/project-*.ts) ──

export type SpecStatus = 'existing' | 'planned' | 'in-progress' | 'delivered' | 'done' | 'paused';
/** 'documented' = an existing feature whose current behaviour was written up (Generate with AI) but not verified. */
export type SpecAlignment = 'verified' | 'partial' | 'unverified' | 'intent-only' | 'pending' | 'documented';

export interface SpecCriterion {
  id: string;
  text: string;
  expect: string;
  verify: 'test' | 'checklist';
  result: 'met' | 'not-met' | 'not-checked';
  outcome: string;
  evidence: string;
}

export interface SpecFeature {
  id: string;
  name: string;
  slug: string;
  position: number;
  status: SpecStatus;
  origin: 'imported' | 'planned';
  /** '<group> · <sub-area>', '<group>', or '' (unsorted). */
  area: string;
  alignment: SpecAlignment;
  intent: { summary: string; doneWhen: string; inScope: string; outOfScope: string; invariants: string; assumptions: string };
  criteria: SpecCriterion[];
  criteriaMet: number;
  delivery: {
    reportStatus: string; startedAt: string | null; finishedAt: string | null; summary: string;
    whatChanged: string[]; followUps: string[]; openItems: string[]; workflows: string[]; costUsd: number;
  } | null;
  targetDate: string;
  /** Where the person placed it on the roadmap ('' = automatic). */
  lane: '' | 'now' | 'next' | 'later';
  /** The roadmap column it is in, decided by the server — null for an existing feature (not on the roadmap). */
  column: 'now' | 'next' | 'later' | 'done' | null;
  completedAt: string | null;
  updatedAt: string;
}

/** A capability group of the spec — every feature is in exactly one (server lib/project-spec.ts). */
export interface SpecGroup {
  name: string;
  summary: string;
  sections: { name: string; featureIds: string[] }[];
  counts: { features: number; existing: number; planned: number; building: number; done: number; verified: number; gaps: number };
}

export interface ProjectSpec {
  generatedAt: string;
  project: { id: string; name: string; description: string; repos: string[]; mainRepo: string; color: string };
  architecture: string;
  features: SpecFeature[];
  /** Empty when no feature has an area — the list then reads flat. */
  groups: SpecGroup[];
  totals: {
    features: number; existing: number; planned: number; inProgress: number; delivered: number; done: number; paused: number;
    verified: number; gaps: number; intentOnly: number;
  };
}

export type ChangeKind = 'added' | 'changed' | 'fixed' | 'removed' | 'security';

export interface ChangelogEntry {
  id: string;
  projectId: string;
  goalId: string;
  kind: ChangeKind;
  title: string;
  body: string;
  release: string;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What "Generate with AI" can be asked to produce (server lib/project-import.ts). */
export type ImportPart = 'architecture' | 'features' | 'changelog' | 'backlog';

export interface ProjectImport {
  id: string;
  projectId: string;
  agentId: string;
  parts: ImportPart[];
  status: 'pending' | 'ready' | 'failed' | 'applied' | 'superseded';
  proposal: {
    message: string;
    architecture: string;
    /** The architecture as a page (self-contained HTML) — '' on proposals written before pages existed. */
    architectureHtml?: string;
    features: { name: string; description: string; area: string; evidence: string; criteria: { text: string; expect: string }[] }[];
    /** The top-level capability groups, each with a line on what it does. */
    areas?: { name: string; summary: string }[];
    backlog: { name: string; description: string; source: string; area?: string }[];
    changelog: { id: string; kind: ChangeKind; title: string; body: string; release: string; date: string }[];
  } | null;
  notes: string[];
  error: string;
  applied: { architecture: boolean; features: string[]; backlog: string[]; changelog?: number } | null;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
}

export interface DocsPublishResult {
  repo: string;
  dir: string;
  written: string[];
  unchanged: string[];
  retired: string[];
  at: string;
}

