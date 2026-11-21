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
// The site's cycle is where a working agent STARTS from when the scene gives it no cycle of
// its own. On the map each working agent plays one of the four work cycles and changes every
// 40–90 seconds (props.ts workCycleAt) — kneeling, repairing, tending, or standing with a tool.

/**
 * WHAT DRIVES EACH ANIMATION — one real event behind every cycle, most urgent first:
 *
 *   walk    the figure is moving: it arrived, its status changed, or it was sent back to its site
 *   rest    its task just finished (working → idle or waiting): it wipes its brow for a moment,
 *           then stands idle or waves for you. (`jump` is drawn and unused.)
 *   call    it is stuck
 *   alert   it needs an approval, an answer or a review, or is waiting on you
 *   work    it is working — one of the four work cycles (kneel / repair / tend / work), with a tool in hand
 *   sit     it has been idle for 30 minutes and has reached the bench by the pond
 *   idle    it is idle — standing still at its building, or wherever you put it
 *
 * ONE LOOK PER STATE, wherever the figure stands: busy with a tool = working, sitting on the bench
 * or standing still = idle, waving = needs you, calling = stuck. Nothing else may share those looks.
 *
 * Idle agents do not wander: any movement on the map means something happened.
 */
export function animationFor(
  member: Pick<CrewMember, 'status' | 'attention'>,
  walking: boolean,
  posture: WorkPosture = 'stand',
  moment: { finishing?: boolean; seated?: boolean; workCycle?: AnimationName } = {},
): AnimationName {
  if (walking) return 'walk';
  if (moment.finishing) return 'rest';
  if (member.attention === 'stuck') return 'call';
  if (member.attention || member.status === 'waiting') return 'alert';
  if (member.status === 'working') return moment.workCycle ?? WORK_CYCLE[posture];
  if (moment.seated) return 'sit';
  return 'idle';
}
