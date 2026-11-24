# The project as the single place — spec, roadmap, changelog, architecture, docs

A project is where you control the product: its **feature list** (what to build, in order), each
feature's **pipeline** (scope → plan → build → verify — see [GOAL-PILOT.md](GOAL-PILOT.md)), and the
documents all of that becomes. The documents are not written by anyone: they are generated from the
records every time you look, so they are always current — and they can live in the repo with the code.
For a codebase that is new to NeonCore, where there are no records yet, a cartridge can write them from
the repos: **✦ Generate with AI** (below).

```
            ┌───────────── Features ─────────────┐
            │ the list, in build order            │──▶ one at a time: scope → plan → run → verify
            └────────────────────────────────────┘
                │ intent (agreed when scoped)  +  evidence (NeonCore's checks)
                ▼
   Spec ─────── every feature: intent beside what was verified, and where they differ
   Roadmap ──── the route of epics, and the Board: To do / In Progress / QA / Done — a shareable page
   Changelog ── an entry per feature marked done; you edit, add, and cut releases
   Architecture how the product is built — generated from the codebase or written by you
                │
                ▼
   docs/product/ in the main repo — on demand, or kept in sync
```

The project page has a tab for each: **Features · Spec · Roadmap · Changelog · Architecture**.

## Spec — intent versus what was delivered

For every feature the spec shows:

- **Intent** — what was agreed when it was scoped: the summary, *done when*, what is in and out of scope,
  what must not break, the assumptions made on your behalf.
- **Acceptance criteria with evidence** — for each criterion, ✓ met / ✗ not met / ○ not checked, with the
  evidence NeonCore holds: the locked test's command and NeonCore's own run of it after the last stage,
  or the independent reviewer's verdict and your confirmation.
- **Delivery** — the report's status, the workflows that ran, what changed, what is still open, the
  cost.

…and from those, how each feature **measures up**:

| | Means |
|---|---|
| Meets its criteria | every acceptance criterion passes on NeonCore's evidence |
| Some criteria not met | built, but some criteria failed or were never checked |
| Not verified | built, and no criterion has passed NeonCore's check |
| No criteria yet | nothing to check it against (scoping writes them) |
| Criteria set | not built yet — the criteria are the target |
| Documented as it behaves today | an existing feature (generated from the codebase): its current behaviour written down as criteria, not yet checked by NeonCore |

**Grouped by capability, for executives.** Every feature carries an **area** — `<group> · <sub-area>`,
e.g. *Gateway · Routing & engines*. The spec reads as a handful of capability groups, each with a line
on what it does for the business, how many features it holds and their mix (existing / done / in
progress / planned / with gaps); open a group for its features, split by sub-area. A long list starts
collapsed, so the first screen is the executive summary. docs/product/README.md opens with the same
**At a glance** table, then a section per group. Generate with AI files features under at most 10
groups named as the business knows them (the smallest fold into *Other*); set or change a feature's
area in the **Capability** field on its page. Projects with no areas at all read as a flat list.

The **Needs attention** filter lists the features that were built (delivered or done) but do not
match their intent: a criterion not met, one never checked, or no criteria to check at all — the ways
a spec quietly stops meaning anything. (A planned feature without criteria is normal: scoping writes
them.)

Statuses: **Planned** (on the list), **In progress** (being scoped, planned or built), **Delivered**
(the pipeline finished — read the report and sign it off), **Done** (marked done), **Paused** (the
pipeline needs a decision), **Existing** (already in the product when the project was taken on).

## The Board — To do → In Progress → QA → Done

The Roadmap tab has two views of the same features — the **Chart** (the route, below) and the **Board** —
and opens on the last one used (`localStorage['neoncore.roadmap.tab']`). The Board is four columns, left
to right, where the work is (server `lib/project-spec.ts` `placeColumns`, so the page and the exports agree):

| Column | A feature is here when |
|---|---|
| **To do** | nothing has started |
| **In Progress** | its pipeline is running, or waits on a decision (*needs a decision*) |
| **QA** | it is delivered and waits for your sign-off — or it is done, and its epic has not passed QA yet |
| **Done** | it is marked done, and its epic passed QA (a feature in no epic: marked done) — newest first |

