/**
 * FEATURE PLATES — one per running or paused feature, in a stack right under its project's signpost.
 *
 * When several features run in one project at once (each on its own branch — server
 * lib/feature-workspace.ts), "which features is this project on, and how far along" matters more
 * than the project's name; the project keeps a small caption on its sign (WorldScene). A plate says:
 * the feature's name, its stage (3/8), "needs you" when its pipeline waits on a person, and the
 * feature's own badges (milestones.ts — the same badges the project plate shows, for this feature).
 *
 * The plates sit with the sign, not over the agents doing the work: agents walk about the pod, and
 * a plate that followed them ended up in the middle of nowhere. At most MAX_PLATES under one sign —
 * those that need you first, then the furthest along — and "+N more under way" for the rest.
 */
import type { ReactNode } from 'react';
import type { ActiveFeature, Goal } from '../types';
import type { Zone } from './zones';
import { badgesFor, FEATURE_BADGES } from './milestones';
import { KIT, type KitName } from './kit';

/** Every worktree a feature runs in → the real repo it is a worktree of (paths normalised by the caller). */
export function worktreeRepos(features: readonly ActiveFeature[], norm: (p: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of features) for (const w of f.worktrees) out.set(norm(w.worktreePath), w.repoPath);
  return out;
}

/** How many plates one sign carries; the rest are counted. */
export const MAX_PLATES = 3;

/** Which plates come first under a sign: those that need you, then the furthest along, then by name. */
export function plateOrder<T extends Pick<ActiveFeature, 'needsYou' | 'stage' | 'name'>>(features: readonly T[]): T[] {
  const along = (f: T) => (f.stage ? f.stage.position / Math.max(1, f.stage.total) : 0);
  return [...features].sort((a, b) => Number(!!b.needsYou) - Number(!!a.needsYou) || along(b) - along(a) || a.name.localeCompare(b.name));
}

const PLATE = 'px-2 py-0.5 rounded-md border bg-[rgba(10,16,32,0.88)] font-mono text-[12px] leading-5 whitespace-nowrap pointer-events-none select-none';

export function FeaturePlates({ features, zones, districts, goals, z, extra, align = 'center' }: {
  features: readonly ActiveFeature[];
  zones: readonly Zone[];
  /** Where each district's signpost stands (fractions of the map). */
  districts: readonly { id: string; x?: number; y?: number }[];
  goals: readonly Goal[];
  z: number;
  /** Anything else that hangs under this project's sign (its medals), after the plates. */
  extra?: (projectId: string) => ReactNode;
  /** 'center' under a post; 'start' from a hanging sign's mast, the way its board hangs. */
  align?: 'center' | 'start';
}) {
  const byProject = new Map<string, ActiveFeature[]>();
  for (const f of features) byProject.set(f.projectId, [...(byProject.get(f.projectId) ?? []), f]);
  return (
    <>
      {[...byProject].map(([projectId, list]) => {
        const d = zones.find((zz) => zz.projectId === projectId)?.districts[0];
        const at = districts.find((x) => x.id === d);
        if (at?.x === undefined || at.y === undefined) return null;
        const ordered = plateOrder(list);
        const shown = ordered.slice(0, MAX_PLATES);
        const more = ordered.length - shown.length;
        return (
          <div key={projectId} data-feature-stack={projectId} className={`absolute mt-1 flex flex-col gap-[3px] pointer-events-none ${align === 'start' ? '-translate-x-[6px] items-start' : '-translate-x-1/2 items-center'}`}
            style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%`, zIndex: z }}>
            {shown.map((f) => {
              const earned = badgesFor(goals.filter((g) => g.id === f.goalId), f.projectId);
              const needs = !!f.needsYou;
              return (
                <div key={f.pilotId} data-feature-plate={f.pilotId}
                  className={`${PLATE} ${needs ? 'border-ember-500/70 text-ember-200' : 'border-violet-400/50 text-gray-100'}`}
                  title={[f.name, f.stage ? `stage ${f.stage.position}/${f.stage.total}: ${f.stage.title}` : '', f.branch ? `branch ${f.branch}` : '', f.needsYou].filter(Boolean).join(' · ')}>
                  <span className="text-violet-300 mr-1">✦</span>
                  <span className="font-semibold">{f.name}</span>
                  {f.stage && <span className="text-gray-400"> · {f.stage.position}/{f.stage.total}</span>}
                  {needs && <span className="text-ember-300 font-semibold"> · needs you</span>}
                  <span className="inline-flex items-center gap-0.5 ml-2 align-[-4px]" aria-label={`${earned} of ${FEATURE_BADGES.length} steps earned`}>
                    {FEATURE_BADGES.map((b, i) => (
                      <img key={b.step} data-badge={b.step} data-earned={i < earned} src={KIT[b.sprite as KitName].src} alt={i < earned ? b.label : ''}
                        className="h-[16px] w-[16px] object-contain" style={{ opacity: i < earned ? 1 : 0.18, filter: i < earned ? undefined : 'grayscale(1)' }} />
                    ))}
                  </span>
                </div>
              );
            })}
            {more > 0 && (
              <div data-feature-more className="px-2 rounded-md border border-white/[0.14] bg-[rgba(10,16,32,0.82)] font-mono text-[11px] leading-5 text-gray-300 whitespace-nowrap">
                +{more} more under way
              </div>
            )}
            {extra?.(projectId)}
          </div>
        );
      })}
    </>
  );
}
