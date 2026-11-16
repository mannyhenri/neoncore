/**
 * Bring a dead cartridge back as ITSELF.
 *
 * The recovery subsystem's only move was transcript replay into a session that already existed,
 * so `POST /api/agents/:id/recover-session` had nothing to offer an OFFLINE cartridge but a 409
 * reading "Relaunch this cartridge before resuming its session" — a instruction to the human to
 * go and do by hand the one thing the machine was in the best position to do.
 *
 * It can now do it: ask the machine's runner to open a terminal in the right repo with
 * `NEONCORE_RESUME_SESSION_ID` set, and the relay turns that into the engine's own resume flag.
 * What comes back is the real session — same id, full context, and a relay owning its PTY so
 * NeonCore can dispatch to it again. Replay remains the fallback for an engine that cannot
 * resume (see agent/relay/resume-args.mjs) and for a transcript that will not load.
 *
 * DELIBERATELY NOT AUTOMATIC HERE. This runs when a person clicks Resume, or when the recovery
 * path already decided to act. Auto-relaunching every offline cartridge on a sweep would open
 * terminals on someone's desktop after a laptop lid closed.
 */
import db from '../db.js';
import { dispatchLaunchToMachine, isMachineOnline } from '../ws.js';
import type { MachineRepo } from '../types.js';

export interface RelaunchResult {
  ok: boolean;
  /** Why it could not be done, in words that name the missing thing. */
  reason?: string;
  machineId?: string;
  sessionId?: string;
}

/**
 * Ask the cartridge's own machine to relaunch it, resumed to `sessionId`.
 *
 * Fails closed and says why: no runner registered for that hostname, the runner offline, or the
 * repo not in the runner's allowlist. Each of those is a real state a person can fix, and each
 * would otherwise surface as a launch that silently never happens.
 */
export function relaunchSessionNatively(
  agent: Record<string, unknown>,
  sessionId: string,
): RelaunchResult {
  const machineName = ((agent.machine as string) || '').trim();
  const repoPath = ((agent.repo_path as string) || '').trim();
  const agentType = ((agent.agent_type as string) || 'claude').trim();
  if (!machineName || !repoPath) {
    return { ok: false, reason: 'the cartridge has no machine or repo path on record' };
  }
  if (!sessionId) {
    return { ok: false, reason: 'no captured session id to resume' };
  }

  const found = findRunnerFor(machineName, repoPath);
  if (!found.machine) return { ok: false, reason: found.reason };
  const machine = found.machine;

  // Same allowlist the launch route enforces. A recovery is not a reason to open a terminal in a
  // directory the machine's owner never exposed.
  let repos: MachineRepo[] = [];
  try { repos = JSON.parse(machine.repos || '[]') as MachineRepo[]; } catch { repos = []; }
  if (!repos.some((r) => r.path === repoPath)) {
    return {
      ok: false,
      reason: `${repoPath} is not in the allowed folders for ${machineName}`,
      machineId: machine.id,
    };
  }

  const dispatched = dispatchLaunchToMachine(machine.id, {
    repoPath,
    agentType,
    sessionId: `recover-${sessionId.slice(0, 8)}`,
    context: '',
    resumeSessionId: sessionId,
  });
  if (!dispatched) {
    return { ok: false, reason: `the runner on ${machineName} went offline`, machineId: machine.id };
  }

  console.log(`[recovery] Relaunching ${agentType} @ ${repoPath} on ${machineName}, resuming ${sessionId}`);
  return { ok: true, machineId: machine.id, sessionId };
}

/**
 * WHICH RUNNER CAN RELAUNCH THIS CARTRIDGE — the step "Resume session" after a crash depends on.
 *
 * The runner is keyed by its own machine id, and matched to a cartridge by hostname. But the two
 * hostnames do not come from the same place: the relay registers a cartridge under os.hostname(),
 * while the runner uses `hostname` from runner.config.json when it is set (a documented field —
 * "Sam's laptop"), and macOS changes os.hostname() between networks. Either way the match failed
 * and Resume answered "no runner is registered" with the runner sitting right there. Found by
 * cutting the power on the sandbox mid-workflow: its runner is configured as "sandbox-machine".
 *
 * So: by hostname first; failing that, the ONE online runner whose allowed folders include the
 * cartridge's repo (a repo path is where the terminal would open — it must be on that machine
 * anyway). Two runners listing the same path is ambiguous, and refused rather than guessed.
 */
export function findRunnerFor(
  machineName: string,
  repoPath: string,
  isOnline: (machineId: string) => boolean = isMachineOnline,
): { machine?: { id: string; repos: string }; reason: string } {
  const byHost = db.prepare('SELECT id, repos FROM machines WHERE hostname = ? ORDER BY last_seen DESC LIMIT 1')
    .get(machineName) as { id: string; repos: string } | undefined;
  if (byHost) {
    return isOnline(byHost.id)
      ? { machine: byHost, reason: 'matched by hostname' }
      : { reason: `the runner on ${machineName} is offline` };
  }
  const listing = (db.prepare('SELECT id, repos FROM machines ORDER BY last_seen DESC').all() as Array<{ id: string; repos: string }>)
    .filter((m) => {
      try { return (JSON.parse(m.repos || '[]') as MachineRepo[]).some((r) => r.path === repoPath); } catch { return false; }
    });
  const online = listing.filter((m) => isOnline(m.id));
  if (online.length === 1) return { machine: online[0], reason: 'matched by the repo in its allowed folders' };
  if (online.length > 1) return { reason: `${online.length} online runners list ${repoPath} — cannot tell which machine the cartridge was on` };
  if (listing.length > 0) return { reason: `the runner that lists ${repoPath} is offline` };
  return { reason: `no runner is registered for ${machineName}` };
}
