/**
 * FROM A DIRECTION TO A DESIGN SYSTEM — step 2, the FINALIZING. Simulated: done here by rule, in
 * the place an agent running Claude's /design will do it. The direction a person selected is a
 * handful of tokens (lib/design-system.ts); a system a repo can build with needs the rest:
 *
 *   colours      a 50–900 scale of the primary, the accent and the neutrals; success / warning /
 *                danger / info; every role named (background, surface, border, text, muted…)
 *   type         the two families as real font stacks, a size scale, weights, line heights
 *   space        a spacing scale, radii, shadows — following the direction's density and surfaces
 *   components   button, input, card, badge, table, navigation — as CSS written from the tokens
 *
 * …and the FILES that carry it into a repo (`design-system/`):
 *
 *   tokens.json        everything, for tools
 *   tokens.css         the same as CSS custom properties (`--ds-…`)
 *   components.css     the components, written against those properties only
 *   index.html         the visual reference: one self-contained page (what the dashboard shows)
 *   DESIGN-SYSTEM.md   the rules, in words: for the people and the agents who build features
 *
 * Pure: the same direction and version always give the same files, byte for byte — so "is the
 * repo up to date" is a comparison, and publishing twice changes nothing.
 */
export interface DirectionTokens {
  dark: boolean;
  colors: { bg: string; surface: string; text: string; muted: string; primary: string; onPrimary: string; accent: string; border: string };
  fontHeading: string; fontBody: string; radius: number;
  density: 'compact' | 'cozy' | 'roomy';
  surface: 'flat' | 'soft' | 'glass' | 'outline';
}
export interface DesignSystemSpec {
  name: string; version: number; project: string; rationale: string; dark: boolean;
  colors: { roles: Record<string, string>; primary: Record<string, string>; accent: Record<string, string>; neutral: Record<string, string>; semantic: Record<string, string> };
  type: { heading: { name: string; stack: string }; body: { name: string; stack: string }; mono: string; sizes: Record<string, string>; lineHeights: Record<string, string>; weights: Record<string, string> };
  space: Record<string, string>; radius: Record<string, string>; shadow: Record<string, string>;
  surface: DirectionTokens['surface']; density: DirectionTokens['density'];
}
export interface DesignFile { path: string; content: string }
/** Where the system lives in a repo. */
export const DESIGN_DIR = 'design-system';

// ── colour ───────────────────────────────────────────────────────────────────────────────
type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
/** `a` moved toward `b` by `t` (0–1). */
export const mix = (a: string, b: string, t: number): string => { const x = rgb(a); const y = rgb(b); return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb); };
const lum = (h: string) => { const [r, g, b] = rgb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a: string, b: string): number => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** `fg` moved toward black or white — whichever can get there — until it reads on `bg`. */
export function legible(fg: string, bg: string, min: number): string {
  const end = contrast(bg, '#ffffff') >= contrast(bg, '#000000') ? '#ffffff' : '#000000';
  let out = fg;
  for (let i = 1; i <= 20 && contrast(out, bg) < min; i++) out = mix(fg, end, i / 20);
  return out;
}
const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
/** A ten-step scale with `base` at 500: lighter toward white above it, darker toward black below. */
export function scale(base: string): Record<string, string> {
  const light = [0.92, 0.82, 0.66, 0.46, 0.24];
  const dark = [0.16, 0.32, 0.48, 0.64];
  return Object.fromEntries(STEPS.map((s, i) => [s, i < 5 ? mix(base, '#ffffff', light[i]) : i === 5 ? base : mix(base, '#000000', dark[i - 6])]));
}

