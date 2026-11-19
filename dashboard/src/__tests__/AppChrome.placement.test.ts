import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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
  const navStart = src.indexOf('<nav');
  const navEnd = src.indexOf('</nav>');
  const headerStart = src.indexOf('<header');
  const headerEnd = src.indexOf('</header>');
  const asideStart = src.indexOf('<aside');
  const asideEnd = src.indexOf('</aside>');
  const mainStart = src.indexOf('<main');
  const mainEnd = src.lastIndexOf('</main>');

  for (const [name, i] of Object.entries({
    navStart, navEnd, headerStart, headerEnd, asideStart, asideEnd, mainStart, mainEnd,
  })) {
    if (i < 0) throw new Error(`App.tsx has no ${name} — the layout changed shape`);
  }
  return {
    nav: src.slice(navStart, navEnd),
    header: src.slice(headerStart, headerEnd),
    aside: src.slice(asideStart, asideEnd),
    main: src.slice(mainStart, mainEnd),
  };
}

type Region = 'nav' | 'header' | 'aside' | 'main';

/**
 * THE SET. Every control in the chrome, and the region it must render in.
 *
 * The `aside` entries are as load-bearing as the others: they are what stops a fix
 * from over-correcting and dragging the whole rail back into the header, which is the
 * layout the rail commit was written to escape.
 */
