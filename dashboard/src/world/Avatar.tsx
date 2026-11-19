/**
 * A crew member's figure: one cycle of a drawn sprite sheet, played in place.
 *
 * THE PLAYER: the row for the current cycle is shown through a one-cell window, and a CSS
 * animation (`world-strip`, steps(n)) slides it one cell at a time. No timers and no
 * re-renders per frame, which keeps a scene with dozens of agents cheap without a GPU.
 * Reduced-motion users see the first frame.
 *
 * NO SHEET, NO FIGURE. If the character has no sprite sheet (sheets.ts) this renders nothing —
 * there is deliberately no stand-in drawn from code.
 */
import { ANIMATIONS } from './anim';
import type { AnimationName } from './anim';
import { sheetFor } from './sheets';

export function Avatar({ character, height, anim, facing = 1 }: {
  /** Which drawn character this agent is (sheets.ts). */
  character: string;
  height: number;
  anim: AnimationName;
  /** 1 faces right (as drawn), -1 faces left. */
  facing?: 1 | -1;
}) {
  const sheet = sheetFor(character);
  if (!sheet) return null;

  const { row, frames, top } = sheet.rows[anim];
  const totalRows = Math.max(...Object.values(sheet.rows).map((r) => r.row)) + 1;
  const totalCols = Math.max(...Object.values(sheet.rows).map((r) => r.frames));
  const width = (height * sheet.frameW) / sheet.frameH;

  return (
    <div
      data-world-avatar={character}
      aria-hidden="true"
      className="overflow-hidden"
      // Each cell has empty room above the figure (a lot of it when kneeling). Pull the figure up
      // by exactly that much, so the overhead panel sits just above the head in every cycle.
      style={{ width, height, marginTop: -height * top, transform: facing < 0 ? 'scaleX(-1)' : undefined }}
    >
      <div
        // Re-keyed per cycle so a new animation starts on its first frame.
        key={anim}
        className="world-strip"
        style={{
          width: width * frames,
          height,
          backgroundImage: `url(${sheet.src})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${width * totalCols}px ${height * totalRows}px`,
          backgroundPosition: `0 ${-row * height}px`,
          animationDuration: `${frames / ANIMATIONS[anim].fps}s`,
          animationTimingFunction: `steps(${frames})`,
        }}
      />
    </div>
  );
}
