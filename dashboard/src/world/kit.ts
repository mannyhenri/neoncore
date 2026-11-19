/**
 * THE SCENERY KIT — which drawn sprite stands for what.
 *
 * The sprites themselves are in `public/world/kit/` and listed in `kit.generated.ts` (both
 * written by `scripts/world/build_world_kit.py` from the sheets in `designs/`). This file is
 * the meaning: how many queued items make which stack of crates, how full the energy cell is.
 */
import { KIT } from './kit.generated';

export type KitName = keyof typeof KIT;

/** The crate stacks, smallest first. Four or more queued items are a pile. */
export const CRATE_STEPS = ['crate-1', 'crate-2', 'crate-3', 'crate-pile'] as const satisfies readonly KitName[];

/** Queue lane → a stack of crates at the agent's work site. Nothing queued, nothing drawn. */
export function crateSpriteFor(waiting: number): KitName | null {
  if (!(waiting > 0)) return null;
  return CRATE_STEPS[Math.min(Math.floor(waiting), CRATE_STEPS.length) - 1];
}

/** Token burn → how full the energy cell on the panel is (share is 0–1 of the busiest agent). */
export function cellSpriteFor(share: number): KitName {
  if (share >= 0.66) return 'cell-full';
  if (share >= 0.33) return 'cell-half';
  return 'cell-low';
}

export { KIT };