const CONTROLS: { name: string; marker: RegExp; region: Region }[] = [
  // Night Glass (2026-11-18, asked for: "update the entire live UI … EXACTLY like the UI
  // designed"): navigation moves to the slim left view bar, with Guide and Settings at its
  // foot. The views and the chrome move TOGETHER — the partial move this file guards against.
  { name: 'Agents view switch', marker: /setActiveView\('agents'\)/, region: 'nav' },
  { name: 'Goals view switch', marker: /setActiveView\('goals'\)/, region: 'nav' },
  { name: 'Tasks view switch', marker: /setActiveView\('tasks'\)/, region: 'nav' },
  { name: 'Guide', marker: /setGuideOpen\(true\)/, region: 'nav' },
  { name: 'Settings', marker: /setSettingsOpen\(true\)/, region: 'nav' },
  // Asked for: the whole "Show" section sits with the cartridges. Both filters ask
  // "which of these am I looking at", which is a question about the grid — my first
  // pass split them, keeping status in the rail, and that was wrong.
  { name: 'Type filter (All/Gridlight/Claude)', marker: /setTypeFilter\(/, region: 'main' },
  { name: 'Status filter (Working/Waiting/Idle)', marker: /setStatusFilter\(/, region: 'main' },

  // Asked for: Launch and New Repo come back to the top bar. They are how you START a
  // session, not something you invoke mid-watch, so they sit in the header — to the
  // LEFT of Guide and Settings, which are pinned to the far right (see below).
  { name: 'Machine launcher', marker: /<MachineLauncher/, region: 'header' },
  { name: 'New repo', marker: /setNewRepoOpen\(true\)/, region: 'header' },


  // The fleet burn rate reads with the identity, not with the controls: it is the one
  // thing in the chrome you READ rather than invoke, and it was asked for immediately
  // after the wordmark (the "Orchestrator" label it used to follow is gone). Registered here so it cannot drift into the rail with
  // the next chrome move — the same partial-relocation failure this file exists to catch.
  { name: 'Burn rate readout', marker: /<BurnRate/, region: 'header' },
  // The burn-rate pill also opens Tokens (onOpen), so the marker is the view bar's own onClick.
  { name: 'Tokens view switch', marker: /onClick=\{\(\) => setActiveView\('tokens'\)\}/, region: 'nav' },
  // The report itself is a working surface, not chrome — same region as the goals workspace
  // and the task list. Registered so a chrome reshuffle cannot drag it into the rail, where
  // a full-width chart has nowhere to go.
  { name: 'Token report', marker: /<TokensPage/, region: 'main' },

  // NOT asked for — what you read or invoke while watching, which is what the rail is
  // for. Listed so an over-broad move fails here.
  { name: 'Workflows', marker: /<WorkflowPanel/, region: 'aside' },

  // Master–detail Goals: "the list of goals on the 1/3 section with the 2/3 the place
  // where we work". The 1/3 IS the aside and the 2/3 IS the main — a nested split inside
  // <main> would produce the same proportions in the wrong place and pass any test that
  // only checked for a grid, so the assertion has to be regional.
  { name: 'Goals list', marker: /<GoalsRail/, region: 'aside' },
  { name: 'Goals working surface', marker: /<GoalsWorkspace/, region: 'main' },
];

/**
 * THE RAIL IS PER-VIEW, AND ITS OCCUPANTS MUST NOT STACK.
 *
 * Both panels render into the same `<aside>`. If either loses its view guard they appear
 * together, and the goals list gets pushed below a full workflow panel — the 1/3 column is
 * not tall enough for both, so the symptom is "the goals list is missing" rather than
 * anything that looks like a layout bug.
 */
const RAIL_OCCUPANTS: { name: string; marker: RegExp; view: string }[] = [
  { name: 'Workflows', marker: /<WorkflowPanel/, view: 'agents' },
  { name: 'Goals list', marker: /<GoalsRail/, view: 'goals' },
];

describe('dashboard chrome placement', () => {
  const R = regions(SRC);

  it.each(CONTROLS)('$name renders in <$region>', ({ marker, region }) => {
    expect(marker.test(R[region])).toBe(true);
  });

  it.each(CONTROLS)('$name is not duplicated into another region', ({ marker, region }) => {
    const others = (['nav', 'header', 'aside', 'main'] as Region[]).filter((r) => r !== region);
    for (const other of others) {
      expect(
        marker.test(R[other]),
        `also found in <${other}> — moved controls must be relocated, not copied`,
      ).toBe(false);
    }
  });

  it.each(RAIL_OCCUPANTS)('$name renders in the rail only on the $view view', ({ marker, view }) => {
    const i = R.aside.search(marker);
    expect(i, 'not in the rail at all').toBeGreaterThan(-1);
    // The guard has to precede it in source — it is what wraps the render.
    const before = R.aside.slice(0, i);
    expect(
      before,
      `unguarded — it would render alongside the other rail panel on every view`,
    ).toMatch(new RegExp(`activeView === '${view}'`));
  });

  /**
   * THE RAIL'S CONTENTS MUST CLEAR ITS SCROLL EDGE.
   *
   * The aside carries `overflow-y-auto`, so its scrollbar is drawn INSIDE its own box. With
   * only `lg:pr-1` (4px) the template cards ran right up against it — reported as the workflows
   * panel sitting too close to what is on its right.
   *
   * Set-based over the rail's occupants, and the property is that the clearance is declared
   * EXACTLY ONCE, on the aside. Padding the workflow panel alone would fix the view it was
   * noticed on and leave the goals rail a different width, so the rail edge would jump as you
   * switch views — the partial fix that looks correct on the screen you are looking at. Two
   * occupants each declaring their own padding is the same bug with extra steps.
   */
  it('the rail declares real clearance from its own scroll edge', () => {
    const asideTag = SRC.slice(SRC.indexOf('<aside'), SRC.indexOf('>', SRC.indexOf('<aside')));
    const pr = asideTag.match(/lg:pr-(\d+)/);
    expect(pr, 'the rail declares no right padding at all').not.toBeNull();
    expect(
      Number(pr![1]),
      'the rail pads its content by less than 0.75rem — the scrollbar sits inside the box, so ' +
      'anything smaller leaves the contents touching it',
    ).toBeGreaterThanOrEqual(3);
  });

  it.each(RAIL_OCCUPANTS)('$name does not declare its own rail clearance', ({ name }) => {
    // One source of truth for the gutter. A second one here would double the padding on one
    // view and diverge from the other the moment either is tuned.
    const file = name === 'Workflows' ? '../components/WorkflowPanel.tsx' : '../components/GoalsPage.tsx';
    const src = readFileSync(resolve(HERE, file), 'utf8');
    const start = name === 'Workflows'
      ? src.indexOf('export function WorkflowPanel')
      : src.indexOf('export function GoalsRail');
    expect(start, `${name} is gone`).toBeGreaterThan(-1);
    // The component's ROOT element only — inner cards legitimately have their own padding.
    const root = src.slice(src.indexOf('return (', start), src.indexOf('return (', start) + 220);
    expect(
      root,
      `${name} pads its own right edge — the rail gutter must be declared once, on the aside`,
    ).not.toMatch(/\bp[rx]-\d|\bm[rx]-\d/);
  });

  it('the rail scrolls on its own, so a long goals list cannot push the page', () => {
    // Master–detail puts an unbounded list in a column beside an unbounded detail pane.
    // Without independent scroll the taller one sets the page height and the other is
    // stranded — the sticky+overflow pair is what makes the 1/3 usable as a list.
    const asideTag = SRC.slice(SRC.indexOf('<aside'), SRC.indexOf('>', SRC.indexOf('<aside')));
    expect(asideTag).toMatch(/sticky/);
    expect(asideTag).toMatch(/overflow-y-auto/);
    expect(asideTag).toMatch(/max-h-/);
  });

  it('the Goals rail offers Goal before Project — containment order', () => {
    // They shipped Project-then-Goal, which inverts the hierarchy the page is built on: a
    // project lives UNDER a goal. This is the one place a user meets both controls at once, so
    // the order is the only thing teaching which contains which.
    //
    // Worth noting because it comes up: Goal > Project is Linear's model (Initiative > Project
    // > Issue), not an invention here. It reads backwards only against Jira, where Project is
    // the top-level container.
    const src = readFileSync(resolve(HERE, '../components/GoalsPage.tsx'), 'utf8');
    const rail = src.slice(src.indexOf('export function GoalsRail'));
    const goal = rail.indexOf("setModal({ type: 'new-goal' })");
    const project = rail.indexOf("setModal({ type: 'new-project', goalId: null })");
    expect(goal, '+ Goal is missing from the rail').toBeGreaterThan(-1);
    expect(project, '+ Project is missing from the rail').toBeGreaterThan(-1);
    expect(goal, '+ Project renders before + Goal, inverting the hierarchy').toBeLessThan(project);
  });

  it('a modal scrolls inside itself instead of growing past the viewport', () => {
    // A `fixed inset-0` overlay means the page behind it cannot scroll, so a form taller than
    // the window loses its title off the top and its Save button off the bottom with no way to
    // reach either. Found when the Phase 7 planning fields pushed the goal form over the line;
    // asserted on the shared Modal because the next long form would hit it again.
    const src = readFileSync(resolve(HERE, '../components/GoalsPage.tsx'), 'utf8');
    const at = src.indexOf('function Modal(');
    expect(at, 'the shared Modal is gone').toBeGreaterThan(-1);
    const body = src.slice(at, at + 1600);
    expect(body, 'the modal panel has no height cap').toMatch(/max-h-/);
    expect(body, 'the modal panel cannot scroll its own overflow').toMatch(/overflow-y-auto/);
  });

  it('the start-actions row lays out horizontally', () => {
    // Stacked buttons ate the top of the rail and pushed the templates below the fold.
    // Anchored on the header cluster, which is where all three starts now live — Confer
    // moved out of WorkflowPanel, so anchoring there no longer measures anything.
    const i = R.header.search(/<MachineLauncher/);
    const row = R.header.slice(0, i);
    const lastDiv = row.lastIndexOf('<div');
    expect(row.slice(lastDiv)).not.toMatch(/flex-col/);
  });

  /**
   * ORDER within the header-right cluster. The ask is positional, not just regional:
   * reading left to right the right edge is Notifications → Guide → Settings → Launch
   * → New Repo. Asserting only "these are in the header" passes on any permutation,
   * which is exactly what got shipped and rejected.
   *
   * Set-based over the sequence: every ADJACENT PAIR is asserted, so a fix that gets
   * Guide next to the bell but leaves Launch stranded fails on the pair it broke rather
   * than silently passing an "all present" check.
   */
  const HEADER_RIGHT: { name: string; marker: RegExp }[] = [
    // Start-a-session controls come first, immediately after the centred view switcher.
    // (Confer used to lead them. It is a workflow template now — see the Confer test below.)
    { name: 'Machine launcher', marker: /<MachineLauncher/ },
    { name: 'New repo', marker: /setNewRepoOpen\(true\)/ },
    // Guide and Settings left the header for the view bar's foot (Night Glass).
    // Status, pinned to the far right. These three were previously unpositioned — the ask
    // gives them an explicit place, so they join the registry rather than floating.
    { name: 'Online count', marker: /onlineAgents\.length/ },
    { name: 'Server picker', marker: /<ServerPicker/ },
    { name: 'Notifications', marker: /<NotificationCenter/ },
  ];

  it.each(
    HEADER_RIGHT.slice(0, -1).map((left, i) => ({ left, right: HEADER_RIGHT[i + 1] })),
  )('$left.name comes before $right.name in the header', ({ left, right }) => {
    const a = R.header.search(left.marker);
    const b = R.header.search(right.marker);
    expect(a, `${left.name} is missing from the header`).toBeGreaterThan(-1);
    expect(b, `${right.name} is missing from the header`).toBeGreaterThan(-1);
    // Source order is render order inside a flex row.
    expect(a).toBeLessThan(b);
  });

  it('nothing in the registry renders after the notification bell — it is the right edge', () => {
    // Derived from the registry's last entry rather than naming a control, so reordering the
    // list above cannot leave this assertion pointing at whatever used to be rightmost.
    const last = HEADER_RIGHT[HEADER_RIGHT.length - 1];
    const trailing = R.header.slice(R.header.search(last.marker));
    for (const { name, marker } of HEADER_RIGHT.slice(0, -1)) {
      expect(marker.test(trailing), `${name} renders to the right of ${last.name}`).toBe(false);
    }
  });

  it('the header cluster holding them is pushed to the right edge', () => {
    // Without a right-aligning container the controls sit next to the logo, which is the
    // layout being replaced. The wrapper must claim the free space.
    const cluster = R.header.slice(0, R.header.search(/<NotificationCenter/));
    const lastDiv = cluster.lastIndexOf('<div');
    expect(cluster.slice(lastDiv)).toMatch(/ml-auto|justify-end|flex-1/);
  });

  /**
   * NIGHT GLASS: the view bar. Agents leads because it is where the day is spent; Projects
   * (the goals view) is second; Tasks and Tokens follow. Pinned as adjacent pairs so a
   * reshuffle fails on the pair it broke.
   */
  const VIEW_ORDER = ['agents', 'goals', 'tasks', 'tokens'] as const;

  it.each(
    VIEW_ORDER.slice(0, -1).map((left, i) => ({ left, right: VIEW_ORDER[i + 1] })),
  )('the $left switch comes before the $right switch in the view bar', ({ left, right }) => {
    const a = R.nav.indexOf(`setActiveView('${left}')`);
    const b = R.nav.indexOf(`setActiveView('${right}')`);
    expect(a, `${left} switch is missing`).toBeGreaterThan(-1);
    expect(b, `${right} switch is missing`).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });

  it('Guide and Settings sit at the foot of the view bar, after every view', () => {
    const lastView = R.nav.indexOf("setActiveView('tokens')");
    expect(R.nav.indexOf('setGuideOpen(true)')).toBeGreaterThan(lastView);
    expect(R.nav.indexOf('setSettingsOpen(true)')).toBeGreaterThan(lastView);
  });

  it('the chrome carries no Gridlight logo or wordmark — asked to be removed', () => {
    expect(SRC).not.toMatch(/logo\.png|alt="Gridlight"/);
    expect(SRC).not.toMatch(/font-pixel/);
  });

  it('the header carries no "Orchestrator" label', () => {
    expect(R.header).not.toMatch(/>\s*Orchestrator\s*</);
  });


  function initialViewDeclaration(): string {
    const at = SRC.search(/useState<(?:'\w+'\s*\|\s*)*'\w+'>\(/);
    expect(at, 'App.tsx no longer declares the active view with a useState union').toBeGreaterThan(-1);
    return SRC.slice(at, at + 240);
  }

  it('the dashboard opens on Agents by default', () => {
    expect(initialViewDeclaration()).toMatch(/'agents'/);
  });

  it('a goal deep link opens the Goals view, not the default one', () => {
    const init = initialViewDeclaration();
    expect(
      init,
      'the initial view ignores the URL — #goal/<id> would land on Agents with the goal ' +
      'selected in a pane that is not rendered',
    ).toMatch(/parseGoalHash/);
  });

  it('a goal link arriving while the app is open also switches view', () => {
    // Same defect, live rather than on load: clicking a notification link fires hashchange
    // without a reload, so selection would move while the view stayed put.
    const at = SRC.indexOf("addEventListener('hashchange'");
    expect(at, 'App does not listen for hashchange').toBeGreaterThan(-1);
    // The handler is normally declared just ABOVE the subscribe call, so look both ways
    // rather than assuming an order this test has no reason to constrain.
    const around = SRC.slice(Math.max(0, at - 500), at + 300);
    expect(around, 'hashchange does not bring the Goals view with it')
      .toMatch(/setActiveView\('goals'\)/);
  });

  /**
   * CONFER IS REACHABLE FROM EVERY VIEW.
   *
   * History, because this control has now moved twice and each move fixed the previous
   * one's defect:
   *
   *  1. A full-width ghost button ABOVE the `Workflows` header — orphaned, belonging to no
   *     section, and styled as the opposite of the sibling `+ New Workflow` beside it.
   *  2. Moved INTO WorkflowPanel beside `+ New Workflow`, which fixed the styling. But that
   *     panel renders only when `activeView === 'agents'`, so the move silently made Confer
   *     unreachable from Goals and Tasks — you had to switch views to start one. The
   *     previous version of this test asserted Confer lived in the panel, so it locked the
   *     defect in rather than catching it.
   *  3. Moved to the header beside Launch and New Repo. All three answer "start something",
   *     and the header renders on every view, which is the property that actually matters.
   *
   * The lesson encoded here: for a GLOBAL action, "which component owns it" is the wrong
   * question — "which views can reach it" is the right one. So this asserts reachability
   * structurally, by requiring Confer to sit outside every view guard.
   */
  it('Confer is NOT a header control — it is a workflow template', () => {
    /**
     * THE FOURTH MOVE, and the one that ended the argument.
     *
     * The history above is real and each move fixed the previous one's defect: orphaned ghost
     * button → into WorkflowPanel (fixed styling, broke reachability) → into the header (fixed
     * reachability). Every one of those was an argument about WHERE TO PUT THE BUTTON.
     *
     * The button was the wrong unit. Confer is cartridges working one task together — which is
     * what a workflow IS. As a header control it was the only way of starting work in NeonCore
     * with no run history, no project attribution, no completion report and no place on the
     * canvas. As a template it gets all four for nothing, and the placement question dissolves.
     *
     * So this asserts the ABSENCE, with the reason attached, because an absence with no
     * explanation is exactly what invites a fifth move.
     */
    expect(SRC, 'App.tsx still opens a confer modal from the chrome')
      .not.toMatch(/setConferOpen/);
    expect(SRC, 'App.tsx still imports ConferModal').not.toMatch(/ConferModal/);

    // And no view-specific panel has quietly grown its own entry point to replace it.
    const panel = readFileSync(resolve(HERE, '../components/WorkflowPanel.tsx'), 'utf8');
    expect(panel, 'WorkflowPanel offers its own Confer again').not.toMatch(/onConfer/);
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

  it('workflow templates stay open — there is no collapse to fall into', () => {
    // "Open on arrival" was not the ask; "open at all times" is. A default-true toggle
    // still lets one click hide them for the rest of the session, and the next arrival
    // does not restore it if the state ever persists. The disclosure is gone entirely.
    const wf = readFileSync(resolve(HERE, '../components/WorkflowPanel.tsx'), 'utf8');
    expect(wf, 'showTemplates state still exists').not.toMatch(/showTemplates/);
    expect(wf, 'the templates list is still conditionally rendered').not.toMatch(
      /\{\s*showTemplates\s*&&/,
    );
  });

  /**
   * The bundle you actually LOOK at.
   *
   * Every assertion above reads `src/`. The dashboard is served by the server from
   * `server/public`, built by `npm run build --workspace=dashboard`. Those are two
   * different artifacts, and a green source suite says nothing about the second one —
   * which is exactly how a layout change got reported as done three times while the
   * browser kept rendering an eight-hour-old build.
   *
   * Skipped when there is no build (fresh checkout, CI) — absent is not stale.
   */
  it('the served bundle is not older than the source it is built from', () => {
    const publicDir = resolve(HERE, '../../../server/public');
    if (!existsSync(publicDir)) return;

    // Tests are not bundled, so touching one does not make the build stale.
    const newest = (dir: string): number =>
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.includes('__tests__') && !e.name.includes('.test.'))
        .reduce((max, e) => {
          const p = resolve(dir, e.name);
          return Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
        }, 0);

    const built = newest(publicDir);
    const source = newest(resolve(HERE, '..'));
    expect(
      built,
      `server/public was built ${Math.round((source - built) / 60000)} min BEFORE the ` +
      `newest file in dashboard/src — the running dashboard is serving stale code. ` +
      `Run: npm run build --workspace=dashboard`,
    ).toBeGreaterThan(source);
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
