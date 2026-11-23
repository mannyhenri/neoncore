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

/** The provider's own meter windows: the weekly limit and the rolling five-hour one. */
export type UsageWindow = 'weekly' | 'session';
export interface UsageCheckpoint {
  id: string; provider: string; window: UsageWindow; pctUsed: number;
  resetsAt: string; observedAt: string; localTokens: number;
}
/** The gauge anchored on a checkpoint — see server/src/lib/usage-checkpoint.ts. */
export interface UsageAnchor {
  provider: string; window: UsageWindow; basis: 'checkpoint' | 'rollover';
  pctUsed: number; pctAtCheckpoint: number; observedAt: string; resetsAt: string;
  pctPerDay: number; hoursToReset: number; hoursToWall: number | null; hitsWallBeforeReset: boolean;
  tokensPerPct: number | null; samples: number; pace: 'ok' | 'watch' | 'hold'; recommendation: string;
}

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
  /**
   * How long to wait for a server before giving up. Default 15s.
   *
   * NOT optional in practice. A machine that is asleep does not REFUSE a connection — it
   * accepts nothing and says nothing, so a fetch against it never settles. Every fan-out in
   * this codebase is an `allSettled`, which settles only when every member does, so a single
   * sleeping laptop hangs the whole read. That is what left the dashboard on "Connecting to
   * orchestrator..." while nine local cartridges were answering in a millisecond.
   */
  timeoutMs?: number;
}

/** Long enough for a slow LAN, short enough that a person does not conclude it is broken. */
const DEFAULT_TIMEOUT_MS = 15_000;

export type NeonCoreClient = ReturnType<typeof createClient>;

