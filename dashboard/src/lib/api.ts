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
  getAvailableModels: () =>
    request<{ openai: string[]; gridlight: string[] }>('/workflows/models'),
};
