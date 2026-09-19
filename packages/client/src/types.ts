export type AgentMode = 'manual' | 'trust' | 'plan';
export type AgentType = 'claude' | 'gridlight' | 'codex';

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

export interface Note {
  id: string;
  agentId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
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

// Epic Autopilot types
export interface EpicTaskState {
  taskId: string;
  label: string;
  taskFilePath: string;
  status: 'pending' | 'running' | 'committing' | 'completed' | 'skipped' | 'failed';
  startedAt: string;
  completedAt: string;
  error: string;
}

export interface EpicRunConfig {
  idleThresholdMs: number;
  commitCommand: string;
  taskPromptTemplate: string;
  skipCommitOnLast: boolean;
  autoEnableTrust: boolean;
  taskPrefix: string;
}

export interface EpicRun {
  id: string;
  name: string;
  agentId: string;
  status: 'pending' | 'running' | 'committing' | 'paused' | 'completed' | 'failed' | 'cancelled';
  currentTask: number;
  tasks: EpicTaskState[];
  config: EpicRunConfig;
  previousMode: AgentMode;
  startedAt: string;
  completedAt: string | null;
  error: string;
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
export type AttentionReason = 'failed' | 'interrupted' | 'decision' | 'agent-waiting' | 'manual-advance';

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

export interface Goal {
  id: string;
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
}

export interface Heartbeat {
  id: string;
  projectId: string | null;
  templateId: string;
  templateName: string | null;
  agentId: string;
  agentName: string | null;
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

/**
 * Anything fetched from a specific server carries where it came from.
 *
 * Without this the merged grid cannot route a write. Agent ids are unique per database,
 * not across the fleet, so "send this command to agent X" is ambiguous the moment two
 * servers are in play — and the failure is silent: the command goes to whichever server
 * happens to be first and simply does nothing.
 */
export type WithOrigin<T> = T & { origin: string; originName: string };


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
