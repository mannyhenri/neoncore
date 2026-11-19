import AsyncStorage from '@react-native-async-storage/async-storage';

/** Pre-federation key: a single server URL. Still read once, for migration. */
const LEGACY_KEY = 'neoncore.serverUrl';
const KEY = 'neoncore.servers.v1';

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

/**
 * Collapse entries that are the SAME server reached by a different name.
 *
 * One server answers on its .local hostname, its LAN IP and its Tailscale name, and
 * advertises itself to peers by whichever one it picked. Add it by hand as
 * `mac.local:4040`, then let a peer gossip it back as `192.168.4.24:4040`, and URL
 * comparison sees two servers — so every cartridge on that machine is listed twice, with
 * nothing to indicate why. `serverId` is the stable identity reported for exactly this.
 *
 * The FIRST entry wins: it is the address the phone was set up with and is known to work.
 */
function dedupe(list: ServerEntry[]): ServerEntry[] {
  const seenUrls = new Set<string>();
  const seenIds = new Set<string>();
  const out: ServerEntry[] = [];
  for (const s of list) {
    const url = normalizeUrl(s.url);
    if (!url || seenUrls.has(url)) continue;
    // An entry with no serverId has never been contacted; keep it, or a newly added
    // server would never get the chance to identify itself.
    if (s.serverId) {
      if (seenIds.has(s.serverId)) continue;
      seenIds.add(s.serverId);
    }
    seenUrls.add(url);
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
      // Servers an earlier version adopted from a peer roster (`manual: false`) are dropped:
      // NeonCore no longer links servers, so the phone keeps only the ones you gave it.
      if (Array.isArray(parsed)) return dedupe(parsed.filter((s) => s && typeof s.url === 'string' && s.manual !== false));
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

  // A server we ALREADY have, reached by another name. Rejecting it here is what stops
  // the list from doubling; matching on URL alone cannot catch it.
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

export function activeServers(servers: ServerEntry[]): ServerEntry[] {
  return servers.filter((s) => !s.hidden);
}

/**
 * What a server's GET /api/peers answer does to the list: it names the server that sent it (its
 * id, and its name unless you named it yourself). Nothing else — the roster's peers are NOT
 * adopted: NeonCore no longer links servers, and the phone talks only to the ones you added.
 */
export function applyServerIdentity(
  servers: ServerEntry[],
  from: string,
  roster: { self: { serverId?: string; name?: string } },
): ServerEntry[] {
  return servers.map((s) => {
    if (s.url !== from) return s;
    const serverId = roster.self.serverId || s.serverId;
    const name = s.manual && s.name ? s.name : roster.self.name || s.name;
    // Unchanged → the same object, so the 30 s poll does not rewrite storage for nothing.
    return serverId === s.serverId && name === s.name ? s : { ...s, serverId, name };
  });
}

// ─── Back-compat shim ───────────────────────────────────────────────────────
// The Connect flow was written against a single URL; it adds that server to the roster.

export async function saveServerUrl(url: string): Promise<void> {
  const servers = await loadServers();
  await saveServers(upsertServer(servers, { url, manual: true }));
}
