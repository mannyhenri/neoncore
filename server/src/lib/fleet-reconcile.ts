/**
 * ADX-009 — HOW MUCH OF THIS MACHINE DOES NEONCORE ACTUALLY SEE?
 *
 * Two registries describe the same machine and neither knows about the other. NeonCore's `agents`
 * table holds the cartridges it launched and relays for. `claude agents --json` holds every Claude
 * Code session running here — including BACKGROUND sessions started outside NeonCore entirely,
 * with `claude --bg`, from agent view, or with `/bg` inside a session.
 *
 * Measured while this was written: 12 sessions visible to the CLI, 9 non-offline rows in NeonCore.
 * The gap is not noise; it is work in flight that the dashboard omits without saying so. Someone
 * reading "9 cartridges" concludes that is the machine. It is not.
 *
 * ── THIS REPORTS A DELTA; IT DOES NOT IMPORT SESSIONS AS CARTRIDGES ───────────────────
 * Deliberate. NeonCore cannot dispatch to a background session, cannot recover it, and does not
 * own its lifecycle. Listing one as a cartridge would promise capabilities that do not exist —
 * a worse lie than the omission it replaces. What NeonCore can honestly say is "there are N
 * sessions here I do not manage", and that is the whole deliverable.
 *
 * ── MATCHED ON SESSION ID. A DIRECTORY IS NOT AN IDENTITY. ────────────────────────────
 * This was built matching on working directory first, and live data falsified it immediately:
 * it reported 12 managed and 0 unmanaged on a machine that demonstrably has 3 background sessions
 * NeonCore never launched. The reason is that those sessions run in directories that ALSO hold a
 * cartridge — `claude --bg` inside a repo NeonCore already relays — so directory matching quietly
 * absorbed exactly the sessions this function exists to find.
 *
 * `agents.session_id` and the CLI's `sessionId` are the same value for a cartridge NeonCore
 * launched, so the join is exact: 12 sessions, 9 matched, 3 unmanaged, all background. Names
 * cannot be used either — a cartridge is `<machine>/<repo>` while the CLI generates
 * `<dir>-<suffix>` — but the fix for that is not a looser key, it is the right one.
 *
 * Directory survives only as a FALLBACK for a session carrying no id, where it is better than
 * nothing and cannot over-match, because a session with no id has nothing else to match on.
 *
 * ── AN ABSENT CLI IS "CANNOT TELL", NEVER "NOTHING UNMANAGED" ─────────────────────────
 * A NeonCore server may run where the `claude` binary is not on PATH. Returning an empty list
 * there would restore the exact false completeness this task exists to remove, so absence is its
 * own state and the caller is told which one it got.
 */
import { execFileSync } from 'node:child_process';
import db from '../db.js';

/** One row of `claude agents --json`. Only the fields reconciliation actually uses. */
export interface CliSession {
  id?: string;
  cwd: string;
  kind: 'interactive' | 'background';
  name?: string;
  state?: string;
  sessionId?: string;
  startedAt?: number;
}

export interface FleetReconciliation {
  /** False when the CLI could not be consulted. Distinguishes "none" from "cannot tell". */
  available: boolean;
  /** How many CLI sessions matched a cartridge NeonCore knows about. */
  managed: number;
  /** Sessions running on this machine that NeonCore does not manage. */
  unmanaged: CliSession[];
  /** Why, in words, for a surface that has to explain itself. */
  detail: string;
}

/**
 * Directories compare as strings, so they have to be normalised or the report invents orphans.
 * A trailing slash and a case difference are the two that occur in practice: the CLI prints the
 * cwd as the process sees it, while NeonCore stores what the launcher was given.
 */
function normalizeDir(p: string): string {
  return (p || '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Compare the machine's live Claude sessions against NeonCore's cartridges.
 *
 * Pass `null` when the CLI could not be run — that is not the same as an empty fleet, and the
 * result says which.
 */
export function reconcileFleet(sessions: CliSession[] | null): FleetReconciliation {
  if (sessions === null) {
    return {
      available: false, managed: 0, unmanaged: [],
      detail: 'the claude CLI is unavailable here, so unmanaged sessions cannot be counted',
    };
  }

  // Only NON-OFFLINE cartridges can manage anything. An offline row is a cartridge NeonCore is
  // not currently running; a live session it points at is genuinely unmanaged right now, and
  // absorbing it would hide running work behind a stopped cartridge.
  const rows = db.prepare("SELECT session_id, repo_path FROM agents WHERE status != 'offline'")
    .all() as { session_id: string; repo_path: string }[];
  const managedSessions = new Set(rows.map((r) => r.session_id).filter(Boolean));
  const managedDirs = new Set(rows.map((r) => normalizeDir(r.repo_path)).filter(Boolean));

  const unmanaged = sessions.filter((s) => {
    // The identity. A cartridge and its session share this exact value.
    if (s.sessionId) return !managedSessions.has(s.sessionId);
    // No id to match on: the directory is all there is. It cannot over-match here, because a
    // session with an id never reaches this line.
    return !managedDirs.has(normalizeDir(s.cwd));
  });
  const managed = sessions.length - unmanaged.length;

  return {
    available: true,
    managed,
    unmanaged,
    detail: unmanaged.length === 0
      ? `all ${sessions.length} Claude session(s) on this machine are managed cartridges`
      : `${unmanaged.length} of ${sessions.length} Claude session(s) on this machine are not NeonCore cartridges`,
  };
}

/**
 * Ask the CLI what is running. Returns null — not [] — on any failure, so the caller can tell
 * "the question could not be asked" from "the answer is none".
 */
export function readCliSessions(): CliSession[] | null {
  try {
    const out = execFileSync('claude', ['agents', '--json'], {
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed as CliSession[] : null;
  } catch {
    // Binary missing, not on PATH, timed out, or output that is not JSON. All of them mean the
    // same thing to a caller: we do not know, and must not claim we do.
    return null;
  }
}

/** The reconciliation for this machine, right now. */
export function currentFleetDelta(): FleetReconciliation {
  return reconcileFleet(readCliSessions());
}
