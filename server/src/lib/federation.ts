/**
 * Federation peer roster.
 *
 * The peer list is a grow-only set of URLs. Union is the entire merge algorithm; removal
 * is a staleness rule, not consensus. There are deliberately no tombstones, no vector
 * clocks and no conflict resolution — a set of URLs does not warrant any of it, and every
 * one of those mechanisms would need its own failure handling.
 */

import db from '../db.js';
import { getServerId, getServerBaseUrl } from './server-url.js';

export interface Peer {
  url: string;
  serverId: string;
  name: string;
  version: string;
  lastOkAt: string;
  lastError: string;
  consecutiveFailures: number;
  addedAt: string;
  /** Derived, not stored: no successful contact recently enough to trust. */
  stale: boolean;
}

/** Consecutive failed pings before a peer is shown as stale. At 15s/tick this is ~1 minute. */
export const STALE_AFTER_FAILURES = 4;

/** A peer unreachable this long is dropped from the roster entirely. */
export const DROP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Canonical form of a peer URL.
 *
 * This is load-bearing for correctness, not tidiness. `http://box:4040` and
 * `http://box:4040/` are different strings, so without normalization they become two rows
 * for one server: pinged twice per tick, counted twice in the roster, and merged into the
 * client grid twice — every cartridge appearing in duplicate. The failure is completely
 * silent; nothing errors, the grid is just wrong.
 *
 * Returns null for anything that is not a usable http(s) URL, so junk from a peer's
 * gossip payload can never enter the roster.
 */
export function normalizePeerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;

  // Drop the port when it is the protocol default, so `https://h` and `https://h:443`
  // collapse to one row.
  const isDefaultPort =
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443');
  const port = isDefaultPort || !parsed.port ? '' : `:${parsed.port}`;

  // Hostnames are case-insensitive; paths are not. Keep any sub-path (a server behind a
  // reverse proxy may live under one) but strip the trailing slash.
  const path = parsed.pathname.replace(/\/+$/, '');

  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}`;
}

function rowToPeer(row: Record<string, unknown>): Peer {
  const failures = Number(row.consecutive_failures ?? 0);
  return {
    url: row.url as string,
    serverId: (row.server_id as string) ?? '',
    name: (row.name as string) ?? '',
    version: (row.version as string) ?? '',
    lastOkAt: (row.last_ok_at as string) ?? '',
    lastError: (row.last_error as string) ?? '',
    consecutiveFailures: failures,
    addedAt: (row.added_at as string) ?? '',
    stale: failures >= STALE_AFTER_FAILURES,
  };
}

export function listPeers(): Peer[] {
  const rows = db.prepare('SELECT * FROM peers ORDER BY added_at ASC').all() as Record<string, unknown>[];
  return rows.map(rowToPeer);
}

/** Just the URLs — what gets gossiped. Carries no secrets by construction. */
export function listPeerUrls(): string[] {
  return listPeers().map((p) => p.url);
}

/**
 * True if this URL is us.
 *
 * Without this a server adds itself to its own roster on the first exchange and then
 * pings itself forever: wasted ticks, a phantom extra server in every client's grid, and
 * a roster that grows by one on every restart under a new URL. We check the URL we know
 * ourselves by, plus whatever URL the caller reached us on, since a server legitimately
 * answers on several (localhost, LAN name, Tailscale name).
 */
export function isSelf(url: string, alsoKnownAs?: string[]): boolean {
  const normalized = normalizePeerUrl(url);
  if (!normalized) return false;
  const mine = [getServerBaseUrl(), ...(alsoKnownAs ?? [])]
    .map(normalizePeerUrl)
    .filter((u): u is string => Boolean(u));
  return mine.includes(normalized);
}

/**
 * Add a peer if new, or refresh what we know about it. Idempotent on the normalized URL.
 * Returns false when the URL was unusable or is us.
 */
export function addPeer(
  rawUrl: string,
  meta?: { serverId?: string; name?: string; version?: string },
  selfAliases?: string[],
): boolean {
  const url = normalizePeerUrl(rawUrl);
  if (!url) return false;
  if (isSelf(url, selfAliases)) return false;
  if (meta?.serverId && meta.serverId === getServerId()) return false; // same server, different URL

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO peers (url, server_id, name, version, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       server_id = CASE WHEN excluded.server_id != '' THEN excluded.server_id ELSE peers.server_id END,
       name      = CASE WHEN excluded.name      != '' THEN excluded.name      ELSE peers.name      END,
       version   = CASE WHEN excluded.version   != '' THEN excluded.version   ELSE peers.version   END`,
  ).run(url, meta?.serverId ?? '', meta?.name ?? '', meta?.version ?? '', now);
  return true;
}

export function removePeer(rawUrl: string): boolean {
  const url = normalizePeerUrl(rawUrl);
  if (!url) return false;
  return db.prepare('DELETE FROM peers WHERE url = ?').run(url).changes > 0;
}

export function recordPeerOk(
  rawUrl: string,
  meta?: { serverId?: string; name?: string; version?: string },
): void {
  const url = normalizePeerUrl(rawUrl);
  if (!url) return;
  db.prepare(
    `UPDATE peers SET last_ok_at = ?, last_error = '', consecutive_failures = 0,
       server_id = CASE WHEN ? != '' THEN ? ELSE server_id END,
       name      = CASE WHEN ? != '' THEN ? ELSE name      END,
       version   = CASE WHEN ? != '' THEN ? ELSE version   END
     WHERE url = ?`,
  ).run(
    new Date().toISOString(),
    meta?.serverId ?? '', meta?.serverId ?? '',
    meta?.name ?? '', meta?.name ?? '',
    meta?.version ?? '', meta?.version ?? '',
    url,
  );
}

export function recordPeerFailure(rawUrl: string, error: string): void {
  const url = normalizePeerUrl(rawUrl);
  if (!url) return;
  db.prepare(
    `UPDATE peers SET last_error = ?, consecutive_failures = consecutive_failures + 1 WHERE url = ?`,
  ).run(error.slice(0, 500), url);
}

/**
 * Drop peers unreachable for longer than DROP_AFTER_MS, and log it.
 *
 * A peer that has NEVER been reachable is measured from when it was added — otherwise a
 * URL typed with a typo would sit in the roster forever, since it has no last_ok_at to
 * age out from.
 */
export function prunePeers(now: number = Date.now()): string[] {
  const cutoff = new Date(now - DROP_AFTER_MS).toISOString();
  const doomed = db
    .prepare(
      `SELECT url FROM peers
        WHERE consecutive_failures > 0
          AND (CASE WHEN last_ok_at != '' THEN last_ok_at ELSE added_at END) < ?`,
    )
    .all(cutoff) as { url: string }[];

  for (const { url } of doomed) {
    db.prepare('DELETE FROM peers WHERE url = ?').run(url);
    console.log(`[peers] Dropped ${url} — unreachable for over 7 days`);
  }
  return doomed.map((d) => d.url);
}

/**
 * Union-merge a roster received from a peer. Returns the URLs that were new to us.
 *
 * Union is the whole algorithm: anything either side knows about, both sides end up
 * knowing about. There is no deletion to propagate, so there is nothing to conflict over.
 */
export function mergeRoster(
  incoming: unknown,
  selfAliases?: string[],
): string[] {
  if (!Array.isArray(incoming)) return [];
  const known = new Set(listPeerUrls());
  const added: string[] = [];

  for (const entry of incoming) {
    const url = normalizePeerUrl(entry);
    if (!url || known.has(url)) continue;
    if (addPeer(url, undefined, selfAliases)) {
      known.add(url);
      added.push(url);
    }
  }
  return added;
}
