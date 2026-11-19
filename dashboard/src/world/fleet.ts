/**
 * MACHINE → LANDING PAD.
 *
 * A machine is known two ways: the runner daemon reports it (online or offline), or an agent
 * is simply live on it. Either makes it "online" here. Each online machine holds a pad — and
 * keeps it for as long as it is online, so one machine going away never moves another's
 * shuttle. Pads left over are named after offline machines, with no shuttle on them.
 */
import type { Machine } from '../types';
import { assignSlots } from './sites';

/** Host names as the same machine reports them in different places ("X.local" vs "x"). */
export const hostKey = (h: string): string => (h || '').trim().toLowerCase().replace(/\.local$/, '');

export interface PadState {
  pad: string;
  /** The machine this pad belongs to right now; null when the pad is spare. */
  host: string | null;
  online: boolean;
}

export function padsFor(
  prev: ReadonlyMap<string, number>,
  machines: readonly Pick<Machine, 'hostname' | 'status'>[],
  agentHosts: readonly string[],
  padIds: readonly string[],
): { slots: Map<string, number>; pads: PadState[] } {
  const label = new Map<string, string>();
  const online = new Set<string>();
  for (const m of machines) {
    label.set(hostKey(m.hostname), m.hostname);
    if (m.status === 'online') online.add(hostKey(m.hostname));
  }
  for (const h of agentHosts) {
    const k = hostKey(h);
    if (!k) continue;
    if (!label.has(k)) label.set(k, h.replace(/\.local$/i, ''));
    online.add(k);
  }
  const kept = new Map([...prev].filter(([k]) => online.has(k)));
  const slots = assignSlots(kept, [...online].sort());
  const pads: PadState[] = padIds.map((pad) => ({ pad, host: null, online: false }));
  for (const [k, slot] of slots) if (slot < pads.length) pads[slot] = { pad: padIds[slot], host: label.get(k)!, online: true };
  const offline = [...label.keys()].filter((k) => !online.has(k)).sort();
  for (const p of pads) {
    if (p.host !== null) continue;
    const k = offline.shift();
    if (!k) break;
    p.host = label.get(k)!;
  }
  return { slots, pads };
}

/** The pad a machine holds, if any. */
export function padOf(pads: readonly PadState[], host: string): string | null {
  return pads.find((p) => p.host !== null && hostKey(p.host) === hostKey(host))?.pad ?? null;
}
