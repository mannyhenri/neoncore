// Ported from server/src/types.ts — the subset the mobile app consumes.
// Keep in sync with the server's ServerToClientEvents contract.

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
}

export type TranscriptRole = 'user' | 'assistant' | 'tool_result' | 'system';

// content is a JSON string of blocks: [{ type: 'text'|'thinking'|'tool_use'|'tool_result', ... }]
export interface TranscriptEvent {
  id: string;
  agentId: string;
  sessionId: string;
  seq: number;
  role: TranscriptRole;
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  engine: 'claude' | 'gridlight';
  ts: string;
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
  response: string;
}

// Parsed content block shapes (from the JSON string in TranscriptEvent.content)
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking?: string; text?: string }
  | { type: 'tool_use'; name: string; input?: unknown }
  | { type: 'tool_result'; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export function parseBlocks(content: string): ContentBlock[] {
  try {
    const v = JSON.parse(content);
    if (Array.isArray(v)) return v as ContentBlock[];
    if (typeof v === 'string') return [{ type: 'text', text: v }];
    return [];
  } catch {
    // Content was a raw string, not JSON.
    return content ? [{ type: 'text', text: content }] : [];
  }
}
