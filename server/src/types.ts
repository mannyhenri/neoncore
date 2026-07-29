export type AgentMode = 'manual' | 'trust' | 'plan';
export type AgentType = 'claude' | 'gridlight' | 'gemini' | 'amazonq' | 'codex' | 'cursor';

// ── Confer (standalone multi-agent collaboration) ──────────────────────────
export type ConferStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ConferMilestone {
  id: string;
  sessionId: string;
  idx: number;
  key: string;
  name: string;
  status: 'pending' | 'active' | 'done';
  /** Participant agentIds that have signalled this milestone complete. */
  doneIds: string[];
  dispatchedAt: string | null;
  completedAt: string | null;
}

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
  /** How the panel relates to the task: split into slices vs. one shared solution. */
  mode: 'collaborate' | 'divide';
  /** Whether each agent works in its own git worktree+branch (divide mode only). */
  isolation: 'shared' | 'worktree';
  /** agentId → the worktree provisioned for it (present only when isolation = worktree). */
  worktrees?: Record<string, { path: string; branch: string }>;
  milestones?: ConferMilestone[];
}

export interface Agent {
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
   * Ordinary cartridge recovery state. Workflow recovery lives on workflow_steps;
   * these fields support ad hoc terminal sessions that shut down mid-task.
   */
  recoveryStatus: '' | 'interrupted' | 'recovered' | 'recovery_failed' | 'dismissed';
  interruptedAt: string;
  activeObjective: string;
  /**
   * Work-standard gate (docs/WORK-STANDARD.md). 'needs_review' means the agent stopped
   * without filing a completion report and was released after the block cap — the task is
   * probably half-done and a human should look. '' is the normal state.
   */
  standardState: '' | 'needs_review';
  /**
   * When the user put this cartridge away ('' = visible). Orthogonal to `status`: a
   * dismissed agent is often still alive and working. Any activity from the session
   * clears it automatically, so it comes back the moment you use it again.
   */
  dismissedAt: string;
}

export interface Activity {
  id: string;
  agentId: string;
  eventType: string;
  toolName: string;
  toolInput: string; // JSON string
  toolResult: string; // JSON string
  timestamp: string;
}

export type TranscriptEngine = 'claude' | 'gridlight' | 'codex' | 'gemini';
export type TranscriptRole = 'user' | 'assistant' | 'tool_result' | 'system';

// A single parsed transcript entry. `content` is a JSON string of content blocks:
// [{ type: 'text'|'thinking'|'tool_use'|'tool_result', ... }]
export interface TranscriptEvent {
  id: string;
  agentId: string;
  sessionId: string;
  seq: number;
  role: TranscriptRole;
  content: string; // JSON string of content blocks
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  engine: TranscriptEngine;
  ts: string;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
}

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

export interface PermissionRequest {
  id: string;
  agentId: string;
  toolName: string;
  toolInput: string; // JSON string
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
  /**
   * Whether the command actually reached a live channel (relay/extension socket, or a
   * terminal). NOT persisted — it is the dispatch-time answer to "did this go anywhere?".
   * `false` means it was queued into the void: nothing was listening. Callers must check
   * it, or a workflow step will sit `running` forever waiting on a command nobody received.
   */
  delivered?: boolean;
}

export interface CommandAttachmentInput {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
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

// Hook payload from Claude Code
export interface HookPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
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
  stepSummary?: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
    stepNames: string[];
    projects: string[];
  };
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

// WebSocket events
export type ServerToClientEvents = {
  agent_registered: (agent: Agent) => void;
  agent_updated: (agent: Agent) => void;
  activity_logged: (activity: Activity) => void;
  transcript_event: (event: TranscriptEvent) => void;
  turn_complete: (data: { agentId: string; sessionId: string; engine: TranscriptEngine; usage: TurnUsage }) => void;
  task_created: (task: Task) => void;
  task_updated: (task: Task) => void;
  permission_requested: (request: PermissionRequest) => void;
  permission_decided: (request: PermissionRequest) => void;
  command_send: (command: Command) => void;
  agent_stuck: (alert: StuckAlert) => void;
  agent_unstuck: (data: { agentId: string }) => void;
  memory_updated: (data: { agentId: string }) => void;
  permissions_expired: (data: { count: number }) => void;
  epic_updated: (run: EpicRun) => void;
  workflow_updated: (workflow: Workflow) => void;
  workflow_deleted: (data: { id: string }) => void;
  workflow_step_updated: (step: WorkflowStep) => void;
  workflow_step_log: (log: WorkflowStepLog) => void;
  workflow_step_recovery: (data: {
    stepId: string;
    workflowId: string;
    name: string;
    status: string;
    recoveryStatus: string;
    interruptedAt: string | null;
    recoveryAttempts: number;
  }) => void;
  virtual_cartridge_updated: (vc: VirtualCartridge) => void;
  confer_updated: (session: ConferSession) => void;
  auto_approve_plan: (data: { agentId: string }) => void;
  plan_executed: (data: { agentId: string }) => void;
  session_started: (data: { agentId: string; project: string; sessionId: string }) => void;
  session_ended: (data: { agentId: string; project: string; sessionId: string }) => void;
  heartbeat_fired: (data: { heartbeatId: string; runId: string; projectId: string | null; templateId: string; label: unknown; firedAt: string; nextRunAt: string }) => void;
  machine_updated: (machine: Machine) => void;
  // Server → runner: launch a cartridge on this machine (delivered to the machine's room).
  launch_cartridge: (data: { machineId: string; repoPath: string; agentType: AgentType; sessionId: string; context: string }) => void;
  // Server → runner: replace this machine's exposed-folder allowlist (portal-managed).
  machine_set_repos: (data: { machineId: string; repos: MachineRepo[] }) => void;
  // Server → runner: scan a directory ON that machine and add the git repos under it.
  machine_scan: (data: { machineId: string; root: string }) => void;
};

export type ClientToServerEvents = {
  subscribe: () => void;
  register_extension: (data: { machine: string; repoPath: string; agentType?: AgentType }) => void;
  join_agent_room: (data: { agentId: string }) => void;
  // Runner → server: this socket belongs to a registered machine (mirrors join_agent_room).
  join_machine_room: (data: { machineId: string }) => void;
  machine_heartbeat: (data: { machineId: string }) => void;
};

/** A directory the runner is allowed to launch a cartridge in. */
export interface MachineRepo {
  path: string;
  name: string;
}

/** A machine running the runner daemon, addressable for remote cartridge launches. */
export interface Machine {
  id: string;
  hostname: string;
  platform: string; // 'win32' | 'darwin' | 'linux'
  arch: string;
  repos: MachineRepo[];
  status: 'online' | 'offline';
  lastSeen: string;
}
