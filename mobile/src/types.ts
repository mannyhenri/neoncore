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
  /**
   * When the user put this cartridge away ('' = visible). Orthogonal to `status`: a
   * dismissed agent is often still alive and working. Any activity clears it.
   */
  dismissedAt: string;
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
  engine: 'claude' | 'gridlight' | 'codex';
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

export type WorkflowStatus =
  | 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

// A quick roll-up the list endpoint attaches to each workflow so a run row can show
// "3/5 · repo-name" without a second fetch. Server: buildStepSummary in routes/workflows.ts.
export interface WorkflowStepSummary {
  total: number;
  completed: number;
  running: number;
  failed: number;
  pending: number;
  stepNames: string[];
  /** Repo/cartridge names the steps run on (deferred steps contribute none). */
  projects: string[];
}

// A workflow with templateId === null is a *template*; one with a templateId is a
// *run* cloned from it. POST /workflows/v2/:id/start on a template makes a new run.
export interface Workflow {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  currentPhase: number;
  initialContext: string;
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
  error: string;
  templateId: string | null;
  runNumber: number;
  /** Present only on the list endpoint for V2 workflows that have steps. */
  stepSummary?: WorkflowStepSummary;
}

/** A directory a machine runner will launch a cartridge in. */
export interface MachineRepo {
  path: string;
  name: string;
}

/** A machine running the runner daemon — a remote launch target. */
export interface Machine {
  id: string;
  hostname: string;
  platform: string; // 'win32' | 'darwin' | 'linux'
  arch: string;
  repos: MachineRepo[];
  status: 'online' | 'offline';
  lastSeen: string;
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type StepExecutorType =
  | 'claude-code' | 'review-gate' | 'deliberation' | 'quality-gate'
  | 'command' | 'connector' | 'decision';

// One option a `decision` step waits on. The human picks one to complete the step.
export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  nextStepId?: string;
}

// A single node in a V2 (canvas) workflow. Mirrors server WorkflowStep — the subset the
// phone consumes. GET /api/workflows/v2/:id returns { workflow, steps }.
export interface WorkflowStep {
  id: string;
  workflowId: string;
  name: string;
  description: string;
  executorType: StepExecutorType;
  /** The cartridge this step runs on. '' or '__deferred__' = not yet assigned. */
  executorId: string;
  executorConfig: Record<string, unknown>;
  autoAdvance: boolean;
  status: StepStatus;
  result: string;
  error: string;
  dependsOn: string[];
  startedAt: string | null;
  completedAt: string | null;
  /** '' | 'interrupted' | 'recovering' | 'recovered' | 'recovery_failed' */
  recoveryStatus: string;
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
