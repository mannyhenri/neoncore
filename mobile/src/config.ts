import AsyncStorage from '@react-native-async-storage/async-storage';

/** Pre-federation key: a single server URL. Still read once, for migration. */
const LEGACY_KEY = 'neoncore.serverUrl';
const KEY = 'neoncore.servers.v1';

// EAS project id — required by expo-notifications to mint an Expo push token in a
// production build. Mirrors app.json → expo.extra.eas.projectId.
export const EAS_PROJECT_ID = '58c8efd5-84b8-4476-8f92-fca6bf3bf691';

/** One NeonCore server this phone talks to. */
export interface ServerEntry {
  url: string;
  name: string;
  serverId: string;
  token?: string | null;
  /** False when discovered through gossip rather than typed in by hand. */
  manual?: boolean;
  hidden?: boolean;
}

/** Normalize user input into a clean base URL (adds http://, strips trailing slash). */
export function normalizeUrl(input: string): string {
  let u = (input ?? '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, '');

  // Lowercase the host so `Studio.local` and `studio.local` cannot become two servers.
  // Every cartridge on that machine would otherwise appear twice in the list.
  const m = /^(https?:\/\/)([^/]+)(.*)$/i.exec(u);
  if (!m) return u;
  return `${m[1].toLowerCase()}${m[2].toLowerCase()}${m[3]}`;
}

export function fallbackName(url: string): string {
  const m = /^https?:\/\/([^:/]+)/i.exec(url);
  return m ? m[1].replace(/\.local$/, '') : url;
}

function dedupe(list: ServerEntry[]): ServerEntry[] {
  const seen = new Set<string>();
  const out: ServerEntry[] = [];
  for (const s of list) {
    const url = normalizeUrl(s.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...s, url, name: s.name || fallbackName(url) });
  }
  return out;
}

/**
 * Load the roster, migrating a pre-federation install on first run.
 *
 * The migration is not optional politeness. Before federation the phone stored ONE url
 * under a different key. Shipping the new key without this would drop that value on
 * upgrade and the app would boot to the Connect screen as though it had never been set
 * up — every user silently logged out of their own server by an update, with no error to
 * explain it.
 */
export async function loadServers(): Promise<ServerEntry[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return dedupe(parsed.filter((s) => s && typeof s.url === 'string'));
    } catch {
      // Corrupt storage falls through to the legacy path rather than bricking the app.
    }
  }

  const legacy = await AsyncStorage.getItem(LEGACY_KEY);
  if (legacy) {
    const url = normalizeUrl(legacy);
    const migrated: ServerEntry[] = [{ url, name: fallbackName(url), serverId: '', token: null, manual: true }];
    await saveServers(migrated);
    // The legacy key is deliberately LEFT in place: if a user downgrades, the old build
    // still finds its server. An orphaned string costs nothing.
    return migrated;
  }

  return [];
}

export async function saveServers(servers: ServerEntry[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(dedupe(servers)));
}

export function upsertServer(
  servers: ServerEntry[],
  entry: { url: string; name?: string; serverId?: string; token?: string | null; manual?: boolean },
): ServerEntry[] {
  const url = normalizeUrl(entry.url);
  if (!url) return servers;

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
      name: entry.name || fallbackName(url),
      serverId: entry.serverId ?? '',
      // Inherit the fleet token already in use — one shared secret is the whole model, so
      // retyping it per machine on a phone keyboard would be pure busywork.
      token: entry.token !== undefined ? entry.token : servers[0]?.token ?? null,
      manual: entry.manual ?? false,
      hidden: false,
    },
  ];
}

export function removeServer(servers: ServerEntry[], url: string): ServerEntry[] {
  return servers.filter((s) => s.url !== normalizeUrl(url));
}

export function setServerHidden(servers: ServerEntry[], url: string, hidden: boolean): ServerEntry[] {
  const target = normalizeUrl(url);
  return servers.map((s) => (s.url === target ? { ...s, hidden } : s));
}

/** Apply one token to every server — the fleet shares a single secret by design. */
export function setFleetToken(servers: ServerEntry[], token: string | null): ServerEntry[] {
  return servers.map((s) => ({ ...s, token }));
}

export function activeServers(servers: ServerEntry[]): ServerEntry[] {
  return servers.filter((s) => !s.hidden);
}

// ─── Back-compat shims ──────────────────────────────────────────────────────
// push.ts and the Connect flow were written against a single URL. They keep working
// against the FIRST server, which is the one the phone was originally set up with.

export async function loadServerUrl(): Promise<string | null> {
  const servers = await loadServers();
  return servers[0]?.url ?? null;
}

export async function saveServerUrl(url: string): Promise<void> {
  const servers = await loadServers();
  await saveServers(upsertServer(servers, { url, manual: true }));
}

export async function clearServerUrl(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
  await AsyncStorage.removeItem(LEGACY_KEY);
}
