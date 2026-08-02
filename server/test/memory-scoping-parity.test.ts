/**
 * Project memory is reached PER CARTRIDGE on both surfaces.
 *
 * The web has no global memory view at all: ProjectMemoryPanel is opened from a cartridge card
 * and scoped to that cartridge's repo (CartridgeCard.tsx:1092, project={agent.repoName}). Mobile
 * shipped it as a top-level tab with a repo picker instead — so the two surfaces disagreed about
 * what memory belongs to, and the phone made the user choose a repo that the desk infers from
 * context they already have.
 *
 * Asserted in BOTH directions: memory must be reachable from a cartridge on each surface, and
 * neither surface may offer a global entry point. Only checking "mobile has memory" would keep
 * passing with the tab still there, which is the thing being removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Where each surface opens memory from, and where a GLOBAL entry would live if one existed. */
const SURFACES = [
  {
    label: 'web',
    perCartridge: 'dashboard/src/components/CartridgeCard.tsx',
    globalEntry: 'dashboard/src/App.tsx',
    marker: /ProjectMemoryPanel/,
  },
  {
    label: 'mobile',
    perCartridge: 'mobile/src/screens/CartridgeDetailScreen.tsx',
    globalEntry: 'mobile/src/components/TabBar.tsx',
    marker: /ProjectMemoryScreen|memory/i,
  },
];

test('the surface files all exist — a typo would pass every assertion below on nothing', () => {
  const missing = SURFACES.flatMap((s) => [s.perCartridge, s.globalEntry])
    .filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`);
});

for (const s of SURFACES) {
  test(`${s.label}: memory is reachable FROM a cartridge`, () => {
    assert.match(
      read(s.perCartridge), s.marker,
      `${s.perCartridge} never opens project memory — on this surface a cartridge's memory is ` +
      `unreachable from the cartridge itself`,
    );
  });

  test(`${s.label}: there is NO global memory entry point`, () => {
    // Matches a tab ENTRY or a route case, not prose. A bare /ProjectMemoryPanel/ also matched
    // the comment explaining why the tab was removed — the same over-matching that made
    // `cursor` report 25 false hits and flagged the phrase "Queue items" as a button.
    assert.doesNotMatch(
      read(s.globalEntry), /name:\s*'memory'|name === 'memory'|<ProjectMemoryScreen/,
      `${s.globalEntry} offers a global memory entry. Memory belongs to a cartridge — a global ` +
      `view makes the user pick a repo the surface already knows from context.`,
    );
  });
}

test('the memory screen is scoped by the cartridge that opened it, not by a picker', () => {
  // The picker was the symptom of the wrong model: if the caller supplies the project, the
  // screen has nothing to choose.
  const screen = read('mobile/src/screens/ProjectMemoryScreen.tsx');
  assert.match(screen, /project\??:\s*string/,
    'ProjectMemoryScreen takes no project prop, so a caller cannot scope it to one cartridge');
});
