import type { Agent, AgentMode, ConferSession, Goal, Machine, PermissionRequest, Task, TaskStatus, TranscriptEvent, Workflow, WorkflowStep } from './types';
/**
 * Queue types come from the SHARED package, not a local copy.
 *
 * mobile was not a workspace member until now, so `@neoncore/client` was unresolvable here
 * and this app hand-copied the server's types with a comment asking a human to keep them in
 * sync. Nobody does: mobile still declared six engines a day after the removal landed.
 * Importing is the mechanism that makes drift impossible rather than merely discouraged.
 */
import type { QueueItem, QueueKind, QueueLane, QueueView } from '@neoncore/client';

export type { QueueItem, QueueKind, QueueLane, QueueView };

/**
 * Fleet tokens, keyed by base URL.
 *
 * Held here rather than threaded through every method because `req` is the only place
 * that needs it — adding a token parameter to forty call sites would be forty chances to
 * forget one, and a forgotten one fails as a 401 that reads like an unreachable server.
 */
const tokens = new Map<string, string>();

export function setServerToken(base: string, token: string | null | undefined): void {
  if (token) tokens.set(base, token);
  else tokens.delete(base);
}

/**
 * Typed enough to tell a rejected token from an unreachable machine.
 *
 * On a phone this distinction matters more than on a desktop: "can't reach the server" is
 * the expected state half the time (asleep, off Wi-Fi, on cellular), so a token problem
 * hiding inside that message would never be noticed.
 */
