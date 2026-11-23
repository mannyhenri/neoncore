/**
 * THE SIMULATED DESIGNER — every direction it can produce is usable (legible, distinct, complete),
 * every word it claims to understand changes what it says it changes, and it never repeats itself.
 */
import { describe, it, expect } from 'vitest';
import {
  ARCHETYPES, FEEDBACK, FONTS, PAIRINGS, VARIATIONS_PER_ROUND, brandColors, colorName, contrast, extractColors, fontStack,
  hexToHsl, hslToHex, legible, proposeRound, readableOn, tokensFor, understood,
} from '../designer';
import type { DesignRound, DesignTokens } from '../../../types';

const HEX = /^#[0-9a-f]{6}$/;
// Palettes a real set of pictures could give: vivid, pastel, dark, greys only, one colour, none.
const PALETTES: Record<string, string[]> = {
  vivid: ['#ff3b30', '#0a84ff', '#111111', '#ffffff'],
  pastel: ['#f6d6e2', '#cfe8ff', '#fff4c9', '#fafafa'],
  dark: ['#0b1020', '#16213e', '#7c5cff', '#22d3ee'],
  greys: ['#111111', '#777777', '#eeeeee'],
  one: ['#16a34a'],
  none: [],
  neon: ['#00ff9c', '#ff00e5', '#000000'],
  earth: ['#8b5e34', '#d9a066', '#f3e9dc', '#2f2a25'],
};
const usable = (t: DesignTokens, label: string) => {
  for (const [k, v] of Object.entries(t.colors)) expect(v, `${label} ${k}`).toMatch(HEX);
  // What a person reads must read; what they press must stand out from the page.
  expect(contrast(t.colors.text, t.colors.bg), `${label}: text on bg`).toBeGreaterThanOrEqual(7);
  expect(contrast(t.colors.muted, t.colors.bg), `${label}: muted on bg`).toBeGreaterThanOrEqual(4.4);
  expect(contrast(t.colors.onPrimary, t.colors.primary), `${label}: label on primary`).toBeGreaterThanOrEqual(4.4);
  expect(contrast(t.colors.primary, t.colors.bg), `${label}: primary on bg`).toBeGreaterThanOrEqual(2.9);
  expect(FONTS[t.fontHeading], `${label}: heading font`).toBeTruthy();
  expect(FONTS[t.fontBody], `${label}: body font`).toBeTruthy();
  expect(t.radius).toBeGreaterThanOrEqual(0); expect(t.radius).toBeLessThanOrEqual(28);
  expect(['compact', 'cozy', 'roomy']).toContain(t.density);
  expect(['flat', 'soft', 'glass', 'outline']).toContain(t.surface);
  expect(t.dark, `${label}: dark flag matches its background`).toBe(hexToHsl(t.colors.bg).l < 0.5);
};
const round = (id: string, r: ReturnType<typeof proposeRound>): DesignRound => ({ id, at: '2026-11-21T00:00:00Z', ...r });

