export type AgentMode = 'manual' | 'trust' | 'plan';

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
  lastSeen: string;
  sessionId: string;
  lastMessage: string;
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

// Hook payload from Claude Code
export interface HookPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// WebSocket events
export type ServerToClientEvents = {
  agent_registered: (agent: Agent) => void;
  agent_updated: (agent: Agent) => void;
  activity_logged: (activity: Activity) => void;
  permission_requested: (request: PermissionRequest) => void;
  permission_decided: (request: PermissionRequest) => void;
  command_send: (command: Command) => void;
};

export type ClientToServerEvents = {
  subscribe: () => void;
};