// ── type ─────────────────────────────────────────────────────────────────────────────────
const STACKS: Record<string, string> = {
  Georgia: 'Georgia, "Times New Roman", serif', Didot: 'Didot, "Bodoni MT", "Playfair Display", Georgia, serif',
  Palatino: 'Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif', 'Iowan Old Style': '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
  Rockwell: 'Rockwell, "Roboto Slab", "Courier New", serif', 'Helvetica Neue': '"Helvetica Neue", Helvetica, Arial, sans-serif',
  'Avenir Next': '"Avenir Next", Avenir, "Segoe UI", sans-serif', Futura: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif',
  'Gill Sans': '"Gill Sans", "Gill Sans MT", Calibri, sans-serif', Optima: 'Optima, Candara, "Segoe UI", sans-serif', Verdana: 'Verdana, Geneva, sans-serif',
  'Trebuchet MS': '"Trebuchet MS", "Lucida Grande", sans-serif', Menlo: 'Menlo, Consolas, "Courier New", monospace',
  'SF Pro Rounded': '"SF Pro Rounded", "Arial Rounded MT Bold", Nunito, system-ui, sans-serif', 'American Typewriter': '"American Typewriter", "Courier New", serif',
};
const clean = (name: string) => name.replace(/[^\w .-]/g, '').trim() || 'system-ui';
export const stackOf = (name: string): string => STACKS[name] ?? `"${clean(name)}", system-ui, sans-serif`;

const DENSITY = { compact: 0.9, cozy: 1, roomy: 1.15 } as const;
const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const rem = (n: number) => `${Math.round(n * 1000) / 1000}rem`;

/** The whole system, worked out from the direction. */
export function finalize(input: { name: string; rationale: string; tokens: DirectionTokens; version: number; project: string }): DesignSystemSpec {
  const t = input.tokens;
  const c = t.colors;
  const d = DENSITY[t.density];
  const semantic = (base: string) => legible(t.dark ? mix(base, '#ffffff', 0.25) : base, c.bg, 4.5);
  const neutralBase = mix(c.text, c.bg, 0.5);
  return {
    name: input.name, version: input.version, project: input.project, rationale: input.rationale, dark: t.dark,
    colors: {
      roles: {
        background: c.bg, surface: c.surface, 'surface-raised': t.dark ? mix(c.surface, '#ffffff', 0.06) : mix(c.surface, c.text, 0.03),
        border: c.border, 'border-strong': mix(c.border, c.text, 0.35), text: c.text, 'text-muted': c.muted,
        primary: c.primary, 'primary-hover': mix(c.primary, t.dark ? '#ffffff' : '#000000', 0.12), 'on-primary': c.onPrimary,
        accent: c.accent, focus: mix(c.primary, c.bg, 0.35),
      },
      primary: scale(c.primary), accent: scale(c.accent), neutral: scale(neutralBase),
      semantic: { success: semantic('#1f9d55'), warning: semantic('#b7791f'), danger: semantic('#d6336c'), info: semantic('#2b6cb0') },
    },
    type: {
      heading: { name: t.fontHeading, stack: stackOf(t.fontHeading) }, body: { name: t.fontBody, stack: stackOf(t.fontBody) },
      mono: 'ui-monospace, Menlo, Consolas, "Courier New", monospace',
      sizes: { xs: rem(0.75), sm: rem(0.875), base: rem(1), lg: rem(1.125), xl: rem(1.375 * (t.density === 'roomy' ? 1.05 : 1)), '2xl': rem(1.75 * (t.density === 'roomy' ? 1.08 : 1)), '3xl': rem(2.25 * (t.density === 'roomy' ? 1.1 : 1)), display: rem(3 * (t.density === 'roomy' ? 1.15 : t.density === 'compact' ? 0.9 : 1)) },
      lineHeights: { tight: '1.15', snug: '1.3', normal: t.density === 'compact' ? '1.45' : '1.6' },
      weights: { regular: '400', medium: '500', bold: '700' },
    },
    space: Object.fromEntries([['0', 0], ['1', 4], ['2', 8], ['3', 12], ['4', 16], ['5', 24], ['6', 32], ['7', 48], ['8', 64]].map(([k, v]) => [k, px((v as number) * d)])),
    radius: { none: '0px', sm: px(Math.min(t.radius, 4)), md: px(t.radius), lg: px(Math.round(t.radius * 1.5)), full: '999px' },
    shadow: t.surface === 'soft' ? { sm: `0 2px 6px ${t.dark ? 'rgba(0,0,0,0.45)' : 'rgba(20,30,60,0.08)'}`, md: `0 8px 22px ${t.dark ? 'rgba(0,0,0,0.5)' : 'rgba(20,30,60,0.10)'}`, lg: `0 18px 44px ${t.dark ? 'rgba(0,0,0,0.6)' : 'rgba(20,30,60,0.14)'}` }
      : t.surface === 'outline' ? { sm: `2px 2px 0 ${c.text}`, md: `4px 4px 0 ${c.text}`, lg: `8px 8px 0 ${c.text}` }
      : t.surface === 'glass' ? { sm: `inset 0 1px 0 ${mix(c.surface, '#ffffff', 0.2)}`, md: `0 10px 30px rgba(0,0,0,0.35)`, lg: `0 24px 60px rgba(0,0,0,0.45)` }
      : { sm: 'none', md: 'none', lg: `0 12px 32px ${t.dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.08)'}` },
    surface: t.surface, density: t.density,
  };
}

