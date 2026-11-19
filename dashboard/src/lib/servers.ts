/**
 * The NeonCore server this browser talks to — the one that served this page.
 *
 * It is identified by the empty-string origin, so it uses the relative "/api" path and the Vite
 * dev proxy. The dashboard used to merge several servers (added by hand, or learned from a peer
 * roster) into one grid; NeonCore no longer links servers, so the list is this server alone.
 * Whatever an earlier version stored is ignored, except the fleet token entered for this server.
 * The list shape stays because the polling, sockets and per-server buffers are written over it.
 */

import type { ServerEntry } from '@neoncore/client';

const STORAGE_KEY = 'neoncore.servers.v1';

/** The server that served this app. Empty url == same origin. */
export const LOCAL_SERVER: ServerEntry = {
  url: '',
  serverId: '',
  name: 'This machine',
  token: null,
  manual: true,
};

/** Best-effort display name until the server tells us its own. */
export function fallbackName(url: string): string {
  if (!url) return LOCAL_SERVER.name;
  try {
    return new URL(url).hostname.replace(/\.local$/, '');
  } catch {
    return url;
  }
}

/** This server, with the fleet token stored for it (if any). */
export function loadServers(): ServerEntry[] {
  let token: string | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) token = parsed.find((s) => s && s.url === '')?.token ?? null;
  } catch {
    // Corrupt storage must not brick the app — no token is the safe default.
  }
  return [{ ...LOCAL_SERVER, token }];
}

export function saveServers(servers: ServerEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers.filter((s) => s.url === '')));
  } catch {
    // Storage full or disabled — the token simply will not persist across reloads.
  }
}

export function setFleetToken(servers: ServerEntry[], token: string | null): ServerEntry[] {
  return servers.map((s) => ({ ...s, token }));
}

/** The servers actually queried for the grid. */
export function activeServers(servers: ServerEntry[]): ServerEntry[] {
  return servers.filter((s) => !s.hidden);
}
