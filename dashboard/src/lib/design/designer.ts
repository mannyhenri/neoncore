/**
 * THE DESIGNER — SIMULATED. Given the pictures a person likes and what they said, it answers with
 * FOUR design directions. Today this file does that by rule, so the whole flow (inspire → four
 * options → comment → four more → select) can be used and judged; the real designer — an agent
 * running Claude's /design over the same inputs — takes this file's place behind `proposeRound`
 * and nothing else changes.
 *
 * How the simulation decides, so its output is explainable rather than random:
 *   · COLOUR comes from the pictures: the most vivid colour found in them is the primary, the
 *     next most different vivid one the accent. Neutrals are tinted toward the primary's hue.
 *   · A DIRECTION is an archetype — a recognisable way an interface can look (editorial, console,
 *     soft product, poster…). A round shows four DIFFERENT archetypes, and a later round shows
 *     ones not shown just before.
 *   · COMMENTS change the next round: words like "darker", "rounder", "serif", "calmer",
 *     "more space" move the matching token on every direction (FEEDBACK below lists them all).
 *   · "MORE LIKE THIS ONE" makes the next round four takes on that direction: the same with the
 *     comments applied, another type pairing, another accent, and the other light/dark mode.
 *
 * Pure and deterministic: the same inputs give the same four directions.
 */
import type { DesignRound, DesignTokens, DesignVariation } from '../../types';

// ── colour ───────────────────────────────────────────────────────────────────────────────
export interface Hsl { h: number; s: number; l: number }
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export function hexToHsl(hex: string): Hsl {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: clamp(s), l };
}
export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * clamp(s);
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = clamp(l) - c / 2;
  const to = (v: number) => Math.round(clamp(v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
/** WCAG contrast ratio of two colours (1–21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Black or white, whichever reads better on `bg`. */
export const readableOn = (bg: string): string => (contrast(bg, '#ffffff') >= contrast(bg, '#0b0d12') ? '#ffffff' : '#0b0d12');
/** Move `fg` lighter or darker until it reads on `bg` at `min` contrast (it keeps its hue). */
export function legible(fg: string, bg: string, min = 4.5): string {
  const hsl = hexToHsl(fg);
  // Toward whichever end can actually get there: on a mid-tone red, white never reaches 4.5 but black does.
  const dir = contrast(bg, '#ffffff') >= contrast(bg, '#000000') ? 1 : -1;
  let out = fg;
  for (let i = 0; i < 40 && contrast(out, bg) < min; i++) { hsl.l = clamp(hsl.l + dir * 0.025); out = hslToHex(hsl); }
  return out;
}

/**
 * The colours of a picture: its pixels (RGBA bytes) sorted into coarse buckets, the fullest and
 * most vivid first. Near-identical colours count once. At most `max`.
 */
export function extractColors(rgba: ArrayLike<number>, max = 6): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const key = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
    const b = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += rgba[i]; b.g += rgba[i + 1]; b.b += rgba[i + 2];
    buckets.set(key, b);
  }
  const all = [...buckets.values()].map((b) => {
    const hex = `#${[b.r, b.g, b.b].map((v) => Math.round(v / b.n).toString(16).padStart(2, '0')).join('')}`;
    const { s, l } = hexToHsl(hex);
    // How much a colour matters: how much of the picture it covers, and far more if it is vivid.
    return { hex, weight: b.n * (0.25 + 3 * s * (1 - Math.abs(2 * l - 1))) };
  }).sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex));
  const out: string[] = [];
  for (const c of all) {
    const a = hexToHsl(c.hex);
    const same = out.some((o) => { const b = hexToHsl(o); const dh = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h)); return (a.s < 0.12 && b.s < 0.12 ? true : dh < 22) && Math.abs(a.l - b.l) < 0.16; });
    if (!same) out.push(c.hex);
    if (out.length >= max) break;
  }
  return out;
}

/** The primary and the accent a set of pictures suggests; a calm blue and a warm orange when there is nothing vivid. */
export function brandColors(colors: readonly string[]): { primary: string; accent: string } {
  const vivid = colors.map((hex) => ({ hex, ...hexToHsl(hex) })).filter((c) => c.s >= 0.28 && c.l > 0.18 && c.l < 0.82);
  const primary = vivid[0] ?? { hex: '#3b6cff', ...hexToHsl('#3b6cff') };
  const far = (c: Hsl) => Math.min(Math.abs(c.h - primary.h), 360 - Math.abs(c.h - primary.h));
  const other = vivid.slice(1).sort((a, b) => far(b) - far(a))[0];
  // No second vivid colour in the pictures: the accent is the primary's complement-ish neighbour.
  const accent = other && far(other) >= 30 ? other.hex : hslToHex({ h: primary.h + 150, s: clamp(primary.s, 0.5, 0.85), l: 0.55 });
  return { primary: primary.hex, accent };
}

