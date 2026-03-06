const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  // Agents
  getAgents: () => request<import('../types').Agent[]>('/agents'),
  deleteAgent: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
  updateAgent: (id: string, data: Record<string, unknown>) =>
    request<import('../types').Agent>(`/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  focusAgent: (id: string) => request<{ ok: boolean }>(`/agents/${id}/focus`, { method: 'POST' }),

  // Activity
  getActivity: (limit = 50) => request<import('../types').Activity[]>(`/activity?limit=${limit}`),

  // Permissions
  getPendingPermissions: () => request<import('../types').PermissionRequest[]>('/permissions/pending'),
  decidePermission: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) =>
    request<import('../types').PermissionRequest>('/permissions/decide', {
      method: 'POST',
      body: JSON.stringify({ id, decision, response }),
    }),

  // Agent mode
  setAgentMode: (agentId: string, mode: import('../types').AgentMode) =>
    request<import('../types').Agent>(`/trust/${agentId}/mode`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),

  // Commands
  sendCommand: (agentId: string, text: string, includeMemory = true) =>
    request<import('../types').Command>('/commands/send', {
      method: 'POST',
      body: JSON.stringify({ agentId, text, includeMemory }),
    }),

  // Memory
  getMemory: (agentId: string) =>
    request<import('../types').AgentMemory[]>(`/agents/${agentId}/memory`),
  addMemory: (agentId: string, data: { category: string; content: string }) =>
    request<import('../types').AgentMemory>(`/agents/${agentId}/memory`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  toggleMemory: (agentId: string, memoryId: string) =>
    request<import('../types').AgentMemory>(`/agents/${agentId}/memory/${memoryId}/toggle`, { method: 'PATCH' }),
  deleteMemory: (agentId: string, memoryId: string) =>
    request<void>(`/agents/${agentId}/memory/${memoryId}`, { method: 'DELETE' }),

  // Notes
  getNotes: (agentId: string) =>
    request<import('../types').Note[]>(`/agents/${agentId}/notes`),
  createNote: (agentId: string, content: string) =>
    request<import('../types').Note>(`/agents/${agentId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  updateNote: (agentId: string, noteId: string, content: string) =>
    request<import('../types').Note>(`/agents/${agentId}/notes/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  deleteNote: (agentId: string, noteId: string) =>
    request<void>(`/agents/${agentId}/notes/${noteId}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => request<Record<string, string>>('/settings'),
  updateSettings: (settings: Record<string, string>) =>
    request<Record<string, string>>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  // Repos
  browseDir: (dirPath?: string) =>
    request<{ current: string; parent: string | null; dirs: string[] }>(
      `/repos/browse${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`
    ),
  getRepos: () => request<{ repos: { name: string; path: string }[]; projectsDir: string }>('/repos'),
  openRepo: (repoPath: string) =>
    request<{ ok: boolean }>('/repos/open', {
      method: 'POST',
      body: JSON.stringify({ path: repoPath }),
    }),

  // Git
  getWorktrees: (agentId: string) =>
    request<import('../types').Worktree[]>(`/git/${agentId}/worktrees`),
  createWorktree: (agentId: string, branch: string, worktreePath?: string) =>
    request<{ ok: boolean; path: string; branch: string }>(`/git/${agentId}/worktrees`, {
      method: 'POST',
      body: JSON.stringify({ branch, path: worktreePath }),
    }),
  removeWorktree: (agentId: string, worktreePath: string) =>
    request<{ ok: boolean }>(`/git/${agentId}/worktrees`, {
      method: 'DELETE',
      body: JSON.stringify({ path: worktreePath }),
    }),
  openWorktree: (agentId: string, worktreePath: string) =>
    request<{ ok: boolean }>(`/git/${agentId}/worktrees/open`, {
      method: 'POST',
      body: JSON.stringify({ path: worktreePath }),
    }),
  getBranches: (agentId: string) =>
    request<string[]>(`/git/${agentId}/branches`),
  getGitStatus: (agentId: string) =>
    request<{ status: string }>(`/git/${agentId}/status`),
  getGitDiff: (agentId: string, staged = false) =>
    request<{ diff: string }>(`/git/${agentId}/diff${staged ? '?staged=true' : ''}`),

  // Epics — Discovery
  scanEpics: (agentId: string) =>
    request<{ epics: { name: string; filename: string; path: string }[]; prefixes: string[]; taskCount: number }>(`/epics/scan/${agentId}`),
  scanTasks: (agentId: string, prefix: string) =>
    request<{ tasks: { taskId: string; label: string; filename: string; taskFilePath: string }[]; prefix: string }>(`/epics/scan/${agentId}/tasks?prefix=${encodeURIComponent(prefix)}`),

  // Epics — Runs
  startEpic: (data: { name: string; agentId: string; tasks: { taskId: string; label?: string; taskFilePath?: string }[]; config?: Partial<import('../types').EpicRunConfig>; startPaused?: boolean }) =>
    request<import('../types').EpicRun>('/epics/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getEpicRuns: () =>
    request<import('../types').EpicRun[]>('/epics/runs'),
  getEpicRun: (id: string) =>
    request<import('../types').EpicRun>(`/epics/runs/${id}`),
  pauseEpic: (id: string) =>
    request<import('../types').EpicRun>(`/epics/runs/${id}/pause`, { method: 'POST' }),
  resumeEpic: (id: string) =>
    request<import('../types').EpicRun>(`/epics/runs/${id}/resume`, { method: 'POST' }),
  cancelEpic: (id: string) =>
    request<import('../types').EpicRun>(`/epics/runs/${id}/cancel`, { method: 'POST' }),
  skipEpicTask: (id: string) =>
    request<import('../types').EpicRun>(`/epics/runs/${id}/skip`, { method: 'POST' }),
  retryEpicTask: (id: string) =>
    request<import('../types').EpicRun>(`/epics/runs/${id}/retry`, { method: 'POST' }),

  // Workflows
  startWorkflow: (data: {
    name?: string;
    jiraTaskId?: string;
    description: string;
    players: { playerType: string; agentId?: string; name?: string; modelId?: string; roles: string[] }[];
    maxIterations?: number;
  }) =>
    request<import('../types').Workflow>('/workflows/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getWorkflows: () =>
    request<import('../types').Workflow[]>('/workflows'),
  getWorkflow: (id: string) =>
    request<import('../types').Workflow>(`/workflows/${id}`),
  pauseWorkflow: (id: string) =>
    request<import('../types').Workflow>(`/workflows/${id}/pause`, { method: 'POST' }),
  resumeWorkflow: (id: string) =>
    request<import('../types').Workflow>(`/workflows/${id}/resume`, { method: 'POST' }),
  cancelWorkflow: (id: string) =>
    request<import('../types').Workflow>(`/workflows/${id}/cancel`, { method: 'POST' }),
  deleteWorkflow: (id: string) =>
    request<void>(`/workflows/${id}`, { method: 'DELETE' }),
  getAvailableModels: () =>
    request<{ openai: string[]; gridlight: string[] }>('/workflows/models'),

  // MCP Servers
  getMcpServers: () =>
    request<import('../types').McpServer[]>('/mcp/servers'),
  addMcpServer: (data: { command: string; name?: string }) =>
    request<import('../types').McpServer>('/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateMcpServer: (id: string, data: { env?: Record<string, string>; command?: string; args?: string[]; name?: string }) =>
    request<import('../types').McpServer>(`/mcp/servers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteMcpServer: (id: string) =>
    request<void>(`/mcp/servers/${id}`, { method: 'DELETE' }),
  startMcpServer: (id: string) =>
    request<import('../types').McpServer>(`/mcp/servers/${id}/start`, { method: 'POST' }),
  stopMcpServer: (id: string) =>
    request<import('../types').McpServer>(`/mcp/servers/${id}/stop`, { method: 'POST' }),
  getMcpTools: (id: string) =>
    request<import('../types').McpTool[]>(`/mcp/servers/${id}/tools`),

  // Workflow V2 (Canvas)
  createWorkflowV2: (data: {
    name: string;
    description: string;
    targetRepos?: string[];
    steps: {
      id: string;
      name: string;
      description?: string;
      positionX: number;
      positionY: number;
      executorType: import('../types').StepExecutorType;
      executorId?: string;
      executorConfig?: Record<string, unknown>;
      autoAdvance?: boolean;
      dependsOn?: string[];
    }[];
  }) =>
    request<{ workflow: import('../types').Workflow; steps: import('../types').WorkflowStep[] }>('/workflows/v2/create', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getWorkflowV2: (id: string) =>
    request<{ workflow: import('../types').Workflow; steps: import('../types').WorkflowStep[] }>(`/workflows/v2/${id}`),
  updateWorkflowV2: (id: string, data: {
    name: string;
    description: string;
    steps: {
      id: string;
      name: string;
      description?: string;
      positionX: number;
      positionY: number;
      executorType: import('../types').StepExecutorType;
      executorId?: string;
      executorConfig?: Record<string, unknown>;
      autoAdvance?: boolean;
      dependsOn?: string[];
    }[];
  }) =>
    request<{ workflow: import('../types').Workflow; steps: import('../types').WorkflowStep[] }>(`/workflows/v2/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  addWorkflowStep: (workflowId: string, step: {
    name: string;
    description?: string;
    positionX: number;
    positionY: number;
    executorType: import('../types').StepExecutorType;
    executorId?: string;
    executorConfig?: Record<string, unknown>;
    autoAdvance?: boolean;
    dependsOn?: string[];
  }) =>
    request<import('../types').WorkflowStep>(`/workflows/v2/${workflowId}/steps`, {
      method: 'POST',
      body: JSON.stringify(step),
    }),
  updateWorkflowStep: (workflowId: string, stepId: string, data: Record<string, unknown>) =>
    request<import('../types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteWorkflowStep: (workflowId: string, stepId: string) =>
    request<void>(`/workflows/v2/${workflowId}/steps/${stepId}`, { method: 'DELETE' }),
  startWorkflowV2: (workflowId: string) =>
    request<import('../types').Workflow>(`/workflows/v2/${workflowId}/start`, { method: 'POST' }),
  completeWorkflowStep: (workflowId: string, stepId: string, result?: string) =>
    request<import('../types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ result }),
    }),
  advanceWorkflowStep: (workflowId: string, stepId: string) =>
    request<import('../types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/advance`, {
      method: 'POST',
    }),
  skipWorkflowStep: (workflowId: string, stepId: string) =>
    request<import('../types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/skip`, {
      method: 'POST',
    }),
  completeWorkflowV2: (workflowId: string) =>
    request<import('../types').Workflow>(`/workflows/v2/${workflowId}/complete`, { method: 'POST' }),

  // Journal / Session Memory
  getProjects: () =>
    request<{ project: string; sessionCount: number; lastSession: string }[]>('/journal/projects'),
  getProjectSessions: (project: string, limit = 20) =>
    request<import('../types').Session[]>(`/journal/projects/${encodeURIComponent(project)}/sessions?limit=${limit}`),
  getSession: (id: string) =>
    request<import('../types').Session>(`/journal/sessions/${id}`),
  getKnowledgeFile: (project: string, filename: string) =>
    request<import('../types').ProjectKnowledge>(`/journal/projects/${encodeURIComponent(project)}/knowledge/${filename}`),
  updateKnowledgeFile: (project: string, filename: string, content: string) =>
    request<{ ok: boolean }>(`/journal/projects/${encodeURIComponent(project)}/knowledge/${filename}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
};
