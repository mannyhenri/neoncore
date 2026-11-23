/**
 * A PROJECT'S DESIGN SYSTEM IS KEPT WHOLE, AND ONLY IF IT IS ONE (lib/design-system.ts).
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { getDesignSystem, saveDesignSystem, validateExploration, DesignSystemError, LIMITS } from '../src/lib/design-system.js';

let n = 0;
function project(): string {
  const id = `ds-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','/code/x','#fff',?,?)`).run(id, 'P', '2026-01-01', '2026-01-01');
  return id;
}
const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const colors = { bg: '#ffffff', surface: '#f4f4f4', text: '#111111', muted: '#666666', primary: '#3355ff', onPrimary: '#ffffff', accent: '#ff5533', border: '#dddddd' };
const variation = (id: string) => ({ id, name: `Direction ${id}`, rationale: 'because', comments: [], tokens: { dark: false, colors, fontHeading: 'Georgia', fontBody: 'Helvetica', radius: 8, density: 'cozy', surface: 'flat' } });
const round = (id: string) => ({ id, at: '2026-11-21T10:00:00Z', brief: '', basedOn: null, variations: ['a', 'b', 'c', 'd'].map(variation) });
const good = () => ({ inspirations: [{ id: 'i1', name: 'shot.png', dataUrl: PIC, colors: ['#3355ff', '#ff5533'] }], rounds: [round('r1'), round('r2')], selected: { roundId: 'r2', variationId: 'c' } });

test('a project with no design system yet has an empty one; a project that does not exist has none', () => {
  assert.deepEqual(getDesignSystem(project()), { inspirations: [], rounds: [], selected: null, updatedAt: '' });
  assert.equal(getDesignSystem('nope'), null);
  assert.throws(() => saveDesignSystem('nope', good()), (e: unknown) => e instanceof DesignSystemError && e.status === 404);
});

test('what is saved is what comes back — pictures, every round, every comment, the selection — and a second save replaces the first', () => {
  const id = project();
  const first = good();
  (first.rounds[0].variations[1].comments as unknown[]).push({ id: 'c1', text: 'rounder please', at: '2026-11-21T10:05:00Z' });
  const kept = saveDesignSystem(id, first, '2026-11-21T10:06:00Z');
  assert.deepEqual(getDesignSystem(id), kept);
  assert.deepEqual({ inspirations: kept.inspirations, rounds: kept.rounds, selected: kept.selected }, first);
  assert.equal(kept.updatedAt, '2026-11-21T10:06:00Z');
  const second = { ...good(), rounds: [round('r9')], selected: null };
  saveDesignSystem(id, second, '2026-11-21T11:00:00Z');
  const now = getDesignSystem(id)!;
  assert.equal(now.rounds.length, 1);
  assert.equal(now.selected, null);
  // Another project's is untouched.
  const other = project();
  assert.deepEqual(getDesignSystem(other)!.rounds, []);
});

test('everything that is not a design system is refused, each for its own reason — and nothing is kept', () => {
  const id = project();
  const bad: [string, (g: ReturnType<typeof good>) => unknown, RegExp][] = [
    ['not an object', () => 'x', /is an object/],
    ['no lists', (g) => ({ ...g, rounds: 'x' }), /are lists/],
    ['too many pictures', (g) => ({ ...g, inspirations: Array.from({ length: LIMITS.inspirations + 1 }, (_, i) => ({ ...g.inspirations[0], id: `i${i}` })) }), /at most 12 inspiration/],
    ['a picture that is not an image', (g) => ({ ...g, inspirations: [{ ...g.inspirations[0], dataUrl: 'data:text/html;base64,PGI+' }] }), /PNG, JPEG, WebP or GIF/],
    ['a picture from a URL', (g) => ({ ...g, inspirations: [{ ...g.inspirations[0], dataUrl: 'https://example.com/a.png' }] }), /PNG, JPEG, WebP or GIF/],
    ['a huge picture', (g) => ({ ...g, inspirations: [{ ...g.inspirations[0], dataUrl: PIC + 'A'.repeat(LIMITS.pictureBytes) }] }), /too large/],
    ['a colour that is not one', (g) => ({ ...g, inspirations: [{ ...g.inspirations[0], colors: ['red'] }] }), /#rrggbb/],
    ['a round of three', (g) => ({ ...g, rounds: [{ ...g.rounds[0], variations: g.rounds[0].variations.slice(0, 3) }], selected: null }), /exactly 4 variations/],
    ['a round of five', (g) => ({ ...g, rounds: [{ ...g.rounds[0], variations: [...g.rounds[0].variations, variation('e')] }], selected: null }), /exactly 4 variations/],
    ['a variation with no tokens', (g) => ({ ...g, rounds: [{ ...g.rounds[0], variations: g.rounds[0].variations.map((v, i) => (i ? v : { ...v, tokens: null })) }], selected: null }), /its tokens/],
    ['a token colour that is not one', (g) => ({ ...g, rounds: [{ ...g.rounds[0], variations: g.rounds[0].variations.map((v, i) => (i ? v : { ...v, tokens: { ...v.tokens, colors: { ...colors, bg: 'url(x)' } } })) }], selected: null }), /#rrggbb/],
    ['two variations with one id', (g) => ({ ...g, rounds: [{ ...g.rounds[0], variations: ['a', 'a', 'c', 'd'].map(variation) }], selected: null }), /share an id/],
    ['a selection that is not there', (g) => ({ ...g, selected: { roundId: 'r2', variationId: 'zz' } }), /not one of the variations/],
    ['a selection of the wrong shape', (g) => ({ ...g, selected: 'c' }), /names a round and a variation/],
    ['too many rounds', (g) => ({ ...g, selected: null, rounds: Array.from({ length: LIMITS.rounds + 1 }, (_, i) => round(`r${i}`)) }), /at most 40 rounds/],
  ];
  for (const [name, make, why] of bad) {
    assert.throws(() => saveDesignSystem(id, make(good())), (e: unknown) => e instanceof DesignSystemError && why.test(e.message), name);
  }
  assert.deepEqual(getDesignSystem(id)!.rounds, [], 'a refused save kept something');
  // And the good one, and one with nothing selected yet, pass.
  assert.doesNotThrow(() => validateExploration(good()));
  assert.equal(validateExploration({ ...good(), selected: null }).selected, null);
  assert.equal(validateExploration({ inspirations: [], rounds: [] }).selected, null);
});