**Epic QA.** At the end of an epic its work is QA'd as a whole. A feature marked done is done in every
way — badges, changelog entry, fireworks, the epic's delivery and commendation — but on the Board it waits
in **QA**, under its epic ("waiting for epic QA"), until the epic passes QA. **Passed QA ✓** (on the epic's
group in the QA column, or on its card on the route) is offered once every feature of the epic is done,
and moves them all to **Done**. A feature reopened, or done after the epic passed, puts the epic back in
QA. Dragging such a feature to Done on its own is refused with what to do. Server: `epicQaOf` in
`lib/project-spec.ts` (none · open · waiting · passed), `setEpicQa` in `lib/roadmap.ts`,
`PUT /api/roadmap/epics/:id { qaPassed: true | false }` (`epics.qa_passed_at`). The automated QA run that
starts when an epic is finished (`lib/qa/feature-link.ts`) is separate: pressing Passed QA is yours.

**You can put a feature somewhere else**: drag its card to another column, or use **Move…** on the card (or
the *Board* picker on the feature's own page). A placed feature shows *placed* and stays where you put it;
**Move… → back to automatic** hands it back. The old Now / Next / Later placements were priorities, not
where the work is: a feature placed with them follows its state again.

**Done is a status, not a placement**: moving a card to Done marks the feature done (after a confirmation —
its changelog entry is written, and the fireworks go up), refused while anything it needs first is not done;
moving it out of Done reopens it, into the column you dropped it on. **Open shareable page** is a
self-contained HTML page of the four columns with no controls — send it, print it, or put it on a screen.
Also as Markdown.

## Roadmap chart — vision, epics, features on the route

The **Chart** is the plan as a route: the vision, then every epic a stop on the way to the destination, with its card under the route (DESIGN.md, *The roadmap deck*). There is no dated timeline.

```
VISION ──── one or two sentences: where the project is going   (projects.vision)
  EPIC ──── a lane: a name, what it delivers, an icon, an order (epics)
    FEATURE ─ a waypoint on its target date, in its state       (goals.epic_id, start_date, target_date, depends_on)
```

- **States** come from the records, never from the chart: *planned*, *under way* (its pipeline is
  running or its work has started), *delivered* (marked done), *late* (target date passed, not delivered).
- **Waits on**: a feature can wait on other features of the same project. A loop is refused. A feature
  that waits on an undelivered one cannot be started from the chart, and says which one it waits on.
- **Planning**: select a feature on its epic's card to set its epic, start and target dates and what it
  waits on; drag a feature's chip onto another epic's card to move it there.
- **Executing**: *Start* on a selected feature, or *Start next* on an epic (the earliest feature of it
  that can start), opens the feature — its pipeline starts from there, as always.
- **Told to the agents**: a feature started while it is on the roadmap is given a short *Where this
  fits* section — the vision, its epic and outcome, its dates, and what it waits on.
- The gauges are of the whole project: delivered / scheduled (has a target date) / on track (not late).

| API | |
|---|---|
| `GET /api/roadmap/:projectId` | the chart |
| `PUT /api/roadmap/:projectId/vision` | `{ vision }` |
| `POST /api/roadmap/:projectId/epics` · `PUT /api/roadmap/epics/:id` · `DELETE /api/roadmap/epics/:id` | an epic: `name`, `outcome`, `icon`; removing one leaves its features in the project |
| `PUT /api/roadmap/:projectId/epics/order` | `{ order: [epicId…] }` |
| `PUT /api/roadmap/features/:featureId` | `epicId`, `startDate`, `targetDate`, `dependsOn` |

Every write answers with the chart as it now is. Code: `server/src/lib/roadmap.ts`, `server/src/routes/roadmap.ts`,
`dashboard/src/world/roadmap/` (`RoadmapChart.tsx`, `chartLayout.ts`), art from `scripts/world/build_roadmap_art.py`.

**An epic's date and dependencies.** An epic has a due date (`epics.target_date`) and a list of
epics it waits on (`epics.depends_on`), set with `POST /api/roadmap/:projectId/epics` and
`PUT /api/roadmap/epics/:epicId` (`targetDate`, `dependsOn`; only the fields given change, `''`
clears the date). A dependency is an epic of the same project, never the epic itself, and can never
close a circle; removing an epic leaves nobody waiting on it. The chart derives, per epic:
`blockedBy` (what it waits on that is not delivered — while non-empty its `nextUp` is null),
`deliveredAt` (the day its last feature was delivered; an epic with no feature is not delivered),
`onTime` (delivered on or before its date — a commendation, which promotes the project's captain:
see DESIGN.md) and `late` (its date has passed and it is not delivered).

**Needs first — what must be done before a feature is done.** A feature's page has a **Needs first**
panel ("⛓ Add what must be done first"): it offers the project's other features, minus anything that
already depends on this one. An epic's Needs first applies to every feature inside it. A feature that
waits can be **started** but not **marked done**: Mark done is disabled and says what it waits on,
and the server refuses everywhere — the page, the API, a drag to Done on the Board — with
`Not yet: "Points per visit" and the epic "Online ordering" must be done first.` (409; `assertCanBeDone`
in `lib/roadmap.ts`). The feature list says "⛓ Waits on …", the Roadmap shows ⛓. Loops, the feature
itself and other projects' features are refused with a reason; deleting a feature clears it from
whatever waited on it; reopening a dependency later does not undo work already marked done.
`GET /api/roadmap/features/:featureId/needs` → `{ chosen, unmet, message, candidates }`.

## Archive a project

**Archive** on a project's page puts it away: it leaves the map, the project list and every picker (the
server leaves it out of `GET /api/projects`), and nothing of it is deleted — its features, changelog,
roadmap and cartridges stay as they were. It is refused while a feature of it is under way ("Not while 2
features are under way — finish or stop them first."). **Archived**, at the bottom of the project list,
lists them with **Restore**, which brings the project back and on screen. Its cartridges are still
cartridges: an agent working in one of its repos shows on open land, as any repo no project owns.
`PUT /api/projects/:id { archived: true | false }` · `GET /api/projects?archived=1` (`projects.archived_at`).

## Changelog

When a feature is **marked done**, NeonCore writes its changelog entry from the feature's own records:
its name, what it does (the scoped summary), how it measured up against its criteria, and what its
stages changed. The kind follows what it was scoped as — a bug fix is *Fixed*, a new feature *Added*, an
improvement *Changed*. Written once per feature; after that it is yours to edit. A feature **reopened**
(moved out of Done) takes its entry back out — unless you edited it or it already shipped in a release.

Add your own entries, edit or delete any, and **cut a release**: every unreleased entry is stamped
with the version and the date. CHANGELOG.md follows [Keep a Changelog](https://keepachangelog.com):
*Unreleased* first, then each release, grouped into Added / Changed / Fixed / Removed / Security.

**✦ Generate with AI** on the Changelog tab writes the history so far, for a repo that had a life
before NeonCore: a cartridge reads the git history (commits, tags, merges) and any CHANGELOG already in
the repo, and proposes entries grouped by release — a release the repo's own CHANGELOG covers is taken
as written, chores nobody outside the team would notice are left out, and entries already in the
project's changelog are not proposed again. You tick what to keep; kept entries keep their dates and
their release. (With several repos, releases are named after their repo: *harbour-ledger 0.3.0*.)

**The Captain's Log** heads the Changelog tab (`components/CaptainsLog.tsx`): the project's
captain in his rank's costume, writing (his `log` cycle), a "● Recording" light, the stardate
(`(year − 2000) × 1000 + the fraction of the year × 1000`, one decimal), "N entries · M missions
logged · K in flight" (missions = entries written from a delivered feature; in flight = features under
way), and "↓ Download CHANGELOG.md".

## Architecture

The Architecture tab shows **a page**: how the product is built, drawn — a diagram of the components and
how data flows between them, then the stack and where the tests are. **✦ Generate with AI** on this tab
asks for the architecture only. The cartridge writes the page as self-contained HTML (inline CSS and SVG);
it is shown in a sandboxed frame with no permissions, scripts and embeds are stripped on arrival, and
the page route serves it under a CSP sandbox — it is written by an agent, so it never runs as the
dashboard. **Download .html** saves it; publishing writes it as `docs/product/ARCHITECTURE.html`.

Beside the page, short **planner notes** (plain text, generated with it, editable): the **planner reads
them when it scopes every feature**, so its questions are grounded in the real system (clipped to 3,000
characters — the repo stays the authority).

## ✦ Generate with AI — a codebase new to NeonCore

A project started in NeonCore grows its documents feature by feature. A repo used with NeonCore for the
first time has none of them — or has a README, a docs/ folder and a CHANGELOG that nobody connected to a
feature list. **Generate with AI** asks a cartridge in the project's repos to write them. It reads the
**existing documents first** (README, docs/, CHANGELOG, release notes, ADRs, API specs, manifests) and
the code second — where a document and the code disagree, the code wins and it says so — changing
nothing. Any of four parts:

| Part | What comes back | Kept as |
|---|---|---|
| **Architecture** | a page (self-contained HTML: a diagram of components and data flow, stack, tests, real paths) plus short planner notes (editable before you keep them) | the Architecture tab's page, and the planner notes |
| **Existing features + specs** | what the product already does, named as a user would, grouped into at most 10 capability groups (each with a one-line summary) and their sub-areas, each with where it lives and **acceptance criteria for how it behaves today** ("When …, the system shall …" with real inputs and results; known gaps said as such) | features with status **Existing**: counted apart from the build list and the roadmap's progress, in the spec as *Documented as it behaves today*, and under *Already in the product* |
| **Changelog** | the history so far, from git and any existing CHANGELOG, grouped by release | changelog entries, with their dates and releases |
| **Backlog** | work the code points at: TODO/FIXME, half-built paths, documented-but-missing behaviour | planned features at the end of the list |

Where to ask:

- **Architecture tab** — the architecture page.
- **Spec tab** — existing features with their specs, and (tick it) the backlog the code points at.
- **Changelog tab** — the changelog from git.
- **Features tab**, on an empty project — links to all three.

The proposal comes back for **review, item by item** — nothing is added until you apply, and only what
is ticked (changelog entries and existing features start ticked, backlog items unticked). Things
already on the feature list or in the changelog are not proposed again, nor added twice. Each tab
shows the newest proposal for its part, so asking for the changelog does not hide a features proposal
still waiting for review. An existing feature you **reopen** becomes a planned feature on the list —
work to do again. After applying, **Publish it to
docs/product/ in the repo now** writes everything into the repo as Markdown (below) — or it happens by
itself if *Keep in sync* is on.

A request goes to the cartridge like any prompt (queued behind work it is doing) and is answered with
the MCP tool `neoncore_submit_project_import` (or the curl fallback in the request). Pick a cartridge
that is not in Manual mode — a Manual cartridge stops for your approval on every command, reading
included; the picker offers the others first. One request per project is outstanding at a time:
asking again (from any tab) replaces it, so a late answer cannot land on the newer request. If the
answer does not come back (the cartridge restarted or went offline), **Ask again**.

## Docs in the repo — docs/product/

**Publish now** writes the documents into the project's **main repo**:

| File | |
|---|---|
| `docs/product/README.md` | the spec index: every feature, its status, how it measures up, where intent and delivery differ |
| `docs/product/features/<slug>.md` | one feature: intent, criteria with evidence, delivery |
| `docs/product/ROADMAP.md`, `ROADMAP.html` | the roadmap, and the shareable page |
| `docs/product/CHANGELOG.md` | the changelog |
| `docs/product/ARCHITECTURE.md` | the planner notes |
| `docs/product/ARCHITECTURE.html` | the architecture page |

**Keep in sync** republishes by itself whenever the spec changes meaning — a plan accepted, a pipeline
finished, a feature marked done, the list or the changelog edited, a generated proposal applied — not on every
stage tick. Only files whose content changed are written, so it does not churn the working tree under an
agent busy in the repo. A feature renamed or removed leaves a one-line stub where its page was.

Nothing is committed: the files show up as changes to commit with the work (or to ignore). They say at
the top that they are generated — edit the project, not the files. Every stage of a feature's pipeline
is told the spec is there, so agents read the project's features and architecture from the repo.

Writing goes through the same path NeonCore uses to run acceptance tests: directly for a repo on the
server's machine, through that machine's runner for a repo elsewhere.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/projects/:id/spec` | The spec as JSON: every feature's intent, criteria with evidence, delivery, alignment, and totals |
| `GET /api/projects/:id/docs/:doc` | `spec`, `roadmap`, `changelog` or `architecture` as Markdown; `?format=html` for the roadmap or architecture page (the latter under a CSP sandbox); `?download=1` to save |
| `GET /api/projects/:id/architecture` | `{ html }` — the architecture page, for the tab |
| `POST /api/projects/:id/docs/publish` | Write docs/product/ into the main repo now |
| `PUT /api/projects/:id` | `architecture` (markdown), `docsAutoPublish` (keep in sync) — turning sync on publishes at once |
| `GET/POST /api/projects/:id/changelog` | List entries; add one `{ kind, title, body }` |
| `PUT/DELETE /api/projects/:id/changelog/:entryId` | Edit or delete an entry |
| `POST /api/projects/:id/changelog/release` | `{ version }` — ship every unreleased entry in it |
| `GET/POST /api/projects/:id/imports` | List Generate-with-AI requests; start one `{ agentId, parts? }` — `parts` any of `architecture`, `features`, `changelog`, `backlog` (default: all) |
| `GET /api/project-imports/:id` | One request and its proposal |
| `POST /api/project-imports/:id/submit` | Where the cartridge submits (MCP `neoncore_submit_project_import`) — stores a proposal only |
| `POST /api/project-imports/:id/apply` | `{ architecture, architectureHtml: true, features: [names], backlog: [names], changelog: [ids] }` — what the person kept |
| `PUT /api/goals/:id` | `roadmapLane`: `now` / `next` / `later`, or `''` for automatic; `area`: `'<group> · <sub-area>'` or `''` |

## Code map

| | |
|---|---|
| `server/src/lib/project-spec.ts` | builds the spec from the records; renders the spec, feature pages and roadmap |
| `server/src/lib/project-changelog.ts` | entries, the entry for a feature marked done, releases, CHANGELOG.md |
| `server/src/lib/project-docs.ts` | publishing docs/product/ and keeping it in sync |
| `server/src/lib/project-import.ts` | Generate with AI: the request (per part), its validation, applying what was kept |
| `dashboard/src/components/ProjectHub.tsx` | the Spec, Roadmap, Changelog and Architecture tabs, the docs bar, and the Generate-with-AI panel |
| `sandbox/sim/importer.mjs` | the sandbox's simulated reader: reads the demo repos, their tests and their git history |

## Retest a delivered feature, and fix what is still missing

A feature whose pipeline completed can be checked again from its acceptance contract (`Retest`,
`components/AcceptanceContractPanel.tsx`; server `retestAcceptance` / `addFixStage` in
`lib/acceptance-runner.ts`; `POST /api/goal-pilots/:id/acceptance/retest|fix`). It is for a feature
delivered with gaps — stopped early, stages skipped, or the missing part done since.

- **Retest** runs the locked tests now (hashes first, then every command) and records the result as
  evidence titled "Retest after delivery"; then it reopens the pipeline's review stage, so an
  independent cartridge judges the checklist criteria afresh and the person confirms each verdict,
  exactly as at the end of a pipeline. The feature report is rewritten from that evidence. Nothing
  is built and no workflow stage runs again. A locked test changed since approval stops the retest
  and is said; nothing is re-judged.
- **Create a fix workflow** is offered while criteria still do not pass. It adds ONE workflow stage
  in front of the review, staffed like the last stage that did the work (same workflow, repos and
  engines), whose brief is exactly the failing criteria — each with what it expects and the evidence
  against it. When it finishes, the locked tests run and the checklist is reviewed again.
