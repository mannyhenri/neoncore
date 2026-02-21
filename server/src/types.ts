export type AgentMode = 'manual' | 'trust' | 'plan';
export type AgentType = 'claude' | 'gridlight';

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
  mode: AgentMode;
  agentType: AgentType;
  lastSeen: string;
  sessionId: string;
  lastMessage: string;
  pendingQuestion: string;
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
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
  error: string;
}

// WebSocket events
export type ServerToClientEvents = {
  agent_registered: (agent: Agent) => void;
  agent_updated: (agent: Agent) => void;
  activity_logged: (activity: Activity) => void;
  permission_requested: (request: PermissionRequest) => void;
  permission_decided: (request: PermissionRequest) => void;
  command_send: (command: Command) => void;
  agent_stuck: (alert: StuckAlert) => void;
  agent_unstuck: (data: { agentId: string }) => void;
  memory_updated: (data: { agentId: string }) => void;
  permissions_expired: (data: { count: number }) => void;
  epic_updated: (run: EpicRun) => void;
  workflow_updated: (workflow: Workflow) => void;
  auto_approve_plan: (data: { agentId: string }) => void;
};

export type ClientToServerEvents = {
  subscribe: () => void;
  register_extension: (data: { machine: string; repoPath: string; agentType?: AgentType }) => void;
  join_agent_room: (data: { agentId: string }) => void;
};
