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

  // The runner is keyed by its own machine id, not the hostname the agent registered under, so
  // resolve through the machines table rather than assuming they match.
  const machine = db.prepare('SELECT id, repos FROM machines WHERE hostname = ? ORDER BY last_seen DESC LIMIT 1')
    .get(machineName) as { id: string; repos: string } | undefined;
  if (!machine) {
    return { ok: false, reason: `no runner is registered for ${machineName}` };
  }
  if (!isMachineOnline(machine.id)) {
    return { ok: false, reason: `the runner on ${machineName} is offline`, machineId: machine.id };
  }

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
