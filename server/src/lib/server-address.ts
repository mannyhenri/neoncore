/**
 * How this server is REACHED — host, port, base URL — with no database access.
 *
 * Split out of lib/server-url.ts, which also holds the federation identity (read from the
 * `settings` table). The MCP server (mcp-server.ts) needs only the URL, and importing server-url
 * pulled in db.ts — so every MCP server start, i.e. every Claude Code session with NeonCore's MCP
 * server and every step a sandbox agent reported, opened the live database and re-ran the server's
 * whole boot: migrations, and deleting and re-inserting every standard template (and deleting any
 * template a newer version retired) underneath the running server. This module must never import
 * db.ts; server-url.ts re-exports it so existing callers are unchanged.
 *
 * Precedence for the base URL:
 *   1. NEONCORE_URL   — full explicit URL, wins outright (trailing slash trimmed).
 *   2. NEONCORE_HOST  — explicit host/IP; combined with the resolved port.
 *   3. os.hostname()  — the machine's network name, ".local" appended to bare names (mDNS).
 *   4. first non-internal IPv4 address.
 *   5. "localhost"    — same-machine fallback of last resort.
 */
import os from 'os';

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