export class ApiError extends Error {
  readonly kind: 'unreachable' | 'auth' | 'server' | 'bad';
  readonly status: number | null;
  constructor(kind: ApiError['kind'], message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * How long to wait for a server before calling it unreachable.
 *
 * `fetch` has no timeout, and on a phone that is the difference between an error and a
 * hang. A machine that is OFF refuses the connection immediately; a machine that is
 * asleep, moved, or wedged accepts it and then says nothing, and iOS will sit on that for
 * more than a minute. Every screen bound to one server shows a spinner for the whole
 * wait, which is indistinguishable from the app being broken.
 *
 * The phone auto-adopts peers, so it WILL be pointed at such a machine eventually — this
 * fleet already advertises one with thousands of consecutive timeouts. Twelve seconds is
 * long enough for a loaded server on slow Wi-Fi and short enough to still feel like an
 * answer. Mutable so tests can shorten it.
 */
export const requestConfig = { timeoutMs: 12_000 };

/** Thin REST client over the NeonCore server. All methods take the base URL. */
async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const token = tokens.get(base);
  let res: Response;

  // Built from AbortController rather than AbortSignal.timeout/any: those are Node and
  // browser statics, and this runs on Hermes, whose AbortController comes from a polyfill
  // that has the constructor but not the statics. Reaching for them here would throw a
  // TypeError on device while every test on Node passed.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestConfig.timeoutMs);
  // A caller's own signal still cancels — the timeout is added to it, not substituted.
  const callerSignal = init?.signal;
  const forwardAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', forwardAbort);

  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers || {}),
      },
    });
  } catch (err) {
    // A timeout arrives as an abort. Said plainly, because "Aborted" reads like the user
    // did something and "timed out" reads like the machine did.
    if (timedOut) {
      throw new ApiError(
        'unreachable',
        `timed out after ${requestConfig.timeoutMs / 1000}s — ${base} accepted the connection but never answered`,
      );
    }
    throw new ApiError('unreachable', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const message = `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`;
    const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'server' : 'bad';
    throw new ApiError(kind, message, res.status);
  }
  // Some endpoints (204) have no body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export type UsageBucket = 'hour' | 'day' | 'week';

export type UsageWindow = 'weekly' | 'session';
export interface UsageCheckpoint {
  id: string; provider: string; window: UsageWindow; pctUsed: number;
  resetsAt: string; observedAt: string; localTokens: number;
}
export interface UsageAnchor {
  provider: string; window: UsageWindow; basis: 'checkpoint' | 'rollover';
  pctUsed: number; pctAtCheckpoint: number; observedAt: string; resetsAt: string;
  pctPerDay: number; hoursToReset: number; hoursToWall: number | null; hitsWallBeforeReset: boolean;
  tokensPerPct: number | null; samples: number; pace: 'ok' | 'watch' | 'hold'; recommendation: string;
}

export interface BurnRate {
  windowHours: number; tokens: number; tokensPerHour: number; tokensPerDay: number;
  costUsd: number; costPerDay: number; samples: number;
  days: number; since: string; activeCartridges: number;
  /** Anchored on what the provider displayed — absent on an older server. */
  usageAnchor?: UsageAnchor[];
}

export interface UsageSeries {
  bucket: string; days: number; from: string; to: string;
  series: { t: string; tokens: number; costUsd: number; samples: number }[];
  total: { tokens: number; costUsd: number; samples: number };
  byCartridge: { agentId: string; name: string; project: string; tokens: number; samples: number }[];
  /** Grouped by repo, not by cartridge — several cartridges can share one project. */
  byProject: { project: string; tokens: number; samples: number; cartridges: number }[];
}

export const api = {
  health: (base: string) => req<{ status: string }>(base, '/api/health'),

  // ── Token usage ────────────────────────────────────────────────────────────
  //
  // Added ahead of the client migration (C2/C3 in docs/plans/ios-parity.md) because the
  // reporting screen was asked for twice and the migration is 62 call sites. These two are
  // deliberately shaped EXACTLY like packages/client's getBurnRate/getUsageSeries so the
  // migration is a delete, not a rewrite.
  burnRate: (base: string, days?: number) =>
    req<BurnRate>(base, `/api/activity/burn-rate${days ? `?days=${days}` : ''}`),

  usageSeries: (base: string, days: number, bucket: UsageBucket) =>
    req<UsageSeries>(base, `/api/activity/usage-series?days=${days}&bucket=${bucket}`),

  // A reading of the provider's own meter, typed in from the phone. `pctUsed` is 0..100.
  logUsageCheckpoint: (base: string, input: { provider: 'claude' | 'codex'; window?: UsageWindow; pctUsed: number; resetsAt: string }) =>
    req<{ checkpoint: UsageCheckpoint; anchor: UsageAnchor | null }>(base, '/api/activity/usage-checkpoints', {
      method: 'POST', body: JSON.stringify(input),
    }),
  getUsageCheckpoints: (base: string, provider?: 'claude' | 'codex') =>
    req<{ checkpoints: UsageCheckpoint[]; anchors: UsageAnchor[] }>(base, `/api/activity/usage-checkpoints${provider ? `?provider=${provider}` : ''}`),
  removeUsageCheckpoint: (base: string, id: string) =>
    req<{ ok: boolean; anchors: UsageAnchor[] }>(base, `/api/activity/usage-checkpoints/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** This server's identity plus every peer it knows — how the phone finds the fleet. */
  getPeers: (base: string) =>
    req<{
      self: { serverId: string; name: string; url: string; version: string };
      peers: { url: string; serverId: string; name: string; stale: boolean }[];
    }>(base, '/api/peers'),

  listAgents: (base: string) => req<Agent[]>(base, '/api/agents'),

  // Transcript history — the endpoint added in Phase 2 (server/src/routes/agents.ts).
  getMessages: (base: string, agentId: string, opts?: { limit?: number; before?: string }) => {
    const q = new URLSearchParams();
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.before) q.set('before', opts.before);
    const qs = q.toString();
    return req<TranscriptEvent[]>(base, `/api/agents/${agentId}/messages${qs ? `?${qs}` : ''}`);
  },

  // Queues when the cartridge is busy, same as confers and workflows: one thing at a time.
  sendCommand: (base: string, agentId: string, text: string, queueIfBusy = true) =>
    req<{ queued?: boolean; note?: string }>(base, '/api/commands/send', {
      method: 'POST',
      body: JSON.stringify({ agentId, text, queueIfBusy }),
    }),

  setMode: (base: string, agentId: string, mode: AgentMode) =>
    req(base, `/api/trust/${agentId}/mode`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),

  // Session recovery after a crash/interruption: replay the last transcript, or dismiss the
  // offer without replaying. Mirrors the web CartridgeCard resume/dismiss.
  recoverAgentSession: (base: string, agentId: string) =>
    req<{ ok: boolean; sessionId: string; promptChars: number }>(
      base, `/api/agents/${agentId}/recover-session`, { method: 'POST' },
    ),
  dismissAgentRecovery: (base: string, agentId: string) =>
    req<{ ok: boolean }>(base, `/api/agents/${agentId}/dismiss-recovery`, { method: 'POST' }),

  // Acknowledge a cartridge the work-standard gate flagged as having stopped unfinished.
  clearStandardReview: (base: string, agentId: string) =>
    req<{ ok: boolean }>(base, `/api/agents/${agentId}/clear-review`, { method: 'POST' }),

  // Put a cartridge away / bring it back. NOT a delete, and NOT a status change — the session
  // keeps running. It reappears on its own the next time the agent does anything.
  dismissAgent: (base: string, agentId: string) =>
    req<Agent>(base, `/api/agents/${agentId}/dismiss`, { method: 'POST' }),

  restoreAgent: (base: string, agentId: string) =>
    req<Agent>(base, `/api/agents/${agentId}/restore`, { method: 'POST' }),

  pendingPermissions: (base: string) =>
    req<PermissionRequest[]>(base, '/api/permissions/pending'),

  // Workflow templates (templateId === null) — the library you can launch from.
  listWorkflowTemplates: (base: string) =>
    req<Workflow[]>(base, '/api/workflows?templates=true'),

  // Active/recent runs (cloned from a template).
  listWorkflowRuns: (base: string) => req<Workflow[]>(base, '/api/workflows?runs=true'),

  // Starting a template clones it into a fresh run and kicks it off.
  //
  // `agentId` is REQUIRED in practice: template steps ship with executor `__deferred__`
  // ("ask at launch"). Without it those steps have no cartridge and the run used to hang
  // silently at step 1 forever. The server now fills every unassigned step with this one.
  // `agentOverrides` ({ stepId -> agentId }) pins specific steps to specific cartridges —
  // the fan-out escape hatch (step 1 -> Claude, step 2 -> Codex). It wins over the run-level
  // `agentId`, which still fills every step left unassigned.
  startWorkflow: (
    base: string,
    id: string,
    agentId: string,
    initialContext?: string,
    agentOverrides?: Record<string, string>,
    // Run-level confer: two or more cartridges work EVERY agent step together.
    conferAllSteps?: string[],
  ) =>
    req<{ id?: string }>(base, `/api/workflows/v2/${id}/start`, {
      method: 'POST',
      body: JSON.stringify({
        agentId,
        ...(initialContext ? { initialContext } : {}),
        ...(agentOverrides && Object.keys(agentOverrides).length > 0 ? { agentOverrides } : {}),
        ...(conferAllSteps && conferAllSteps.length > 0 ? { conferAllSteps } : {}),
      }),
    }),

  // ─── V2 (canvas) workflow runs ───────────────────────────────
  // A run's steps, with which cartridge each runs on and its live status.
  getWorkflowV2: (base: string, id: string) =>
    req<{ workflow: Workflow; steps: WorkflowStep[] }>(base, `/api/workflows/v2/${id}`),

  // Mark a running step complete (the "Mark complete" button on the web canvas).
  completeWorkflowStep: (base: string, id: string, stepId: string, result?: string) =>
    req<WorkflowStep>(base, `/api/workflows/v2/${id}/steps/${stepId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ result: result ?? 'Marked complete from mobile' }),
    }),

  // Skip a step so its dependents unblock.
  skipWorkflowStep: (base: string, id: string, stepId: string) =>
    req<WorkflowStep>(base, `/api/workflows/v2/${id}/steps/${stepId}/skip`, { method: 'POST' }),

  // For a completed step with auto-advance off — let dependents proceed.
  advanceWorkflowStep: (base: string, id: string, stepId: string) =>
    req<WorkflowStep>(base, `/api/workflows/v2/${id}/steps/${stepId}/advance`, { method: 'POST' }),

  // Answer a `decision` step by choosing one of its options.
  decideWorkflowStep: (base: string, id: string, stepId: string, optionId: string) =>
    req<WorkflowStep>(base, `/api/workflows/v2/${id}/steps/${stepId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ optionId }),
    }),

  // Inject a mid-task message to the cartridge running a step ("Steer" on the web).
  steerWorkflowStep: (base: string, id: string, stepId: string, message: string) =>
    req<{ ok: boolean; commandId: string }>(base, `/api/workflows/v2/${id}/steps/${stepId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // Resume a step the server marked interrupted (crash/recovery path).
  recoverStep: (base: string, stepId: string) =>
    req<{ ok: boolean; recoveryStatus?: string }>(base, `/api/workflows/steps/${stepId}/recover`, {
      method: 'POST',
    }),

  // Machines — remote cartridge launch. Lists computers running the runner daemon and
  // dispatches a launch to one of them.
  getMachines: (base: string) => req<Machine[]>(base, '/api/machines'),
  launchOnMachine: (
    base: string, machineId: string, repoPath: string, agentType: string, context?: string,
    opts?: { fresh?: boolean },
  ) =>
    req<{ ok: boolean; sessionId: string; resumed: string | null }>(base, `/api/machines/${machineId}/launch`, {
      method: 'POST',
      body: JSON.stringify({
        repoPath, agentType,
        ...(context ? { context } : {}),
        ...(opts?.fresh ? { fresh: true } : {}),
      }),
    }),
  setMachineRepos: (base: string, machineId: string, repos: { path: string; name?: string }[]) =>
    req<{ ok: boolean }>(base, `/api/machines/${machineId}/repos`, {
      method: 'PUT',
      body: JSON.stringify({ repos }),
    }),
  scanMachineFolder: (base: string, machineId: string, root: string) =>
    req<{ ok: boolean }>(base, `/api/machines/${machineId}/scan`, {
      method: 'POST',
      body: JSON.stringify({ root }),
    }),

  // Register / unregister this device's Expo push token so the server can notify it
  // when a workflow finishes.
  registerPushToken: (base: string, token: string, platform: string) =>
    req<{ ok: boolean }>(base, '/api/push/register', {
      method: 'POST',
      body: JSON.stringify({ token, platform }),
    }),
  unregisterPushToken: (base: string, token: string) =>
    req<{ ok: boolean }>(base, '/api/push/unregister', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  // Run-level controls.
  pauseWorkflow: (base: string, id: string) =>
    req<Workflow>(base, `/api/workflows/${id}/pause`, { method: 'POST' }),
  resumeWorkflow: (base: string, id: string) =>
    req<Workflow>(base, `/api/workflows/${id}/resume`, { method: 'POST' }),
  cancelWorkflow: (base: string, id: string) =>
    req<Workflow>(base, `/api/workflows/${id}/cancel`, { method: 'POST' }),

  // Confer — milestone-driven multi-agent collaboration. `start` kicks off the server-side
  // conductor; it runs the whole cycle and pushes progress over the confer_updated socket.
  startConfer: (
    base: string,
    participantIds: string[],
    task: string,
    opts?: {
      mode?: import('./types').ConferMode;
      isolation?: import('./types').ConferIsolation;
      /** Repeat the build/fix milestone this many times (1–20). */
      buildRounds?: number;
    },
  ) =>
    req<ConferSession>(base, '/api/confer/start', {
      method: 'POST',
      body: JSON.stringify({
        participantIds, task,
        mode: opts?.mode, isolation: opts?.isolation, buildRounds: opts?.buildRounds,
      }),
    }),
  listConfers: (base: string) => req<ConferSession[]>(base, '/api/confer'),
  cancelConfer: (base: string, id: string) =>
    req<ConferSession>(base, `/api/confer/${id}/cancel`, { method: 'POST' }),

  // ─── Goals ───────────────────────────────────────────────────────────────
  // Read plus the one write a phone should own. Drafting and decomposition stay on the
  // desk: both are multi-field authoring against a proposal, and a goal's intent reaches
  // working cartridges at dispatch, so accepting one on a small screen by mistake is
  // expensive in a way that pausing a goal is not.

  /** Every goal, already carrying progress, health, reach, cost and schedule. */
  listGoals: (base: string) => req<Goal[]>(base, '/api/goals'),

  getGoal: (base: string, id: string) => req<Goal>(base, `/api/goals/${id}`),

  /** Pause, resume, or mark achieved — a one-tap decision, which is phone work. */
  setGoalStatus: (base: string, id: string, status: 'active' | 'paused' | 'achieved') =>
    req<Goal>(base, `/api/goals/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }),

  // ─── Tasks ───────────────────────────────────────────────────────────────

  /** `goalId` is what links the two screens: a goal's own tasks, without a second concept. */
  listTasks: (base: string, filters?: { status?: TaskStatus; goalId?: string; agentId?: string }) => {
    const q = new URLSearchParams();
    if (filters?.status) q.set('status', filters.status);
    if (filters?.goalId) q.set('goalId', filters.goalId);
    if (filters?.agentId) q.set('agentId', filters.agentId);
    const qs = q.toString();
    return req<Task[]>(base, `/api/tasks${qs ? `?${qs}` : ''}`);
  },

  /**
   * Send a task to a cartridge. Omit agentId and the server picks one for the project.
   *
   * 409 is not a failure here, it is the DEPENDENCY GATE answering: the task has an
   * unfinished prerequisite. The server sends `blocked` and a `hint` saying so, and the
   * caller is expected to show them and offer `force` rather than retry blindly — the gate
   * exists precisely to make overriding it a deliberate act.
   */
  dispatchTask: (base: string, id: string, opts?: { agentId?: string; force?: boolean }) =>
    req<Task & { queued?: boolean; note?: string }>(base, `/api/tasks/${id}/dispatch`, {
      method: 'POST',
      body: JSON.stringify({
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
        ...(opts?.force ? { force: true } : {}),
      }),
    }),

  cancelTask: (base: string, id: string) =>
    req<Task>(base, `/api/tasks/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),

  /**
   * Settle a task by hand — the desk's "Mark done" / "Mark failed".
   *
   * A cartridge normally reports its own result, so this is the escape hatch for work that
   * finished somewhere the fleet cannot see, or that will never finish. Without it a task
   * that drifted out of `queued` was inert on the phone: no way to start it, no way to end it.
   */
  completeTask: (base: string, id: string, status: 'done' | 'failed' = 'done', result?: string) =>
    req<Task>(base, `/api/tasks/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ status, ...(result ? { result } : {}) }),
    }),

  /**
   * Clear a finished task. The server refuses anything still live ("only a finished task can
   * be cleared — cancel it first"), so a stale list on a phone cannot delete work in flight.
   */
  removeTask: (base: string, id: string) =>
    req<{ ok: boolean }>(base, `/api/tasks/${id}`, { method: 'DELETE' }),

  // New repo — scaffold a folder on the server host, git init, gh repo create + push, and
  // (optionally) launch an agent. parentDir/owner default server-side (projects_dir / active
  // gh account), so the phone only needs a name + a couple of choices.
  createRepo: (
    base: string,
    data: { name: string; description?: string; isPrivate: boolean; agentType: string },
  ) =>
    req<{ ok: boolean; path: string; repoUrl: string; launchError: string | null }>(base, '/api/repos/create', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // decision: 'allowed' | 'denied'. `response` carries AskUserQuestion answers
  // or ExitPlanMode feedback (string or object).
  decidePermission: (
    base: string,
    id: string,
    decision: 'allowed' | 'denied',
    response?: string | object,
  ) =>
    req(base, '/api/permissions/decide', {
      method: 'POST',
      body: JSON.stringify({ id, decision, response }),
    }),

  // Queue — view, enqueue, start, cancel. Pausing a LANE is desk work and stays on the portal;
  // starting one waiting ITEM is not, so it lives here too.
  getQueue: (base: string) => req<QueueView>(base, '/api/queue'),
  cancelQueueItem: (base: string, id: string) =>
    req<{ ok: boolean }>(base, `/api/queue/${id}`, { method: 'DELETE' }),
  /** Run a waiting item now, even if its cartridge is busy — the human override. This is the
   *  action you most want from a phone: you can see what is holding the lane, and say go. */
  startQueueItem: (base: string, id: string) =>
    req<{ ok: boolean }>(base, `/api/queue/${id}/start`, { method: 'POST' }),
  /** Reorder one place within the lane. Phone-shaped: you see the list and shuffle it. */
  moveQueueItem: (base: string, id: string, direction: 'up' | 'down') =>
    req<{ ok: boolean }>(base, `/api/queue/${id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }),
  /** Park one item; the rest of its lane keeps draining. */
  pauseQueueItem: (base: string, id: string) =>
    req<{ ok: boolean }>(base, `/api/queue/${id}/pause`, { method: 'POST' }),
  resumeQueueItem: (base: string, id: string) =>
    req<{ ok: boolean }>(base, `/api/queue/${id}/resume`, { method: 'POST' }),
  retryQueueItem: (base: string, id: string) =>
    req<{ ok: boolean }>(base, `/api/queue/${id}/retry`, { method: 'POST' }),
  /** Remove ONE finished row. The server refuses anything still live. */
  removeQueueItem: (base: string, id: string) =>
    req<{ ok: boolean }>(base, `/api/queue/${id}/remove`, { method: 'DELETE' }),

  // ── Project memory ────────────────────────────────────────────────────────
  // The same four knowledge files and the same note CRUD the web panel offers, so a fix
  // typed on a phone lands in the place the next agent actually reads. Session history and
  // journal search are deliberately absent — see NOT_ON_MOBILE in mobile-memory-parity.test.ts.
  getKnowledgeFile: (base: string, project: string, filename: string) =>
    req<{ project: string; filename: string; content: string; updatedAt: string }>(
      base, `/api/journal/projects/${encodeURIComponent(project)}/knowledge/${encodeURIComponent(filename)}`),
  updateKnowledgeFile: (base: string, project: string, filename: string, content: string) =>
    req<{ ok: boolean }>(base, `/api/journal/projects/${encodeURIComponent(project)}/knowledge/${encodeURIComponent(filename)}`, {
      method: 'PUT', body: JSON.stringify({ content }),
    }),
  getProjectNotes: (base: string, project: string) =>
    req<ProjectNote[]>(base, `/api/journal/projects/${encodeURIComponent(project)}/notes`),
  createProjectNote: (base: string, project: string, content: string) =>
    req<ProjectNote>(base, `/api/journal/projects/${encodeURIComponent(project)}/notes`, {
      method: 'POST', body: JSON.stringify({ content }),
    }),
  updateProjectNote: (base: string, project: string, noteId: string, content: string) =>
    req<ProjectNote>(base, `/api/journal/projects/${encodeURIComponent(project)}/notes/${noteId}`, {
      method: 'PUT', body: JSON.stringify({ content }),
    }),
  deleteProjectNote: (base: string, project: string, noteId: string) =>
    req<{ ok: boolean }>(base, `/api/journal/projects/${encodeURIComponent(project)}/notes/${noteId}`, { method: 'DELETE' }),
};

export interface ProjectNote {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