// ── the files ────────────────────────────────────────────────────────────────────────────
const vars = (s: DesignSystemSpec): [string, string][] => [
  ...Object.entries(s.colors.roles).map(([k, v]) => [`--ds-color-${k}`, v] as [string, string]),
  ...(['primary', 'accent', 'neutral'] as const).flatMap((g) => Object.entries(s.colors[g]).map(([k, v]) => [`--ds-color-${g}-${k}`, v] as [string, string])),
  ...Object.entries(s.colors.semantic).map(([k, v]) => [`--ds-color-${k}`, v] as [string, string]),
  ['--ds-font-heading', s.type.heading.stack], ['--ds-font-body', s.type.body.stack], ['--ds-font-mono', s.type.mono],
  ...Object.entries(s.type.sizes).map(([k, v]) => [`--ds-text-${k}`, v] as [string, string]),
  ...Object.entries(s.type.lineHeights).map(([k, v]) => [`--ds-leading-${k}`, v] as [string, string]),
  ...Object.entries(s.type.weights).map(([k, v]) => [`--ds-weight-${k}`, v] as [string, string]),
  ...Object.entries(s.space).map(([k, v]) => [`--ds-space-${k}`, v] as [string, string]),
  ...Object.entries(s.radius).map(([k, v]) => [`--ds-radius-${k}`, v] as [string, string]),
  ...Object.entries(s.shadow).map(([k, v]) => [`--ds-shadow-${k}`, v] as [string, string]),
];
/** A name a person typed, made safe to sit inside a CSS comment, an HTML comment or a line of markdown. */
export const plain = (text: string): string => text.replace(/[<>*\/\\`\r\n]+/g, ' ').replace(/-{2,}/g, '-').replace(/\s+/g, ' ').trim();
const banner = (s: DesignSystemSpec) => `${plain(s.project)} design system — "${plain(s.name)}", version ${s.version}. Generated by NeonCore; change it in NeonCore (Projects → Design system), not here.`;

export function tokensCss(s: DesignSystemSpec): string {
  return `/* ${banner(s)} */\n:root {\n${vars(s).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n  color-scheme: ${s.dark ? 'dark' : 'light'};\n}\n`;
}

export function componentsCss(s: DesignSystemSpec): string {
  const line = s.surface === 'outline' ? '2px solid var(--ds-color-text)' : '1px solid var(--ds-color-border)';
  const card = s.surface === 'glass' ? 'color-mix(in srgb, var(--ds-color-surface) 70%, transparent)' : 'var(--ds-color-surface)';
  return `/* ${banner(s)} */
/* Components, written against tokens.css only: load tokens.css first. Every class starts with ds-. */
.ds-root { background: var(--ds-color-background); color: var(--ds-color-text); font-family: var(--ds-font-body); font-size: var(--ds-text-base); line-height: var(--ds-leading-normal); }
.ds-heading { font-family: var(--ds-font-heading); line-height: var(--ds-leading-tight); font-weight: var(--ds-weight-bold); color: var(--ds-color-text); margin: 0; }
.ds-muted { color: var(--ds-color-text-muted); }
.ds-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--ds-space-2); padding: var(--ds-space-2) var(--ds-space-4); border-radius: var(--ds-radius-md); border: ${line}; background: transparent; color: var(--ds-color-text); font: inherit; font-weight: var(--ds-weight-medium); cursor: pointer; }
.ds-btn:hover { border-color: var(--ds-color-border-strong); }
.ds-btn:focus-visible, .ds-input:focus-visible { outline: 3px solid var(--ds-color-focus); outline-offset: 2px; }
.ds-btn--primary { background: var(--ds-color-primary); border-color: ${s.surface === 'outline' ? 'var(--ds-color-text)' : 'var(--ds-color-primary)'}; color: var(--ds-color-on-primary); box-shadow: ${s.surface === 'outline' ? 'var(--ds-shadow-sm)' : 'none'}; }
.ds-btn--primary:hover { background: var(--ds-color-primary-hover); }
.ds-btn--ghost { border-color: transparent; }
.ds-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ds-input { width: 100%; padding: var(--ds-space-2) var(--ds-space-3); border-radius: var(--ds-radius-md); border: ${line}; background: var(--ds-color-surface); color: var(--ds-color-text); font: inherit; }
.ds-input::placeholder { color: var(--ds-color-text-muted); }
.ds-card { background: ${card}; border: ${line}; border-radius: var(--ds-radius-lg); padding: var(--ds-space-5); box-shadow: var(--ds-shadow-md);${s.surface === 'glass' ? ' backdrop-filter: blur(12px);' : ''} }
.ds-badge { display: inline-flex; align-items: center; padding: 0 var(--ds-space-2); border-radius: var(--ds-radius-full); border: 1px solid currentColor; font-size: var(--ds-text-xs); font-weight: var(--ds-weight-medium); line-height: 1.7; color: var(--ds-color-text-muted); }
.ds-badge--success { color: var(--ds-color-success); } .ds-badge--warning { color: var(--ds-color-warning); } .ds-badge--danger { color: var(--ds-color-danger); } .ds-badge--info { color: var(--ds-color-info); }
.ds-nav { display: flex; align-items: center; gap: var(--ds-space-5); padding: var(--ds-space-3) var(--ds-space-5); border-bottom: ${line}; }
.ds-nav a { color: var(--ds-color-text-muted); text-decoration: none; padding-bottom: 2px; border-bottom: 2px solid transparent; }
.ds-nav a[aria-current="page"] { color: var(--ds-color-text); border-bottom-color: var(--ds-color-primary); }
.ds-table { width: 100%; border-collapse: collapse; font-size: var(--ds-text-sm); }
.ds-table th { text-align: left; color: var(--ds-color-text-muted); font-weight: var(--ds-weight-medium); padding: var(--ds-space-2) var(--ds-space-3); border-bottom: ${line}; }
.ds-table td { padding: var(--ds-space-2) var(--ds-space-3); border-bottom: 1px solid var(--ds-color-border); }
`;
}

export function tokensJson(s: DesignSystemSpec): string {
  return `${JSON.stringify({ $schema: 'neoncore/design-system@1', note: banner(s), ...s }, null, 2)}\n`;
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The visual reference: one page, nothing fetched — it opens from the repo as it is. */
export function referenceHtml(s: DesignSystemSpec): string {
  const sw = (name: string, value: string) => `<div class="sw"><span style="background:${value}"></span><b>${esc(name)}</b><code>${value}</code></div>`;
  const ramp = (group: 'primary' | 'accent' | 'neutral') => `<h3 class="ds-heading">${group}</h3><div class="ramp">${Object.entries(s.colors[group]).map(([k, v]) => `<div style="background:${v};color:${contrast(v, '#ffffff') >= contrast(v, '#000000') ? '#ffffff' : '#000000'}"><b>${k}</b><code>${v}</code></div>`).join('')}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.project)} — design system</title>