// ── type ─────────────────────────────────────────────────────────────────────────────────
/** Typefaces by the name shown to a person; the stack is what the browser is given. */
export const FONTS: Record<string, string> = {
  Georgia: 'Georgia, "Times New Roman", serif',
  Didot: 'Didot, "Bodoni MT", "Playfair Display", Georgia, serif',
  Palatino: 'Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif',
  'Iowan Old Style': '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
  Rockwell: 'Rockwell, "Roboto Slab", "Courier New", serif',
  'Helvetica Neue': '"Helvetica Neue", Helvetica, Arial, sans-serif',
  'Avenir Next': '"Avenir Next", Avenir, "Segoe UI", sans-serif',
  Futura: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif',
  'Gill Sans': '"Gill Sans", "Gill Sans MT", Calibri, sans-serif',
  Optima: 'Optima, Candara, "Segoe UI", sans-serif',
  Verdana: 'Verdana, Geneva, sans-serif',
  'Trebuchet MS': '"Trebuchet MS", "Lucida Grande", sans-serif',
  Menlo: 'Menlo, Consolas, "Courier New", monospace',
  'SF Pro Rounded': '"SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif',
  'American Typewriter': '"American Typewriter", "Courier New", serif',
};
export const fontStack = (name: string): string => FONTS[name] ?? `${JSON.stringify(name)}, system-ui, sans-serif`;
const SERIFS = ['Georgia', 'Didot', 'Palatino', 'Iowan Old Style', 'Rockwell', 'American Typewriter'];
const MONOS = ['Menlo'];
/** Heading + body pairings, for "another type pairing". */
export const PAIRINGS: readonly (readonly [string, string])[] = [
  ['Didot', 'Avenir Next'], ['Futura', 'Georgia'], ['Rockwell', 'Helvetica Neue'], ['Gill Sans', 'Palatino'],
  ['Menlo', 'Helvetica Neue'], ['Optima', 'Verdana'], ['Iowan Old Style', 'Gill Sans'], ['SF Pro Rounded', 'Avenir Next'],
];

// ── the directions ───────────────────────────────────────────────────────────────────────
interface Archetype {
  id: string;
  name: string;
  /** Why this direction looks the way it does; {primary} is replaced by a description of the colour. */
  why: string;
  dark: boolean;
  fontHeading: string; fontBody: string;
  radius: number; density: DesignTokens['density']; surface: DesignTokens['surface'];
  /** Neutrals: how much of the primary's hue the background and surfaces carry, and how vivid the brand colours stay. */
  tint: number; vivid: number;
  /** A fixed warm or cool cast for the neutrals instead of the primary's hue (paper, ink). */
  cast?: number;
}
export const ARCHETYPES: readonly Archetype[] = [
  { id: 'editorial', name: 'Quiet Editorial', why: 'Reads like a well-set magazine: serif headlines, generous margins, hairline rules, and {primary} used sparingly so it means something.', dark: false, fontHeading: 'Didot', fontBody: 'Avenir Next', radius: 2, density: 'roomy', surface: 'flat', tint: 0.04, vivid: 0.85 },
  { id: 'console', name: 'Midnight Console', why: 'A control room at night: deep surfaces, mono headings, glowing {primary} for what is live. Built for long sessions and dense data.', dark: true, fontHeading: 'Menlo', fontBody: 'Helvetica Neue', radius: 6, density: 'compact', surface: 'glass', tint: 0.35, vivid: 1 },
  { id: 'soft', name: 'Soft Product', why: 'Friendly and rounded: big corners, soft shadows, pastel surfaces lifted from {primary}. Feels approachable on first use.', dark: false, fontHeading: 'SF Pro Rounded', fontBody: 'Avenir Next', radius: 18, density: 'cozy', surface: 'soft', tint: 0.22, vivid: 0.9 },
  { id: 'poster', name: 'Bold Poster', why: 'Loud on purpose: huge geometric type, square corners, flat blocks of {primary}. Every screen has one thing to say.', dark: false, fontHeading: 'Futura', fontBody: 'Helvetica Neue', radius: 0, density: 'roomy', surface: 'flat', tint: 0, vivid: 1.15 },
  { id: 'paper', name: 'Warm Paper', why: 'Cream paper and ink: a humanist face, warm neutrals, {primary} as the single spot colour. Calm, bookish, trustworthy.', dark: false, fontHeading: 'Iowan Old Style', fontBody: 'Gill Sans', radius: 6, density: 'cozy', surface: 'flat', tint: 0.5, vivid: 0.8, cast: 42 },
  { id: 'brutal', name: 'Neo Brutal', why: 'Thick outlines and hard edges: everything is a labelled box, {primary} fills the ones you can press. Honest and a little cheeky.', dark: false, fontHeading: 'Rockwell', fontBody: 'Verdana', radius: 4, density: 'cozy', surface: 'outline', tint: 0.06, vivid: 1.1 },
  { id: 'aurora', name: 'Glass Aurora', why: 'Translucent panels over a dark field washed with {primary}: depth from blur and light rather than borders. Modern and atmospheric.', dark: true, fontHeading: 'Avenir Next', fontBody: 'Avenir Next', radius: 14, density: 'cozy', surface: 'glass', tint: 0.55, vivid: 1.05 },
  { id: 'swiss', name: 'Swiss Grid', why: 'Nothing decorative: one grotesque, a strict grid, black on white, and {primary} only where the eye must go.', dark: false, fontHeading: 'Helvetica Neue', fontBody: 'Helvetica Neue', radius: 3, density: 'compact', surface: 'flat', tint: 0, vivid: 1 },
];

