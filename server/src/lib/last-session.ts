/**
 * "Put me back where I was" — resolving WHICH session a launch should resume.
 *
 * Launching a cartridge for a project is where a person most expects continuity, and it was the
 * last caller still starting cold. Resume is now the default there. Two things make defaulting
 * safe rather than reckless:
 *
 *   1. A LAUNCH LABEL IS NOT A SESSION. `agents.session_id` holds a real native session id most
 *      of the time, but it also holds `relay-<pid>` (the relay's own registration before any
 *      hook fires), `neoncore-claude-<ts>` (openDirectory), `remote-<uuid>` and `recover-<id>`
 *      (the launch route). Resuming any of those asks the CLI for a session that never existed
 *      and kills the terminal on startup. They are refused here, by shape.
 *
 *   2. THE RELAY HAS THE VETO. This server can propose an id but cannot see whether the
 *      transcript still exists — on a fleet the repo is on another machine's disk. The relay
 *      runs there and checks before using it (see agent/relay/resume-args.mjs), falling back to
 *      a cold start it announces rather than one it hides.
 */
import os from 'os';
import db from '../db.js';

/**
 * Session ids that are LABELS, not resumable sessions. Each prefix is minted by a specific
 * launcher; the list is here rather than inline so a new launcher that invents another prefix
 * has one obvious place to declare it.
 */
export const SYNTHETIC_SESSION_PREFIXES = ['relay-', 'neoncore-', 'remote-', 'recover-'];

/**
 * Is this a real session id we could hand to a CLI's resume?
 *
 * Shape-based on purpose: engines mint their own ids and we cannot enumerate them, so this
 * rejects what we KNOW we minted ourselves rather than trying to recognise what they minted.
 */
export function isResumableSessionId(sessionId: string | null | undefined): boolean {
  if (!sessionId || typeof sessionId !== 'string') return false;
  const id = sessionId.trim();
  if (!id) return false;
  return !SYNTHETIC_SESSION_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * The last real session this machine+repo+engine reported, or null.
 *
 * Ordered by `last_seen` so a repo that has hosted several cartridges resumes the one that was
 * actually most recently alive, not whichever row happens to sort first.
 */
export function lastResumableSession(
  repoPath: string,
  agentType: string,
  machine: string = os.hostname(),
): string | null {
  if (!repoPath) return null;
  const rows = db.prepare(
    `SELECT session_id FROM agents
      WHERE repo_path = ? AND agent_type = ? AND machine = ?
      ORDER BY last_seen DESC LIMIT 5`,
  ).all(repoPath, agentType, machine) as { session_id: string }[];
  for (const r of rows) {
    if (isResumableSessionId(r.session_id)) return r.session_id;
  }
  return null;
}

/**
 * Which session id a launch should carry, given what the caller asked for and what is on record.
 *
 * The precedence is the whole contract, and it is a truth table rather than a heuristic:
 *   · `fresh` wins over everything — asking for a clean session must never be overridden, not
 *     even by an explicit id, or the control is a lie.
 *   · an explicit id beats the lookup — the caller knows something we do not.
 *   · otherwise resume what is on record, which is the default the launcher relies on.
 * Returns '' for "start cold", which is what every launch path already passes when not resuming.
 */
export function launchResumeDecision(opts: {
  fresh?: boolean;
  resumeSessionId?: string;
  lastSession: string | null;
}): string {
  if (opts.fresh) return '';
  if (opts.resumeSessionId) return opts.resumeSessionId;
  return opts.lastSession || '';
}
