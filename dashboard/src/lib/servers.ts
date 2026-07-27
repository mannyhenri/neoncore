/**
 * The set of NeonCore servers this browser talks to.
 *
 * The server that served this page is ALWAYS in the list, always first, and cannot be
 * removed — it is identified by the empty-string origin, so it keeps using the relative
 * "/api" path and the Vite dev proxy exactly as before federation existed. Everything
 * else is either added by hand or learned from that server's peer roster.
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

/**
 * Canonical form of a server URL — the browser-side twin of the server's normalizePeerUrl.
 *
 * Both sides must agree, or the same server enters the list twice: once as the user typed
 * it and once as gossip reported it. Every one of its cartridges would then render twice.
 */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  // Accept "studio.local:4040" without a scheme — nobody types http:// by choice.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;

  const isDefaultPort =
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443');
  const port = isDefaultPort || !parsed.port ? '' : `:${parsed.port}`;
  const path = parsed.pathname.replace(/\/+$/, '');

  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}`;
}

/** Best-effort display name until the server tells us its own. */
export function fallbackName(url: string): string {
  if (!url) return LOCAL_SERVER.name;
  try {
    return new URL(url).hostname.replace(/\.local$/, '');
  } catch {
    return url;
  }
}

function isSameOrigin(url: string): boolean {
  if (!url) return true;
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Collapse entries that are the SAME server reached by a different name.
 *
 * URL comparison alone cannot do this, and assuming it could was a real bug: one server
 * answers on localhost, on its .local hostname, on its LAN IP and on its Tailscale name,
 * and it advertises itself to peers by whichever `getServerBaseUrl()` picks. Browse to
 * `http://localhost:4040` while the server calls itself `http://Mac.local:4040`, let a
 * peer gossip that name back, and the app adopts your own server a second time — every
 * cartridge on it renders twice, with nothing to indicate why.
 *
 * `serverId` is the stable identity the server reports precisely for this. The FIRST
 * entry wins, which keeps the local server (always index 0) as the canonical one — it is
 * the connection already known to work.
 */
export function dedupeByServerId(servers: ServerEntry[]): ServerEntry[] {
  const seen = new Set<string>();
  const out: ServerEntry[] = [];
  for (const s of servers) {
    // An entry with no serverId yet has never been contacted; keep it, since it is the
    // only way a newly added server gets a chance to identify itself.
    if (s.serverId) {
      if (seen.has(s.serverId)) continue;
      seen.add(s.serverId);
    }
    out.push(s);
  }
  return out;
}

export function loadServers(): ServerEntry[] {
  let stored: ServerEntry[] = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) stored = parsed.filter((s) => s && typeof s.url === 'string');
    }
  } catch {
    // Corrupt storage must not brick the app into a blank grid — fall back to local only.
  }

  // The local server is re-derived rather than trusted from storage, so a stale entry can
  // never displace it. Anything that resolves to our own origin is dropped: it is the
  // same server under another name, and keeping it would duplicate every cartridge.
  const others = stored.filter((s) => s.url && !isSameOrigin(s.url));

  const seen = new Set<string>();
  const deduped: ServerEntry[] = [];
  for (const s of others) {
    const url = normalizeServerUrl(s.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    deduped.push({ ...s, url, name: s.name || fallbackName(url) });
  }

  const local = {
    ...LOCAL_SERVER,
    token: stored.find((s) => !s.url)?.token ?? null,
    // Carried across reloads so an alias of ourselves is rejected on the very first
    // discovery pass, not one render after the duplicates have already appeared.
    serverId: stored.find((s) => !s.url)?.serverId ?? '',
  };
  return dedupeByServerId([local, ...deduped]);
}

export function saveServers(servers: ServerEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
  } catch {
    // Private browsing / quota. Losing persistence is survivable; crashing is not.
  }
}

/** Add or update a server. Returns the new list, unchanged if the URL was unusable or a duplicate. */
export function upsertServer(
  servers: ServerEntry[],
  entry: { url: string; name?: string; serverId?: string; token?: string | null; manual?: boolean },
): ServerEntry[] {
  const url = normalizeServerUrl(entry.url);
  if (!url || isSameOrigin(url)) return servers;

  // A server we ALREADY have, reached by another name. Rejecting it here is what stops
  // the whole grid from doubling; matching on URL alone cannot catch it.
  if (entry.serverId && servers.some((s) => s.serverId === entry.serverId && s.url !== url)) {
    return servers;
  }

  const existing = servers.find((s) => s.url === url);
  if (existing) {
    return servers.map((s) =>
      s.url === url
        ? {
            ...s,
            // Never blank known metadata with an empty update.
            name: entry.name || s.name,
            serverId: entry.serverId || s.serverId,
            token: entry.token !== undefined ? entry.token : s.token,
            manual: s.manual || entry.manual,
          }
        : s,
    );
  }

  return [
    ...servers,
    {
      url,
      serverId: entry.serverId ?? '',
      name: entry.name || fallbackName(url),
      // A newly added server inherits the local server's token. One shared fleet secret is
      // the whole model, so making you paste it once per machine would be busywork.
      token: entry.token !== undefined ? entry.token : servers.find((s) => !s.url)?.token ?? null,
      manual: entry.manual ?? false,
      hidden: false,
    },
  ];
}

export function removeServer(servers: ServerEntry[], url: string): ServerEntry[] {
  if (!url) return servers; // the local server is not removable
  return servers.filter((s) => s.url !== url);
}

export function setServerHidden(servers: ServerEntry[], url: string, hidden: boolean): ServerEntry[] {
  return servers.map((s) => (s.url === url ? { ...s, hidden } : s));
}

/** Apply one token to every server. The fleet shares a single secret by design. */
export function setFleetToken(servers: ServerEntry[], token: string | null): ServerEntry[] {
  return servers.map((s) => ({ ...s, token }));
}

/** The servers actually queried for the grid. */
export function activeServers(servers: ServerEntry[]): ServerEntry[] {
  return servers.filter((s) => !s.hidden);
}