const HUE_NAMES: [number, string][] = [[15, 'red'], [40, 'orange'], [65, 'yellow'], [160, 'green'], [200, 'teal'], [250, 'blue'], [290, 'violet'], [335, 'pink'], [361, 'red']];
/** A colour in a word or two, for the rationale. */
export function colorName(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  if (s < 0.12) return l < 0.25 ? 'near-black' : l > 0.8 ? 'off-white' : 'grey';
  const hue = HUE_NAMES.find(([upTo]) => h < upTo)![1];
  return `${l < 0.32 ? 'deep ' : l > 0.68 ? 'light ' : s > 0.75 ? 'vivid ' : ''}${hue}`;
}

/** The tokens of an archetype in the given brand colours. Text always reads on its background. */
export function tokensFor(a: Archetype, brand: { primary: string; accent: string }): DesignTokens {
  const p = hexToHsl(brand.primary);
  const hue = a.cast ?? p.h;
  const vivid = (hex: string) => { const c = hexToHsl(hex); return hslToHex({ h: c.h, s: clamp(c.s * a.vivid), l: a.dark ? clamp(c.l, 0.55, 0.72) : clamp(c.l, 0.38, 0.56) }); };
  const bg = hslToHex(a.dark ? { h: hue, s: 0.3 * a.tint + 0.08, l: 0.07 } : { h: hue, s: 0.5 * a.tint, l: 0.985 - 0.05 * a.tint });
  const surface = hslToHex(a.dark ? { h: hue, s: 0.3 * a.tint + 0.08, l: 0.12 } : { h: hue, s: 0.55 * a.tint, l: a.tint > 0.1 ? 0.955 - 0.06 * a.tint : 1 });
  const text = hslToHex(a.dark ? { h: hue, s: 0.1, l: 0.94 } : { h: hue, s: 0.18 * Math.max(a.tint, 0.2), l: 0.1 });
  return fix({
    dark: a.dark,
    colors: {
      bg, surface, text,
      muted: hslToHex(a.dark ? { h: hue, s: 0.1, l: 0.66 } : { h: hue, s: 0.1, l: 0.42 }),
      primary: vivid(brand.primary), onPrimary: '#ffffff',
      accent: vivid(brand.accent),
      border: hslToHex(a.dark ? { h: hue, s: 0.2, l: 0.24 } : { h: hue, s: 0.15 * Math.max(a.tint, 0.2), l: a.surface === 'outline' ? 0.1 : 0.86 }),
    },
    fontHeading: a.fontHeading, fontBody: a.fontBody, radius: a.radius, density: a.density, surface: a.surface,
  });
}