<!-- ${esc(banner(s))} -->
<style>
${tokensCss(s)}
${componentsCss(s)}
body { margin: 0; }
main { max-width: 1040px; margin: 0 auto; padding: var(--ds-space-7) var(--ds-space-5); display: grid; gap: var(--ds-space-7); }
section { display: grid; gap: var(--ds-space-4); }
h1.ds-heading { font-size: var(--ds-text-display); } h2.ds-heading { font-size: var(--ds-text-2xl); } h3.ds-heading { font-size: var(--ds-text-lg); text-transform: capitalize; }
code { font-family: var(--ds-font-mono); font-size: var(--ds-text-xs); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--ds-space-3); }
.sw { display: grid; gap: 2px; font-size: var(--ds-text-sm); } .sw span { height: 56px; border-radius: var(--ds-radius-md); border: 1px solid var(--ds-color-border); }
.ramp { display: grid; grid-template-columns: repeat(10, 1fr); border-radius: var(--ds-radius-md); overflow: hidden; } .ramp div { padding: var(--ds-space-3) var(--ds-space-2); display: grid; gap: 2px; font-size: var(--ds-text-xs); }
.row { display: flex; flex-wrap: wrap; gap: var(--ds-space-3); align-items: center; }
.bar { height: 14px; background: var(--ds-color-primary); border-radius: 2px; }
.box { width: 72px; height: 72px; background: var(--ds-color-surface); border: 1px solid var(--ds-color-border); display: grid; place-items: center; font-size: var(--ds-text-xs); }
</style>
</head>
<body class="ds-root">
<nav class="ds-nav"><strong class="ds-heading">${esc(s.project)}</strong><a href="#colour" aria-current="page">Colour</a><a href="#type">Type</a><a href="#space">Space</a><a href="#components">Components</a></nav>
<main>
<section>
<p class="ds-muted">Design system · version ${s.version}</p>
<h1 class="ds-heading">${esc(s.name)}</h1>
<p>${esc(s.rationale)}</p>
<p class="ds-muted">${s.dark ? 'Dark' : 'Light'} · ${esc(s.type.heading.name)}${s.type.body.name !== s.type.heading.name ? ` + ${esc(s.type.body.name)}` : ''} · ${s.radius.md} corners · ${s.density} · ${s.surface} surfaces</p>
</section>
<section id="colour"><h2 class="ds-heading">Colour</h2>
<div class="grid">${Object.entries(s.colors.roles).map(([k, v]) => sw(k, v)).join('')}</div>
${ramp('primary')}${ramp('accent')}${ramp('neutral')}
<h3 class="ds-heading">Meaning</h3><div class="grid">${Object.entries(s.colors.semantic).map(([k, v]) => sw(k, v)).join('')}</div>
</section>
<section id="type"><h2 class="ds-heading">Type</h2>
${Object.entries(s.type.sizes).reverse().map(([k, v]) => `<div><code>${k} · ${v}</code><div class="${['display', '3xl', '2xl', 'xl'].includes(k) ? 'ds-heading' : ''}" style="font-size:var(--ds-text-${k})">${['display', '3xl', '2xl', 'xl'].includes(k) ? esc(s.type.heading.name) : esc(s.type.body.name)} — the quick brown fox</div></div>`).join('\n')}
</section>
<section id="space"><h2 class="ds-heading">Space, corners, depth</h2>
${Object.entries(s.space).filter(([k]) => k !== '0').map(([k, v]) => `<div class="row"><code style="width:90px">space-${k} · ${v}</code><div class="bar" style="width:${v}"></div></div>`).join('\n')}
<div class="row">${Object.entries(s.radius).map(([k, v]) => `<div class="box" style="border-radius:${v}">${k}</div>`).join('')}</div>
<div class="row">${Object.keys(s.shadow).map((k) => `<div class="box" style="box-shadow:var(--ds-shadow-${k});border-radius:var(--ds-radius-md)">${k}</div>`).join('')}</div>
</section>
<section id="components"><h2 class="ds-heading">Components</h2>
<div class="row"><button class="ds-btn ds-btn--primary">Primary</button><button class="ds-btn">Secondary</button><button class="ds-btn ds-btn--ghost">Ghost</button><button class="ds-btn ds-btn--primary" disabled>Disabled</button></div>
<div class="row" style="max-width:420px"><input class="ds-input" placeholder="A text field"></div>
<div class="row"><span class="ds-badge">Neutral</span><span class="ds-badge ds-badge--success">Success</span><span class="ds-badge ds-badge--warning">Warning</span><span class="ds-badge ds-badge--danger">Danger</span><span class="ds-badge ds-badge--info">Info</span></div>
<div class="ds-card" style="max-width:520px"><h3 class="ds-heading">A card</h3><p class="ds-muted">Surfaces are ${s.surface}: this is what a panel, a dialog or a list item sits on.</p>
<table class="ds-table"><thead><tr><th>Name</th><th>State</th><th>Total</th></tr></thead><tbody><tr><td>Ada Chen</td><td><span class="ds-badge ds-badge--success">Paid</span></td><td>$1,240</td></tr><tr><td>Marco Ruiz</td><td><span class="ds-badge ds-badge--info">Shipped</span></td><td>$310</td></tr></tbody></table></div>
</section>
</main>
</body>
</html>
`;
}

export function guideMd(s: DesignSystemSpec): string {
  const table = (rows: [string, string][]) => `| Token | Value |\n|---|---|\n${rows.map(([k, v]) => `| \`${k}\` | \`${v}\` |`).join('\n')}`;
  return `# ${plain(s.project)} — design system

