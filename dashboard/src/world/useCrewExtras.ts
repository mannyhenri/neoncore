import { useEffect, useRef, useState } from 'react';
import type { ActiveFeature, Agent, Goal, Machine, Project, QueueItem, QueueLane } from '../types';
import { api } from '../lib/api';
import type { CrewMember } from './crew';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Polls what the scene shows beyond an agent's status: the queue, the fleet's machines and
 * the projects with their repos and feature counts (every 15 s, like the queue panel) and each crew member's token use over the last hour
 * (every 60 s).
 *
 * Token use is asked of THIS server only. An agent that came from a federated peer has its
 * usage in that peer's database, so it is left out rather than shown as zero — a missing bar
 * is honest, an empty one would claim the agent is idle.
 */
export function useCrewExtras(crew: CrewMember[], agents: Agent[]): {
  queue: { items: QueueItem[]; lanes: QueueLane[] };
  burn: Map<string, number>;
  /** Machines running the runner daemon, as the server reports them. */
  machines: Pick<Machine, 'hostname' | 'status'>[];
  /** Projects: which repos each owns, and how far its features are. */
  projects: Project[];
  /** Every feature (goal): the scene reads their target dates for the deadline gauges. */
  goals: Goal[];
  /** Running and paused features — the teams on the map, with their plates (FeaturePlates.tsx). */
  features: ActiveFeature[];
  /**
   * False until machines and projects have answered once (or failed). The scene draws nobody
   * before that: placing the crew first and then moving it when the projects arrive would make
   * every agent walk across the map each time the screen opens.
   */
  ready: boolean;
} {
  const [queue, setQueue] = useState<{ items: QueueItem[]; lanes: QueueLane[] }>({ items: [], lanes: [] });
  const [burn, setBurn] = useState<Map<string, number>>(new Map());
  const [machines, setMachines] = useState<Pick<Machine, 'hostname' | 'status'>[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [features, setFeatures] = useState<ActiveFeature[]>([]);
  const [ready, setReady] = useState(false);
  const crewRef = useRef(crew);
  crewRef.current = crew;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const crewKeys = crew.map((m) => `${m.key}=${m.agentIds.join(',')}`).join('|');

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getQueue().then((v) => { if (alive) setQueue({ items: v.items ?? [], lanes: v.lanes ?? [] }); }).catch(() => {});
      const fleet = api.getMachines().then((m) => { if (alive) setMachines(Array.isArray(m) ? m : []); }).catch(() => {});
      const owned = api.getGoalProjects().then((p) => { if (alive) setProjects(Array.isArray(p) ? p : []); }).catch(() => {});
      api.getGoals().then((g) => { if (alive) setGoals(Array.isArray(g) ? g : []); }).catch(() => {});
      api.getActiveFeatures().then((f) => { if (alive) setFeatures(Array.isArray(f) ? f : []); }).catch(() => {});
      Promise.all([fleet, owned]).then(() => { if (alive) setReady(true); });
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const since = new Date(Date.now() - HOUR_MS).toISOString();
      const next = new Map<string, number>();
      await Promise.all(crewRef.current.map(async (m) => {
        // `origin` is set on agents fetched from another server; '' or undefined means this one.
        const local = m.agentIds.filter((id) => !agentsRef.current.find((a) => a.id === id)?.origin);
        const totals = await Promise.all(local.map((id) => api.getAgentTokenUsage(id, since).then((u) => Number(u?.total) || 0).catch(() => null)));
        const known = totals.filter((t): t is number => t !== null);
        if (known.length > 0) next.set(m.key, known.reduce((a, b) => a + b, 0));
      }));
      if (alive) setBurn(next);
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [crewKeys]);

  return { queue, burn, machines, projects, goals, features, ready };
}
