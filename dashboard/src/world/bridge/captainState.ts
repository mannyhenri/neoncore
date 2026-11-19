/**
 * THE CAPTAIN'S STATE, and what the gauges read. Pure, so it is tested without a screen.
 *
 * ONE LOOK PER STATE (the same rule as the crew on the map, world/anim.ts):
 *   call   the project in front of you needs you (a feature waits on an answer, a plan, a review)
 *   brief  you just selected a project: he taps his board for a moment
 *   idle   nothing to say: he stands with the board
 */
import type { Project } from '../../types';

export const CAPTAIN_ANIMS = ['idle', 'brief', 'call'] as const;
export type CaptainAnim = (typeof CAPTAIN_ANIMS)[number];
/** Frames per second of each cycle. */
export const CAPTAIN_FPS: Record<CaptainAnim, number> = { idle: 3, brief: 6, call: 6 };
/** How long he briefs a newly selected project, in milliseconds. */
export const BRIEF_MS = 2400;

export function captainAnim(s: { needsYou: boolean; justSelected: boolean }): CaptainAnim {
  if (s.needsYou) return 'call';
  if (s.justSelected) return 'brief';
  return 'idle';
}

export type BridgeProject = Pick<Project, 'id' | 'name' | 'primaryRepo' | 'cartridges' | 'costUsd' | 'featureCount' | 'featuresDone' | 'featuresNeedYou'>;

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
