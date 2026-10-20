/**
 * A cartridge nothing can reach is not "idle".
 *
 * A relay registers an addressed inbox (the pid of the session it spawned). When the relay dies,
 * the inbox usually dies with it — and until now nothing noticed: a Claude cartridge is only
 * reaped after 24h of silence (zombie-reaper.ts), so film-engine sat `idle` for 14 hours with
 * inbox_pid 57413 pointing at a process that no longer existed. The dashboard offered it, a
 * workflow was launched onto it, and its first step failed at dispatch.
 *
 * A dead inbox pid with no relay socket is not a timer guess, it is proof: there is no road left
 * to this session. So it is acted on at once, from both places that see it — the periodic
 * sweep and the dispatch that just got refused.
 *
 * Only for cartridges on THIS machine: a pid is only meaningful on the box that issued it.
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import db from '../db.js';
import { pidIsOurs } from './inbox-client.js';
import { isLocalMachine } from './machine-locality.js';
import { markAgentSessionInterrupted } from './agent-session-state.js';
import { endSession } from './session-manager.js';
import { broadcastAgent } from '../ws.js';

/** Active cartridges on this machine whose recorded inbox is gone and that hold no relay socket. */
export function findDeadInboxes(
  database: DatabaseType,
  opts: { hasActiveSocket: (id: string) => boolean; pidAlive?: (pid: number) => boolean },
): string[] {
  if (process.platform === 'win32') return [];   // named pipes carry no pid the OS honours
  const alive = opts.pidAlive ?? pidIsOurs;
  const rows = database.prepare(
    `SELECT id, machine, inbox_pid FROM agents
      WHERE status IN ('idle', 'waiting', 'working') AND inbox_pid > 0`,
  ).all() as { id: string; machine: string; inbox_pid: number }[];
  return rows
    .filter((r) => isLocalMachine(r.machine) && !alive(r.inbox_pid) && !opts.hasActiveSocket(r.id))
    .map((r) => r.id);
}

/**
 * Take a cartridge out of the pool: offline, session interrupted and ended (so it offers Resume
 * like any other lost session), and the dead inbox forgotten. Forgetting it matters: a Claude
 * session running outside NeonCore still reports through hooks, and it must come back as a
 * hooks-only session — not as one with a "reachable inbox" that refuses every hand-off.
 */
export function markUnreachable(agentId: string, reason: 'dead-inbox' | 'inbox-refused'): boolean {
  const changed = db.prepare(
    `UPDATE agents SET status = 'offline', inbox_pid = 0, inbox_token = ''
      WHERE id = ? AND status != 'offline'`,
  ).run(agentId).changes > 0;
  if (!changed) return false;
  markAgentSessionInterrupted(agentId, 'disconnect');
  endSession(agentId);
  try { broadcastAgent(agentId, new Date().toISOString()); } catch { /* no socket server in tests */ }
  console.log(`[dead-inbox] Agent ${agentId} marked offline (${reason}) — no relay and its inbox process is gone`);
  return true;
}
