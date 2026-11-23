/**
 * FEATURE PLATES — one per running or paused feature, above the team working on it.
 *
 * When several features run in one project at once (each on its own branch — server
 * lib/feature-workspace.ts), "which feature is this team on, and how far along" matters more than
 * the project's name; the project keeps a small caption on its district (WorldScene). A plate says:
 * the feature's name, its stage (3/8), "needs you" when its pipeline waits on a person, and the
 * feature's own badges (milestones.ts — the same badges the project plate shows, for this feature).
 */
import type { ActiveFeature, Goal } from '../types';
import type { Placement } from './sites';
import type { Zone } from './zones';
import { badgesFor, FEATURE_BADGES } from './milestones';
import { KIT, type KitName } from './kit';

/** Every worktree a feature runs in → the real repo it is a worktree of (paths normalised by the caller). */
export function worktreeRepos(features: readonly ActiveFeature[], norm: (p: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of features) for (const w of f.worktrees) out.set(norm(w.worktreePath), w.repoPath);
  return out;
}

/** How close two plates' anchors may be before the later one is lifted clear: about a plate's width and height, as fractions of the map. */
export const PLATE_CLEAR = { x: 0.24, y: 0.034 };
/**
 * Two features of one project work side by side (two pods, or one crowded one), and their plates
 * would be written over each other. Each plate keeps its place unless an earlier one is in the
 * way; then it is lifted above it. Pure, and in order: the first feature never moves.
 */
export function clearPlates<T extends { x: number; y: number }>(wanted: readonly (T | null)[]): (T | null)[] {
  const placed: { x: number; y: number }[] = [];
  return wanted.map((w) => {
    if (!w) return null;
    let y = w.y;
    for (let guard = 0; guard < 12 && placed.some((p) => Math.abs(p.x - w.x) < PLATE_CLEAR.x && Math.abs(p.y - y) < PLATE_CLEAR.y); guard++) y -= PLATE_CLEAR.y;
    placed.push({ x: w.x, y });
    return { ...w, y };
  });
}

const PLATE = 'absolute -translate-x-1/2 -translate-y-full px-2 py-0.5 rounded-md border bg-[rgba(10,16,32,0.88)] font-mono text-[12px] leading-5 whitespace-nowrap pointer-events-none select-none';

export function FeaturePlates({ features, crew, placement, zones, districts, goals, z }: {
  features: readonly ActiveFeature[];
  /** The crew on the map: which agents each figure carries. */
  crew: readonly { key: string; agentIds: string[] }[];
  /** Where each figure works (WorldScene's placement). */
  placement: ReadonlyMap<string, Placement>;
  zones: readonly Zone[];
  districts: readonly { id: string; x?: number; y?: number }[];
  goals: readonly Goal[];
  z: number;
}) {
  const unplacedInDistrict = new Map<string, number>();
  const wanted = features.map((f) => {
        // Above its team: the figures carrying its agents. With nobody on the map yet, under the
        // project's caption (stacked when several features are waiting for their crew).
        const spots = crew.filter((m) => m.agentIds.some((id) => f.agentIds.includes(id)))
          .map((m) => placement.get(m.key)).filter((p): p is Placement => !!p);
        let at: { x: number; y: number } | null = null;
        if (spots.length) {
          at = { x: spots.reduce((s, p) => s + p.x, 0) / spots.length, y: Math.min(...spots.map((p) => p.y)) - 0.075 };
        } else {
          const d = zones.find((zz) => zz.projectId === f.projectId)?.districts[0];
          const pos = districts.find((x) => x.id === d);
          if (pos?.x !== undefined && pos.y !== undefined) {
            const n = unplacedInDistrict.get(d!) ?? 0;
            unplacedInDistrict.set(d!, n + 1);
            at = { x: pos.x, y: pos.y + 0.07 + n * 0.04 };
          }
        }
    return at;
  });
  const places = clearPlates(wanted);
  return (
    <>
      {features.map((f, i) => {
        const at = places[i];
        if (!at) return null;
        const earned = badgesFor(goals.filter((g) => g.id === f.goalId), f.projectId);
        const needs = !!f.needsYou;
        return (
          <div key={f.pilotId} data-feature-plate={f.pilotId}
            className={`${PLATE} ${needs ? 'border-ember-500/70 text-ember-200' : 'border-violet-400/50 text-gray-100'}`}
            style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%`, zIndex: z }}
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
    </>
  );
}
