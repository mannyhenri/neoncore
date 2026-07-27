/**
 * Gossip tick — mirrors lib/heartbeat-scheduler.ts in shape and lifecycle.
 *
 * Every 15s, ping every known peer with our roster and union in theirs. The same tick
 * yields per-server liveness for free: a peer that answers is up, one that does not is
 * counted toward staleness. No separate health check is needed.
 *
 * Cost is N² pings per tick across the fleet. Negligible at N≤10 (90 tiny requests a
 * minute fleet-wide); revisit alongside the socket ceiling if a fleet ever grows past it.
 */

import {
  listPeerUrls,
  mergeRoster,
  prunePeers,
  recordPeerFailure,
  recordPeerOk,
} from './federation.js';
import { getServerBaseUrl, getServerIdentity } from './server-url.js';
import { getFleetToken } from './auth.js';

const TICK_MS = 15_000;

/**
 * Per-peer timeout. This is the load-bearing part of the tick.
 *
 * A sleeping laptop does not refuse connections — it accepts and never answers. Without
 * an explicit timeout that request hangs until the OS gives up (minutes), so one asleep
 * machine would stall the tick, and with it liveness for every other peer. Well under
 * TICK_MS so a slow peer can never cause overlapping ticks.
 */
const PING_TIMEOUT_MS = 5_000;

let tickInterval: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function pingPeer(url: string): Promise<void> {
  const identity = getServerIdentity();
  const token = getFleetToken();

  try {
    const res = await fetch(`${url}/api/peers/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        me: getServerBaseUrl(),
        serverId: identity.serverId,
        name: identity.name,
        version: identity.version,
        peers: listPeerUrls(),
      }),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });

    if (!res.ok) {
      // 401 is worth calling out by name. It renders as "unreachable" everywhere else,
      // which sends you debugging the network when the actual fix is the token.
      const detail = res.status === 401
        ? '401 — fleet token rejected (is this peer configured with the same token?)'
        : `HTTP ${res.status}`;
      recordPeerFailure(url, detail);
      return;
    }

    const body = (await res.json()) as { self?: { serverId?: string; name?: string; version?: string }; peers?: unknown };
    recordPeerOk(url, {
      serverId: body.self?.serverId,
      name: body.self?.name,
      version: body.self?.version,
    });
    mergeRoster(body.peers);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordPeerFailure(url, message);
  }
}

export async function runPeerTick(): Promise<void> {
  // A tick that overruns must not stack on top of the next one. Each would re-ping the
  // same peers and double the fleet-wide request rate every time it happened.
  if (ticking) return;
  ticking = true;

  try {
    const peers = listPeerUrls();
    if (peers.length > 0) {
      // allSettled, never all: one unreachable peer must not abort the round and deny
      // every other peer its liveness update. Each pingPeer already swallows its own
      // errors, so this is belt-and-braces against an unexpected throw.
      await Promise.allSettled(peers.map((url) => pingPeer(url)));
    }
    prunePeers();
  } finally {
    ticking = false;
  }
}

export function startPeerScheduler(): void {
  if (tickInterval) return;
  tickInterval = setInterval(() => {
    runPeerTick().catch((err) => console.error('[peers] tick failed:', err));
  }, TICK_MS);
  console.log(`[peers] Gossip scheduler started (every ${TICK_MS / 1000}s)`);
}

export function stopPeerScheduler(): void {
  if (!tickInterval) return;
  clearInterval(tickInterval);
  tickInterval = null;
}
