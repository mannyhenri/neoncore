/**
 * The mobile screens share ONE visual language, and it lives in one place.
 *
 * The queue and memory screens were built as plumbing that worked, and they looked it. Next to
 * the cartridge list — bordered cards, a status pill with a dot, uppercase chips — the queue was
 * a divider-separated text list with bare-text "cancel" links, and memory was the only screen in
 * the app with no StyleSheet at all. Both re-derived the palette by hand: `'#f87171'` next to
 * `theme.danger`, `'#0d0f12'` retyped ten times when it IS `theme.bg`.
 *
 * The title work before this one fixed the font and nothing else, which is why the screens still
 * did not match — consistency is the card, the pill, the chip and the button, not the heading.
 *
 * Set-based over EVERY mobile screen and component rather than the two that prompted it, because
 * a two-file fix leaves the ninth screen free to invent a tenth red. The idioms are derived from
 * the reference implementation (CartridgeListScreen) rather than from a description of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MOBILE = path.join(import.meta.dirname, '..', '..', 'mobile', 'src');
const read = (p: string) => fs.readFileSync(path.join(MOBILE, p), 'utf8');

/** Every screen and component that renders UI. The set the rules apply to. */
function uiFiles(): string[] {
  const out: string[] = [];
  for (const dir of ['screens', 'components']) {
    for (const f of fs.readdirSync(path.join(MOBILE, dir))) {
      if (f.endsWith('.tsx')) out.push(`${dir}/${f}`);
    }
  }
  return out.sort();
}

test('the file scan is non-vacuous', () => {
  // A glob that matches nothing would make every rule below pass while enforcing none of them.
  assert.ok(uiFiles().length >= 15, `expected the mobile UI file set, found ${uiFiles().length}`);
});

test('shared UI primitives exist — one definition, not one per screen', () => {
  // Without these there is nothing for a screen to conform TO, and "consistent" degrades to
  // "everyone copied the same numbers", which is how the palette forked in the first place.
  const ui = read('components/ui.tsx');
  for (const prim of ['Card', 'StatusPill', 'Chip', 'ActionButton']) {
    assert.match(ui, new RegExp(`export function ${prim}\\b`),
      `components/ui.tsx does not export ${prim}`);
  }
});

test('EVERY UI file uses theme tokens — no raw hex colours anywhere but the theme', () => {
  // theme.ts is the only file allowed to name a colour. Ten files naming their own is not a
  // style preference: `#f87171` and theme.danger are two different reds shipping side by side.
  const offenders: string[] = [];
  for (const f of uiFiles()) {
    const hits = [...read(f).matchAll(/'#[0-9a-fA-F]{3,8}'/g)].map((m) => m[0]);
    if (hits.length) offenders.push(`${f}: ${[...new Set(hits)].join(', ')}`);
  }
  assert.deepEqual(offenders, [],
    `raw hex colours outside theme.ts:\n  ${offenders.join('\n  ')}\n` +
    `Add a token to theme.ts and use it — a second literal is a second colour.`);
});

test('EVERY screen styles with StyleSheet, not inline objects', () => {
  // An inline style object is re-allocated every render and cannot be shared, which is why the
  // memory screen drifted furthest: nothing about it was reusable, so nothing was reused.
  const inlineOnly = fs.readdirSync(path.join(MOBILE, 'screens'))
    .filter((f) => f.endsWith('.tsx'))
    .filter((f) => !read(`screens/${f}`).includes('StyleSheet.create'));
  assert.deepEqual(inlineOnly, [],
    `these screens have no StyleSheet: ${inlineOnly.join(', ')}`);
});

test('the two screens the user called out actually adopt the primitives', () => {
  // The specific ask. Named explicitly so this cannot pass by the primitives merely existing
  // while the screens that needed them keep their hand-rolled versions.
  for (const screen of ['screens/QueueScreen.tsx', 'screens/ProjectMemoryScreen.tsx']) {
    const src = read(screen);
    assert.match(src, /from '\.\.\/components\/ui'/, `${screen} does not import the shared primitives`);
    assert.match(src, /<Card\b/, `${screen} does not use the shared Card`);
  }
  // The queue is a status surface; the pill is how status reads on every other screen.
  assert.match(read('screens/QueueScreen.tsx'), /<StatusPill\b/,
    'the queue renders status without the shared StatusPill');
});

test('no dead styles left behind', () => {
  // The queue kept nine styles from an enqueue form that was removed. Dead style keys are how a
  // stylesheet stops describing the screen, and then nobody trusts it enough to edit it.
  const bad: string[] = [];
  for (const f of uiFiles()) {
    const src = read(f);
    const block = /StyleSheet\.create\(\{([\s\S]*?)\n\}\);/.exec(src);
    if (!block) continue;
    for (const m of block[1].matchAll(/^  (\w+):/gm)) {
      const key = m[1];
      // Count uses outside the definition: s.key / styles.key.
      const uses = [...src.matchAll(new RegExp(`\\b(?:s|styles)\\.${key}\\b`, 'g'))].length;
      if (uses === 0) bad.push(`${f}: ${key}`);
    }
  }
  assert.deepEqual(bad, [], `styles defined but never used:\n  ${bad.join('\n  ')}`);
});
