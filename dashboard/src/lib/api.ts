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
  sendCommand: (agentId: string, text: string) =>
    request<import('../types').Command>('/commands/send', {
      method: 'POST',
      body: JSON.stringify({ agentId, text }),
    }),
};
