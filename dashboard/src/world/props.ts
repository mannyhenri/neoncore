/**
 * WHAT ELSE STANDS ON THE MAP, AND WHY — every prop here is one fact from the records. Pure, so
 * each rule is tested without a screen.
 *
 *   statue     a pod has one once a feature of its project has been delivered for 24 hours
 *   freight    what is left to build in the pod's project:
 *                nothing (no features, or all delivered)  the open, empty crate
 *                1 feature                                the glowing crate
 *                2–3                                      the cart with one crate
 *                4 or more                                the loaded cart
 *   bench      one bench by the pond, two seats: an agent idle for 30 minutes goes and sits
 *   work       a working agent plays one of four work cycles, changing every 40–90 seconds
 *   marker     under a pod's signpost while its project has features in their pipeline:
 *                yellow, pulsing   one of them waits on you (answer the planner, accept the plan,
 *                                  pick repos, review a stage, resume a paused run, check the report)
 *                green             all of them are moving without you
 *                none              nothing is in a pipeline
 */
import type { Goal } from '../types';
import type { AnimationName } from './anim';
import type { KitName } from './kit';
import { featureStatus } from '../lib/featureStatus';

const HOUR_MS = 60 * 60 * 1000;

/** How long a feature has to have been delivered before its pod gets the statue. */
export const STATUE_AFTER_MS = 24 * HOUR_MS;
export type DeliveredFeature = Pick<Goal, 'projectId' | 'status' | 'origin' | 'doneAt'>;

/** How many of the project's features have been delivered for a day or more. */
export function settledDeliveries(features: readonly DeliveredFeature[], projectId: string, now: number): number {
  return features.filter((f) => {
    if (f.projectId !== projectId || f.status !== 'achieved' || f.origin === 'imported' || !f.doneAt) return false;
    const at = new Date(f.doneAt).getTime();
    return Number.isFinite(at) && now - at >= STATUE_AFTER_MS;
  }).length;
}

export const FREIGHT = ['crate-open', 'crate-glow', 'cart-1', 'cart-3'] as const satisfies readonly KitName[];
export type Freight = (typeof FREIGHT)[number];

/** Features of a project still to deliver. */
export const featuresToDo = (f: { total: number; done: number }): number => Math.max(0, f.total - f.done);

export function freightFor(toDo: number): Freight {
  if (toDo <= 0) return 'crate-open';
  if (toDo === 1) return 'crate-glow';
  return toDo <= 3 ? 'cart-1' : 'cart-3';
}

export function freightTitle(toDo: number, total: number): string {
  if (total <= 0) return 'No features planned';
  if (toDo <= 0) return `All ${total} feature${total === 1 ? '' : 's'} delivered`;
  return `${toDo} feature${toDo === 1 ? '' : 's'} to deliver`;
}

/** How long an agent has to be idle before it goes to the bench. */
export const BENCH_AFTER_MS = 30 * 60 * 1000;

/**
 * Who sits on the bench: agents idle for BENCH_AFTER_MS or more, a seat each. Whoever already
 * sits keeps the seat (nobody is shuffled along the bench); free seats go to whoever has been
 * idle longest. With the seats taken, the others stay standing where they are.
 */
export function benchSeats(
  prev: ReadonlyMap<string, number>,
  idle: readonly { key: string; since: number }[],
  now: number,
  seats: number,
): Map<string, number> {
  const due = idle.filter((m) => now - m.since >= BENCH_AFTER_MS).sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
  const next = new Map<string, number>();
  const taken = new Set<number>();
  for (const m of due) {
    const seat = prev.get(m.key);
    if (seat !== undefined && seat < seats && !taken.has(seat)) { next.set(m.key, seat); taken.add(seat); }
  }
  for (const m of due) {
    if (next.has(m.key)) continue;
    let seat = 0;
    while (taken.has(seat)) seat++;
    if (seat >= seats) break;
    next.set(m.key, seat);
    taken.add(seat);
  }
  return next;
}

/** The four ways working is drawn. Three are down on the floor, one is standing with a tool. */
export const WORK_CYCLES = ['kneel', 'repair', 'tend', 'work'] as const satisfies readonly AnimationName[];
export type WorkCycle = (typeof WORK_CYCLES)[number];
export const WORK_SWITCH_MS = { min: 40_000, max: 90_000 } as const;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Which work cycle an agent plays at a given moment. Each agent keeps its own pace (somewhere
 * between 40 and 90 seconds, from its key), so the crew never changes all at once, and each
 * change is to a DIFFERENT cycle. Depends only on the key and the clock: the same agent looks
 * the same in every open window.
 */
export function workCycleAt(key: string, now: number): WorkCycle {
  const h = hash(key);
  const period = WORK_SWITCH_MS.min + (h % (WORK_SWITCH_MS.max - WORK_SWITCH_MS.min + 1));
  const turn = Math.floor(now / period);
  // Stepping by 1 or 3 through four cycles never lands on the same one twice running.
  const step = (h >>> 8) % 2 === 0 ? 1 : 3;
  return WORK_CYCLES[(((h >>> 16) + turn * step) % WORK_CYCLES.length + WORK_CYCLES.length) % WORK_CYCLES.length];
}

/** Milliseconds until that agent's next change of work cycle. */
export function nextWorkSwitch(key: string, now: number): number {
  const period = WORK_SWITCH_MS.min + (hash(key) % (WORK_SWITCH_MS.max - WORK_SWITCH_MS.min + 1));
  return period - (now % period);
}

export type PipelineFeature = Pick<Goal, 'id' | 'name' | 'projectId' | 'status' | 'pilot' | 'health' | 'origin'>;
export interface PipelineSignal {
  tone: 'yellow' | 'green';
  /** The features in their pipeline, those waiting on you first; each with the words the feature list shows. */
  features: { id: string; name: string; label: string; needsYou: boolean }[];
}
/** Not in a pipeline: never started, cancelled, or delivered. */
const OUTSIDE = new Set(['backlog', 'cancelled', 'done']);

/**
 * The marker under a pod's signpost. The SAME rules as the "needs you" labels in Projects
 * (lib/featureStatus.ts), so the map and the feature list can never disagree.
 */
export function pipelineSignal(features: readonly PipelineFeature[], projectId: string): PipelineSignal | null {
  const live = features
    .filter((f) => f.projectId === projectId && f.origin !== 'imported')
    .map((f) => ({ f, st: featureStatus(f) }))
    .filter(({ st }) => !OUTSIDE.has(st.key))
    .map(({ f, st }) => ({ id: f.id, name: f.name, label: st.label, needsYou: st.needsYou }));
  if (live.length === 0) return null;
  const sorted = [...live.filter((x) => x.needsYou), ...live.filter((x) => !x.needsYou)];
  return { tone: sorted[0].needsYou ? 'yellow' : 'green', features: sorted };
}