// ── what a comment changes ───────────────────────────────────────────────────────────────
/** Every word the simulated designer understands, what it does, and how it says so. */
export const FEEDBACK: readonly { id: string; words: RegExp; say: string; apply: (t: DesignTokens) => DesignTokens }[] = [
  { id: 'darker', words: /\b(dark(er)?|night|black)\b/i, say: 'dark mode', apply: (t) => relight(t, true) },
  { id: 'lighter', words: /\b(light(er)?|bright(er)?|white)\b/i, say: 'light mode', apply: (t) => relight(t, false) },
  { id: 'rounder', words: /\b(round(er|ed)?|soft(er)?|pill|friendl(y|ier))\b/i, say: 'rounder corners', apply: (t) => ({ ...t, radius: Math.min(28, t.radius + 10) }) },
  { id: 'sharper', words: /\b(sharp(er)?|square(d)?|angular|hard(er)? edges?)\b/i, say: 'square corners', apply: (t) => ({ ...t, radius: 0 }) },
  { id: 'serif', words: /(?<!sans[- ])\bserifs?\b/i, say: 'serif headings', apply: (t) => ({ ...t, fontHeading: SERIFS.includes(t.fontHeading) ? t.fontHeading : 'Didot' }) },
  { id: 'sans', words: /\bsans([- ]serif)?\b/i, say: 'sans-serif headings', apply: (t) => ({ ...t, fontHeading: SERIFS.includes(t.fontHeading) || MONOS.includes(t.fontHeading) ? 'Avenir Next' : t.fontHeading }) },
  { id: 'mono', words: /\b(mono(space(d)?)?|code|terminal|technical)\b/i, say: 'monospace headings', apply: (t) => ({ ...t, fontHeading: 'Menlo' }) },
  { id: 'bolder', words: /\b(bold(er)?|vivid|vibrant|colou?rful|more colou?r|punch(y|ier)|saturated)\b/i, say: 'stronger colour', apply: (t) => recolor(t, 1.35) },
  { id: 'calmer', words: /\b(calm(er)?|muted|subtle|quiet(er)?|minimal(ist)?|less colou?r|toned? down)\b/i, say: 'calmer colour', apply: (t) => recolor(t, 0.6) },
  { id: 'roomier', words: /\b(airy|spacious|room(y|ier)?|more (white ?)?space|breath(e|ing)|bigger)\b/i, say: 'more space', apply: (t) => ({ ...t, density: 'roomy' }) },
  { id: 'denser', words: /\b(compact|dense(r)?|tight(er)?|less space|smaller)\b/i, say: 'tighter spacing', apply: (t) => ({ ...t, density: 'compact' }) },
  { id: 'warmer', words: /\bwarm(er)?\b/i, say: 'warmer neutrals', apply: (t) => cast(t, 38) },
  { id: 'cooler', words: /\b(cool(er)?|cold(er)?|icy)\b/i, say: 'cooler neutrals', apply: (t) => cast(t, 218) },
  { id: 'glass', words: /\b(glass(y)?|blur(red)?|translucent|frosted)\b/i, say: 'glass surfaces', apply: (t) => ({ ...t, surface: 'glass' }) },
  { id: 'flat', words: /\b(flat(ter)?|no shadows?|plain)\b/i, say: 'flat surfaces', apply: (t) => ({ ...t, surface: 'flat' }) },
  { id: 'outline', words: /\b(outlines?|borders?|brutal(ist)?)\b/i, say: 'outlined surfaces', apply: (t) => ({ ...t, surface: 'outline' }) },
];

/** Whatever was done to the tokens, what is read still reads and what is pressed still stands out. */
function fix(t: DesignTokens): DesignTokens {
  const c = t.colors;
  const primary = legible(c.primary, c.bg, 3);
  return { ...t, colors: { ...c, text: legible(c.text, c.bg, 7), muted: legible(c.muted, c.bg, 4.5), primary, onPrimary: readableOn(primary), accent: legible(c.accent, c.bg, 3) } };
}
function relight(t: DesignTokens, dark: boolean): DesignTokens {
  if (t.dark === dark) return t;
  const flip = (hex: string, l: number) => { const c = hexToHsl(hex); return hslToHex({ h: c.h, s: dark ? Math.max(c.s, 0.12) : c.s * 0.6, l }); };
  const c = t.colors;
  return fix({ ...t, dark, colors: { ...c, bg: flip(c.bg, dark ? 0.07 : 0.975), surface: flip(c.surface, dark ? 0.12 : 1), text: flip(c.text, dark ? 0.94 : 0.1), muted: flip(c.muted, dark ? 0.66 : 0.42), border: flip(c.border, dark ? 0.24 : 0.86) } });
}
function recolor(t: DesignTokens, by: number): DesignTokens {
  const s = (hex: string) => { const c = hexToHsl(hex); return hslToHex({ ...c, s: clamp(c.s * by, 0.05, 1) }); };
  return fix({ ...t, colors: { ...t.colors, primary: s(t.colors.primary), accent: s(t.colors.accent) } });
}
function cast(t: DesignTokens, hue: number): DesignTokens {
  const n = (hex: string) => { const c = hexToHsl(hex); return hslToHex({ h: hue, s: Math.max(c.s, t.dark ? 0.18 : 0.22), l: c.l }); };
  const c = t.colors;
  return fix({ ...t, colors: { ...c, bg: n(c.bg), surface: n(c.surface), border: n(c.border) } });
}

