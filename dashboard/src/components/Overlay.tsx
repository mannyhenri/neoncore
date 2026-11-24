import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Render a modal, backdrop or floating menu at the end of <body>, with `z-overlay` on it.
 *
 * A `fixed` element is only "over the page" if no ancestor makes a stacking context (a z-index,
 * transform, filter, backdrop blur or opacity). Rendered in place, a dialog opened from the top
 * bar or from a card on the map is sealed into that ancestor and paints under the next HUD.
 * Leaving the subtree is the only fix — see src/__tests__/overlayLayers.test.ts.
 */
export function Overlay({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
