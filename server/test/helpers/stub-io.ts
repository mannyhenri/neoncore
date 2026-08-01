/**
 * A socket server that records instead of transmitting.
 *
 * Satisfies the whole surface production code uses — emit, to().emit, sockets.sockets.get and
 * sockets.adapter.rooms.get — and reaches nobody. Tests that need a cartridge to look "connected"
 * register a room; everything else behaves as an empty server.
 */
import { setIOForTests } from '../../src/ws.js';

export interface Emission { room: string; event: string; payload: unknown }

export function installStubIO(): { emissions: Emission[]; connect(agentId: string): void } {
  const emissions: Emission[] = [];
  const rooms = new Map<string, Set<string>>();
  const sockets = new Map<string, unknown>();

  const stub = {
    emit: (event: string, payload: unknown) => { emissions.push({ room: '*', event, payload }); return true; },
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => { emissions.push({ room, event, payload }); return true; },
    }),
    sockets: { sockets, adapter: { rooms } },
  };
  setIOForTests(stub);

  return {
    emissions,
    /** Make an agent look like it has a live cartridge attached. */
    connect(agentId: string) { rooms.set(`agent:${agentId}`, new Set([`sock-${agentId}`])); },
  };
}