export function createClient(config: ClientConfig = {}) {
  const origin = (config.baseUrl ?? '').replace(/\/+$/, '');
  const BASE_URL = `${origin}/api`;
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * A deadline that works on EVERY runtime this client ships to.
   *
   * Built from AbortController and setTimeout rather than AbortSignal.timeout. The statics are
   * Node and browser features; Hermes — which React Native runs — supplies AbortController from
   * a polyfill that has the constructor and NOT the statics. mobile/src/api.ts learned this the
   * hard way and wrote it down: reaching for the static "would throw a TypeError on device
   * while every test on Node passed."
   *
   * The first version here guarded with `'timeout' in AbortSignal`, which avoided the TypeError
   * and replaced it with something quieter — on Hermes it returned undefined, so there was NO
   * deadline. That is the "Connecting to orchestrator" hang this deadline exists to prevent,
   * reintroduced on the one runtime where no test would catch it.
   *
   * A CALLER'S SIGNAL IS ADDED TO, NOT SUBSTITUTED FOR. `signal: options?.signal ?? deadline()`
   * meant that passing your own signal silently disabled the timeout: a caller that wanted to be
   * able to cancel gave up its protection against a server that never answers. Either may abort
   * the request now.
   *
   * `done()` must be called in a finally. An uncleared timer keeps React Native from tearing a
   * screen down cleanly, and Node never complains, so the leak is invisible where it is tested.
   */
  function deadline(callerSignal?: AbortSignal | null): {
    signal: AbortSignal;
    done: () => void;
    timedOut: () => boolean;
  } {
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);

    const forward = () => controller.abort();
    callerSignal?.addEventListener('abort', forward);

    return {
      signal: controller.signal,
      timedOut: () => expired,
      done: () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', forward);
      },
    };
  }

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
    const gate = deadline(options?.signal);
    try {
      res = await doFetch(`${BASE_URL}${path}`, {
        ...options,
        signal: gate.signal,
        headers: { ...headers, ...(options?.headers as Record<string, string>) },
      });
    } catch (err) {
      // No HTTP reply at all: refused, DNS failure, TLS rejection, aborted timeout.
      //
      // A timeout arrives as an abort, so say which it was: "Aborted" reads like the caller did
      // something and "timed out" reads like the machine did.
      if (gate.timedOut()) {
        throw asUnreachable(
          new Error(`timed out after ${timeoutMs / 1000}s — ${origin || 'this server'} accepted the connection but never answered`),
          origin,
        );
      }
      throw asUnreachable(err, origin);
    } finally {
      gate.done();
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
  getPeers: () =>
    request<{
      self: { serverId: string; name: string; url: string; version: string };
      peers: import('./types').Peer[];
    }>('/peers'),

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
  /** Dispatch a waiting item immediately, even if its cartridge is busy — the human override.
   *  409 when there is nothing to start (already running, or already finished). */
  startQueueItem: (id: string) => request<{ ok: boolean }>(`/queue/${id}/start`, { method: 'POST' }),
  /** Move a queued item one place up or down within its lane. 409 once it is running. */
  moveQueueItem: (id: string, direction: 'up' | 'down') =>
    request<{ ok: boolean }>(`/queue/${id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }),
  /** Park one item. The rest of its lane keeps running — unlike pausing the lane. */
  pauseQueueItem: (id: string) => request<{ ok: boolean }>(`/queue/${id}/pause`, { method: 'POST' }),
  resumeQueueItem: (id: string) => request<{ ok: boolean }>(`/queue/${id}/resume`, { method: 'POST' }),
  /** Remove ONE finished queue row. 409 if it is still live. */
  removeQueueItem: (id: string) => request<{ ok: boolean }>(`/queue/${id}/remove`, { method: 'DELETE' }),
  /** Remove ONE finished task. Same rule. */
  removeTask: (id: string) => request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' }),
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
  getContextOptions: (id: string) =>
    request<{
      sessions: { id: string; startedAt: string; summary: string; branch: string }[];
      hasDetails: boolean;
    }>(`/agents/${id}/context-options`),
  sendContext: (id: string, options?: {
    sessionIds?: string[];
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
   * `queueIfBusy` defaults to TRUE — the same rule as confers and workflows. A cartridge works
   * one thing at a time, so a prompt sent while it is busy lines up behind that work instead of
   * interrupting it.
   *
   * I briefly defaulted this to false after messages looked "stuck". They were not: the stall
   * was one slow turn, and turning queueing off meant new prompts INTERRUPTED work in progress —
   * the exact thing the queue exists to prevent. Restored, and the intended behaviour is now
   * asserted for all three entry points rather than two.
   *
   * Returns either the dispatched Command or { queued: true, item } — callers must handle
   * both, because "it ran" and "it is next" are different things to tell a user.
   */
  sendCommand: (
    agentId: string,
    text: string,
    includeMemory = true,
    attachments?: import('./types').CommandAttachmentInput[],
    queueIfBusy = true,
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

  // Command Templates
  getCommandTemplates: () => request<import('./types').CommandTemplate[]>('/command-templates'),

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
    opts?: {
      mode?: import('./types').ConferMode;
      isolation?: import('./types').ConferIsolation;
      /** Repeat the build/fix milestone this many times (1–20). */
      buildRounds?: number;
    },
  ) =>
    request<import('./types').ConferSession>('/confer/start', {
      method: 'POST',
      body: JSON.stringify({
        participantIds, task, attachments,
        mode: opts?.mode, isolation: opts?.isolation, buildRounds: opts?.buildRounds,
      }),
    }),
  getConfers: () => request<import('./types').ConferSession[]>('/confer'),
  cancelConfer: (id: string) =>
    request<import('./types').ConferSession>(`/confer/${id}/cancel`, { method: 'POST' }),
  resumeConfer: (id: string) =>
    request<{ ok: true; session: import('./types').ConferSession; delivered: number }>(`/confer/${id}/resume`, { method: 'POST' }),

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
  // `agentId` is the run-level cartridge: it fills every step that hasn't got one, so you
  // pick once instead of naming a cartridge for each step. `agentOverrides` still wins
  // per-step, for the genuine cross-cartridge case.
  // `conferAllSteps` is the RUN-LEVEL confer mode: name two or more cartridges and every
  // agent step of ANY workflow is worked by all of them together, whichever repo owns the
  // code taking that piece. Distinct from `agentOverrides`, which pins ONE cartridge per step.
  startWorkflowV2: (workflowId: string, agentOverrides?: Record<string, string>, promptOverrides?: Record<string, Record<string, string>>, initialContext?: string, projectId?: string | null, agentId?: string, attachments?: import('./types').CommandAttachmentInput[], conferAllSteps?: string[], conferMode?: 'divide' | 'collaborate', conferIsolation?: 'shared' | 'worktree') =>
    // A 202 means the run was QUEUED behind a busy cartridge rather than started, and the body
    // is {queued, item, note} with no workflow. Callers must check `queued` before reaching for
    // `workflow` — typing it as always-present is what turns a queued run into a silent no-op.
    request<{
      workflow?: import('./types').Workflow;
      steps?: import('./types').WorkflowStep[];
      queued?: boolean;
      item?: import('./types').QueueItem;
      note?: string;
    }>(`/workflows/v2/${workflowId}/start`, {
      method: 'POST',
      body: JSON.stringify({ agentOverrides, promptOverrides, initialContext, projectId, agentId, attachments, conferAllSteps, conferMode, conferIsolation }),
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
  /**
   * Tasks still open (server lib/coverage-loop.ts): `continue` sends the run back to the work on
   * what is left, `accept` lets it go on as it is.
   */
  resolveCoverage: (workflowId: string, stepId: string, action: 'continue' | 'accept') =>
    request<{ ok: boolean }>(`/workflows/v2/${workflowId}/steps/${stepId}/coverage`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  /** Where a task-list run has got to: summary, the engine's record, and the progress document. */
  getWorkflowProgress: (workflowId: string) =>
    request<import('./types').WorkflowProgress>(`/workflows/${workflowId}/progress`),
  skipWorkflowStep: (workflowId: string, stepId: string) =>
    request<import('./types').WorkflowStep>(`/workflows/v2/${workflowId}/steps/${stepId}/skip`, {
      method: 'POST',
    }),
  completeWorkflowV2: (workflowId: string) =>
    request<import('./types').Workflow>(`/workflows/v2/${workflowId}/complete`, { method: 'POST' }),
  // Journal / Session Memory
  getProjectSessions: (project: string, limit = 20) =>
    request<import('./types').Session[]>(`/journal/projects/${encodeURIComponent(project)}/sessions?limit=${limit}`),
  getKnowledgeFile: (project: string, filename: string) =>
    request<import('./types').ProjectKnowledge>(`/journal/projects/${encodeURIComponent(project)}/knowledge/${filename}`),
  updateKnowledgeFile: (project: string, filename: string, content: string) =>
    request<{ ok: boolean }>(`/journal/projects/${encodeURIComponent(project)}/knowledge/${filename}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  /**
   * The completion reports a project's runs produced. This is what replaced progress.md,
   * decisions.md and gotchas.md: written once per run by the agent that did the work, rather
   * than appended to on every hook.
   */
  getProjectReports: (project: string, limit = 50) =>
    request<import('./types').WorkflowReport[]>(
      `/journal/projects/${encodeURIComponent(project)}/reports?limit=${limit}`),

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

  // Fleet burn rate — the header readout. `days` is the trailing window (default 7).
  getBurnRate: (days?: number) =>
    request<{
      windowHours: number; tokens: number; tokensPerHour: number; tokensPerDay: number;
      costUsd: number; costPerDay: number; samples: number;
      days: number; since: string; activeCartridges: number;
      subscriptionUsage?: Array<{
        provider: 'claude' | 'codex'; ceilingTokens: number; tokensUsed: number;
        tokensPerDay: number; pctUsed: number; daysRemaining: number | null;
        samples: number; confidence: number; lastHitAt: string;
      }>;
      /** Anchored on what the provider displayed — absent on an older server. */
      usageAnchor?: UsageAnchor[];
    }>(`/activity/burn-rate${days ? `?days=${days}` : ''}`),

  // A reading of the provider's own meter: "62%, resets Sunday 14:00". `pctUsed` is 0..100.
  logUsageCheckpoint: (input: { provider: 'claude' | 'codex'; window?: UsageWindow; pctUsed: number; resetsAt: string; observedAt?: string }) =>
    request<{ checkpoint: UsageCheckpoint; anchor: UsageAnchor | null }>(
      '/activity/usage-checkpoints',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  getUsageCheckpoints: (provider?: 'claude' | 'codex') =>
    request<{ checkpoints: UsageCheckpoint[]; anchors: UsageAnchor[] }>(
      `/activity/usage-checkpoints${provider ? `?provider=${provider}` : ''}`,
    ),
  removeUsageCheckpoint: (id: string) =>
    request<{ ok: boolean; anchors: UsageAnchor[] }>(`/activity/usage-checkpoints/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  markTokenLimit: (provider: 'claude' | 'codex', hitAt: string) =>
    request<{ id: string; provider: string; hitAt: string; weeklyTokens: number }>(
      '/activity/token-limit-calibrations',
      { method: 'POST', body: JSON.stringify({ provider, hitAt }) },
    ),

  // Token burn over time — the reporting page. `bucket` is the granularity of each point.
  getUsageSeries: (days: number, bucket: 'hour' | 'day' | 'week') =>
    request<{
      bucket: string; days: number; from: string; to: string;
      series: { t: string; tokens: number; costUsd: number; samples: number }[];
      total: { tokens: number; costUsd: number; samples: number };
      byCartridge: { agentId: string; name: string; project: string; tokens: number; samples: number }[];
      /** Grouped by repo. Several cartridges can share one project, and often do. */
      byProject: { project: string; tokens: number; samples: number; cartridges: number }[];
    }>(`/activity/usage-series?days=${days}&bucket=${bucket}`),

  // Workflow V2 — Autonomy (N4). A raise carries its own expiry; see the route.
  getWorkflowAutonomy: (workflowId: string) =>
    request<{
      level: 'manual' | 'advance' | 'full'; source: string; expiresAt: string | null;
      resolutions: { stepId: string; reason: string; chose: string; autonomy: string }[];
    }>(`/workflows/v2/${workflowId}/autonomy`),
  setWorkflowAutonomy: (workflowId: string, level: string, durationMs?: number) =>
    request<{ ok: boolean; level: string; source: string; expiresAt: string | null }>(
      `/workflows/v2/${workflowId}/autonomy`,
      { method: 'PUT', body: JSON.stringify({ level, durationMs }) },
    ),

  // Workflow V2 — Mid-task steering
  steerWorkflowStep: (workflowId: string, stepId: string, message: string) =>
    request<{ ok: boolean; commandId: string }>(`/workflows/v2/${workflowId}/steps/${stepId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // Machines — remote cartridge launch
  getMachines: () => request<import('./types').Machine[]>('/machines'),
  // `fresh` opts OUT of the default, which is to resume the last real session for this
  // machine+repo+engine. `resumed` comes back naming the session that was picked up, or null
  // for a cold start, so the caller can say which happened instead of leaving it to be guessed.
  launchOnMachine: (
    machineId: string, repoPath: string, agentType: string, context?: string,
    opts?: { fresh?: boolean; resumeSessionId?: string },
  ) =>
    request<{ ok: boolean; sessionId: string; resumed: string | null }>(`/machines/${machineId}/launch`, {
      method: 'POST',
      body: JSON.stringify({
        repoPath, agentType,
        ...(context ? { context } : {}),
        ...(opts?.fresh ? { fresh: true } : {}),
        ...(opts?.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
      }),
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
  /** Every goal/feature, or one project's features in build order (`projectId`). */
  getGoals: (projectId?: string) => request<import('./types').Goal[]>(`/goals${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  // The intent fields are what actually reach the agents at dispatch (lib/goal-brief.ts).
  createGoal: (data: { name: string; description?: string; successMetric?: string; tokenBudget?: number | null; budgetUsd?: number | null; acceptanceCriteria?: string; noGos?: string; rabbitHoles?: string; invariants?: string; keyResults?: { metric: string; baseline?: string; target?: string; measure?: string }[]; targetDate?: string; owner?: string; investmentCategory?: string; autonomy?: string; projectId?: string }) =>
    request<import('./types').Goal>('/goals', { method: 'POST', body: JSON.stringify(data) }),
  updateGoal: (id: string, data: { name?: string; description?: string; successMetric?: string; tokenBudget?: number | null; budgetUsd?: number | null; status?: string; acceptanceCriteria?: string; noGos?: string; rabbitHoles?: string; invariants?: string; keyResults?: { metric: string; baseline?: string; target?: string; measure?: string }[]; targetDate?: string; owner?: string; investmentCategory?: string; autonomy?: string; projectId?: string; roadmapLane?: '' | 'now' | 'next' | 'later'; area?: string }) =>
    request<import('./types').Goal>(`/goals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGoal: (id: string) => request<void>(`/goals/${id}`, { method: 'DELETE' }),

  /** Cross-goal strip + the registries the goal form needs. `show` is decided server-side. */
  getPortfolio: () => request<{
    show: boolean;
    summary: import('./types').PortfolioSummary;
    categories: { key: string; label: string; hint: string }[];
    autonomyLevels: { key: string; label: string; hint: string }[];
  }>('/goals/portfolio'),

  // Assisted goal authoring. A draft is a PROPOSAL — only applyGoalDraft moves anything into
  // the goal, and only the fields it is explicitly given.
  getDraftableFields: () =>
    request<import('./types').DraftableField[]>('/goals/drafts/meta/fields'),
  getGoalDrafts: (goalId?: string) =>
    request<import('./types').GoalDraft[]>(`/goals/drafts/list${goalId ? `?goalId=${goalId}` : ''}`),
  getGoalDraft: (draftId: string) =>
    request<import('./types').GoalDraft>(`/goals/drafts/${draftId}`),
  /** Dispatches to a cartridge; the draft arrives later via MCP. 202, not a result. */
  requestGoalDraft: (data: { goalId?: string | null; seed: string; agentId: string }) =>
    request<{ draft: import('./types').GoalDraft; queued: boolean }>('/goals/drafts', {
      method: 'POST', body: JSON.stringify(data),
    }),
  // Decomposition: goal → projects → tasks. Same contract, higher stakes — accepting creates
  // rows that get dispatched to cartridges.
  getDecompositions: (goalId: string) =>
    request<import('./types').GoalDecomposition[]>(`/goals/${goalId}/decompositions`),
  getDecomposition: (id: string) =>
    request<import('./types').GoalDecomposition>(`/goals/decompositions/${id}`),
  requestDecomposition: (goalId: string, data: { seed: string; agentId: string }) =>
    request<{ decomposition: import('./types').GoalDecomposition; queued: boolean }>(
      `/goals/${goalId}/decompositions`, { method: 'POST', body: JSON.stringify(data) },
    ),
  /** The ONLY path from a proposal to real projects and tasks. */
  acceptDecomposition: (id: string, projectKeys: string[], taskKeys: string[]) =>
    request<{ createdProjects: number; createdTasks: number; createdRuns: number; skipped: string[]; decomposition: import('./types').GoalDecomposition }>(
      `/goals/decompositions/${id}/accept`, { method: 'POST', body: JSON.stringify({ projectKeys, taskKeys }) },
    ),

  /** The ONLY path from generated text to a goal. `fields` must name each accepted key. */
  applyGoalDraft: (draftId: string, fields: string[]) =>
    request<{ draft: import('./types').GoalDraft; goal: import('./types').Goal }>(
      `/goals/drafts/${draftId}/apply`, { method: 'POST', body: JSON.stringify({ fields }) },
    ),

  // Desktop notifications raised by the SERVER (OS notification centre, no browser needed).
  getDesktopNotifications: () => request<import('./types').DesktopNotificationStatus>('/push/desktop'),
  setDesktopNotifications: (mode: 'action' | 'all' | 'off') =>
    request<import('./types').DesktopNotificationStatus>('/push/desktop', { method: 'PUT', body: JSON.stringify({ mode }) }),
  /** Sends a test notice through every configured channel (desktop, phone). */
  sendTestNotification: () =>
    request<{ ok: boolean; channels: string[]; note?: string }>('/push/test', { method: 'POST', body: JSON.stringify({}) }),

  // Goal Pilot — a goal run as a managed pipeline. Planner steps are dispatched to a cartridge
  // and arrive later; these calls return the pilot as it stands.
  getGoalPilotMeta: () => request<import('./types').GoalPilotMeta>('/goal-pilots/meta'),
  getGoalPilots: (goalId?: string) =>
    request<import('./types').GoalPilot[]>(`/goal-pilots${goalId ? `?goalId=${goalId}` : ''}`),
  getGoalPilotCandidates: (goalId?: string) =>
    request<import('./types').PilotCandidateRepo[]>(`/goal-pilots/candidates${goalId ? `?goalId=${goalId}` : ''}`),
  getGoalPilotRequest: (requestId: string) =>
    request<import('./types').PilotRequest & { prompt: string }>(`/goal-pilots/requests/${requestId}`),
  /** Starts piloting: a new goal from the intake, or `goalId` for an existing one. */
  /** `projectId` files a NEW feature under that project; `goalId` pilots an existing feature. */
  /** The files attached to a feature — every cartridge its pipeline talks to gets them (server lib/feature-files.ts). */
  getFeatureFiles: (goalId: string) => request<import('./types').FeatureFile[]>(`/goals/${goalId}/files`),
  addFeatureFiles: (goalId: string, files: import('./types').CommandAttachmentInput[]) =>
    request<import('./types').FeatureFile[]>(`/goals/${goalId}/files`, { method: 'POST', body: JSON.stringify({ files }) }),
  removeFeatureFile: (goalId: string, fileId: string) => request<void>(`/goals/${goalId}/files/${fileId}`, { method: 'DELETE' }),
  /** A cartridge's full final answer, read from its transcript (server lib/final-answer.ts). */
  getFinalAnswer: (agentId: string) => request<import('./types').FinalAnswer>(`/agents/${agentId}/final-answer`),
  createGoalPilot: (data: { intake: Record<string, string>; plannerAgentId: string; goalId?: string; projectId?: string; replace?: boolean; files?: import('./types').CommandAttachmentInput[]; repos?: string[] }) =>
    request<{ pilot: import('./types').GoalPilot; goalId: string; queued: boolean; error: string | null }>(
      '/goal-pilots', { method: 'POST', body: JSON.stringify(data) },
    ),
  answerGoalPilot: (id: string, answers: Record<string, import('./types').PilotAnswer>) =>
    request<{ pilot: import('./types').GoalPilot; queued: boolean; error: string | null }>(
      `/goal-pilots/${id}/answers`, { method: 'POST', body: JSON.stringify({ answers }) },
    ),
  retryGoalPilot: (id: string, agentId?: string) =>
    request<{ pilot: import('./types').GoalPilot; queued: boolean; error: string | null }>(
      `/goal-pilots/${id}/retry`, { method: 'POST', body: JSON.stringify({ agentId }) },
    ),
  /** THE ONLY path from the planner's proposal to the goal. */
  acceptGoalPilotPlan: (id: string, data: {
    brief: Partial<import('./types').PilotBrief>; stages: Partial<import('./types').PilotProposedStage>[];
    criteria?: { text: string; expect: string; verify: import('./types').VerifyMethod }[];
  }) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/accept-plan`, { method: 'POST', body: JSON.stringify(data) }),
  reviseGoalPilotPlan: (id: string) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/revise`, { method: 'POST' }),
  /** `assignments`: stage key → repo path, or → several repo paths for a stage worked together (Confer). */
  startGoalPilot: (id: string, data: { repos: { repoPath: string; agentType: string }[]; assignments: Record<string, string | string[]>; isolate?: boolean }) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/start`, { method: 'POST', body: JSON.stringify(data) }),
  /** Every running or paused feature, as the world map draws it. */
  getActiveFeatures: () => request<import('./types').ActiveFeature[]>('/goal-pilots/active'),
  /** Push a feature's branches and open its PRs now (server lib/feature-workspace.ts). */
  openFeaturePrs: (id: string) => request<import('./types').GoalPilot>(`/goal-pilots/${id}/workspace/prs`, { method: 'POST' }),
  /** Merge every PR of the feature (all or none), then remove its worktrees, branch and cartridges. */
  mergeFeaturePrs: (id: string) => request<import('./types').GoalPilot>(`/goal-pilots/${id}/workspace/merge`, { method: 'POST' }),
  /** After merge: end the feature's worktree cartridges and remove the worktrees (`force` = even unmerged). */
  cleanupFeatureWorkspace: (id: string, force = false) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/workspace/cleanup`, { method: 'POST', body: JSON.stringify({ force }) }),
  pauseGoalPilot: (id: string) => request<import('./types').GoalPilot>(`/goal-pilots/${id}/pause`, { method: 'POST' }),
  resumeGoalPilot: (id: string) => request<import('./types').GoalPilot>(`/goal-pilots/${id}/resume`, { method: 'POST' }),
  cancelGoalPilot: (id: string) => request<import('./types').GoalPilot>(`/goal-pilots/${id}/cancel`, { method: 'POST' }),
  retryGoalPilotStage: (id: string, stageId: string) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/stages/${stageId}/retry`, { method: 'POST' }),
  skipGoalPilotStage: (id: string, stageId: string) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/stages/${stageId}/skip`, { method: 'POST' }),

  // The acceptance contract — every one of these is the PERSON's decision; no agent tool reaches them.
  /** Run the tests under review now (before any work they should fail). Results arrive by socket. */
  runAcceptanceTests: (id: string) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/run`, { method: 'POST' }),
  /** Approve & lock — locks once a fresh run shows every test red, or with `confirmPassing`. */
  approveAcceptanceTests: (id: string, confirmPassing = false) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/approve`, { method: 'POST', body: JSON.stringify({ confirmPassing }) }),
  requestAcceptanceChanges: (id: string, feedback: string) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/changes`, { method: 'POST', body: JSON.stringify({ feedback }) }),
  askAgainForAcceptanceTests: (id: string) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/request`, { method: 'POST' }),
  unlockAcceptanceCriterion: (id: string, criterionId: string, data: { reason: string; text?: string; expect?: string }) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/criteria/${criterionId}/unlock`, { method: 'POST', body: JSON.stringify(data) }),
  restoreAcceptanceTests: (id: string) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/restore`, { method: 'POST' }),
  acceptAcceptanceTestChange: (id: string, reason: string) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/accept-change`, { method: 'POST', body: JSON.stringify({ reason }) }),
  confirmAcceptanceChecklist: (id: string, confirmations: Record<string, { accepted: boolean; note?: string }>) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/checklist`, { method: 'POST', body: JSON.stringify({ confirmations }) }),
  /** A delivered feature, checked again: the locked tests now, then a fresh checklist review. Nothing is built. */
  retestAcceptance: (id: string) => request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/retest`, { method: 'POST' }),
  /** After a retest that still shows gaps: one workflow stage for exactly the criteria that do not pass. */
  addAcceptanceFixStage: (id: string) => request<import('./types').GoalPilot>(`/goal-pilots/${id}/acceptance/fix`, { method: 'POST' }),
  verifyGoalPilotStageAgain: (id: string, stageId: string) =>
    request<import('./types').GoalPilot>(`/goal-pilots/${id}/stages/${stageId}/verify`, { method: 'POST' }),
  /** Build (or rebuild) the goal report now — e.g. for a pipeline cancelled part-way. */
  buildGoalPilotReport: (id: string) =>
    request<import('./types').GoalReport>(`/goal-pilots/${id}/report`, { method: 'POST' }),

  // Goal Projects (separate from journal projects)
  getGoalProjects: (goalId?: string) =>
    request<import('./types').Project[]>(`/projects${goalId ? `?goalId=${goalId}` : ''}`),
  createProject: (data: { name: string; description?: string; goalId?: string | null; primaryRepo?: string; color?: string; cartridges?: string[] }) =>
    request<import('./types').Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: string, data: { name?: string; description?: string; goalId?: string | null; primaryRepo?: string; color?: string; cartridges?: string[]; architecture?: string; docsAutoPublish?: boolean }) =>
    request<import('./types').Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  /** Deleting a project deletes its features too, unless `keepFeatures` (they are left unfiled). */
  deleteProject: (id: string, keepFeatures = false) => request<void>(`/projects/${id}${keepFeatures ? '?keepFeatures=1' : ''}`, { method: 'DELETE' }),
  /** Add features to the end of a project's list — one or many (a pasted list). Nothing starts. */
  addProjectFeatures: (projectId: string, features: { name: string; description?: string }[]) =>
    request<{ ids: string[] }>(`/projects/${projectId}/features`, { method: 'POST', body: JSON.stringify({ features }) }),
  // The project's design system, step 1: inspiration pictures, the designer's rounds, the direction chosen.
  getDesignSystem: (projectId: string) => request<import('./types').DesignExploration>(`/design-system/${projectId}`),
  saveDesignSystem: (projectId: string, data: Omit<import('./types').DesignExploration, 'updatedAt'>) =>
    request<import('./types').DesignExploration>(`/design-system/${projectId}`, { method: 'PUT', body: JSON.stringify(data) }),
  // The designer is Claude's /design in the project's main repo: ask it for a round of four; stop waiting for one.
  requestDesign: (projectId: string, data: { note?: string; basedOn?: { roundId: string; variationId: string } | null }) =>
    request<import('./types').DesignExploration>(`/design-system/${projectId}/design`, { method: 'POST', body: JSON.stringify(data) }),
  cancelDesign: (projectId: string) => request<import('./types').DesignExploration>(`/design-system/${projectId}/design/cancel`, { method: 'POST' }),
  // Step 2: the selected direction → the whole system; then that system → every repo of the project (commit + push).
  finalizeDesignSystem: (projectId: string) => request<import('./types').DesignExploration>(`/design-system/${projectId}/finalize`, { method: 'POST' }),
  publishDesignSystem: (projectId: string) => request<import('./types').DesignExploration>(`/design-system/${projectId}/publish`, { method: 'POST' }),
  // Rewards: what each project has earned, counted from its own records.
  getRewards: () => request<{ projects: import('./types').ProjectRewards[] }>('/rewards'),
  getWorldProgress: () => request<{ totals: Record<string, number>; maps: import('./types').MapProgress[] }>('/rewards/world'),
  getProjectRewards: (projectId: string) => request<import('./types').ProjectRewards>(`/rewards/${projectId}`),
  // The roadmap: vision → epics → features on a timeline. Every write answers with the chart as it now is.
  getRoadmap: (projectId: string) => request<import('./types').RoadmapChart>(`/roadmap/${projectId}`),
  setRoadmapVision: (projectId: string, vision: string) =>
    request<import('./types').RoadmapChart>(`/roadmap/${projectId}/vision`, { method: 'PUT', body: JSON.stringify({ vision }) }),
  createEpic: (projectId: string, data: { name: string; outcome?: string; icon?: string; targetDate?: string; dependsOn?: string[] }) =>
    request<import('./types').RoadmapChart>(`/roadmap/${projectId}/epics`, { method: 'POST', body: JSON.stringify(data) }),
  updateEpic: (epicId: string, data: { name?: string; outcome?: string; icon?: string; targetDate?: string; dependsOn?: string[] }) =>
    request<import('./types').RoadmapChart>(`/roadmap/epics/${epicId}`, { method: 'PUT', body: JSON.stringify(data) }),
  /** Its features stay in the project, in no epic. */
  deleteEpic: (epicId: string) => request<import('./types').RoadmapChart>(`/roadmap/epics/${epicId}`, { method: 'DELETE' }),
  reorderEpics: (projectId: string, ids: string[]) =>
    request<import('./types').RoadmapChart>(`/roadmap/${projectId}/epics/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),
  /** Plan one feature: its epic ('' = none), its dates ('' = clear), what it waits on. Only the fields given change. */
  planFeature: (featureId: string, data: { epicId?: string; startDate?: string; targetDate?: string; dependsOn?: string[] }) =>
    request<import('./types').RoadmapChart>(`/roadmap/features/${featureId}`, { method: 'PUT', body: JSON.stringify(data) }),
  /** The living spec: every feature's intent beside the evidence for each acceptance criterion. */
  getProjectSpec: (projectId: string) => request<import('./types').ProjectSpec>(`/projects/${projectId}/spec`),
  /** The architecture page (self-contained HTML; '' when none) — the Architecture tab renders it sandboxed. */
  getArchitecturePage: (projectId: string) => request<{ html: string }>(`/projects/${projectId}/architecture`),
  /** Write docs/product/ (spec, features, roadmap, changelog, architecture) into the project's main repo. */
  publishProjectDocs: (projectId: string) =>
    request<import('./types').DocsPublishResult>(`/projects/${projectId}/docs/publish`, { method: 'POST' }),
  getProjectChangelog: (projectId: string) =>
    request<{ kinds: import('./types').ChangeKind[]; entries: import('./types').ChangelogEntry[] }>(`/projects/${projectId}/changelog`),
  addChangelogEntry: (projectId: string, data: { kind: string; title: string; body?: string }) =>
    request<import('./types').ChangelogEntry>(`/projects/${projectId}/changelog`, { method: 'POST', body: JSON.stringify(data) }),
  updateChangelogEntry: (projectId: string, entryId: string, data: { kind?: string; title?: string; body?: string }) =>
    request<import('./types').ChangelogEntry>(`/projects/${projectId}/changelog/${entryId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteChangelogEntry: (projectId: string, entryId: string) =>
    request<void>(`/projects/${projectId}/changelog/${entryId}`, { method: 'DELETE' }),
  /** Cut a release: every unreleased changelog entry ships in `version`. */
  releaseChangelog: (projectId: string, version: string) =>
    request<{ shipped: number; entries: import('./types').ChangelogEntry[] }>(`/projects/${projectId}/changelog/release`, { method: 'POST', body: JSON.stringify({ version }) }),
  getProjectImports: (projectId: string) => request<import('./types').ProjectImport[]>(`/projects/${projectId}/imports`),
  /** Ask a cartridge to read the project's repos and propose its architecture, existing features and backlog. */
  /** Ask a cartridge to take stock of the project's repos — only the `parts` named (default: all four). */
  /** With parts ['plan'] and a `document` ({ name, data: base64 }): "Plan from a document". */
  startProjectImport: (projectId: string, agentId: string, parts?: import('./types').ImportPart[], document?: { name: string; data: string }) =>
    request<{ import: import('./types').ProjectImport; queued: boolean }>(`/projects/${projectId}/imports`, { method: 'POST', body: JSON.stringify({ agentId, parts, document }) }),
  getProjectImport: (importId: string) => request<import('./types').ProjectImport>(`/project-imports/${importId}`),
  /** Keep what the person ticked: the architecture (as edited), existing features, backlog items. */
  applyProjectImport: (importId: string, data: {
    architecture?: string; architectureHtml?: boolean; features: string[]; backlog: string[]; changelog: string[];
    /** The plan: the vision as edited ('' = keep the project's), new epics and features to keep, by name. */
    vision?: string; epics?: string[]; plan?: string[];
    /** Features already on the project whose blanks to fill; project fields to keep; answers to the plan's questions. */
    updates?: string[]; project?: string[]; answers?: Record<string, { value: string; delegated: boolean }>;
  }) =>
    request<{ imp: import('./types').ProjectImport; created: { existing: string[]; planned: string[]; changelog: number; epics?: string[]; roadmap?: string[] } }>(`/project-imports/${importId}/apply`, { method: 'POST', body: JSON.stringify(data) }),
  /** The order the project's features are to be built in. */
  reorderProjectFeatures: (projectId: string, ids: string[]) =>
    request<{ ok: boolean }>(`/projects/${projectId}/features/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),

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
    // 'once' is the unchecked "Repeat?" box — scheduled for a time, then finished.
    schedule: { type: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'quarterly'; time?: string; day?: number; dayOfMonth?: number };
    label?: string;
    active?: boolean;
    /** Posture the scheduled run starts in. Defaults server-side to DEFAULT_AUTONOMY. */
    autonomy?: string;
    /** What was typed into the launch form. A scheduled run that drops it is a different run. */
    initialContext?: string;
    /** The FIRST run, from "Schedule this run". Used verbatim, not rounded to the cadence. */
    firstRunAt?: string;
    /** A scheduled CONFER: every cartridge that works it (two or more), and how. */
    conferAgentIds?: string[];
    conferMode?: string;
    conferIsolation?: string;
  }) => request<import('./types').Heartbeat>('/heartbeats', { method: 'POST', body: JSON.stringify(data) }),
  updateHeartbeat: (id: string, data: {
    templateId?: string;
    agentId?: string;
    schedule?: { type: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'quarterly'; time?: string; day?: number; dayOfMonth?: number };
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
    // Also 202-able: a task aimed at a busy cartridge is queued behind its work.
    request<import('./types').Task & { queued?: boolean; item?: import('./types').QueueItem; note?: string }>(
      `/tasks/${id}/dispatch`, { method: 'POST', body: JSON.stringify(agentId ? { agentId } : {}) }),
  completeTask: (id: string, status: 'done' | 'failed' = 'done', result?: string) =>
    request<import('./types').Task>(`/tasks/${id}/done`, { method: 'POST', body: JSON.stringify({ status, result }) }),
};
}
