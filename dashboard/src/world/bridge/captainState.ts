/**
 * THE CAPTAIN'S STATE, and what the gauges read. Pure, so it is tested without a screen.
 *
 * ONE LOOK PER STATE (the same rule as the crew on the map, world/anim.ts):
 * (the looks and their order are on captainAnim below)
 */
import type { Project } from '../../types';

export const CAPTAIN_ANIMS = ['idle', 'brief', 'call', 'log', 'celebrate', 'worry'] as const;
export type CaptainAnim = (typeof CAPTAIN_ANIMS)[number];
/** Frames per second of each cycle. */
export const CAPTAIN_FPS: Record<CaptainAnim, number> = { idle: 3, brief: 6, call: 6, log: 5, celebrate: 6, worry: 3 };
/** How long he briefs a newly selected project, and how long he celebrates a delivery, in milliseconds. */
export const BRIEF_MS = 2400;
export const CELEBRATE_MS = 3200;

/**
 * Most urgent first, one look each:
 *   call       the project in front of you needs you
 *   celebrate  it just had one more feature delivered (for a moment)
 *   brief      you just selected it (for a moment)
 *   worry      its nearest feature date is close or past (world/milestones.ts: tight, overdue)
 *   log        a feature is under way: he keeps the log
 *   idle       nothing to say
 */
export function captainAnim(s: { needsYou: boolean; justDelivered?: boolean; justSelected: boolean; deadline?: 'ok' | 'tight' | 'overdue' | null; underWay?: boolean }): CaptainAnim {
  if (s.needsYou) return 'call';
  if (s.justDelivered) return 'celebrate';
  if (s.justSelected) return 'brief';
  if (s.deadline === 'tight' || s.deadline === 'overdue') return 'worry';
  if (s.underWay) return 'log';
  return 'idle';
}

export type BridgeProject = Pick<Project, 'id' | 'name' | 'primaryRepo' | 'cartridges' | 'costUsd' | 'featureCount' | 'featuresDone' | 'featuresNeedYou' | 'featuresActive'>;

export interface Gauges { scope: string; repos: number; spentUsd: number; features: number; done: number }

/** The selected project's readings; with nothing selected (or a stale id), every project's together. */
export function gaugesFor(projects: readonly BridgeProject[], selectedId: string | null): Gauges {
  const one = projects.find((p) => p.id === selectedId);
  const set = one ? [one] : projects;
  const reposOf = (p: BridgeProject) => (p.cartridges?.length ? p.cartridges.length : p.primaryRepo ? 1 : 0);
  return {
    scope: one ? one.name : 'All projects',
    repos: set.reduce((n, p) => n + reposOf(p), 0),
    spentUsd: set.reduce((n, p) => n + (p.costUsd ?? 0), 0),
    features: set.reduce((n, p) => n + (p.featureCount ?? 0), 0),
    done: set.reduce((n, p) => n + (p.featuresDone ?? 0), 0),
  };
}

/** Does the project in front of you (or, with none selected, any project) need you? */
export function needsYou(projects: readonly BridgeProject[], selectedId: string | null): boolean {
  const one = projects.find((p) => p.id === selectedId);
  return (one ? [one] : projects).some((p) => (p.featuresNeedYou ?? 0) > 0);
}

export const formatSpent = (usd: number): string => (usd >= 1000 ? `$${(usd / 1000).toFixed(1)}K` : `$${Math.round(usd)}`);
