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

export interface Command {
  id: string;
  agentId: string;
  text: string;
  source: 'dashboard';
  status: 'pending' | 'delivered' | 'failed';
  createdAt: string;
  deliveredAt: string | null;
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
  description: string;
  players: WorkflowPlayer[];
  phases: WorkflowPhaseState[];
  status: WorkflowStatus;
  currentPhase: number;
  iteration: number;
  maxIterations: number;
  sharedContext: string;
  initialContext: string;
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
export interface Goal {
  id: string;
  name: string;
  description: string;
  successMetric: string;
  tokenBudget: number | null;
  budgetUsd: number | null;
  status: 'active' | 'achieved' | 'paused';
  createdAt: string;
  updatedAt: string;
  projectCount?: number;
  runCount?: number;
  tokensUsed?: number;
  costUsd?: number;
}

export interface Project {
  id: string;
  goalId: string | null;
  goalName?: string;
  name: string;
  description: string;
  primaryRepo: string;
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
  schedule: { type: 'hourly' | 'daily' | 'weekly'; time?: string; day?: number };
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
export type StepExecutorType = 'claude-code' | 'review-gate' | 'deliberation' | 'quality-gate' | 'command' | 'connector' | 'decision';
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
  participantIds: string[];
  status: ConferStatus;
  currentMilestone: number;
  error: string;
  createdAt: string;
  completedAt: string | null;
  mode: ConferMode;
  isolation: ConferIsolation;
  worktrees?: Record<string, { path: string; branch: string }>;
  milestones?: ConferMilestone[];
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
