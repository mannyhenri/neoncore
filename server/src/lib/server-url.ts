/**
 * Resolves the base URL that OTHER machines (and agents launched off-box) should use
 * to reach this NeonCore server.
 *
 * The server binds to 0.0.0.0, so it's reachable on the LAN — but for a long time the
 * webhook callbacks and launcher env baked in `http://localhost:<port>`. An agent that
 * runs on a different machine (or in a sandbox) would then POST its completion webhook
 * back to *its own* localhost instead of the orchestrator, and the step would hang.
 *
 * Precedence:
 *   1. NEONCORE_URL   — full explicit URL, wins outright (trailing slash trimmed).
 *   2. NEONCORE_HOST  — explicit host/IP; combined with the resolved port.
 *   3. os.hostname()  — the machine's network name (e.g. "Mannys-Mac-Pro.local" on
 *                       macOS). Bare names with no dot get ".local" appended so mDNS
 *                       can resolve them across the LAN.
 *   4. first non-internal IPv4 address.
 *   5. "localhost"    — same-machine fallback of last resort.
 */
import os from 'os';
import { randomUUID } from 'crypto';
import db from '../db.js';

/** The port the HTTP server listens on. PORT wins; NEONCORE_PORT is the legacy alias. */
export function getServerPort(): string {
  return process.env.PORT || process.env.NEONCORE_PORT || '4040';
}

function firstLanIP(): string | null {
  const interfaces = os.networkInterfaces();
  for (const devName of Object.keys(interfaces)) {
    for (const iface of interfaces[devName] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

/** A host reachable from other machines on the LAN — never a bare "localhost" unless nothing better exists. */
export function getServerHost(): string {
  const override = process.env.NEONCORE_HOST?.trim();
  if (override) return override;

  const hostname = os.hostname()?.trim();
  if (hostname && hostname.toLowerCase() !== 'localhost') {
    // macOS reports "Foo.local" already; append ".local" to bare names so mDNS resolves them.
    return hostname.includes('.') ? hostname : `${hostname}.local`;
  }

  return firstLanIP() || 'localhost';
}

/** The base URL other machines should use to reach this NeonCore server (no trailing slash). */
export function getServerBaseUrl(): string {
  const explicit = process.env.NEONCORE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return `http://${getServerHost()}:${getServerPort()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Federation identity — WHO this server is, as distinct from how to reach it.
//
// A URL cannot be the identity. It changes with DHCP, with Tailscale, with a port
// override, and a laptop legitimately answers on several at once. Peers and clients
// need one stable handle to attribute cartridges, activity and push notifications to.
// ─────────────────────────────────────────────────────────────────────────────

function readSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value?.trim() || null;
}

function writeSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

/**
 * This server's stable identity. Generated once, then persisted forever.
 *
 * It MUST survive restarts. If it were regenerated on boot, every peer and every client
 * would see a brand-new server after each restart: the old id lingers in their rosters
 * as a dead entry while the cartridges appear to migrate to a stranger. That failure is
 * completely silent — everything still "works", the grid just slowly fills with ghosts.
 */
export function getServerId(): string {
  const existing = readSetting('server_id');
  if (existing) return existing;

  const generated = randomUUID();
  writeSetting('server_id', generated);
  return generated;
}

/** Human-readable label for this server in the grid. Defaults to the machine's short hostname. */
export function getServerName(): string {
  const override = process.env.NEONCORE_SERVER_NAME?.trim() || readSetting('server_name');
  if (override) return override;
  return (os.hostname() || 'neoncore').split('.')[0];
}

/** Identity as advertised to peers and clients. */
export function getServerIdentity(): { serverId: string; name: string; url: string; version: string } {
  return {
    serverId: getServerId(),
    name: getServerName(),
    url: getServerBaseUrl(),
    version: SERVER_VERSION,
  };
}

/**
 * Protocol version, declared on every peer exchange. Per D8 this is advisory: a mismatch
 * warns, it never blocks. Refusing to federate on skew would mean one un-upgraded laptop
 * partitions the whole fleet — strictly worse than a degraded merge.
 */
export const SERVER_VERSION = '1';

/**
 * The auth header for any curl an agent is told to run against the API. Same token file the hooks
 * read (agent/hooks/_fleet.py); without it every such curl is a 401 once auth is strict.
 */
export const AUTH_CURL_HEADER = '-H "Authorization: Bearer $(cat ~/.neoncore/token)"';
