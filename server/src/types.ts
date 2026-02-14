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

// Workflow types
export interface WorkflowStep {
  command: string;
  target: string; // agentId or 'any_idle'
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  autoRun: boolean;
  intervalMinutes: number;
  triggerWhen: 'idle' | 'any';
  lastAutoRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepState {
  command: string;
  target: string;
  agentId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
}

export interface WorkflowRun {
  id: string;
  templateId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentStep: number;
  steps: WorkflowStepState[];
  startedAt: string;
  completedAt: string | null;
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
  workflow_updated: (run: WorkflowRun) => void;
  auto_approve_plan: (data: { agentId: string }) => void;
};

export type ClientToServerEvents = {
  subscribe: () => void;
  register_extension: (data: { machine: string; repoPath: string; agentType?: AgentType }) => void;
  join_agent_room: (data: { agentId: string }) => void;
};
