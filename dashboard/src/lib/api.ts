const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
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
  decidePermission: (id: string, decision: 'allowed' | 'denied') =>
    request<import('../types').PermissionRequest>('/permissions/decide', {
      method: 'POST',
      body: JSON.stringify({ id, decision }),
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

  // Workflows
  getWorkflowTemplates: () =>
    request<import('../types').WorkflowTemplate[]>('/workflows/templates'),
  createWorkflowTemplate: (data: { name: string; description?: string; steps: import('../types').WorkflowStep[] }) =>
    request<import('../types').WorkflowTemplate>('/workflows/templates', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorkflowTemplate: (id: string, data: { name: string; description?: string; steps: import('../types').WorkflowStep[] }) =>
    request<import('../types').WorkflowTemplate>(`/workflows/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteWorkflowTemplate: (id: string) =>
    request<void>(`/workflows/templates/${id}`, { method: 'DELETE' }),
  startWorkflow: (templateId: string) =>
    request<import('../types').WorkflowRun>('/workflows/run', {
      method: 'POST',
      body: JSON.stringify({ templateId }),
    }),
  getWorkflowRuns: () =>
    request<import('../types').WorkflowRun[]>('/workflows/runs'),
  advanceWorkflow: (runId: string) =>
    request<import('../types').WorkflowRun>(`/workflows/runs/${runId}/advance`, { method: 'POST' }),
  cancelWorkflow: (runId: string) =>
    request<import('../types').WorkflowRun>(`/workflows/runs/${runId}/cancel`, { method: 'POST' }),
};
