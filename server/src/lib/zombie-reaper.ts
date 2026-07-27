/**
 * Which cartridges are actually dead.
 *
 * An agent going quiet does NOT mean it died. Death is REPORTED, not inferred:
 *   - SessionEnd hook   → POST /api/agents/session-end   (the honest signal)
 *   - socket disconnect → markAgentOffline                (relay / VS Code extension)
 *   - relay SIGTERM     → POST /api/agents/interrupted
 *
 * This reaper is the backstop for sessions killed in a way that fires none of those:
 * kill -9, terminal window closed, laptop slept.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE THRESHOLD DEPENDS ON THE AGENT TYPE
 *
 * The 24h window exists because Claude Code CAN report its own death, so silence is
 * genuinely ambiguous — a session quiet for six hours is very likely still sitting open in
 * a terminal. Reaping it early is the bug that made cartridges vanish while in use, which
 * is why the threshold was raised from 5 minutes.
 *
 * But that reasoning does not transfer. Only `agent/hooks/reporter.py` posts session-end.
 * The codex, gemini, amazonq and cursor reporters have no such path at all, because those
 * CLIs have no SessionEnd-equivalent hook to attach one to. For them, silence is the ONLY
 * signal that will ever arrive. Giving them 24h does not protect a live session — it just
 * guarantees a full day of ghost cartridges for sessions that ended the moment you pressed
 * Ctrl-C, with nothing in the UI to say so.
 *
 * So: honest reporters keep the long, forgiving window. Silent ones get a shorter one that
 * still comfortably outlasts a lunch break.
 *
 * A false reap is not destructive — it marks the row offline and ends the session record.
 * The cartridge stays visible in the grid, and the next event from that agent re-registers
 * it. Anything holding a live socket is exempt regardless of type or age.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Database as DatabaseType } from 'better-sqlite3';

/** Sessions quiet this long are reaped when their agent CAN report death but did not. */
export const ZOMBIE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Sessions quiet this long are reaped when their agent CANNOT report death.
 *
 * Two hours: long enough to survive lunch, a meeting, or a long build, short enough that
 * ghosts clear within the same working session rather than the next day.
 */
export const SILENT_ZOMBIE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/**
 * Agent types with a working death signal.
 *
 *  - claude    → agent/hooks/reporter.py posts /api/agents/session-end on SessionEnd.
 *                (The reporter.sh fallback does not, so claude stays on the LONG window:
 *                when unsure, never reap early.)
 *  - gridlight → holds a socket; ws.ts marks it offline on disconnect.
 *
 * Everything else is hooks-only with no session-end path. Verify before adding a type
 * here: `grep -l session-end agent/hooks/*`.
 */
export const DEATH_REPORTING_TYPES = new Set(['claude', 'gridlight']);

export function zombieThresholdFor(agentType: string | null | undefined): number {
  const type = (agentType || 'claude').toLowerCase();
  // Unknown types default to the LONG window. A new agent type showing up here should
  // linger rather than have its live sessions culled by a rule written before it existed.
  return DEATH_REPORTING_TYPES.has(type) || !isKnownType(type)
    ? ZOMBIE_THRESHOLD_MS
    : SILENT_ZOMBIE_THRESHOLD_MS;
}

const KNOWN_TYPES = new Set(['claude', 'gridlight', 'gemini', 'amazonq', 'codex', 'cursor']);
function isKnownType(type: string): boolean {
  return KNOWN_TYPES.has(type);
}

export interface ZombieCandidate {
  id: string;
  agentType: string;
  lastSeen: string;
  ageMs: number;
  thresholdMs: number;
}

/**
 * Agents that are demonstrably dead: past their type's threshold AND holding no socket.
 *
 * `hasActiveSocket` is injected so this stays pure and testable — a live connection is
 * proof of life that outranks any timer.
 */
export function findZombies(
  db: DatabaseType,
  opts: { now?: number; hasActiveSocket: (id: string) => boolean },
): ZombieCandidate[] {
  const now = opts.now ?? Date.now();

  // Pull every plausibly-stale row with the LONGEST threshold, then apply the per-type
  // rule in code. Encoding the type table as SQL would put the policy in two places.
  const cutoff = new Date(now - SILENT_ZOMBIE_THRESHOLD_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT id, agent_type, last_seen FROM agents
        WHERE status IN ('idle', 'waiting', 'working') AND last_seen < ?`,
    )
    .all(cutoff) as { id: string; agent_type: string | null; last_seen: string | null }[];

  const out: ZombieCandidate[] = [];
  for (const row of rows) {
    if (!row.last_seen) continue;
    const seenAt = Date.parse(row.last_seen);
    if (Number.isNaN(seenAt)) continue;

    const agentType = row.agent_type || 'claude';
    const thresholdMs = zombieThresholdFor(agentType);
    const ageMs = now - seenAt;
    if (ageMs < thresholdMs) continue;

    // Demonstrably alive. Checked last because it is the most expensive test.
    if (opts.hasActiveSocket(row.id)) continue;

    out.push({ id: row.id, agentType, lastSeen: row.last_seen, ageMs, thresholdMs });
  }
  return out;
}
