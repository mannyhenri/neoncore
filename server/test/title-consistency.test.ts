/**
 * Every screen titles itself the same way.
 *
 * Measured before writing this: the web had FIVE different section-title styles — text-base
 * semibold gray-200, text-sm medium gray-200, uppercase tracking-wide gray-400, semibold white,
 * uppercase gray-300 — and mobile had a 26px/800 title on the list screen against 16px/700
 * everywhere else, with the Queue screen carrying no title at all.
 *
 * Nobody chose that. Each screen was written at a different time and copied whatever was
 * nearest, which is exactly how a hand-maintained style drifts — the same failure as a
 * hand-maintained type. So the fix is a shared primitive, not a pass of matching numbers:
 * matching numbers drift again on the next screen, a shared primitive cannot.
 *
 * Set-based over the SCREENS rather than over the styles, so a new screen with an ad-hoc title
 * fails here rather than quietly becoming the sixth variant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Web surfaces that render a top-level section heading. */
const WEB_SCREENS = [
  'dashboard/src/components/TasksPage.tsx',
  'dashboard/src/components/QueuePanel.tsx',
  'dashboard/src/components/GoalsPage.tsx',
  'dashboard/src/components/WorkflowPanel.tsx',
];

/** Mobile screens that render their own title. */
const MOBILE_SCREENS = [
  'mobile/src/screens/CartridgeListScreen.tsx',
  'mobile/src/screens/CartridgeDetailScreen.tsx',
  'mobile/src/screens/WorkflowsScreen.tsx',
  'mobile/src/screens/QueueScreen.tsx',
];

test('the screen lists are real — a bad path would pass every assertion on nothing', () => {
  const missing = [...WEB_SCREENS, ...MOBILE_SCREENS].filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`);
});

test('a shared web title primitive exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'dashboard/src/components/SectionTitle.tsx')),
    'no SectionTitle component — without one, "consistent" means copying classes, which is what drifted');
});

test('EVERY web screen titles itself through the shared primitive', () => {
  const adhoc = WEB_SCREENS.filter((f) => {
    const src = read(f);
    // A heading with hand-written typography classes is the drift this prevents.
    return /<h2 className="[^"]*(text-(sm|base|lg|xl)|font-(medium|semibold|bold))/.test(src);
  });
  assert.deepEqual(
    adhoc, [],
    `these render a heading with ad-hoc typography instead of <SectionTitle>:\n  ${adhoc.join('\n  ')}`,
  );
});

test('a shared mobile title style exists', () => {
  const theme = read('mobile/src/theme.ts');
  assert.match(theme, /screenTitle/,
    'theme.ts has no screenTitle — each mobile screen would keep defining its own size and weight');
});

test('EVERY mobile screen titles itself through the shared style', () => {
  const adhoc = MOBILE_SCREENS.filter((f) => {
    const src = read(f);
    // A local `title:` style block with its own fontSize is the drift.
    return /title:\s*\{[^}]*fontSize:\s*\d+/.test(src);
  });
  assert.deepEqual(
    adhoc, [],
    `these define their own title typography instead of using theme.screenTitle:\n  ${adhoc.join('\n  ')}`,
  );
});

test('the QUEUE screen has a title at all', () => {
  // It shipped without one, so the phone showed a list with no indication of what it was.
  //
  // Asserts the PROPERTY — the screen titles itself through a sanctioned mechanism — not one
  // particular spelling of it. The original matched /screenTitle/, which broke the moment the
  // screen switched from a local `title` style to the shared <ScreenTitle> primitive: a stricter
  // adherence to the rule, failed by the test meant to enforce the rule. A test coupled to how
  // a thing is done blocks the improvement it was written to encourage.
  const src = read('mobile/src/screens/QueueScreen.tsx');
  assert.ok(
    /<ScreenTitle\b/.test(src) || /screenTitle/.test(src),
    'the mobile queue screen renders no title — use <ScreenTitle> from components/ui',
  );
});