/** The changes a piece of feedback asks for, in the order they are understood. */
export function understood(feedback: string): typeof FEEDBACK[number][] {
  return FEEDBACK.filter((f) => f.words.test(feedback));
}
const applyAll = (t: DesignTokens, changes: readonly typeof FEEDBACK[number][]) => changes.reduce((acc, f) => f.apply(acc), t);

// ── a round ──────────────────────────────────────────────────────────────────────────────
export interface DesignerInput {
  /** The colours read off every inspiration picture, most important first. */
  colors: readonly string[];
  /** Every round so far, oldest first. */
  rounds: readonly DesignRound[];
  /** What the person wants changed: their note, with the comments on the last round. */
  feedback: string;
  /** "More like this one": the direction to explore further. */
  base?: { roundId: string; variation: DesignVariation } | null;
}
export const VARIATIONS_PER_ROUND = 4;

/** Four directions for the next round. The caller gives the round its id and time. */
export function proposeRound(input: DesignerInput): Pick<DesignRound, 'brief' | 'basedOn' | 'variations'> {
  const brand = brandColors(input.colors);
  const changes = understood(input.feedback);
  const said = changes.map((c) => c.say);
  const n = input.rounds.length;
  const id = (i: number) => `v${n + 1}-${i + 1}`;
  const note = said.length ? ` Adjusted as asked: ${said.join(', ')}.` : '';

  if (input.base) {
    const b = input.base.variation;
    const t = applyAll(b.tokens, changes);
    const pair = PAIRINGS.find(([h]) => h !== t.fontHeading && h !== b.tokens.fontHeading) ?? PAIRINGS[0];
    const swapped = fix({ ...t, colors: { ...t.colors, primary: t.colors.accent, accent: t.colors.primary } });
    const takes: [string, string, DesignTokens][] = [
      [`${b.name} · refined`, `The direction you picked, kept as it is${said.length ? ` with ${said.join(', ')}` : ''}.`, t],
      [`${b.name} · new type`, `The same colours and shapes set in ${pair[0]} over ${pair[1]}, to see how much of the feeling is the typeface.`, { ...t, fontHeading: pair[0], fontBody: pair[1] }],
      [`${b.name} · accent forward`, `The accent (${colorName(t.colors.accent)}) takes the lead and the ${colorName(t.colors.primary)} steps back: a different temperature on the same structure.`, swapped],
      [`${b.name} · ${t.dark ? 'in daylight' : 'after dark'}`, `The same direction in ${t.dark ? 'light' : 'dark'} mode, so you can judge it both ways before committing.`, relight(t, !t.dark)],
    ];
    return {
      brief: input.feedback.trim(), basedOn: { roundId: input.base.roundId, variationId: b.id },
      variations: takes.map(([name, rationale, tokens], i) => ({ id: id(i), name, rationale: rationale + (i > 0 ? note : ''), tokens, comments: [] })),
    };
  }

  // Four archetypes not shown in the round before, walking the list so every one gets its turn.
  const lastShown = new Set((input.rounds[n - 1]?.variations ?? []).map((v) => v.name.split(' · ')[0]));
  const start = (n * VARIATIONS_PER_ROUND) % ARCHETYPES.length;
  const order = [...ARCHETYPES.slice(start), ...ARCHETYPES.slice(0, start)];
  const picks = [...order.filter((a) => !lastShown.has(a.name)), ...order.filter((a) => lastShown.has(a.name))].slice(0, VARIATIONS_PER_ROUND);
  return {
    brief: input.feedback.trim(), basedOn: null,
    variations: picks.map((a, i) => ({
      id: id(i), name: a.name, comments: [],
      rationale: a.why.replace('{primary}', `the ${colorName(brand.primary)} from your pictures`) + note,
      tokens: applyAll(tokensFor(a, brand), changes),
    })),
  };
}