**${plain(s.name)}** · version ${s.version}

${plain(s.rationale)}

> ${banner(s)}

## Use it

Every screen of ${plain(s.project)} is built from these files, in \`${DESIGN_DIR}/\`:

| File | What it is |
|---|---|
| \`tokens.css\` | Every value as a CSS custom property (\`--ds-…\`). Load it once, at the root. |
| \`components.css\` | Button, input, card, badge, navigation, table — classes starting with \`ds-\`, written against the tokens only. |
| \`tokens.json\` | The same values for tools (a Tailwind theme, native code, tests). |
| \`index.html\` | The visual reference. Open it in a browser to see everything on this page. |

\`\`\`html
<link rel="stylesheet" href="/${DESIGN_DIR}/tokens.css">
<link rel="stylesheet" href="/${DESIGN_DIR}/components.css">
<body class="ds-root"> … <button class="ds-btn ds-btn--primary">Save</button>
\`\`\`

## Rules for whoever builds a feature (people and agents)

1. **Never write a colour, a font, a radius or a shadow by hand.** Use a token: \`var(--ds-color-primary)\`, \`var(--ds-space-4)\`, \`var(--ds-radius-md)\`. A value that is not a token is a bug.
2. **Reach for a \`ds-\` component first.** Build a new one only when none fits, write it against tokens only, and add it to \`components.css\` through NeonCore — not in a feature's own stylesheet.
3. **One primary action per view.** \`ds-btn--primary\` is for the thing the screen is for; everything else is secondary or ghost.
4. **Colour carries meaning, never alone.** Success, warning, danger and info each have a colour AND a word or icon.
5. **Text must read.** Body text on \`background\` and \`surface\` is at least 7:1; muted text at least 4.5:1. Do not put text on \`primary\` in anything but \`on-primary\`.
6. **This is a ${s.dark ? 'dark' : 'light'} system.** Do not add a ${s.dark ? 'light' : 'dark'} variant in a feature; ask for one here.
7. **Do not edit these files in the repo.** They are regenerated; change the system in NeonCore and it is published to every repo of the project.

## Colour

${table(Object.entries(s.colors.roles).map(([k, v]) => [`--ds-color-${k}`, v]))}

Scales (50 lightest – 900 darkest, 500 is the colour itself): \`--ds-color-primary-*\`, \`--ds-color-accent-*\`, \`--ds-color-neutral-*\`.

${table(Object.entries(s.colors.semantic).map(([k, v]) => [`--ds-color-${k}`, v]))}

## Type

Headings: **${s.type.heading.name}** (\`--ds-font-heading\`). Body: **${s.type.body.name}** (\`--ds-font-body\`).

${table([...Object.entries(s.type.sizes).map(([k, v]) => [`--ds-text-${k}`, v] as [string, string]), ...Object.entries(s.type.lineHeights).map(([k, v]) => [`--ds-leading-${k}`, v] as [string, string])])}

## Space, corners, depth

Density is **${s.density}**; surfaces are **${s.surface}**.

${table([...Object.entries(s.space).map(([k, v]) => [`--ds-space-${k}`, v] as [string, string]), ...Object.entries(s.radius).map(([k, v]) => [`--ds-radius-${k}`, v] as [string, string]), ...Object.entries(s.shadow).map(([k, v]) => [`--ds-shadow-${k}`, v] as [string, string])])}
`;
}

