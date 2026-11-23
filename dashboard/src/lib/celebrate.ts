/**
 * A FEATURE WAS MARKED DONE → fireworks (components/Fireworks.tsx), wherever it was marked: the
 * feature page's Mark done, a drag to Done on the Board, the pipeline panel's Done step.
 * Called only once the server has accepted it.
 */
export const CELEBRATE_EVENT = 'neoncore:feature-done';
export interface Celebration { name: string }

export function celebrateFeature(name: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<Celebration>(CELEBRATE_EVENT, { detail: { name } }));
}
