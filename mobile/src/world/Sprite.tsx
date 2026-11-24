import React, { useEffect, useState } from 'react';
import { View, Image, type ImageSourcePropType } from 'react-native';
import type { SheetArt } from './art.generated';

/**
 * One animated figure from a drawn sprite sheet — the phone's version of the dashboard's
 * sprite strip (world/Avatar.tsx, bridge DeckSprite). The sheet is a grid: a row per look, a
 * column per frame. The view shows one cell and steps along its row.
 *
 * Nothing is ever drawn from code: a look the sheet has no row for falls back to the sheet's
 * first row rather than to a shape made up here.
 */
export function Sprite({
  art, anim, height, fps = 4, facing = 1, paused = false,
}: {
  /** A sheet bundled with the app, or one on the server (`{ uri }`). */
  art: Omit<SheetArt, 'source'> & { source: ImageSourcePropType };
  anim: string;
  /** Height on screen; the width follows the cell's proportions. */
  height: number;
  fps?: number;
  /** 1 faces right (as drawn), -1 faces left. */
  facing?: 1 | -1;
  /** Hold the first frame (reduced motion, or a screen that is not in front). */
  paused?: boolean;
}) {
  const cycle = art.rows[anim] ?? Object.values(art.rows)[0];
  const [frame, setFrame] = useState(0);

  // A new look starts on its first frame.
  useEffect(() => { setFrame(0); }, [anim]);
  useEffect(() => {
    if (paused || cycle.frames < 2 || fps <= 0) return undefined;
    const t = setInterval(() => setFrame((f) => (f + 1) % cycle.frames), 1000 / fps);
    return () => clearInterval(t);
  }, [paused, cycle.frames, fps, anim]);

  const scale = height / art.frameH;
  const width = art.frameW * scale;
  return (
    <View
      style={{ width, height, overflow: 'hidden', transform: facing < 0 ? [{ scaleX: -1 }] : undefined }}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Image
        source={art.source}
        resizeMode="stretch"
        fadeDuration={0}
        style={{
          position: 'absolute',
          left: -Math.min(frame, cycle.frames - 1) * width,
          top: -cycle.row * height,
          width: art.cols * width,
          height: art.rowCount * height,
        }}
      />
    </View>
  );
}
