import type { Agent, AgentMode, PermissionRequest, TranscriptEvent } from './types';

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

  pendingPermissions: (base: string) =>
    req<PermissionRequest[]>(base, '/api/permissions/pending'),

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
