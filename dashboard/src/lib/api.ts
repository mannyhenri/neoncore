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
};
