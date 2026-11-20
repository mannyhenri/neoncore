/**
 * HOW AN AVATAR MOVES — the animation registry and the mapping from an agent's state to a cycle.
 *
 * The artwork itself is drawn sprite sheets (sheets.ts). There are no figures drawn from code:
 * an engine without a sheet shows its overhead panel and no figure.
 */
import type { CrewMember } from './crew';

/** In atlas row order (scripts/world/build_crew_sheets.py writes the rows in this order). */
export const ANIMATION_NAMES = ['idle', 'walk', 'work', 'kneel', 'repair', 'tend', 'alert', 'rest', 'call', 'jump', 'sit'] as const;
/**
 * Cycles a character's sheet may not have drawn yet — none today: every character has all
 * eleven. A NEW character may list one here while its art is on the way; the figure then shows
 * `idle` in its place (Avatar.tsx), and nothing is drawn in code to fill the gap.
 */
export const OPTIONAL_ANIMATIONS: readonly AnimationName[] = [];
export type AnimationName = (typeof ANIMATION_NAMES)[number];

/** Playback speed per cycle, in frames per second. Frame counts come from each sheet. */
export const ANIMATIONS: Record<AnimationName, { fps: number }> = {
  idle: { fps: 3 },
  walk: { fps: 8 },
  work: { fps: 5 },
  kneel: { fps: 4 },
  repair: { fps: 5 },
  tend: { fps: 4 },
  alert: { fps: 6 },
  rest: { fps: 2 },
  call: { fps: 6 },
  jump: { fps: 7 },
  sit: { fps: 2 },
};

/**
 * HOW WORK IS DONE AT A SITE. In the concept art the crew kneel at the generator, the planter
 * and the water station, and stand at the survey tripod — so the posture belongs to the site
 * (sites.ts), and each posture has its own work cycle.
 */
export const WORK_POSTURES = ['stand', 'kneel', 'repair', 'tend'] as const;
export type WorkPosture = (typeof WORK_POSTURES)[number];
/**
 * stand  — on their feet, tool or tablet in hand (the survey tripod, doors, the pad)
 * kneel  — down on one knee, scanning the ground (water station, crates, rover track)
 * repair — kneeling at a machine with a tool (the generator)
 * tend   — crouched, hands in the soil (the planter)
 */
export const WORK_CYCLE: Record<WorkPosture, AnimationName> = { stand: 'kneel', kneel: 'kneel', repair: 'repair', tend: 'tend' };
// `stand` sites use the kneeling cycle too: WORKING ALWAYS LOOKS THE SAME — down on the floor
// with a tool. A working agent on its feet at one site and on its knees at another could not
// be told from an idle one at a glance. (The drawn `work` and `rest` rows are unused.)

/**
 * WHAT DRIVES EACH ANIMATION — one real event behind every cycle, most urgent first:
 *
 *   walk    the figure is moving: it arrived, its status changed, or it was sent back to its site
 *   jump    its turn just finished (working → idle), for a moment, before it walks off
 *   call    it is stuck
 *   alert   it needs an approval, an answer or a review, or is waiting on you
 *   floor   it is working — down at its work with a tool (kneel / repair / tend, by site)
 *   sit     it is idle and has reached a seat — sitting (only on a plate that has seats; the map has none today)
 *   idle    it is idle — standing still at its building, or wherever you put it
 *
 * ONE LOOK PER STATE, wherever the figure stands: on the floor = working, sitting on a bench
 * (or standing still, off it) = idle, waving = needs you, calling = stuck. Nothing else may share those looks.
 *
 * Idle agents do not wander: any movement on the map means something happened.
 */
export function animationFor(
  member: Pick<CrewMember, 'status' | 'attention'>,
  walking: boolean,
  posture: WorkPosture = 'stand',
  moment: { cheering?: boolean; seated?: boolean } = {},
): AnimationName {
  if (walking) return 'walk';
  if (moment.cheering) return 'jump';
  if (member.attention === 'stuck') return 'call';
  if (member.attention || member.status === 'waiting') return 'alert';
  if (member.status === 'working') return WORK_CYCLE[posture];
  if (moment.seated) return 'sit';
  return 'idle';
}
