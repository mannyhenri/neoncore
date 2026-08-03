/**
 * Which socket speaks for a machine runner.
 *
 * A machineId is not a socket. It is read from runner.config.json, so EVERY runner process
 * that reads that file claims the same id — an installed launchd/systemd service plus a
 * leftover `node index.js` are two daemons with one identity. Socket.IO rooms broadcast, so
 * dispatching a launch to `machine:<id>` handed a single "+ Launch" click to both runners and
 * each opened its own terminal.
 *
 * So instructions go to exactly ONE socket per machine: the newest to claim it (a runner that
 * just reconnected is the live one). If that socket dies, a surviving claimant is promoted
 * lazily on the next lookup, so a reconnect race never strands a machine as "offline".
 *
 * Liveness is injected rather than read from the socket server: this module stays free of
 * Socket.IO, and the same rules are testable without opening a port.
 */

/** socketId → machineId, for every socket that has claimed a machine. */
const socketToMachine = new Map<string, string>();

/** machineId → the one socketId instructions are sent to. */
const machinePrimary = new Map<string, string>();

export type IsConnected = (socketId: string) => boolean;

/**
 * A socket claims a machine. Returns the socket it displaced as primary, if any — a caller
 * can use that to warn about duplicate runners when both are still live.
 */
export function claimMachineSocket(socketId: string, machineId: string): { displaced: string | null } {
  const previous = machinePrimary.get(machineId) ?? null;
  socketToMachine.set(socketId, machineId);
  machinePrimary.set(machineId, socketId);
  return { displaced: previous === socketId ? null : previous };
}

/** A socket went away. Returns the machine it held, or null if it held none. */
export function releaseMachineSocket(socketId: string): string | null {
  const machineId = socketToMachine.get(socketId);
  if (!machineId) return null;
  socketToMachine.delete(socketId);
  if (machinePrimary.get(machineId) === socketId) machinePrimary.delete(machineId);
  return machineId;
}

/**
 * The single socket to address for this machine, or null when no live socket holds it.
 * Prunes sockets that are no longer connected and promotes a survivor to primary.
 */
export function machineSocketId(machineId: string, isConnected: IsConnected): string | null {
  const primary = machinePrimary.get(machineId);
  if (primary) {
    if (isConnected(primary)) return primary;
    machinePrimary.delete(machineId);
    socketToMachine.delete(primary);
  }
  for (const [socketId, mapped] of socketToMachine) {
    if (mapped !== machineId) continue;
    if (isConnected(socketId)) {
      machinePrimary.set(machineId, socketId);
      return socketId;
    }
    socketToMachine.delete(socketId); // prune stale
  }
  return null;
}

/** Every live socket claiming this machine — more than one means duplicate runners. */
export function machineClaimants(machineId: string, isConnected: IsConnected): string[] {
  return [...socketToMachine.entries()]
    .filter(([socketId, mapped]) => mapped === machineId && isConnected(socketId))
    .map(([socketId]) => socketId);
}

/** TEST ONLY — drop all claims so suites don't leak state into each other. */
export function resetMachineSocketsForTests(): void {
  socketToMachine.clear();
  machinePrimary.clear();
}