/** Every file of the system, by its path in the repo. */
export function filesOf(s: DesignSystemSpec): DesignFile[] {
  return [
    { path: `${DESIGN_DIR}/tokens.json`, content: tokensJson(s) },
    { path: `${DESIGN_DIR}/tokens.css`, content: tokensCss(s) },
    { path: `${DESIGN_DIR}/components.css`, content: componentsCss(s) },
    { path: `${DESIGN_DIR}/index.html`, content: referenceHtml(s) },
    { path: `${DESIGN_DIR}/DESIGN-SYSTEM.md`, content: guideMd(s) },
  ];
}

// ── the pointer in the repo's agent instructions ─────────────────────────────────────────
export const BLOCK_START = '<!-- neoncore:design-system:start -->';
export const BLOCK_END = '<!-- neoncore:design-system:end -->';
/** What CLAUDE.md / AGENTS.md say, so an agent starting a feature finds the system without being told. */
export function agentBlock(s: DesignSystemSpec): string {
  return `${BLOCK_START}
## Design system

This repo is built with the **${plain(s.project)} design system** ("${plain(s.name)}", version ${s.version}) in \`${DESIGN_DIR}/\`.
Before writing or changing any interface, read \`${DESIGN_DIR}/DESIGN-SYSTEM.md\` and follow it: use the tokens in
\`${DESIGN_DIR}/tokens.css\` and the \`ds-\` components in \`${DESIGN_DIR}/components.css\`; never hand-write a colour, font,
radius or shadow. Do not edit the files in \`${DESIGN_DIR}/\` — they are generated by NeonCore.
${BLOCK_END}`;
}
/** `existing` with the block added, or replaced in place when it is already there. Nothing else in the file changes. */
export function withAgentBlock(existing: string, s: DesignSystemSpec): string {
  const block = agentBlock(s);
  const a = existing.indexOf(BLOCK_START);
  const b = existing.indexOf(BLOCK_END);
  if (a >= 0 && b > a) return existing.slice(0, a) + block + existing.slice(b + BLOCK_END.length);
  return `${existing.replace(/\s*$/, '')}${existing.trim() ? '\n\n' : ''}${block}\n`;
}
