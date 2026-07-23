import type { Agent, AgentMode, ConferSession, Machine, PermissionRequest, TranscriptEvent, Workflow, WorkflowStep } from './types';

/** Thin REST client over the NeonCore server. All methods take the base URL. */
async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  // Some endpoints (204) have no body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  health: (base: string) => req<{ status: string }>(base, '/api/health'),

  listAgents: (base: string) => req<Agent[]>(base, '/api/agents'),

  // Transcript history — the endpoint added in Phase 2 (server/src/routes/agents.ts).
  getMessages: (base: string, agentId: string, opts?: { limit?: number; before?: string }) => {
    const q = new URLSearchParams();
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.before) q.set('before', opts.before);
    const qs = q.toString();
    return req<TranscriptEvent[]>(base, `/api/agents/${agentId}/messages${qs ? `?${qs}` : ''}`);
  },

  sendCommand: (base: string, agentId: string, text: string) =>
    req(base, '/api/commands/send', {
      method: 'POST',
      body: JSON.stringify({ agentId, text }),
    }),

  setMode: (base: string, agentId: string, mode: AgentMode) =>
    req(base, `/api/trust/${agentId}/mode`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),

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
  ) =>
    req<{ id?: string }>(base, `/api/workflows/v2/${id}/start`, {
      method: 'POST',
      body: JSON.stringify({
        agentId,
        ...(initialContext ? { initialContext } : {}),
        ...(agentOverrides && Object.keys(agentOverrides).length > 0 ? { agentOverrides } : {}),
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
  launchOnMachine: (base: string, machineId: string, repoPath: string, agentType: string, context?: string) =>
    req<{ ok: boolean; sessionId: string }>(base, `/api/machines/${machineId}/launch`, {
      method: 'POST',
      body: JSON.stringify({ repoPath, agentType, ...(context ? { context } : {}) }),
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
    opts?: { mode?: import('./types').ConferMode; isolation?: import('./types').ConferIsolation },
  ) =>
    req<ConferSession>(base, '/api/confer/start', {
      method: 'POST',
      body: JSON.stringify({ participantIds, task, mode: opts?.mode, isolation: opts?.isolation }),
    }),
  listConfers: (base: string) => req<ConferSession[]>(base, '/api/confer'),
  cancelConfer: (base: string, id: string) =>
    req<ConferSession>(base, `/api/confer/${id}/cancel`, { method: 'POST' }),

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
};
