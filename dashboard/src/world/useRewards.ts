/**
 * Every project's rewards, for the map (server lib/project-rewards.ts). Read when the map opens
 * and once a minute after: a reward is earned by a delivery, a merge or a run, none of which
 * happens by the second. A server without rewards yet simply shows none.
 */
import { useEffect, useState } from 'react';
import type { ProjectRewards, MapProgress } from '../types';
import { api } from '../lib/api';

export const REWARDS_POLL_MS = 60_000;

export function useRewards(): Map<string, ProjectRewards> {
  const [byProject, setByProject] = useState<Map<string, ProjectRewards>>(new Map());
  useEffect(() => {
    let alive = true;
    const load = () => {
      try {
        void Promise.resolve(api.getRewards?.()).then((r) => { if (alive && r && Array.isArray(r.projects)) setByProject(new Map(r.projects.map((p) => [p.projectId, p]))); }).catch(() => { /* none shown */ });
      } catch { /* none shown */ }
    };
    load();
    const t = setInterval(load, REWARDS_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return byProject;
}

/** The new maps the outfit can unlock, and how far each is. Read with the same rhythm as the rewards. */
export function useNewMaps(): MapProgress[] {
  const [maps, setMaps] = useState<MapProgress[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      try {
        void Promise.resolve(api.getWorldProgress?.()).then((r) => { if (alive && r && Array.isArray(r.maps)) setMaps(r.maps); }).catch(() => { /* none shown */ });
      } catch { /* none shown */ }
    };
    load();
    const t = setInterval(load, REWARDS_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return maps;
}
