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
