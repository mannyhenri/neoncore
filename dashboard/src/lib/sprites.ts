// ---------------------------------------------------------------------------
// 8-bit pixel art sprites (hand-crafted Atari/NES-style game characters)
// Shared across CartridgeCard and VirtualCartridgeCard
// ---------------------------------------------------------------------------

// Each sprite is an array of row strings. '#' = filled pixel, '.' = empty.
// All sprites are 11 wide × 8 tall for consistent sizing.
export const SPRITES: string[][] = [
  [ // Space Invader (crab)
    '..#.....#..', '...#...#...', '..#######..', '.##.###.##.',
    '###########', '#.#######.#', '#.#.....#.#', '...##.##...',
  ],
  [ // Space Invader (squid)
    '.....#.....', '....###....', '...#####...', '..##.#.##..',
    '..#######..', '....#.#....', '...#...#...', '..#.....#..',
  ],
  [ // Ghost (Pac-Man)
    '...#####...', '..#######..', '.##.##.##..', '.#########.',
    '.#########.', '.#########.', '.#########.', '.#.##.##.#.',
  ],
  [ // Pac-Man
    '...####....', '..######...', '.########..', '.######....',
    '.####......', '.######....', '..######...', '...####....',
  ],
  [ // Rocket ship
    '.....#.....', '....###....', '....###....', '...#####...',
    '...#####...', '..##.#.##..', '.##.###.##.', '.#...#...#.',
  ],
  [ // Robot
    '..#######..', '..#.#.#.#..', '..#######..', '...#####...',
    '.#########.', '...#####...', '..##...##..', '..##...##..',
  ],
  [ // Heart
    '..##...##..', '.####.####.', '.#########.', '.#########.',
    '..#######..', '...#####...', '....###....', '.....#.....',
  ],
  [ // Skull
    '..#######..', '.#########.', '.##.###.##.', '.#########.',
    '.#########.', '...#.#.#...', '..#######..', '..#.#.#.#..',
  ],
  [ // Crown
    '.#...#...#.', '.##.###.##.', '.#########.', '.#########.',
    '.#########.', '.#########.', '..#######..', '...........',
  ],
  [ // Mushroom (Mario-style)
    '...#####...', '..##.#.##..', '.###.#.###.', '.##.###.##.',
    '.#########.', '...#####...', '...#####...', '...#####...',
  ],
  [ // Alien face
    '..#.....#..', '.#.#####.#.', '.#.##.##.#.', '.#.#####.#.',
    '.#########.', '..#.###.#..', '..#.....#..', '...#####...',
  ],
  [ // Shield / badge
    '.#########.', '###########', '###.###.###', '###########',
    '.#########.', '..#######..', '...#####...', '....###....',
  ],
  [ // Sword
    '.....#.....', '.....#.....', '.....#.....', '.....#.....',
    '....###....', '.....#.....', '...#####...', '....###....',
  ],
  [ // Tank
    '....##.....', '..########.', '.##########', '.#..#..#..#',
    '.##########', '.#.######.#', '..########.', '...........',
  ],
  [ // Star / power-up
    '.....#.....', '....###....', '.#########.', '..#######..',
    '...#####...', '..##...##..', '.##.....##.', '.#.......#.',
  ],
  [ // Castle turret
    '.#.###.#...', '.#.###.#...', '.#########.', '..#######..',
    '..#.#.#.#..', '..#######..', '..#######..', '..#######..',
  ],
  [ // Lightning bolt
    '...####....', '..####.....', '.####......', '..########.',
    '......####.', '.....####..', '....####...', '...........',
  ],
  [ // Diamond / gem
    '.....#.....', '....###....', '...#####...', '..#######..',
    '..#######..', '...#####...', '....###....', '.....#.....',
  ],
  [ // Dragon / monster
    '.##.....##.', '.###...###.', '..#######..', '.#.##.##.#.',
    '.#########.', '..#.....#..', '.##.###.##.', '.#.......#.',
  ],
  [ // Spaceship (wide)
    '.....#.....', '...#####...', '..#######..', '.####.####.',
    '###########', '#.###.###.#', '..#.....#..', '...........',
  ],
  [ // Tree
    '.....#.....', '....###....', '...#####...', '..#######..',
    '.#########.', '...#####...', '....###....', '....###....',
  ],
  [ // Potion / flask
    '...#####...', '....###....', '....###....', '...#####...',
    '..#######..', '..##.####..', '..#######..', '...#####...',
  ],
  [ // Key
    '..####.....', '..#..#.....', '..####.....', '....#......',
    '....####...', '....#......', '....###....', '...........',
  ],
  [ // Music note
    '......####.', '......#..#.', '......#..#.', '......#..#.',
    '..##..#....', '.####.#....', '.####.####.', '..##..####.',
  ],
];

// Color palettes — each sprite gets a primary + accent color
export const SPRITE_COLORS = [
  ['#e74c3c', '#ff6b6b'],  // red
  ['#e67e22', '#ffa04c'],  // orange
  ['#f1c40f', '#ffe066'],  // yellow
  ['#2ecc71', '#6ff5a5'],  // green
  ['#1abc9c', '#55efc4'],  // teal
  ['#3498db', '#74b9ff'],  // blue
  ['#9b59b6', '#c39bd3'],  // purple
  ['#e84393', '#fd79a8'],  // pink
  ['#00cec9', '#55f5f0'],  // cyan
  ['#6c5ce7', '#a29bfe'],  // indigo
  ['#fdcb6e', '#ffeaa7'],  // gold
  ['#00b894', '#55efc4'],  // mint
];

export function hashStr(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Render a sprite grid to an SVG data URL. */
export function spriteToSvg(sprite: string[], primary: string, accent: string): string {
  const W = sprite[0].length;
  const H = sprite.length;
  const rects: string[] = [];

  for (let y = 0; y < H; y++) {
    const row = sprite[y];
    for (let x = 0; x < W; x++) {
      if (row[x] === '#') {
        const color = ((x + y) % 3 === 0) ? accent : primary;
        rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`);
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Generate a second animation frame by shifting the bottom rows. */
export function generateFrame2(sprite: string[]): string[] {
  const f2 = [...sprite];
  for (let i = Math.max(0, f2.length - 3); i < f2.length; i++) {
    const row = f2[i];
    f2[i] = row[row.length - 1] + row.slice(0, -1);
  }
  return f2;
}

/**
 * Pick a unique sprite + color for an ID and render two animation frames.
 * Returns [frame1svg, frame2svg, animSpeed].
 */
export function generatePixelSprites(id: string): [string, string, number] {
  const seed = hashStr(id);
  const sprite = SPRITES[seed % SPRITES.length];
  const [primary, accent] = SPRITE_COLORS[(seed * 7 + 3) % SPRITE_COLORS.length];

  const frame1 = spriteToSvg(sprite, primary, accent);
  const frame2 = spriteToSvg(generateFrame2(sprite), primary, accent);
  const speed = 500 + (seed % 5) * 100;

  return [frame1, frame2, speed];
}
