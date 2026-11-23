/**
 * THE ROUTE — the roadmap as a flight path. The project launches at the left and flies to its
 * destination (the vision) at the right; every epic is a STOP on the way, in plan order, and the
 * ship is where the project is now. Pure geometry and state, so it can be checked for any plan.
 */
import type { RoadmapEpic } from '../../types';

/** Where an epic stands, as the route shows it. */
export type EpicStage = 'commended' | 'delivered' | 'late' | 'under-way' | 'blocked' | 'planned';
export const STAGE_LABEL: Record<EpicStage, string> = {
  commended: 'Delivered on time', delivered: 'Delivered', late: 'Late', 'under-way': 'Under way', blocked: 'Waiting', planned: 'Planned',
};
export const STAGE_COLOUR: Record<EpicStage, string> = {
  commended: '#F5C542', delivered: '#34D36B', late: '#FF8A3D', 'under-way': '#3FB4FF', blocked: '#E8B84A', planned: '#9FB2D2',
};
const done = (s: EpicStage) => s === 'commended' || s === 'delivered';

export function epicStage(e: RoadmapEpic): EpicStage {
  // Delivered: it has features and every one is (the server says when; an older one only counts).
  if (e.deliveredAt || (e.progress.total > 0 && e.progress.done === e.progress.total)) return e.onTime ? 'commended' : 'delivered';
  if (e.late || e.features.some((f) => f.state === 'late')) return 'late';
  if ((e.blockedBy ?? []).length > 0) return 'blocked';
  if (e.progress.done > 0 || e.features.some((f) => f.state === 'under-way')) return 'under-way';
  return 'planned';
}

/** The stop the project is at: the first epic not delivered — or the number of epics, when all are. */
export function currentStop(stages: readonly EpicStage[]): number {
  const i = stages.findIndex((s) => !done(s));
  return i === -1 ? stages.length : i;
}

export interface RoutePoint { x: number; y: number }
export interface RouteStop extends RoutePoint { /** Its label goes above the path, or below. */ side: 'above' | 'below' }
export interface RouteLeg { d: string; state: 'travelled' | 'flying' | 'ahead' }
export interface RouteLayout {
  width: number; height: number;
  launch: RoutePoint; destination: RoutePoint;
  stops: RouteStop[];
  /** One leg INTO each stop, and one into the destination: stops.length + 1 of them. */
  legs: RouteLeg[];
  ship: RoutePoint;
}

export const ROUTE = { left: 96, right: 210, minStep: 112, node: 68, label: 124 } as const;

/**
 * Lay the route out in a box at least `width` wide: the stops evenly spaced, alternately above and
 * below the middle so their labels never meet, joined by one smooth line. A plan with more stops
 * than fit gets a wider route (it scrolls) rather than a tighter one.
 */
export function routeLayout(stages: readonly EpicStage[], width: number, height: number): RouteLayout {
  const n = stages.length;
  const w = Math.max(width, ROUTE.left + ROUTE.right + (n + 1) * ROUTE.minStep);
  const mid = height / 2;
  const amp = Math.min(64, height * 0.17);
  const step = (w - ROUTE.left - ROUTE.right) / (n + 1);
  const launch = { x: ROUTE.left * 0.55, y: mid + amp * 0.75 };
  const destination = { x: w - ROUTE.right * 0.5, y: mid - amp * 0.35 };
  const stops: RouteStop[] = stages.map((_, i) => ({ x: ROUTE.left + (i + 1) * step, y: i % 2 === 0 ? mid - amp : mid + amp, side: i % 2 === 0 ? 'above' : 'below' }));
  const points: RoutePoint[] = [launch, ...stops, destination];
  const at = currentStop(stages);
  const legs: RouteLeg[] = points.slice(1).map((p, i) => {
    const from = points[i];
    const half = (p.x - from.x) / 2;
    const d = `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${(from.x + half).toFixed(1)} ${from.y.toFixed(1)}, ${(p.x - half).toFixed(1)} ${p.y.toFixed(1)}, ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    // Leg i leads into stop i (or the destination, last). Behind the ship it is travelled; the one it is on is being flown.
    return { d, state: i < at ? 'travelled' : i === at ? 'flying' : 'ahead' };
  });
  // The ship: at the destination when everything is delivered; at its stop once that epic has
  // started; otherwise halfway along the leg towards it. With no epics it waits at the launch.
  let ship: RoutePoint = launch;
  if (n > 0) {
    if (at >= n) ship = destination;
    else if (stages[at] === 'under-way' || stages[at] === 'late') ship = { x: stops[at].x, y: stops[at].y };
    else { const from = points[at]; ship = { x: (from.x + stops[at].x) / 2, y: (from.y + stops[at].y) / 2 }; }
  }
  return { width: w, height, launch, destination, stops, legs, ship };
}
