/**
 * Reaching an agent that a PEER server owns.
 *
 * A cartridge registers with exactly one server — whichever its relay's NEONCORE_URL points
 * at. Federation gossips STATE between servers, but never routed COMMANDS, so
 * `/api/agents/message` and the confer conductor could only ever talk to agents in their own
 * database. That is why a confer spanning two machines needed a human to carry every
 * message: the browser can hold connections to both servers, but a server could not hand a
 * command to its peer.
 *
 * This closes that gap. A local miss is no longer the end of the road — we ask the fleet who
 * owns the agent and forward to them, over the same authenticated channel peer-scheduler
 * already uses for gossip.
 *
 * Deliberately narrow: forwarding is ONE hop. A peer that does not own the agent does not
 * re-forward, so a cycle in the peer graph cannot turn a lost message into a storm.
 */

import { listPeers } from './federation.js';
import { getFleetToken } from './auth.js';

/** Peer calls are best-effort and must never hold up a caller; a sleeping laptop is normal. */
const PEER_TIMEOUT_MS = 4000;

function authHeaders(): Record<string, string> {
  const token = getFleetToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export interface FleetAgent {
  id: string;
  name?: string;
  status?: string;
  /** The peer that owns it. Absent/'' means this server. */
  origin?: string;
}

/**
 * Every agent this server can see, its own plus each reachable peer's.
 *
 * allSettled, never all: one unreachable peer must not blank the fleet — the same tolerance
 * the dashboard applies. Peers are asked WITHOUT recursion (`?fleet=` is not propagated), so
 * this stays one hop deep.
 */
export async function listFleetAgents(localAgents: FleetAgent[]): Promise<FleetAgent[]> {
  const peers = listPeers();
  if (peers.length === 0) return localAgents.map((a) => ({ ...a, origin: '' }));

  const results = await Promise.allSettled(
    peers.map(async (p) => {
      const res = await fetch(`${p.url}/api/agents`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as FleetAgent[];
      return list.map((a) => ({ ...a, origin: p.url }));
    }),
  );

  const remote = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  // Local wins on an id collision: this server's own view of its own agent is authoritative.
  const seen = new Set(localAgents.map((a) => a.id));
  return [
    ...localAgents.map((a) => ({ ...a, origin: '' })),
    ...remote.filter((a) => !seen.has(a.id)),
  ];
}

/** Which peer, if any, holds this agent. Null when nobody in the fleet admits to it. */
export async function findAgentOwner(agentId: string): Promise<string | null> {
  if (!agentId) return null;
  const peers = listPeers();
  if (peers.length === 0) return null;

  const results = await Promise.allSettled(
    peers.map(async (p) => {
      const res = await fetch(`${p.url}/api/agents/${encodeURIComponent(agentId)}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const agent = (await res.json()) as { id?: string };
      if (!agent?.id) throw new Error('no such agent');
      return p.url;
    }),
  );

  for (const r of results) if (r.status === 'fulfilled') return r.value;
  return null;
}

export interface ForwardResult {
  ok: boolean;
  /** The peer we reached, when we found one. */
  origin?: string;
  reason?: string;
}

/**
 * Deliver a message to an agent this server does not own.
 *
 * Returns ok:false rather than throwing — callers are dispatch paths that must keep going
 * for the other participants when one machine is asleep.
 */
export async function forwardMessageToOwner(agentId: string, message: string): Promise<ForwardResult> {
  const owner = await findAgentOwner(agentId);
  if (!owner) return { ok: false, reason: 'no peer in the fleet owns this agent' };

  try {
    // /api/commands/send is the real delivery path — the same one neoncore_message_agent
    // uses locally. /api/agents/message is the opposite direction: an agent REPORTING its
    // own last message, which would record text against the peer rather than deliver it.
    const res = await fetch(`${owner}/api/commands/send`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agentId, text: message, includeMemory: false }),
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, origin: owner, reason: `peer replied HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    // The peer accepted it, but "accepted" is not "delivered": it still needs a live relay
    // on its side. Pass that distinction through instead of flattening it to success.
    const cmd = (await res.json().catch(() => ({}))) as { delivered?: boolean };
    if (cmd?.delivered === false) {
      return { ok: false, origin: owner, reason: 'the owning server has no live command channel for it' };
    }
    return { ok: true, origin: owner };
  } catch (err) {
    return { ok: false, origin: owner, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch one agent's record from whichever peer owns it.
 *
 * The confer needs this because its participants are loaded straight from the local agents
 * table: a participant owned by a peer did not merely fail to receive messages, it silently
 * vanished from the confer, which then ran as if that machine had never been invited.
 */
export async function fetchPeerAgent(agentId: string): Promise<Record<string, unknown> | null> {
  const owner = await findAgentOwner(agentId);
  if (!owner) return null;
  try {
    const res = await fetch(`${owner}/api/agents/${encodeURIComponent(agentId)}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Deliver to an agent wherever it lives: locally if we own it, otherwise via its owner.
 *
 * The single entry point for any dispatch that must work across the fleet. Local delivery
 * stays synchronous underneath, so a single-server install pays nothing and behaves exactly
 * as before — the peer lookup only happens on a miss.
 */
export async function deliverToAgent(
  agentId: string,
  text: string,
  sendLocal: (id: string, body: string) => { delivered?: boolean } | null,
): Promise<{ delivered: boolean; origin?: string; reason?: string }> {
  const local = sendLocal(agentId, text);
  if (local && local.delivered !== false) return { delivered: true, origin: '' };

  // Known locally but with no live channel: forwarding cannot help, and pretending
  // otherwise would hide a dead relay behind a healthy-looking fleet.
  if (local) return { delivered: false, origin: '', reason: 'no live command channel on this server' };

  const forwarded = await forwardMessageToOwner(agentId, text);
  return { delivered: forwarded.ok, origin: forwarded.origin, reason: forwarded.reason };
}