describe('colour', () => {
  it('hex → hsl → hex gives the colour back, for a spread of colours', () => {
    for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#3b6cff', '#f6d6e2', '#8b5e34', '#123456', '#abcdef', '#7f7f7f']) {
      const back = hslToHex(hexToHsl(hex));
      for (const i of [1, 3, 5]) expect(Math.abs(parseInt(back.slice(i, i + 2), 16) - parseInt(hex.slice(i, i + 2), 16)), `${hex} → ${back}`).toBeLessThanOrEqual(1);
    }
  });
  it('legible() and readableOn() always end up readable, on every background', () => {
    for (const bg of ['#000000', '#ffffff', '#0b1020', '#f6d6e2', '#777777', '#ff3b30', '#fff4c9']) {
      // (On the exact mid-grey neither black nor white reaches 4.5; the better of the two is 4.48.)
      expect(contrast(readableOn(bg), bg), bg).toBeGreaterThanOrEqual(4.4);
      expect(contrast(readableOn(bg), bg), bg).toBe(Math.max(contrast('#ffffff', bg), contrast('#0b0d12', bg)));
      for (const fg of ['#777777', '#ff3b30', '#0a84ff', '#eeeeee', '#111111']) expect(contrast(legible(fg, bg, 4.5), bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('reads a picture\'s colours: the vivid ones first, near-duplicates once, transparent pixels ignored', () => {
    const px = (r: number, g: number, b: number, n: number, a = 255) => Array.from({ length: n }, () => [r, g, b, a]).flat();
    const colors = extractColors([...px(250, 250, 250, 600), ...px(255, 59, 48, 120), ...px(252, 60, 50, 60), ...px(10, 132, 255, 90), ...px(0, 255, 0, 500, 0)]);
    const first = hexToHsl(colors[0]);
    expect(first.h < 15 && first.s > 0.8, `the red leads, though white covers more: ${colors[0]}`).toBe(true);
    expect(colors.filter((c) => hexToHsl(c).h < 20 && hexToHsl(c).s > 0.5)).toHaveLength(1);
    expect(colors.some((c) => { const h = hexToHsl(c); return h.h > 200 && h.h < 220 && h.s > 0.5; })).toBe(true);
    expect(colors.some((c) => { const h = hexToHsl(c); return h.h > 100 && h.h < 140 && h.s > 0.5; }), 'a fully transparent green was counted').toBe(false);
    expect(extractColors([])).toEqual([]);
    expect(extractColors(px(1, 2, 3, 10), 3).length).toBe(1);
  });
  it('finds a primary and a different accent in every palette — even one with nothing vivid in it', () => {
    for (const [name, colors] of Object.entries(PALETTES)) {
      const { primary, accent } = brandColors(colors);
      expect(primary, name).toMatch(HEX); expect(accent, name).toMatch(HEX);
      const a = hexToHsl(primary); const b = hexToHsl(accent);
      expect(Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h)), `${name}: accent is the primary again`).toBeGreaterThanOrEqual(30);
      expect(colorName(primary).length, name).toBeGreaterThan(2);
    }
    expect(brandColors(PALETTES.vivid).primary).toBe('#ff3b30');
  });
});

describe('the directions', () => {
  it('there are eight, each with its own name, look and reason', () => {
    expect(ARCHETYPES).toHaveLength(8);
    expect(new Set(ARCHETYPES.map((a) => a.name)).size).toBe(8);
    expect(new Set(ARCHETYPES.map((a) => `${a.fontHeading}|${a.radius}|${a.surface}|${a.dark}|${a.density}`)).size).toBe(8);
    for (const a of ARCHETYPES) expect(a.why, a.name).toContain('{primary}');
    for (const [h, b] of PAIRINGS) { expect(FONTS[h], h).toBeTruthy(); expect(FONTS[b], b).toBeTruthy(); }
    expect(fontStack('Didot')).toContain('serif');
    expect(fontStack('Something Else')).toContain('"Something Else"');
  });
  it('every direction is usable in every palette', () => {
    for (const [name, colors] of Object.entries(PALETTES)) for (const a of ARCHETYPES) usable(tokensFor(a, brandColors(colors)), `${a.name} in ${name}`);
  });
});

describe('a round', () => {
  it('is four different directions, in the pictures\' colours, each saying why', () => {
    for (const [name, colors] of Object.entries(PALETTES)) {
      const r = proposeRound({ colors, rounds: [], feedback: '' });
      expect(r.variations, name).toHaveLength(VARIATIONS_PER_ROUND);
      expect(new Set(r.variations.map((v) => v.id)).size).toBe(4);
      expect(new Set(r.variations.map((v) => v.name)).size).toBe(4);
      expect(new Set(r.variations.map((v) => JSON.stringify(v.tokens))).size, `${name}: two directions are identical`).toBe(4);
      expect(new Set(r.variations.map((v) => v.tokens.fontHeading)).size, `${name}: not enough type variety`).toBeGreaterThanOrEqual(3);
      for (const v of r.variations) { usable(v.tokens, `${name}/${v.name}`); expect(v.rationale.length).toBeGreaterThan(40); expect(v.rationale).not.toContain('{primary}'); expect(v.comments).toEqual([]); }
      expect(r.basedOn).toBeNull();
    }
  });
  it('the same inputs give the same round; a new round shows four directions not shown just before; all eight come round', () => {
    const colors = PALETTES.vivid;
    expect(proposeRound({ colors, rounds: [], feedback: 'darker' })).toEqual(proposeRound({ colors, rounds: [], feedback: 'darker' }));
    const rounds: DesignRound[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const r = proposeRound({ colors, rounds, feedback: '' });
      const before = new Set((rounds[i - 1]?.variations ?? []).map((v) => v.name));
      for (const v of r.variations) { expect(before.has(v.name), `round ${i + 1} repeats ${v.name}`).toBe(false); seen.add(v.name); }
      // Ids never collide with an earlier round's.
      for (const v of r.variations) expect(rounds.flatMap((x) => x.variations).some((o) => o.id === v.id)).toBe(false);
      rounds.push(round(`r${i + 1}`, r));
    }
    expect(seen.size).toBe(ARCHETYPES.length);
  });
});

describe('comments', () => {
  const check: Record<string, (before: DesignTokens, after: DesignTokens) => boolean> = {
    darker: (_b, a) => a.dark, lighter: (_b, a) => !a.dark,
    rounder: (b, a) => a.radius > b.radius || b.radius >= 28, sharper: (_b, a) => a.radius === 0,
    serif: (_b, a) => /serif$/.test(FONTS[a.fontHeading]) && !/sans-serif$/.test(FONTS[a.fontHeading]),
    sans: (_b, a) => /sans-serif$/.test(FONTS[a.fontHeading]), mono: (_b, a) => a.fontHeading === 'Menlo',
    bolder: (b, a) => hexToHsl(a.colors.primary).s >= hexToHsl(b.colors.primary).s - 0.02,
    calmer: (b, a) => hexToHsl(a.colors.primary).s < hexToHsl(b.colors.primary).s,
    roomier: (_b, a) => a.density === 'roomy', denser: (_b, a) => a.density === 'compact',
    warmer: (_b, a) => { const h = hexToHsl(a.colors.bg).h; return h > 20 && h < 60; },
    cooler: (_b, a) => { const h = hexToHsl(a.colors.bg).h; return h > 190 && h < 250; },
    glass: (_b, a) => a.surface === 'glass', flat: (_b, a) => a.surface === 'flat', outline: (_b, a) => a.surface === 'outline',
  };
  const SAMPLE: Record<string, string> = {
    darker: 'make it darker', lighter: 'I want it lighter', rounder: 'rounder corners please', sharper: 'sharper', serif: 'try a serif', sans: 'sans-serif would be better',
    mono: 'more technical, monospace', bolder: 'more colour, bolder', calmer: 'calmer and more minimal', roomier: 'more space, airy', denser: 'more compact',
    warmer: 'warmer', cooler: 'cooler tones', glass: 'frosted glass', flat: 'flatter, no shadows', outline: 'thick outlines',
  };
  it('every word it understands is listed with a sample and a check', () => {
    expect(Object.keys(check).sort()).toEqual(FEEDBACK.map((f) => f.id).sort());
    expect(Object.keys(SAMPLE).sort()).toEqual(FEEDBACK.map((f) => f.id).sort());
  });
  it.each(FEEDBACK.map((f) => ({ id: f.id })))('"$id" changes what it says it changes, on every direction, and leaves it usable', ({ id }) => {
    expect(understood(SAMPLE[id]).map((f) => f.id), SAMPLE[id]).toContain(id);
    for (const colors of [PALETTES.vivid, PALETTES.dark, PALETTES.greys]) {
      const plain = proposeRound({ colors, rounds: [], feedback: '' });
      const asked = proposeRound({ colors, rounds: [], feedback: SAMPLE[id] });
      asked.variations.forEach((v, i) => {
        expect(check[id](plain.variations[i].tokens, v.tokens), `${id} on ${v.name}`).toBe(true);
        usable(v.tokens, `${id}/${v.name}`);
        expect(v.rationale).toContain('Adjusted as asked');
      });
    }
  });
  it('"sans-serif" is not read as "serif"; words it does not know change nothing; several can be asked at once', () => {
    expect(understood('sans-serif please').map((f) => f.id)).toEqual(['sans']);
    expect(understood('I love it, ship it')).toEqual([]);
    expect(proposeRound({ colors: PALETTES.vivid, rounds: [], feedback: 'ship it' }).variations).toEqual(proposeRound({ colors: PALETTES.vivid, rounds: [], feedback: '' }).variations);
    const many = proposeRound({ colors: PALETTES.vivid, rounds: [], feedback: 'darker, rounder, with a serif and more space' });
    for (const v of many.variations) { expect(v.tokens.dark).toBe(true); expect(v.tokens.density).toBe('roomy'); usable(v.tokens, v.name); }
  });
});

describe('"more like this one"', () => {
  it('gives four takes on that direction: itself refined, new type, the accent leading, the other mode — for every direction', () => {
    const first = round('r1', proposeRound({ colors: PALETTES.vivid, rounds: [], feedback: '' }));
    const second = round('r2', proposeRound({ colors: PALETTES.vivid, rounds: [first], feedback: '' }));
    for (const [r, list] of [[first, [first]], [second, [first, second]]] as const) for (const base of r.variations) {
      const next = proposeRound({ colors: PALETTES.vivid, rounds: list, feedback: '', base: { roundId: r.id, variation: base } });
      expect(next.basedOn).toEqual({ roundId: r.id, variationId: base.id });
      expect(next.variations).toHaveLength(4);
      expect(new Set(next.variations.map((v) => JSON.stringify(v.tokens))).size, `${base.name}: two takes are identical`).toBe(4);
      const [same, type, accent, mode] = next.variations;
      expect(same.tokens).toEqual(base.tokens);
      expect(type.tokens.fontHeading).not.toBe(base.tokens.fontHeading);
      expect(type.tokens.colors).toEqual(base.tokens.colors);
      expect(accent.tokens.colors.primary).not.toBe(base.tokens.colors.primary);
      expect(mode.tokens.dark).toBe(!base.tokens.dark);
      for (const v of next.variations) { expect(v.name.startsWith(base.name)).toBe(true); usable(v.tokens, `${base.name} → ${v.name}`); }
    }
  });
  it('applies the comments to all four takes', () => {
    const first = round('r1', proposeRound({ colors: PALETTES.dark, rounds: [], feedback: '' }));
    const next = proposeRound({ colors: PALETTES.dark, rounds: [first], feedback: 'rounder and more compact', base: { roundId: 'r1', variation: first.variations[0] } });
    for (const v of next.variations) { expect(v.tokens.radius).toBeGreaterThan(first.variations[0].tokens.radius); expect(v.tokens.density).toBe('compact'); }
    expect(next.brief).toBe('rounder and more compact');
  });
});
