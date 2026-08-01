/**
 * The NeonCore API surface, as a factory.
 *
 * Extracted verbatim from the web app's lib/api.ts. The ONLY change to the method bodies
 * is that `request` now closes over a per-server base URL and token instead of a
 * module-level constant. That is what makes it usable N times over.
 *
 * Web and mobile had drifted into two hand-maintained copies of this surface; one had
 * endpoints the other lacked. A single factory is the fix, and it is also the thing
 * federation requires — the merged grid needs one client per server, not one per app.
 */

import { ApiError, asUnreachable, classifyStatus } from './errors.js';

export interface ClientConfig {
  /**
   * Origin of the server, e.g. "http://studio.local:4040". Empty string means same-origin,
   * which is how the web app talks to the server that served it — and keeps the existing
   * Vite dev proxy working untouched.
   */
  baseUrl?: string;
  /** Fleet token. Omitted while a fleet is still running in permissive mode. */
  token?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export type NeonCoreClient = ReturnType<typeof createClient>;

export function createClient(config: ClientConfig = {}) {
  const origin = (config.baseUrl ?? '').replace(/\/+$/, '');
  const BASE_URL = `${origin}/api`;
  const doFetch = config.fetchImpl ?? fetch;

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {};
    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }
    // Sent when configured. While a fleet is permissive the server accepts an absent
    // header, so an un-tokened client keeps working through the migration.
    if (config.token) {
      headers['Authorization'] = `Bearer ${config.token}`;
    }

    let res: Response;
    try {
      res = await doFetch(`${BASE_URL}${path}`, {
        ...options,
        headers: { ...headers, ...(options?.headers as Record<string, string>) },
      });
    } catch (err) {
      // No HTTP reply at all: refused, DNS failure, TLS rejection, aborted timeout.
      throw asUnreachable(err, origin);
    }

