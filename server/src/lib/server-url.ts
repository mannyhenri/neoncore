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
