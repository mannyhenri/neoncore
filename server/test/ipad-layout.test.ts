/**
 * The app adapts to iPad instead of being a stretched phone.
 *
 * It already RUNS on iPad — TARGETED_DEVICE_FAMILY has been "1,2" all along — which is exactly
 * why this is worth a test: "it launches" and "it is usable" look identical from the build log.
 * At 1366pt landscape a card with marginHorizontal:12 is ~1342pt wide, so a line of text runs
 * far past the ~90 characters anyone can comfortably track, and a one-line status row leaves
 * most of the display empty.
 *
 * The correctness half is `useWindowDimensions` vs `Dimensions.get`. Info.plist does not set
 * UIRequiresFullScreen, so iPad multitasking is ALLOWED: the window is resized at runtime when
 * the user drags a Split View divider. `Dimensions.get('window')` is read once and never updates,
 * so a layout built on it is correct until the moment someone resizes — the kind of bug that
 * never reproduces on the machine it was written on. That makes the hook a requirement rather
 * than a preference, and it is why this rule is asserted over EVERY file rather than reviewed.
 *
 * Set-based over all mobile UI files and all screens, so screen nine cannot ship phone-only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const MOBILE = path.join(ROOT, 'mobile');
const SRC = path.join(MOBILE, 'src');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

function uiFiles(): string[] {
  const out: string[] = [];
  for (const dir of ['screens', 'components']) {
    for (const f of fs.readdirSync(path.join(SRC, dir))) if (f.endsWith('.tsx')) out.push(`${dir}/${f}`);
  }
  return out.sort();
}

/** Every screen. Includes ProjectMemoryScreen, which is nested rather than routed. */
function screens(): string[] {
  return fs.readdirSync(path.join(SRC, 'screens')).filter((f) => f.endsWith('.tsx')).sort();
}

test('the scans are non-vacuous', () => {
  // A glob that matches nothing passes every rule below while enforcing none.
  assert.ok(uiFiles().length >= 15, `expected the UI file set, found ${uiFiles().length}`);
  assert.ok(screens().length >= 7, `expected the screen set, found ${screens().length}`);
});

test('the iPad build configuration is intact', () => {
  // Already true, asserted so it cannot silently regress — losing "2" here turns the app back
  // into an iPhone-only binary and nothing in the JS would show it.
  const pbx = fs.readFileSync(path.join(MOBILE, 'ios/NeonCore.xcodeproj/project.pbxproj'), 'utf8');
  assert.match(pbx, /TARGETED_DEVICE_FAMILY = "1,2"/, 'the target no longer builds for iPad');

  const plist = fs.readFileSync(path.join(MOBILE, 'ios/NeonCore/Info.plist'), 'utf8');
  assert.match(plist, /UISupportedInterfaceOrientations~ipad/, 'no iPad orientations declared');
  for (const o of ['LandscapeLeft', 'LandscapeRight']) {
    assert.ok(plist.includes(o), `iPad cannot rotate to ${o} — an iPad is used in landscape`);
  }
  // UIRequiresFullScreen=true would disable Split View and Slide Over entirely.
  assert.ok(!/<key>UIRequiresFullScreen<\/key>\s*<true\/>/.test(plist),
    'UIRequiresFullScreen is true — iPad multitasking is disabled');
});

test('a single responsive module defines the breakpoint once', () => {
  // One definition, for the same reason the palette needed one: a breakpoint copied into eight
  // screens is eight breakpoints that drift.
  const r = fs.readFileSync(path.join(SRC, 'responsive.ts'), 'utf8');
  assert.match(r, /export function useResponsive/, 'responsive.ts does not export useResponsive');
  assert.match(r, /useWindowDimensions/, 'useResponsive does not track the LIVE window size');
  assert.match(r, /export const TABLET_MIN_WIDTH|TABLET_BREAKPOINT/, 'no named breakpoint constant');
});

/**
 * Source with comments removed.
 *
 * Needed because the first version of the rule below flagged responsive.ts — whose doc comment
 * EXPLAINS why `Dimensions.get` is wrong. A scanner that cannot tell code from prose reports the
 * documentation of a rule as a violation of it, and the tempting fix is to delete the sentence.
 */
function code(f: string): string {
  return read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('NO file reads a frozen window size — Split View resizes us at runtime', () => {
  // The whole correctness case. Dimensions.get is captured once; a Split View drag changes the
  // window and the layout keeps using the old number.
  const offenders = uiFiles()
    .concat(['responsive.ts'])
    .filter((f) => fs.existsSync(path.join(SRC, f)))
    .filter((f) => /Dimensions\s*\.\s*get\s*\(/.test(code(f)));
  assert.deepEqual(offenders, [],
    `these read a frozen window size instead of useWindowDimensions():\n  ${offenders.join('\n  ')}\n` +
    `On iPad the window changes size while the app runs — a captured value goes stale.`);
});

test('EVERY screen adapts to width', () => {
  // A screen that never consults width cannot be adapting; it is inheriting phone layout and
  // being stretched. Accepts either the hook directly or the shared width-constraining
  // container, since a static centred column is a legitimate way to adapt.
  // The sanctioned mechanisms, all of which resolve to useResponsive underneath:
  //   useResponsive()        — the screen reads width itself (needed for column counts)
  //   useAdaptiveContent()   — the cap as a style, for FlatList contentContainerStyle
  //   <Adaptive>             — the cap as a wrapper, for headers and forms
  // Listing them explicitly beats a loose substring: the first draft omitted useAdaptiveContent
  // and reported three screens as phone-only that were fully adapted.
  const ADAPTS = /useResponsive\(|useAdaptiveContent\(|<Adaptive\b/;
  const phoneOnly = screens().filter((f) => !ADAPTS.test(code(`screens/${f}`)));
  assert.deepEqual(phoneOnly, [],
    `these screens have no width adaptation — they will render as stretched phone layouts:\n  ${phoneOnly.join('\n  ')}`);
});

test('a column-count change remounts the list, and the key is not spread', () => {
  // Two failures in one rule, both invisible in review:
  //
  //   1. FlatList throws "Changing numColumns on the fly is not supported" — so every list that
  //      takes numColumns from the live window MUST be keyed on the column count, or rotating an
  //      iPad crashes the screen.
  //   2. That key cannot travel inside a spread. React 19 refuses to read `key` from a spread
  //      props object, warns, and DROPS it — which silently removes the remount from (1) and
  //      turns a working layout back into the crash. The first draft here did exactly that; the
  //      simulator surfaced the warning, nothing else would have.
  const gridUsers = screens().filter((f) => /gridProps\(/.test(code(`screens/${f}`)));
  assert.ok(gridUsers.length > 0, 'no screen uses gridProps — this rule would be vacuous');

  for (const f of gridUsers) {
    const src = code(`screens/${f}`);
    assert.match(src, /key=\{gridKey\(/,
      `${f} varies numColumns without an explicit key — rotation will throw`);
  }
  // And the helper must not hand back a key to be spread.
  const r = fs.readFileSync(path.join(SRC, 'responsive.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const body = /export function gridProps[\s\S]*?\n\}/.exec(r)?.[0] ?? '';
  assert.ok(!/\bkey\s*:/.test(body),
    'gridProps returns a key — spreading it makes React drop it and the remount silently stops working');
});

test('long-form text is width-capped somewhere shared', () => {
  // The readability half. Unbounded line length is the single most visible "this is a blown-up
  // phone app" symptom, and it must be solved in one place rather than per screen.
  const ui = read('components/ui.tsx');
  assert.match(ui, /useResponsive|maxWidth/,
    'the shared primitives never constrain width, so every card stretches to the full display');
});
