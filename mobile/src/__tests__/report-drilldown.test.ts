import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every dimension the report exposes must be on screen AND openable; memory must be reachable.
 *
 * REPORTED, from the phone: "on the ios app in the metrics/report tool [could I] tap on any
 * items and get more details, like for example tokens by project I can't really see them?
 * Also the memory button doesn't bring anything on the app…don't know if it's because the item
 * is hidden behind the main screen".
 *
 * ── THE REPORT ──────────────────────────────────────────────────────────────────────────
 * `byProject` did not exist server-side at all, so no phone could have shown it. The other
 * dimensions rendered but as flat bars with no press target — the number was visible and the
 * rows behind it were not. Set-based over the dimensions the endpoint returns, because a report
 * is a contract of dimensions and the next one added would otherwise ship unrendered.
 *
 * ── MEMORY ──────────────────────────────────────────────────────────────────────────────
 * The user's guess — "hidden behind the main screen" — is the right shape. The panel was
 * mounted INSIDE CartridgeDetailScreen between the header and the mode row, as a `flex: 1`
 * sibling of the transcript FlatList, with its own KeyboardAvoidingView nested inside the
 * detail screen's KeyboardAvoidingView. Whatever height it won was a negotiation with a list
 * that also wanted to grow, and nested KAVs each compute their own frame.
 *
 * It is a pushed route now, like `detail`, `workflowRun` and `goalDetail`: a full surface with
 * its own back control and nothing to compete with. That removes the class of bug rather than
 * tuning one instance of it — the app already had the pattern and memory was the one screen
 * not using it.
 *
 * Also asserted: memory does not open on its emptiest tab. `notes` is [] for 10 of 11 projects,
 * so defaulting to notes made a working screen look broken — which is exactly what was
 * reported. It opens on details.md (progress.md, the original default, is retired).
 */

const MOBILE = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(MOBILE, p), 'utf8');
/** Comments describe what code does NOT do as often as what it does. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TOKENS = 'src/screens/TokensScreen.tsx';
const APP = 'App.tsx';

/** The dimensions /api/activity/usage-series returns. Kept in step with the server's response. */
const DIMENSIONS = ['series', 'total', 'byCartridge', 'byProject'] as const;

/** Every tab the memory screen offers, from its own registry. */
function memoryTabs(): string[] {
  const src = read('src/screens/ProjectMemoryScreen.tsx');
  const line = src.slice(src.indexOf('const KNOWLEDGE_FILES'), src.indexOf(']', src.indexOf('const KNOWLEDGE_FILES')));
  return ['notes', ...[...line.matchAll(/'([^']+\.md)'/g)].map((m) => m[1])];
}

describe('the metrics report is drillable', () => {
  it('scans are non-vacuous', () => {
    expect(code(TOKENS).length, 'TokensScreen not readable').toBeGreaterThan(500);
    // 2: notes + details.md. Was 5 — three knowledge files were retired (see
    // server/src/lib/knowledge-files.ts). Still a non-vacuity check on the parser.
    expect(memoryTabs().length, 'memory tab registry not parsed').toBeGreaterThanOrEqual(2);
  });

  it('renders EVERY dimension the endpoint returns', () => {
    const src = code(TOKENS);
    const missing = DIMENSIONS.filter((d) => !new RegExp(`\\b${d}\\b`).test(src));
    expect(missing, `TokensScreen never reads: ${missing.join(', ')}`).toEqual([]);
  });

  it('makes the breakdown rows pressable — a number you cannot open is a dead end', () => {
    // NOT "contains TouchableOpacity": the segmented range picker already did, and `selected`
    // already appeared as an accessibility prop, so the first version of this passed against
    // the unfixed screen. It asserts the drill-down's own machinery by name instead.
    const src = code(TOKENS);
    expect(src, 'no state holding the row the user opened').toMatch(/setDrill\(/);
    expect(src, 'no sheet renders the opened row').toMatch(/<BreakdownSheet\b/);
    const block = src.slice(src.indexOf('byProject'));
    expect(block.slice(0, 900), 'byProject rows have no onPress').toMatch(/onPress=\{\(\) => setDrill/);
  });

  /**
   * REPORTED: "in the token reporting we only need stats by project not by cartridge below,
   * it's the same thing." It was — on live data every project held exactly one cartridge, so
   * the two cards listed the same rows in the same order, differing only in a `<machine>/`
   * prefix. The per-cartridge numbers did not go away; they moved BEHIND the project row they
   * explain, which is where the drill-down already put them.
   *
   * This used to assert both cards were tappable. Removing that assertion without replacing it
   * would leave the drill-down — now the only path to a per-cartridge number — unguarded, so
   * what it guards moves to the split being CORRECT rather than merely present.
   */
  it('splits a project by the project the server assigned, not by name matching', () => {
    const src = code(TOKENS);
    expect(src, 'the standalone cartridge card is back — it is the project list again')
      .not.toMatch(/By cartridge/);
    expect(src, 'the project drill-down no longer lists its cartridges')
      .toMatch(/cartridges:\s*data!\.byCartridge\.filter/);
    // `name.includes(project)` put gridlight-work and gridlight-manager inside gridlight, under
    // a heading that correctly said "1 cartridge". An equality on the server's own grouping
    // cannot do that.
    expect(src, 'cartridges are still matched by NAME, which over-matches prefixed repo names')
      .not.toMatch(/c\.name\.includes\(/);
    expect(src, 'the split must compare the project the server assigned')
      .toMatch(/c\.project === row\.project/);
  });
});

describe('memory is reachable', () => {
  it('is a pushed full-screen route, not a panel competing for flex height', () => {
    const app = code(APP);
    const pushed = app.slice(app.indexOf('const PUSHED'), app.indexOf('];', app.indexOf('const PUSHED')));
    expect(pushed, 'memory must be a pushed screen so it owns the surface').toMatch(/'memory'/);
    expect(app, 'memory needs a route that renders it').toMatch(/route\.name === 'memory'/);
  });

  it('no longer mounts the panel inside the cartridge detail screen', () => {
    // The old mount is the bug: a flex:1 sibling of the transcript list, inside a nested
    // KeyboardAvoidingView. Leaving it in place would keep the broken path reachable.
    const detail = code('src/screens/CartridgeDetailScreen.tsx');
    expect(detail, 'CartridgeDetailScreen must navigate to memory, not embed it')
      .not.toMatch(/<ProjectMemoryScreen/);
  });

  it('opens on a tab that has content, not on the emptiest one', () => {
    const src = code('src/screens/ProjectMemoryScreen.tsx');
    const initial = src.match(/useState<Tab>\('([^']+)'\)/);
    expect(initial, 'could not find the initial tab').toBeTruthy();
    expect(initial![1], 'notes is empty for almost every project — opening there looks broken')
      .not.toBe('notes');
  });

  it('still offers every tab in its registry', () => {
    const src = code('src/screens/ProjectMemoryScreen.tsx');
    const missing = memoryTabs().filter((t) => !src.includes(t));
    expect(missing, `memory lost tabs: ${missing.join(', ')}`).toEqual([]);
  });
});
