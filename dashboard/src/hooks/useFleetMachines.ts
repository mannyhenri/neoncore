import { useState, useEffect, useMemo } from 'react';
import { api, apiFor } from '../lib/api';
import { useSocket } from './useSocket';
import type { Machine, ServerEntry } from '../types';
import { activeServers } from '../lib/servers';

/**
 * A machine plus the server that owns it.
 *
 * Machines are NOT gossiped between servers — a runner registers with exactly one. So the
 * launcher has to ask every server itself, and remember which answered, because launching
 * or editing folders has to go back to that same server. Dispatching to the page's own
 * server instead would target a box that has never heard of the machine.
 */
export type FleetMachine = Machine & { origin: string };

/**
 * Every machine across the fleet, polled while `enabled`. Shared by "+ Launch" and a project's
 * "Launch all repos", so the two can never disagree about which box a launch goes to.
 */
export function useFleetMachines(servers: ServerEntry[], enabled: boolean) {
  const [machines, setMachines] = useState<FleetMachine[]>([]);
  const [loading, setLoading] = useState(false);

  // Every server we should ask. '' is the server that served this page, and is the only
  // entry when no roster is supplied — which keeps single-server installs behaving exactly
  // as before.
  const bases = useMemo(() => {
    // Collapse aliases of ONE server before querying.
    //
    // The browser stores the server it is on as '' and, once gossip names it, ALSO as the
    // URL that server advertises ('localhost' vs 'mac.local'). Same box, one serverId, two
    // roster rows. Asking both turned a single launch click into two dispatches — and the
    // target machine dutifully opened two terminals.
    //
    // Prefer '' when it is one of the aliases: the same-origin client needs no token and is
    // the connection we already know works.
    const active = activeServers(servers);
    const byIdentity = new Map<string, string>();
    for (const s of active) {
      // No serverId yet (first poll hasn't answered) → key on the URL so it is still asked.
      const key = s.serverId || `url:${s.url}`;
      const existing = byIdentity.get(key);
      if (existing === undefined || (existing !== '' && s.url === '')) byIdentity.set(key, s.url);
    }
    const list = [...byIdentity.values()];
    return list.length > 0 ? list : [''];
  }, [servers]);
  // Primitive dep for the fetch effect: the array identity changes every render.
  const baseKey = bases.join('|');

  /** The client for one server. Mirrors useAgents' clientFor — '' means same-origin. */
  const clientFor = (base: string) => {
    if (!base) return api;
    return apiFor(base, servers.find((s) => s.url === base)?.token);
  };

  // Live status updates so a machine coming online/offline reflects without reopening.
  useSocket({
    onMachineUpdated: (m) =>
      setMachines((prev) => {
        const i = prev.findIndex((x) => x.id === m.id);
        if (i === -1) return [...prev, { ...m, origin: '' }];
        const next = prev.slice();
        next[i] = { ...m, origin: prev[i].origin };
        return next;
      }),
  });

  useEffect(() => {
    if (!enabled) return;
    const fetchMachines = async () => {
      // Read from the SETTER, not from the closure. `machines` here came from the render
      // that created this effect, and the deps are [enabled, baseKey] with exhaustive-deps
      // disabled — so `machines.length` was always the initial 0 and this fired on every
      // poll, not just the first. That is what made the list vanish every 20 seconds.
      setMachines((current) => {
        setLoading(current.length === 0);
        return current;
      });
      // allSettled, not all: a sleeping laptop in the fleet must not blank the machines
      // from every healthy server. Same tolerance useAgents applies to agents.
      const results = await Promise.allSettled(
        bases.map((base) =>
          clientFor(base)
            .getMachines()
            .then((list) => list.map((m) => ({ ...m, origin: base }))),
        ),
      );
      // Collapse a machine that two servers both know about.
      //
      // A runner keeps ONE stable machineId, so re-pointing it at a different server leaves
      // the old server holding a stale row forever. Rendering both means the same laptop
      // appears twice — once live, once as "Runner not connected" with a frozen folder list
      // — which reads as a broken install rather than as a leftover.
      //
      // The ONLINE copy wins, because exactly one server can hold its live socket. A machine
      // nobody has online is still listed: genuinely offline is worth seeing and explaining,
      // and hiding it is what made folders look lost in the first place.
      const merged = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const byId = new Map<string, FleetMachine>();
      for (const m of merged) {
        const seen = byId.get(m.id);
        if (!seen || (seen.status !== 'online' && m.status === 'online')) byId.set(m.id, m);
      }
      const next = [...byId.values()];
      // Keep what we have if every server failed this round. allSettled already stops one
      // sleeping laptop from THROWING, but the merge still yields [] when nothing answers —
      // and blanking a good list because the network hiccuped is the same defect one layer on.
      setMachines((current) => (next.length === 0 && current.length > 0 ? current : next));
      setLoading(false);
    };
    fetchMachines();
    const interval = setInterval(fetchMachines, 20000);
    return () => clearInterval(interval);
  }, [enabled, baseKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { machines, loading, clientFor };
}