    if (!res.ok) {
      const parsed = await res.json().catch(() => ({ error: res.statusText }));
      // Typed, so the caller can tell "wrong token" from "asleep" — they are the same
      // string to a user otherwise, and only one of them is fixable by waiting.
      throw new ApiError(classifyStatus(res.status), parsed.error || res.statusText, {
        status: res.status,
        origin,
      });
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  return {
  /** Which server this client points at. '' means same-origin. Used to tag data by origin. */
  origin,

  // Federation
  getHealth: () => request<{ status: string; timestamp: string }>('/health'),
  getPeers: () =>
    request<{
      self: { serverId: string; name: string; url: string; version: string };
      peers: import('./types').Peer[];
    }>('/peers'),
  addPeer: (url: string) =>
    request<{ ok: boolean; url: string }>('/peers', { method: 'POST', body: JSON.stringify({ url }) }),
  removePeer: (url: string) =>
    request<{ ok: boolean }>('/peers', { method: 'DELETE', body: JSON.stringify({ url }) }),

  // Queue — request() prefixes /api, so these paths are the /api/queue* routes.
  getQueue: () => request<import('./types').QueueView>('/queue'),
  enqueueItem: (input: {
    kind: import('./types').QueueKind;
    payload: Record<string, unknown>;
    targets?: string[];
    lane?: string;
    // Returns the CREATED ITEM, because that is what POST /api/queue sends (201 + the item).
    // It previously declared an { ok, item, error } envelope the server never sends, so
    // `!res.ok` was true on every success and every accepted enqueue reported "rejected".
    // A rejection is a 400, which request() throws — so failure arrives as an exception,
    // not as a field.
  }) => request<import('./types').QueueItem>('/queue', { method: 'POST', body: JSON.stringify(input) }),
  cancelQueueItem: (id: string) => request<{ ok: boolean }>(`/queue/${id}`, { method: 'DELETE' }),
  /** Put a failed or cancelled item back. The server clears the attempt/stall counters and the
   *  lane halt it caused — a status reset alone would leave it queued and unable to run. */
  retryQueueItem: (id: string) => request<{ ok: boolean }>(`/queue/${id}/retry`, { method: 'POST' }),
  pauseQueueLane: (lane: string) =>
    request<{ ok: boolean }>(`/queue/lanes/${encodeURIComponent(lane)}/pause`, { method: 'POST' }),
  resumeQueueLane: (lane: string) =>
    request<{ ok: boolean }>(`/queue/lanes/${encodeURIComponent(lane)}/resume`, { method: 'POST' }),
  tickQueue: () => request<{ ok: boolean }>('/queue/tick', { method: 'POST' }),

  // Agents
  getAgents: () => request<import('./types').Agent[]>('/agents'),
  deleteAgent: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
  // Put a cartridge away / bring it back. NOT a delete and NOT a status change — the
  // session keeps running; this only controls whether you're looking at it.
  dismissAgent: (id: string) =>
    request<import('./types').Agent>(`/agents/${id}/dismiss`, { method: 'POST' }),
  restoreAgent: (id: string) =>
    request<import('./types').Agent>(`/agents/${id}/restore`, { method: 'POST' }),
  updateAgent: (id: string, data: Record<string, unknown>) =>
    request<import('./types').Agent>(`/agents/${id}`, {
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
  recoverAgentSession: (id: string) =>
    request<{ ok: boolean; reason: string; sessionId: string; promptChars: number }>(
      `/agents/${id}/recover-session`,
      { method: 'POST' },
    ),
  // Turn off the Resume offer without replaying anything.
  dismissAgentRecovery: (id: string) =>
    request<{ ok: boolean }>(`/agents/${id}/dismiss-recovery`, { method: 'POST' }),
  // Acknowledge a cartridge the work-standard gate flagged as stopping unfinished.
  clearStandardReview: (id: string) =>
    request<{ ok: boolean }>(`/agents/${id}/clear-review`, { method: 'POST' }),

  // Activity
  getActivity: (limit = 50) => request<import('./types').Activity[]>(`/activity?limit=${limit}`),

  // Permissions
  getPendingPermissions: () => request<import('./types').PermissionRequest[]>('/permissions/pending'),
  decidePermission: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) =>
    request<import('./types').PermissionRequest>('/permissions/decide', {
      method: 'POST',
      body: JSON.stringify({ id, decision, response }),
    }),

  // Agent mode
  setAgentMode: (agentId: string, mode: import('./types').AgentMode) =>
    request<import('./types').Agent>(`/trust/${agentId}/mode`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),

  setPlansIncluded: (agentId: string, plansIncluded: boolean) =>
    request<import('./types').Agent>(`/trust/${agentId}/plans-included`, {
      method: 'PUT',
      body: JSON.stringify({ plansIncluded }),
    }),

  // Commands
  /**
   * Send a prompt to a cartridge.
   *
   * `queueIfBusy` defaults to FALSE for a direct prompt, and that default was learned the
   * hard way: with it on, every message typed at a cartridge mid-turn was parked behind that
   * turn. Since a turn can run for minutes, the dashboard simply looked dead — messages went
   * in, nothing came back, and two of them sat unread in a queue nobody was watching.
   *
   * Queueing still applies where the user actually asked for it: starting a CONFER or a
   * WORKFLOW against a busy cartridge (routes/confer.ts, routes/workflows.ts default it ON).
   * Those are dispatched work with no one waiting on a reply. A conversation is not.
   *
   * Returns either the dispatched Command or { queued: true, item } — callers must handle
   * both, because "it ran" and "it is next" are different things to tell a user.
   */
  sendCommand: (
    agentId: string,
    text: string,
    includeMemory = true,
    attachments?: import('./types').CommandAttachmentInput[],
    queueIfBusy = false,
  ) =>
    request<import('./types').Command & { queued?: boolean; item?: import('./types').QueueItem; note?: string }>('/commands/send', {
      method: 'POST',
      body: JSON.stringify({ agentId, text, includeMemory, attachments, queueIfBusy }),
    }),

  // Memory
  getMemory: (agentId: string) =>
    request<import('./types').AgentMemory[]>(`/agents/${agentId}/memory`),
  addMemory: (agentId: string, data: { category: string; content: string }) =>
    request<import('./types').AgentMemory>(`/agents/${agentId}/memory`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  toggleMemory: (agentId: string, memoryId: string) =>
    request<import('./types').AgentMemory>(`/agents/${agentId}/memory/${memoryId}/toggle`, { method: 'PATCH' }),
  deleteMemory: (agentId: string, memoryId: string) =>
    request<void>(`/agents/${agentId}/memory/${memoryId}`, { method: 'DELETE' }),

  // Notes
  getNotes: (agentId: string) =>
    request<import('./types').Note[]>(`/agents/${agentId}/notes`),
  createNote: (agentId: string, content: string) =>
    request<import('./types').Note>(`/agents/${agentId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  updateNote: (agentId: string, noteId: string, content: string) =>
    request<import('./types').Note>(`/agents/${agentId}/notes/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  deleteNote: (agentId: string, noteId: string) =>
    request<void>(`/agents/${agentId}/notes/${noteId}`, { method: 'DELETE' }),

  // Command Templates
  getCommandTemplates: () => request<import('./types').CommandTemplate[]>('/command-templates'),
  createCommandTemplate: (data: { name: string; content: string; category: string }) =>
    request<import('./types').CommandTemplate>('/command-templates', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateCommandTemplate: (id: string, data: { name?: string; content?: string; category?: string }) =>
    request<import('./types').CommandTemplate>(`/command-templates/${id}`, {
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
  createRepo: (data: {
    name: string;
    parentDir: string;
    description?: string;
    isPrivate: boolean;
    agentType: string;
    owner: string;
  }) =>
    request<{ ok: boolean; path: string; repoUrl: string; launchError: string | null }>('/repos/create', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Confer (standalone multi-agent collaboration)
  startConfer: (
    participantIds: string[],
    task: string,
    attachments?: import('./types').CommandAttachmentInput[],
    opts?: { mode?: import('./types').ConferMode; isolation?: import('./types').ConferIsolation },
  ) =>
    request<import('./types').ConferSession>('/confer/start', {
      method: 'POST',
      body: JSON.stringify({ participantIds, task, attachments, mode: opts?.mode, isolation: opts?.isolation }),
    }),
  getConfers: () => request<import('./types').ConferSession[]>('/confer'),
  cancelConfer: (id: string) =>
    request<import('./types').ConferSession>(`/confer/${id}/cancel`, { method: 'POST' }),

  // GitHub accounts (gh CLI)
  getGithubAccounts: () =>
    request<{ accounts: { login: string; active: boolean }[] }>('/github/accounts'),
  switchGithubAccount: (login: string) =>
    request<{ ok: boolean; accounts: { login: string; active: boolean }[] }>('/github/switch', {
      method: 'POST',
      body: JSON.stringify({ login }),
    }),

  // Git
  getWorktrees: (agentId: string) =>
    request<import('./types').Worktree[]>(`/git/${agentId}/worktrees`),
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
  startEpic: (data: { name: string; agentId: string; tasks: { taskId: string; label?: string; taskFilePath?: string }[]; config?: Partial<import('./types').EpicRunConfig>; startPaused?: boolean }) =>
    request<import('./types').EpicRun>('/epics/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getEpicRuns: () =>
    request<import('./types').EpicRun[]>('/epics/runs'),
  getEpicRun: (id: string) =>
    request<import('./types').EpicRun>(`/epics/runs/${id}`),
  pauseEpic: (id: string) =>
    request<import('./types').EpicRun>(`/epics/runs/${id}/pause`, { method: 'POST' }),
  resumeEpic: (id: string) =>
    request<import('./types').EpicRun>(`/epics/runs/${id}/resume`, { method: 'POST' }),
  cancelEpic: (id: string) =>
    request<import('./types').EpicRun>(`/epics/runs/${id}/cancel`, { method: 'POST' }),
  skipEpicTask: (id: string) =>
    request<import('./types').EpicRun>(`/epics/runs/${id}/skip`, { method: 'POST' }),
  retryEpicTask: (id: string) =>
    request<import('./types').EpicRun>(`/epics/runs/${id}/retry`, { method: 'POST' }),

  // Workflows
  startWorkflow: (data: {
    name?: string;
    jiraTaskId?: string;
    description: string;
    players: { playerType: string; agentId?: string; name?: string; modelId?: string; roles: string[] }[];
    maxIterations?: number;
  }) =>
    request<import('./types').Workflow>('/workflows/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getWorkflows: () =>
    request<import('./types').Workflow[]>('/workflows'),
  getWorkflow: (id: string) =>
    request<import('./types').Workflow>(`/workflows/${id}`),
  pauseWorkflow: (id: string) =>
    request<import('./types').Workflow>(`/workflows/${id}/pause`, { method: 'POST' }),
  resumeWorkflow: (id: string) =>
    request<import('./types').Workflow>(`/workflows/${id}/resume`, { method: 'POST' }),
  cancelWorkflow: (id: string) =>
    request<import('./types').Workflow>(`/workflows/${id}/cancel`, { method: 'POST' }),
  deleteWorkflow: (id: string) =>
    request<void>(`/workflows/${id}`, { method: 'DELETE' }),
  recoverStep: (stepId: string) =>
    request<{ ok: boolean; reason: string; recoveryStatus?: string; attempts?: number }>(
      `/workflows/steps/${stepId}/recover`,
      { method: 'POST' }
    ),

  // Virtual Cartridges
  getVirtualCartridges: () =>
    request<import('./types').VirtualCartridge[]>('/virtual-cartridges'),
  createVirtualCartridge: (data: { name?: string; directoryPath: string }) =>
    request<import('./types').VirtualCartridge>('/virtual-cartridges', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateVirtualCartridge: (id: string, data: Record<string, unknown>) =>
    request<import('./types').VirtualCartridge>(`/virtual-cartridges/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteVirtualCartridge: (id: string) =>
    request<void>(`/virtual-cartridges/${id}`, { method: 'DELETE' }),
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
      executorType: import('./types').StepExecutorType;
      executorId?: string;
      executorConfig?: Record<string, unknown>;
      autoAdvance?: boolean;
      dependsOn?: string[];
    }[];
  }) =>
    request<{ workflow: import('./types').Workflow; steps: import('./types').WorkflowStep[] }>('/workflows/v2/create', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getWorkflowV2: (id: string) =>
    request<{ workflow: import('./types').Workflow; steps: import('./types').WorkflowStep[] }>(`/workflows/v2/${id}`),
  updateWorkflowV2: (id: string, data: {
    name: string;
    description: string;
    steps: {
      id: string;
      name: string;
      description?: string;
      positionX: number;
      positionY: number;
      executorType: import('./types').StepExecutorType;
      executorId?: string;
      executorConfig?: Record<string, unknown>;
      autoAdvance?: boolean;
      dependsOn?: string[];
    }[];
  }) =>
    request<{ workflow: import('./types').Workflow; steps: import('./types').WorkflowStep[] }>(`/workflows/v2/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  addWorkflowStep: (workflowId: string, step: {
    name: string;
    description?: string;
    positionX: number;
    positionY: number;
    executorType: import('./types').StepExecutorType;
    executorId?: string;
    executorConfig?: Record<string, unknown>;
    autoAdvance?: boolean;
    dependsOn?: string[];
  }) =>
    request<import('./types').WorkflowStep>(`/workflows/v2/${workflowId}/steps`, {
      method: 'POST',
      body: JSON.stringify(step),
    }),
  updateWorkflowStep: (workflowId: string, stepId: string, data: Record<string, unknown>) =>
    request<import('./types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteWorkflowStep: (workflowId: string, stepId: string) =>
    request<void>(`/workflows/v2/${workflowId}/steps/${stepId}`, { method: 'DELETE' }),
  // `agentId` is the run-level cartridge: it fills every step that hasn't got one, so you
  // pick once instead of naming a cartridge for each step. `agentOverrides` still wins
  // per-step, for the genuine cross-cartridge case.
  startWorkflowV2: (workflowId: string, agentOverrides?: Record<string, string>, promptOverrides?: Record<string, Record<string, string>>, initialContext?: string, projectId?: string | null, agentId?: string, attachments?: import('./types').CommandAttachmentInput[]) =>
    request<{ workflow: import('./types').Workflow; steps: import('./types').WorkflowStep[] }>(`/workflows/v2/${workflowId}/start`, {
      method: 'POST',
      body: JSON.stringify({ agentOverrides, promptOverrides, initialContext, projectId, agentId, attachments }),
    }),
  completeWorkflowStep: (workflowId: string, stepId: string, result?: string) =>
    request<import('./types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ result }),
    }),
  decideWorkflowStep: (workflowId: string, stepId: string, optionId: string) =>
    request<import('./types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ optionId }),
    }),
  advanceWorkflowStep: (workflowId: string, stepId: string) =>
    request<import('./types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/advance`, {
      method: 'POST',
    }),
  skipWorkflowStep: (workflowId: string, stepId: string) =>
    request<import('./types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/skip`, {
      method: 'POST',
    }),
  completeWorkflowV2: (workflowId: string) =>
    request<import('./types').Workflow>(`/workflows/v2/${workflowId}/complete`, { method: 'POST' }),
  getWorkflowRuns: (templateId: string) =>
    request<import('./types').Workflow[]>(`/workflows/v2/${templateId}/runs`),

  // Journal / Session Memory
  getProjects: () =>
    request<{ project: string; sessionCount: number; lastSession: string }[]>('/journal/projects'),
  getProjectSessions: (project: string, limit = 20) =>
    request<import('./types').Session[]>(`/journal/projects/${encodeURIComponent(project)}/sessions?limit=${limit}`),
  getSession: (id: string) =>
    request<import('./types').Session>(`/journal/sessions/${id}`),
  getKnowledgeFile: (project: string, filename: string) =>
    request<import('./types').ProjectKnowledge>(`/journal/projects/${encodeURIComponent(project)}/knowledge/${filename}`),
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

  // Workflow V2 — Mid-task steering
  steerWorkflowStep: (workflowId: string, stepId: string, message: string) =>
    request<{ ok: boolean; commandId: string }>(`/workflows/v2/${workflowId}/steps/${stepId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // Machines — remote cartridge launch
  getMachines: () => request<import('./types').Machine[]>('/machines'),
  launchOnMachine: (machineId: string, repoPath: string, agentType: string, context?: string) =>
    request<{ ok: boolean; sessionId: string }>(`/machines/${machineId}/launch`, {
      method: 'POST',
      body: JSON.stringify({ repoPath, agentType, ...(context ? { context } : {}) }),
    }),
  setMachineRepos: (machineId: string, repos: { path: string; name?: string }[]) =>
    request<{ ok: boolean }>(`/machines/${machineId}/repos`, {
      method: 'PUT',
      body: JSON.stringify({ repos }),
    }),
  scanMachineFolder: (machineId: string, root: string) =>
    request<{ ok: boolean }>(`/machines/${machineId}/scan`, {
      method: 'POST',
      body: JSON.stringify({ root }),
    }),

  // Journal search
  searchJournal: (query: string, project?: string) =>
    request<{ sessions: { id: string; project: string; summary: string; startedAt: string }[]; knowledge: { project: string; filename: string; snippet: string }[] }>(
      `/journal/search?q=${encodeURIComponent(query)}${project ? `&project=${encodeURIComponent(project)}` : ''}`
    ),

  // Goals
  getGoals: () => request<import('./types').Goal[]>('/goals'),
  createGoal: (data: { name: string; description?: string; successMetric?: string; tokenBudget?: number | null; budgetUsd?: number | null }) =>
    request<import('./types').Goal>('/goals', { method: 'POST', body: JSON.stringify(data) }),
  updateGoal: (id: string, data: { name?: string; description?: string; successMetric?: string; tokenBudget?: number | null; budgetUsd?: number | null; status?: string }) =>
    request<import('./types').Goal>(`/goals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGoal: (id: string) => request<void>(`/goals/${id}`, { method: 'DELETE' }),

  // Goal Projects (separate from journal projects)
  getGoalProjects: (goalId?: string) =>
    request<import('./types').Project[]>(`/projects${goalId ? `?goalId=${goalId}` : ''}`),
  getGoalProject: (id: string) =>
    request<{ project: import('./types').Project; workflows: Record<string, unknown>[] }>(`/projects/${id}`),
  createProject: (data: { name: string; description?: string; goalId?: string | null; primaryRepo?: string; color?: string; cartridges?: string[] }) =>
    request<import('./types').Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: string, data: { name?: string; description?: string; goalId?: string | null; primaryRepo?: string; color?: string; cartridges?: string[] }) =>
    request<import('./types').Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  // Assign workflow to project
  assignWorkflowProject: (workflowId: string, projectId: string | null) =>
    request<void>(`/workflows/${workflowId}/project`, { method: 'PUT', body: JSON.stringify({ projectId }) }),

  // Project learnings
  getProjectLearnings: (projectId: string, limit?: number) =>
    request<import('./types').ProjectLearning[]>(`/projects/${projectId}/learnings${limit ? `?limit=${limit}` : ''}`),

  // Heartbeats
  getHeartbeats: (projectId?: string) =>
    request<import('./types').Heartbeat[]>(`/heartbeats${projectId ? `?projectId=${projectId}` : ''}`),
  createHeartbeat: (data: {
    projectId?: string | null;
    templateId: string;
    agentId?: string;
    schedule: { type: 'hourly' | 'daily' | 'weekly'; time?: string; day?: number };
    label?: string;
    active?: boolean;
  }) => request<import('./types').Heartbeat>('/heartbeats', { method: 'POST', body: JSON.stringify(data) }),
  updateHeartbeat: (id: string, data: {
    templateId?: string;
    agentId?: string;
    schedule?: { type: 'hourly' | 'daily' | 'weekly'; time?: string; day?: number };
    label?: string;
    active?: boolean;
  }) => request<import('./types').Heartbeat>(`/heartbeats/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
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
    return request<import('./types').Task[]>(`/tasks${qs}`);
  },
  createTask: (data: { title: string; prompt?: string; projectId?: string | null; priority?: number }) =>
    request<import('./types').Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  cancelTask: (id: string) =>
    request<import('./types').Task>(`/tasks/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
  updateTask: (id: string, data: { title?: string; prompt?: string; projectId?: string | null; priority?: number }) =>
    request<import('./types').Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  dispatchTask: (id: string, agentId?: string) =>
    request<import('./types').Task>(`/tasks/${id}/dispatch`, { method: 'POST', body: JSON.stringify(agentId ? { agentId } : {}) }),
  completeTask: (id: string, status: 'done' | 'failed' = 'done', result?: string) =>
    request<import('./types').Task>(`/tasks/${id}/done`, { method: 'POST', body: JSON.stringify({ status, result }) }),
};
}
