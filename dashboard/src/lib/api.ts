
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
  // Put a cartridge away / bring it back. NOT a delete and NOT a status change — the
  // session keeps running; this only controls whether you're looking at it.
  dismissAgent: (id: string) =>
    request<import('../types').Agent>(`/agents/${id}/dismiss`, { method: 'POST' }),
  restoreAgent: (id: string) =>
    request<import('../types').Agent>(`/agents/${id}/restore`, { method: 'POST' }),
  updateAgent: (id: string, data: Record<string, unknown>) =>
    request<import('../types').Agent>(`/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  focusAgent: (id: string) => request<{ ok: boolean }>(`/agents/${id}/focus`, { method: 'POST' }),
  getContextOptions: (id: string) =>
    request<{
      sessions: { id: string; startedAt: string; summary: string; branch: string }[];
      hasProgress: boolean;
      hasGotchas: boolean;
      hasDecisions: boolean;
      hasDetails: boolean;
    }>(`/agents/${id}/context-options`),
  sendContext: (id: string, options?: {
    sessionIds?: string[];
    includeProgress?: boolean;
    includeGotchas?: boolean;
    includeDecisions?: boolean;
    includeDetails?: boolean;
  }) => request<{ ok: boolean }>(`/agents/${id}/send-context`, {
    method: 'POST',
    body: JSON.stringify(options || {}),
  }),

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

  setPlansIncluded: (agentId: string, plansIncluded: boolean) =>
    request<import('../types').Agent>(`/trust/${agentId}/plans-included`, {
      method: 'PUT',
      body: JSON.stringify({ plansIncluded }),
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

  // Command Templates
  getCommandTemplates: () => request<import('../types').CommandTemplate[]>('/command-templates'),
  createCommandTemplate: (data: { name: string; content: string; category: string }) =>
    request<import('../types').CommandTemplate>('/command-templates', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateCommandTemplate: (id: string, data: { name?: string; content?: string; category?: string }) =>
    request<import('../types').CommandTemplate>(`/command-templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteCommandTemplate: (id: string) =>
    request<void>(`/command-templates/${id}`, { method: 'DELETE' }),

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
  getRepos: () => request<{ repos: { name: string; path: string; source: string }[]; projectsDirs: string[] }>('/repos'),
  openRepo: (repoPath: string, agentType: string = 'claude') =>
    request<{ ok: boolean }>('/repos/open', {
      method: 'POST',
      body: JSON.stringify({ path: repoPath, agentType }),
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
  recoverStep: (stepId: string) =>
    request<{ ok: boolean; reason: string; recoveryStatus?: string; attempts?: number }>(
      `/workflows/steps/${stepId}/recover`,
      { method: 'POST' }
    ),
  getAvailableModels: () =>
    request<{ openai: string[]; gridlight: string[] }>('/workflows/models'),

  // MCP Registry (marketplace)
  getMcpRegistry: () =>
    request<{ servers: import('../types').McpRegistryEntry[]; categories: string[]; installed: string[] }>('/mcp/registry'),

  // MCP Servers
  getMcpServers: () =>
    request<import('../types').McpServer[]>('/mcp/servers'),
  addMcpServer: (data: { command: string; name?: string; args?: string[]; env?: Record<string, string>; slug?: string; description?: string }) =>
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

  // Virtual Cartridges
  getVirtualCartridges: () =>
    request<import('../types').VirtualCartridge[]>('/virtual-cartridges'),
  createVirtualCartridge: (data: { name?: string; directoryPath: string; mcpServerIds?: string[] }) =>
    request<import('../types').VirtualCartridge>('/virtual-cartridges', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateVirtualCartridge: (id: string, data: Record<string, unknown>) =>
    request<import('../types').VirtualCartridge>(`/virtual-cartridges/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteVirtualCartridge: (id: string) =>
    request<void>(`/virtual-cartridges/${id}`, { method: 'DELETE' }),
  getVirtualCartridgeTools: (id: string) =>
    request<(import('../types').McpTool & { serverId: string; serverName: string })[]>(`/virtual-cartridges/${id}/tools`),
  executeVirtualCartridgeTool: (id: string, serverId: string, toolName: string, args: Record<string, unknown>) =>
    request<{ result: unknown }>(`/virtual-cartridges/${id}/execute`, {
      method: 'POST',
      body: JSON.stringify({ serverId, toolName, args }),
    }),
  launchVirtualCartridge: (id: string, agentType: string) =>
    request<{ ok: boolean }>(`/virtual-cartridges/${id}/launch`, {
      method: 'POST',
      body: JSON.stringify({ agentType }),
    }),

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
  // `agentId` is the run-level cartridge: it fills every step that hasn't got one, so you
  // pick once instead of naming a cartridge for each step. `agentOverrides` still wins
  // per-step, for the genuine cross-cartridge case.
  startWorkflowV2: (workflowId: string, agentOverrides?: Record<string, string>, promptOverrides?: Record<string, Record<string, string>>, initialContext?: string, projectId?: string | null, agentId?: string) =>
    request<{ workflow: import('../types').Workflow; steps: import('../types').WorkflowStep[] }>(`/workflows/v2/${workflowId}/start`, {
      method: 'POST',
      body: JSON.stringify({ agentOverrides, promptOverrides, initialContext, projectId, agentId }),
    }),
  completeWorkflowStep: (workflowId: string, stepId: string, result?: string) =>
    request<import('../types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ result }),
    }),
  decideWorkflowStep: (workflowId: string, stepId: string, optionId: string) =>
    request<import('../types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ optionId }),
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
  getWorkflowRuns: (templateId: string) =>
    request<import('../types').Workflow[]>(`/workflows/v2/${templateId}/runs`),

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

  // Project-scoped notes
  getProjectNotes: (project: string) =>
    request<{ id: string; content: string; createdAt: string; updatedAt: string }[]>(
      `/journal/projects/${encodeURIComponent(project)}/notes`
    ),
  createProjectNote: (project: string, content: string) =>
    request<{ id: string; content: string; createdAt: string; updatedAt: string }>(
      `/journal/projects/${encodeURIComponent(project)}/notes`,
      { method: 'POST', body: JSON.stringify({ content }) },
    ),
  updateProjectNote: (project: string, noteId: string, content: string) =>
    request<{ id: string; content: string; updatedAt: string }>(
      `/journal/projects/${encodeURIComponent(project)}/notes/${noteId}`,
      { method: 'PUT', body: JSON.stringify({ content }) },
    ),
  deleteProjectNote: (project: string, noteId: string) =>
    request<void>(`/journal/projects/${encodeURIComponent(project)}/notes/${noteId}`, { method: 'DELETE' }),

  // Token usage
  getAgentTokenUsage: (agentId: string, since?: string) =>
    request<{ agentId: string; totalInput: number; totalOutput: number; totalCacheRead: number; totalCacheCreation: number; total: number; costUsd: number; latestModel: string; sessions: number }>(
      `/activity/usage/${agentId}${since ? `?since=${encodeURIComponent(since)}` : ''}`
    ),

  // Push notifications
  testPushNotification: () =>
    request<{ ok: boolean }>('/settings/push-test', { method: 'POST' }),

  // Workflow V2 — Mid-task steering
  steerWorkflowStep: (workflowId: string, stepId: string, message: string) =>
    request<{ ok: boolean; commandId: string }>(`/workflows/v2/${workflowId}/steps/${stepId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // Workflow V2 — AI generator
  generateWorkflow: (description: string) =>
    request<{ id: string }>('/workflows/v2/generate', {
      method: 'POST',
      body: JSON.stringify({ description }),
    }),

  // Machines — remote cartridge launch
  getMachines: () => request<import('../types').Machine[]>('/machines'),
  launchOnMachine: (machineId: string, repoPath: string, agentType: string, context?: string) =>
    request<{ ok: boolean; sessionId: string }>(`/machines/${machineId}/launch`, {
      method: 'POST',
      body: JSON.stringify({ repoPath, agentType, ...(context ? { context } : {}) }),
    }),

  // Virtual cartridge suggestions
  getCartridgeSuggestions: (id: string) =>
    request<{ title: string; prompt: string; toolName: string; serverId: string }[]>(`/virtual-cartridges/${id}/suggestions`),

  // Journal search
  searchJournal: (query: string, project?: string) =>
    request<{ sessions: { id: string; project: string; summary: string; startedAt: string }[]; knowledge: { project: string; filename: string; snippet: string }[] }>(
      `/journal/search?q=${encodeURIComponent(query)}${project ? `&project=${encodeURIComponent(project)}` : ''}`
    ),

  // Goals
  getGoals: () => request<import('../types').Goal[]>('/goals'),
  createGoal: (data: { name: string; description?: string; successMetric?: string; tokenBudget?: number | null; budgetUsd?: number | null }) =>
    request<import('../types').Goal>('/goals', { method: 'POST', body: JSON.stringify(data) }),
  updateGoal: (id: string, data: { name?: string; description?: string; successMetric?: string; tokenBudget?: number | null; budgetUsd?: number | null; status?: string }) =>
    request<import('../types').Goal>(`/goals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGoal: (id: string) => request<void>(`/goals/${id}`, { method: 'DELETE' }),

  // Goal Projects (separate from journal projects)
  getGoalProjects: (goalId?: string) =>
    request<import('../types').Project[]>(`/projects${goalId ? `?goalId=${goalId}` : ''}`),
  getGoalProject: (id: string) =>
    request<{ project: import('../types').Project; workflows: Record<string, unknown>[] }>(`/projects/${id}`),
  createProject: (data: { name: string; description?: string; goalId?: string | null; primaryRepo?: string; color?: string }) =>
    request<import('../types').Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: string, data: { name?: string; description?: string; goalId?: string | null; primaryRepo?: string; color?: string }) =>
    request<import('../types').Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  // Assign workflow to project
  assignWorkflowProject: (workflowId: string, projectId: string | null) =>
    request<void>(`/workflows/${workflowId}/project`, { method: 'PUT', body: JSON.stringify({ projectId }) }),

  // Project learnings
  getProjectLearnings: (projectId: string, limit?: number) =>
    request<import('../types').ProjectLearning[]>(`/projects/${projectId}/learnings${limit ? `?limit=${limit}` : ''}`),

  // Heartbeats
  getHeartbeats: (projectId?: string) =>
    request<import('../types').Heartbeat[]>(`/heartbeats${projectId ? `?projectId=${projectId}` : ''}`),
  createHeartbeat: (data: {
    projectId?: string | null;
    templateId: string;
    agentId?: string;
    schedule: { type: 'hourly' | 'daily' | 'weekly'; time?: string; day?: number };
    label?: string;
    active?: boolean;
  }) => request<import('../types').Heartbeat>('/heartbeats', { method: 'POST', body: JSON.stringify(data) }),
  updateHeartbeat: (id: string, data: {
    templateId?: string;
    agentId?: string;
    schedule?: { type: 'hourly' | 'daily' | 'weekly'; time?: string; day?: number };
    label?: string;
    active?: boolean;
  }) => request<import('../types').Heartbeat>(`/heartbeats/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteHeartbeat: (id: string) => request<void>(`/heartbeats/${id}`, { method: 'DELETE' }),
  fireHeartbeat: (id: string) => request<{ runId: string; message: string }>(`/heartbeats/${id}/fire`, { method: 'POST' }),

  // Tool integrations
  getToolsStatus: () =>
    request<Record<string, { label: string; installed: boolean; configFile: string; hooksExist: boolean; cliInstalled: boolean; cliPath: string | null; npmPkg: string | null; authCmd: string | null }>>('/tools/status'),
  installTool: (tool: string) =>
    request<{ ok: boolean; tool: string; configFile: string; note: string }>(`/tools/install/${tool}`, { method: 'POST' }),
  uninstallTool: (tool: string) =>
    request<{ ok: boolean; note?: string }>(`/tools/uninstall/${tool}`, { method: 'POST' }),

  // Tasks (agent queue)
  getTasks: (filters?: { status?: string; agentId?: string; projectId?: string }) => {
    const qs = filters
      ? '?' + new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString()
      : '';
    return request<import('../types').Task[]>(`/tasks${qs}`);
  },
  createTask: (data: { title: string; prompt?: string; projectId?: string | null; priority?: number }) =>
    request<import('../types').Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  cancelTask: (id: string) =>
    request<import('../types').Task>(`/tasks/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
  updateTask: (id: string, data: { title?: string; prompt?: string; projectId?: string | null; priority?: number }) =>
    request<import('../types').Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  dispatchTask: (id: string, agentId?: string) =>
    request<import('../types').Task>(`/tasks/${id}/dispatch`, { method: 'POST', body: JSON.stringify(agentId ? { agentId } : {}) }),
  completeTask: (id: string, status: 'done' | 'failed' = 'done', result?: string) =>
    request<import('../types').Task>(`/tasks/${id}/done`, { method: 'POST', body: JSON.stringify({ status, result }) }),
};
