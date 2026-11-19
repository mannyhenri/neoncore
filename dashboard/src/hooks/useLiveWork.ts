import { useEffect, useState } from 'react';
import type { ConferSession, Workflow } from '../types';
import { api } from '../lib/api';

/**
 * The work cartridges are part of — confers and live runs — so a meter can show real progress
 * (lib/cartridgeProgress). Polled: both change on the server's clock, not on agent events.
 * Shared by the cartridge list and the scene so their meters cannot disagree.
 */
export function useLiveWork(): { confers: ConferSession[]; runs: Workflow[] } {
  const [confers, setConfers] = useState<ConferSession[]>([]);
  const [runs, setRuns] = useState<Workflow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getConfers().then((c) => { if (alive) setConfers(c); }).catch(() => {});
      api.getWorkflows().then((w) => { if (alive) setRuns(w); }).catch(() => {});
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { confers, runs };
}
