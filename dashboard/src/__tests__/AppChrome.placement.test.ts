import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Where each control in the dashboard chrome LIVES.
 *
 * `feat(dashboard): a command rail you don't have to scroll back to` moved every
 * control out of the header into a sticky left rail, on the reasoning that the header
 * was not sticky so acting on anything meant scrolling up and back down. That is true
 * of the things you INVOKE repeatedly — Launch, New Repo, Confer, Workflows — but it
 * over-applied: the view switcher, Guide and Settings are navigation and chrome, and
 * putting them in the rail cost them their conventional place. The cartridge TYPE
 * filter belongs with the cartridges it filters, not in a column beside them.
 *
 * This test is SET-BASED over a registry of controls rather than a handful of
 * examples, because the failure it exists to prevent is a partial move: relocating
 * Agents but not Goals, or Guide but not Settings, looks correct at a glance and
 * leaves the chrome split across two places.
 *
 * It parses the SOURCE rather than rendering, because the question is structural —
 * which region does this control render in — and rendering App would require mocking
 * the API, the socket and the whole agent tree to answer it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../App.tsx'), 'utf8');

/** Slice the source into the three chrome regions by their JSX landmarks. */
function regions(src: string) {
  const headerStart = src.indexOf('<header');
  const headerEnd = src.indexOf('</header>');
  const asideStart = src.indexOf('<aside');
  const asideEnd = src.indexOf('</aside>');
  const mainStart = src.indexOf('<main');
  const mainEnd = src.lastIndexOf('</main>');

  for (const [name, i] of Object.entries({
    headerStart, headerEnd, asideStart, asideEnd, mainStart, mainEnd,
  })) {
    if (i < 0) throw new Error(`App.tsx has no ${name} — the layout changed shape`);
  }
  return {
    header: src.slice(headerStart, headerEnd),
    aside: src.slice(asideStart, asideEnd),
    main: src.slice(mainStart, mainEnd),
  };
}

type Region = 'header' | 'aside' | 'main';

/**
 * THE SET. Every control in the chrome, and the region it must render in.
 *
 * The `aside` entries are as load-bearing as the others: they are what stops a fix
 * from over-correcting and dragging the whole rail back into the header, which is the
 * layout the rail commit was written to escape.
 */
const CONTROLS: { name: string; marker: RegExp; region: Region }[] = [
  // Asked for: navigation returns to the top menu.
  { name: 'Agents view switch', marker: /setActiveView\('agents'\)/, region: 'header' },
  { name: 'Goals view switch', marker: /setActiveView\('goals'\)/, region: 'header' },
  { name: 'Tasks view switch', marker: /setActiveView\('tasks'\)/, region: 'header' },
  // Asked for: chrome returns to the top menu.
  { name: 'Guide', marker: /setGuideOpen\(true\)/, region: 'header' },
  { name: 'Settings', marker: /setSettingsOpen\(true\)/, region: 'header' },
  // Asked for: the whole "Show" section sits with the cartridges. Both filters ask
  // "which of these am I looking at", which is a question about the grid — my first
  // pass split them, keeping status in the rail, and that was wrong.
  { name: 'Type filter (All/Gridlight/Claude)', marker: /setTypeFilter\(/, region: 'main' },
  { name: 'Status filter (Working/Waiting/Idle)', marker: /setStatusFilter\(/, region: 'main' },

  // NOT asked for — these are commands you invoke while watching a cartridge, which
  // is exactly what the rail is for. Listed so an over-broad revert fails here.
  { name: 'Machine launcher', marker: /<MachineLauncher/, region: 'aside' },
  { name: 'New repo', marker: /setNewRepoOpen\(true\)/, region: 'aside' },
  { name: 'Confer', marker: /setConferOpen\(true\)/, region: 'aside' },
  { name: 'Workflows', marker: /<WorkflowPanel/, region: 'aside' },
];

describe('dashboard chrome placement', () => {
  const R = regions(SRC);

  it.each(CONTROLS)('$name renders in <$region>', ({ marker, region }) => {
    expect(marker.test(R[region])).toBe(true);
  });

  it.each(CONTROLS)('$name is not duplicated into another region', ({ marker, region }) => {
    const others = (['header', 'aside', 'main'] as Region[]).filter((r) => r !== region);
    for (const other of others) {
      expect(
        marker.test(R[other]),
        `also found in <${other}> — moved controls must be relocated, not copied`,
      ).toBe(false);
    }
  });

  it('Launch, New Repo and Confer share one row', () => {
    // Three stacked buttons ate the top of the rail and pushed the workflows below the
    // fold. They are peers — one row, not a column.
    const block = R.aside.slice(
      R.aside.indexOf('<MachineLauncher'),
      R.aside.indexOf('setConferOpen'),
    );
    expect(block.length).toBeGreaterThan(0);
    // The container that wraps them must lay out horizontally.
    const container = R.aside.slice(0, R.aside.indexOf('<MachineLauncher'));
    const lastDiv = container.lastIndexOf('<div');
    expect(container.slice(lastDiv)).not.toMatch(/flex-col/);
  });

  it('the type filter sits beside the Cartridges heading, not below the grid', () => {
    // "Beside the title" is the ask. If it renders after <CartridgeGrid it has been
    // appended to the section rather than placed in its header row.
    const heading = R.main.indexOf('Cartridges');
    const filter = R.main.search(/setTypeFilter\(/);
    const grid = R.main.indexOf('<CartridgeGrid');
    expect(heading).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(heading);
    expect(filter).toBeLessThan(grid);
  });

  it('workflow templates are open on arrival', () => {
    // Templates you cannot see are templates you do not use. The panel opens with them
    // already listed rather than behind a disclosure.
    const wf = readFileSync(resolve(HERE, '../components/WorkflowPanel.tsx'), 'utf8');
    expect(wf).toMatch(/useState\(true\);?\s*\/\/.*template|const \[showTemplates, setShowTemplates\] = useState\(true\)/);
  });

  it('the type filter is only shown on the cartridges view', () => {
    // Goals and Tasks render INSTEAD of the grid, so a filter for cartridges must not
    // appear over them. The cartridges branch is the fall-through of the view ternary
    // rather than an explicit `activeView === 'agents'` test, so the property is proved
    // by position: the filter must sit after the last branch condition, inside the
    // else. Asserting the literal would fail against code that is already correct.
    const lastBranch = R.main.search(/activeView === 'tasks'/);
    const filter = R.main.search(/setTypeFilter\(/);
    expect(lastBranch).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(lastBranch);
  });
});
