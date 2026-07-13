export type AgentMode = 'manual' | 'trust' | 'plan';
export type AgentType = 'claude' | 'gridlight' | 'gemini' | 'amazonq' | 'codex' | 'cursor';

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
export type PlayerType = 'vscode-agent' | 'openai' | 'gridlight-gateway';

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

// MCP Server types
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServer {
  id: string;
  name: string;
  slug: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  isPreconfigured: boolean;
  status: 'stopped' | 'running' | 'error';
  error: string;
  pid: number | null;
  capabilities: McpTool[];
  createdAt: string;
  updatedAt: string;
}

// MCP Registry (marketplace)
export interface McpRegistryEnvField {
  required: boolean;
  label: string;
  placeholder: string;
}

export interface McpRegistryEntry {
  slug: string;
  name: string;
  description: string;
  category: string;
  command: string;
  args: string[];
  env: Record<string, McpRegistryEnvField>;
  homepage: string;
  tags: string[];
  featured: boolean;
}

// Virtual Cartridges
export interface PinnedTool {
  serverId: string;
  toolName: string;
  label?: string;
}

export interface VirtualCartridge {
  id: string;
  name: string;
  directoryPath: string;
  iconIndex: number;
  color: string;
  mcpServerIds: string[];
  pinnedTools: PinnedTool[];
  ntfyUrl: string;
  createdAt: string;
  updatedAt: string;
}

// MCP Macros
export interface MacroStep {
  id: string;
  serverId: string;
  toolName: string;
  args: Record<string, string>;
  label?: string;
  continueOnError?: boolean;
}

export interface McpMacro {
  id: string;
  name: string;
  description: string;
  category: string;
  steps: MacroStep[];
  createdAt: string;
  updatedAt: string;
}

export interface McpMacroRun {
  id: string;
  macroId: string;
  cartridgeId: string;
  status: 'running' | 'completed' | 'failed';
  currentStep: number;
  stepResults: { stepId: string; result: unknown; error?: string; completedAt: string }[];
  inputParams: Record<string, string>;
  startedAt: string;
  completedAt: string | null;
  error: string;
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

// Git types
export interface Worktree {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
}
