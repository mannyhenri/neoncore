/**
 * Project memory must be EDITABLE on mobile, not just on the web.
 *
 * The set is derived from what the web panel actually calls, not from a list someone wrote
 * down — the same reason the engine removal iterated the enum rather than a description. If
 * the web panel gains an operation, this fails until mobile either gains it too or declares
 * it out of scope WITH A REASON. "Not on mobile" and "forgotten on mobile" look identical
 * from the outside otherwise, which is how mobile ended up with no memory surface at all
 * while the web had four editable files and full note CRUD.
 *
 * Deliberately parity-of-EDITING, not parity-of-everything: a phone is for capturing a note
 * and fixing a line, not for browsing session history. Read-only browse operations are named
 * below rather than silently missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const WEB_PANEL = read('dashboard/src/components/ProjectMemoryPanel.tsx');
const MOBILE_API = read('mobile/src/api.ts');
const MOBILE_ENTRY = read('mobile/App.tsx');
const MOBILE_TABS = read('mobile/src/components/TabBar.tsx');

/**
 * Operations the web panel offers that a phone deliberately does NOT, each with the reason.
 * A map rather than a filter so adding an exemption is a visible decision.
 */
const NOT_ON_MOBILE: Record<string, string> = {
  getProjectSessions: 'session history is a browsing surface; a phone is for capture and quick edits',
  searchJournal: 'full-text journal search across a project is desk work, not phone work',
};

/** Every api.<name>( the web Project Memory panel calls. */
function webOperations(): string[] {
  return [...new Set([...WEB_PANEL.matchAll(/api\.(\w+)\(/g)].map((m) => m[1]))].sort();
}

test('the web panel scan is non-vacuous', () => {
  // A scan that matches nothing would make every assertion below pass while proving nothing.
  assert.ok(webOperations().length >= 6,
    `expected the web panel to call several api methods, found ${webOperations().length}`);
});

test('every EDITING operation the web offers is reachable from mobile', () => {
  const missing = webOperations()
    .filter((op) => !(op in NOT_ON_MOBILE))
    .filter((op) => !MOBILE_API.includes(op));

  assert.deepEqual(
    missing, [],
    `mobile cannot do these, and they are not declared out of scope:\n  ${missing.join('\n  ')}\n` +
    `Either add them to mobile/src/api.ts or add them to NOT_ON_MOBILE with a reason.`,
  );
});

test('every mobile exemption names an operation the web actually has', () => {
  // Stops the exemption map from rotting into a list of names nothing recognises, which would
  // silently widen the hole it was meant to document.
  const web = webOperations();
  const stale = Object.keys(NOT_ON_MOBILE).filter((op) => !web.includes(op));
  assert.deepEqual(stale, [], `these exemptions name operations the web panel no longer calls: ${stale.join(', ')}`);
});

test('the memory screen is REACHABLE on mobile, not merely present', () => {
  // A screen that exists but is never routed is a file, not a feature. Memory is not a global
  // tab — it belongs to a CARTRIDGE, matching the web where ProjectMemoryPanel opens from a
  // cartridge card. What changed is the MECHANISM, not the requirement.
  //
  // It used to be EMBEDDED in the detail screen, and this test asserted that by checking for
  // the import. Embedding is what broke it: the panel mounted as a `flex: 1` sibling of the
  // transcript FlatList with its own KeyboardAvoidingView nested inside the detail screen's,
  // so whatever height it won was a negotiation with a list that also wanted to grow. Reported
  // from the phone as "the memory button doesn't bring anything… maybe it's hidden behind the
  // main screen".
  //
  // So the chain asserted here is now detail-screen HANDS OFF -> pushed route renders, scoped
  // to this cartridge's repo. Asserting the import would now fail on the fixed app and pass on
  // the broken one, which is the wrong way round.
  assert.ok(fs.existsSync(path.join(ROOT, 'mobile/src/screens/ProjectMemoryScreen.tsx')),
    'mobile/src/screens/ProjectMemoryScreen.tsx does not exist');

  const detail = read('mobile/src/screens/CartridgeDetailScreen.tsx');
  assert.match(detail, /onOpenMemory/, 'the cartridge detail screen offers no way into memory');
  assert.doesNotMatch(detail, /<ProjectMemoryScreen/,
    'memory is embedded in the detail screen again — that is the layout bug this replaced');

  const app = read('mobile/App.tsx');
  assert.match(app, /route\.name === 'memory'/, 'no route renders the memory screen');
  assert.match(app, /<ProjectMemoryScreen/, 'the memory route renders nothing');
  const pushed = app.slice(app.indexOf('const PUSHED'), app.indexOf('];', app.indexOf('const PUSHED')));
  assert.match(pushed, /'memory'/,
    'memory must be a PUSHED screen so it owns the surface instead of sharing it');
  assert.match(app, /project=\{route\.project\}/,
    'memory is rendered without scoping to THIS cartridge — the whole point of opening it from one');
});

test('every knowledge file the web edits is editable on mobile', () => {
  // A registry in the web panel, whatever its size. Mobile offering a SUBSET would be the bug —
  // the user asked to edit project memory "like on web". It was four files; three were retired
  // (server/src/lib/knowledge-files.ts), so this asserts parity rather than a count, and the
  // non-vacuity check is that the registry parsed at all.
  const webFiles = [...WEB_PANEL.matchAll(/'(\w+\.md)'/g)].map((m) => m[1]);
  assert.ok(webFiles.length >= 1, `expected the web KNOWLEDGE_FILES registry, found ${webFiles.length}`);
  const screen = read('mobile/src/screens/ProjectMemoryScreen.tsx');
  const missing = [...new Set(webFiles)].filter((f) => !screen.includes(f));
  assert.deepEqual(missing, [], `mobile cannot edit these knowledge files: ${missing.join(', ')}`);
});
