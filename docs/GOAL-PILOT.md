# The feature pipeline (Goal Pilot) — one feature as a managed pipeline of agents and workflows

> **Projects hold features.** A project names the work and the repos involved and lists the features
> to build ([GOALS.md](GOALS.md)); each **feature** is taken through this pipeline on its own. In
> the code a feature is a goal row filed under its project, so the pipeline is still called the
> *goal pilot* (`goal_pilots`, `/api/goal-pilots`, `neoncore_submit_goal_pilot`) and "goal" below
> means the feature.

A feature is where the work is **driven from**: you say what you want, a planner cartridge asks
whatever is still needed for the scope to be unambiguous, proposes the workflows that will deliver
it, and — once you accept and confirm which of the project's repos to use — runs them one after
another, handing each the scope and the results of the ones before it.

```
 1. Feature     2. Scope             3. Workflows           4. Repos             5. Run
 ───────────    ─────────────────    ───────────────────    ─────────────────    ─────────────────────────────────
 general        planner asks the     planner writes the     you pick repos +     0. tests written, you approve
 questions  →   open questions,   →  brief, the numbered →  engine per repo, →   → stage 1 → NeonCore checks
 (the form)     you answer/delegate  ACCEPTANCE CRITERIA    and where each       → stage 2 → checks → …
                — as many rounds     and the workflows;     stage runs           → independent checklist review
                as it needs          you edit + accept                           → feature report (criteria-based)
```

Open it from **Projects → (a project) → ▶ Start** on a feature of the list (the form is pre-filled
from the feature), or from the **Up next** card. The planner is told the project — its description,
its repos, and the project's **other features**, which it keeps out of this feature's scope.

---

## 1. The general questions

| Question | Why it is asked |
|---|---|
| What do you want to achieve? | Becomes the goal's name |
| What exists today, and what should change? | Background the planner reasons from |
| What kind of work is it? (feature, bug, improvement, performance, research, QA, docs) | Decides which questions get asked and which workflows fit |
| Who is it for? | Wording, defaults, what "easy" means |
| How will you know it is done? | Becomes "done when" and an acceptance criterion |
| What must not change, or is off-limits? | Becomes no-gos and invariants |
| Target date, budget | Scope the plan; the budget also stops the pipeline (see below) |
| How involved do you want to be while it runs? | Hands-on / Balanced / Hands-off — sets both the goal's autonomy line and each run's posture |

You also pick **which cartridge does the planning**. The registry of questions is
`INTAKE_QUESTIONS` in `server/src/lib/goal-pilot.ts`: the form, the validation and the planner
prompt are all driven from it.

### Files

The questions take **files** too — a mockup, a spec PDF, a CSV of examples — and so does the pipeline
panel at every step after (**Files** card: add or remove any time). They belong to the **feature**,
not to one prompt: the server keeps them (beside its database, `feature-files/<featureId>/`, at most 20
files and 50 MB per feature), and every cartridge the feature's pipeline talks to gets a copy in its
**own** repo, under `.neoncore/attachments/feature-<id>/` (gitignored), named in its prompt by an
absolute path:

- every request — scoping, planning, tests, review, the report — through the one delivery path
  (`deliverPlannerRequest`); files picked in the questions travel with the request that starts
  scoping, so the planner's very first prompt has them;
- every stage — in its launch context, for each participant's repo.

A file added later reaches the next request and every stage not yet started; one removed stops being
handed out (and leaves the repos' copies). Deleting the feature deletes its files. As with prompt
attachments, the copy is made on the server's machine: a cartridge on another machine is named a path
that exists only there.

## 2. Scoping — until nothing is left for an agent to ask

The planner receives your answers and either **asks questions** or, when nothing that would
change what gets built is still open, **writes the scope brief**. Each question says why it
matters and usually carries a suggested answer. For each one you can answer it, take the
suggestion, or **let the agents decide** (the suggestion is used and recorded as an
*assumption*). Required questions must be answered or delegated before the answers are sent.

There can be several rounds — a vague answer ("not sure") earns one sharper follow-up, and an
answer can open new questions ("recurring expenses: yes" → "how often?"). A question already
answered can never be asked again (validation drops it), and after **4 rounds** the planner must
submit the brief, listing anything still open under assumptions.

## 3. The brief, the criteria and the workflows

The brief has: slug, summary, done-when, in scope, invariants, out of scope, rabbit holes,
assumptions — and the **acceptance criteria**, numbered AC-1…n, each with:

- **text** — one observable behaviour: "When <situation>, the system shall <result>";
- **expected** — *exactly* what is expected, inputs → result, with real values
  ("12.50 + 7.25 in March → March total 19.75");
- **how it is checked** — an automated **test**, or a **checklist** item for what only judgement can
  decide (research conclusions, docs quality, "done" in your own words). Code work (feature, bug,
  improvement, performance) defaults to tests; research, QA and docs default to checklist.

They become the **acceptance contract** (below) the moment you accept the plan. The planner then proposes an ordered list of workflows
from the templates that exist — each with why it is there and the **focus** it will be given —
plus alternatives it considered.

You review all of it: edit any brief field, edit/add/remove/reorder criteria and switch how each is
checked (a criterion checked by a test **must** say exactly what it expects — accept refuses it
otherwise), rename/reorder/untick stages, rewrite a stage's focus, add any other workflow.
**Accept plan** freezes the criteria and is the only step that writes to the goal: the brief's summary,
done-when, acceptance criteria, invariants, no-gos and rabbit holes are written onto the goal
(an empty field leaves the goal's own value alone). From then on they reach **every** prompt
dispatched under the goal through the goal brief. Nothing runs yet.

## 4. Repos

The project's repos are pre-selected (the planner's repo first, so it is where stages run by
default). Untick any the feature does not touch, pick the engine in each (Claude Code or
Codex), and — with more than one repo — which stage runs where. The contract's own stages are
placed like any other: the acceptance tests live (and run) in the repo of stage 0. Every stage's run
is attached to the feature's project and tagged with the feature (`workflows.goal_id`); a repo
picked here that the project did not list yet is added to the project. (An old-style goal with no
project still gets a project per repo created under it, as before.)

**Workflows worked by several cartridges together** (a Confer stage — a template whose confer step
leaves its participants to the launch) are staffed with two or more of the chosen repos; by default
every chosen repo. The stage starts once every participant's cartridge is running and free.

**One job per stage, each job once.** A build stage builds and a QA stage (Super QA) tests and
reviews; the planner is told not to plan two stages for the same job. Each stage's context says
which job is its own ("this stage builds" / "this stage reviews"), and a Confer stage that has a
QA, review or audit stage after it runs **without its Cross-review step** — the later stage reads
the diff, once (`stage-steps.ts laterStageReviews`). See WORKFLOWS.md → Confer for the rest of how a
Confer stage is kept short (one build for a feature, rounds only for an epic, leftover tasks straight to their owner, no
waiting on a silent cartridge).

A stage names a **repo + engine, not a cartridge id**: cartridge ids change every time a
cartridge restarts, and a pipeline outlives many restarts. The live cartridge is resolved when
each stage starts.

## 5. Run

With test criteria, **stage 0 — Write the acceptance tests** runs first (see the contract below);
no workflow starts until you have approved and locked the tests. Then each workflow stage runs as a
normal workflow run (the same clone path scheduled
runs use). When a run completes, the next stage starts immediately; a 10-second sweep is the
backstop. Each run opens with a launch context built for it:

- the feature slug (for `docs/<slug>/…` paths), the summary, what is in scope, the assumptions;
- every decision made while scoping, question → answer;
- this stage's focus;
- what each earlier stage produced (its completion report, or its last result);
- what the next stage will need.

The rest of the brief (acceptance criteria, invariants, no-gos, rabbit holes) reaches every step
through the goal brief — and it is **this** feature's brief even though the project has other
features, because a step dispatched for a run uses the run's own feature tag (`workflows.goal_id`,
then the legacy project → goal link; `goalId` option of `sendCommandToAgent`).

| A stage… | The pipeline… |
|---|---|
| has no live cartridge of its engine in its repo | **waits** (says so), and starts by itself when one connects |
| has a busy cartridge | **waits** until it is free — never starts on top of running work |
| would start with the feature's budget spent | **pauses**: raise the budget, then Resume |
| is waiting on you (decision, review gate, held step) | shows **needs you** with the step; **Open run** opens it in place |
| completes | **NeonCore checks it** against the locked tests (below), then starts the next stage |
| changed a locked acceptance test | **stops**: restore the approved version, or accept the change with a reason |
| fails or is cancelled | **pauses**; **Retry** runs it again (new run), **Skip** moves on |

**You are notified** (desktop, phone, Discord and the dashboard bell) whenever the pilot needs you:
questions arrived, a plan is ready to review, the planner did not answer, the pipeline stopped, a
stage is waiting for a cartridge that is not running — and once when everything has finished. A
stage waiting on a decision or a held step is announced by the same attention notices every run
gets; a held step can be released with **Advance** right in the pipeline, and under Balanced or
Hands-off it is released at once by the run's posture.

## Features side by side — a branch, a worktree and a cartridge per repo

**Which repos.** The questions that start a feature list the project's repos, all ticked: untick the
ones this feature does not touch. The planner is told only those ("Repos for THIS feature", the rest
"not part of this feature, leave them alone"), and staffing starts from the same choice.

**Its own branch** (staffing → *Work on its own branch*, unticked by default — a feature works in the repos' own checkouts unless you tick it). When the pipeline starts,
every chosen repo gets:

| | |
|---|---|
| a branch | `feature/<slug>`, started from the repo's default branch (origin's HEAD, else `main`/`master`); a slug another feature already uses gets a suffix |
| a worktree | `../<repo>-feature-<slug>`, on that branch |
| a cartridge | launched in the worktree (the same launcher as New Repo). Every stage, the acceptance tests and the review of this feature run there — so a second feature on the same repos runs at the same time, in its own worktrees, with its own cartridges |

Each stage is told its branch: commit there, do not switch branches, do not merge, do not open a PR.
The project keeps listing the real repos; feature worktrees are never offered as repos to build in.

**PRs.** When the pipeline finishes, NeonCore pushes the branch and opens a PR into the base in every
repo that has commits on it (with `gh`); each PR names its sibling PRs in the other repos. A repo with
nothing on the branch is named, not given an empty PR; uncommitted changes left in a worktree are
reported, never committed for the agent. **It never merges** — you do. *Open PRs now* on the pipeline
does it early (or again).

**After merging.** *Clean up merged* ends each merged repo's worktree cartridge (`/exit`) and removes
its worktree; an unmerged one is left alone.

**Conflicts.** The second feature to merge can conflict with the first: run the **Resolve PR
Conflicts** workflow on its branch — base in → resolve keeping both sides → re-test → push and comment
on the PR (never force-pushes, never merges).

Through the API, isolation is opt-in: `POST /api/goal-pilots/:id/start` with `isolate: true`.

## The acceptance contract

A report built from what agents *say* ("tests pass") is only as honest as the least careful agent,
and an agent that writes the code also writes the test — so the bar quietly moves to wherever the
code landed. The contract takes both out of the agents' hands:

```
 accept plan          stage 0                          you                     every stage            end
 ───────────          ──────────────────────           ──────────────────      ──────────────────     ─────────────────
 criteria     →       an agent writes ONE         →    review criterion ↔  →   NeonCore re-hashes →   an independent
 numbered &           FAILING test per test-           test ↔ contents,        the locked files,      cartridge judges the
 frozen               criterion (no product code)      run them (red),         then runs every        checklist items; you
                      NeonCore reads + hashes it        approve = LOCK          criterion's command    confirm each verdict
```

1. **Stage 0 — write the tests.** A `tests` request goes to a cartridge in the tests' repo:
   one test per test-criterion encoding its expected result exactly, each with its own one-line
   command, failing now, no product code touched. NeonCore reads every file the submission names
   (a missing file is refused with the list), stores the contents and their sha256.
2. **You review** criterion ↔ test ↔ command ↔ file contents. **Run them now** runs every command
   (NeonCore runs them itself — they should all be red). **Ask for changes** sends your words back to
   the test writer. **Approve & lock** runs them if they have not been run against this version and
   locks as soon as they are all red; a test that already passes before any work blocks the lock
   ("it proves nothing about this work") unless you **approve anyway**. Workflow stages wait.
3. **After every workflow stage** NeonCore re-hashes every locked file, then runs each criterion's
   command, and records "x/n criteria passing" on the stage. A changed or deleted locked file
   **stops the pipeline** until *you* decide: **Restore the approved version** (NeonCore writes the
   locked contents back and checks again) or **Accept the change** with a reason (it becomes the
   locked version, v+1; a deleted test cannot be accepted — unlock its criterion instead).
4. **Only a person unlocks a test**: **Unlock…** on a criterion, with a reason and optionally new
   wording or a new expected result. The test writer rewrites that one test; you approve it again
   (v+1). Stages that have not started wait for the new lock; a stage that finishes meanwhile is
   checked once it is locked. No agent-facing tool can approve, unlock, restore or accept a change.
5. **Checklist items** are judged after the last stage by an **independent** cartridge — one that did
   not do the work (a different engine first, then a cartridge that ran no stage; in the tests' repo
   first). It is told which repo the criteria and locked tests live in, since in a multi-repo project
   the independent reviewer usually sits in another repo. It submits a verdict and the evidence per item; you confirm or overrule each (overruling needs a note). If only an author is available it is used, and the report says the review was not
   independent.
6. **Every prompt** dispatched for the goal carries the locked contract (`[NeonCore acceptance
   contract vN — LOCKED by the person]`: each test's command and files, "do not edit these") in full
   once per session and as a one-line reference after that.

**Skipping stage 0** runs the pipeline without tests: the test criteria stay *not checked* and the
report says so. **Where commands run:** in a repo on the server's machine, directly; in a repo on
another machine, through that machine's **runner** (`agent/runner/repo-ops.js`, over its socket;
only its exposed repos, paths inside the repo only). Output is kept to its tail, a command that
outruns `NEONCORE_ACCEPTANCE_TIMEOUT_MS` (default 5 min) is killed, and `NEONCORE_*` variables
(tokens) are not passed to it. Nothing an agent submits is executed before a person has seen it:
commands run when you click *Run them now* / *Approve & lock*, and after that only locked ones.

### The feature report (goal report)

When the last stage finishes, NeonCore builds the **goal report** — one document for the whole goal:
status — with a contract, **SUCCESS only when every criterion passes on NeonCore's own evidence**
(its run of the locked test, or the independent verdict you confirmed); PARTIAL when some do,
FAILED when none do, INCOMPLETE when nothing was judged — the **acceptance criteria** one by one
(expected result, command, exit code and output, the red baseline before any work, or the reviewer's
verdict and your confirmation), whether the locked tests stayed unchanged, every amendment;
workflows, steps, tests and issues reported, spend and duration; a **summary** with what was done and the follow-ups; every **stage** with its run's own
completion report (what changed, issues); the **scope** that was agreed; every **decision** made while
scoping; the **learnings** captured; and the **open items** — every criterion that is not met (and
why), assumptions to confirm, `[HUMAN]` next steps and unresolved issues from the run reports,
stages that did not complete.

It is compiled from the records the moment the pipeline ends (it never waits on a model), then the
planner cartridge is asked for the narrative summary on top; until it answers — or if it never does —
a summary compiled from the run reports stands in, and the card says which. It shows on the goal
(**Open report**, **Download .md**) and is saved as `goal-report.html/.md/.json` under
`reports/goals/<goalId>/<pilotId>/` next to the database. A pipeline cancelled part-way can still get
one (**Build report**). You are notified when it is ready.

Each stage's run keeps its own completion report too (its last step); the goal report is built from
those, so a run that filed one contributes what it changed and what is open.

**Pause** pauses the current run too; **Resume** resumes it. **Cancel pilot** cancels the current
run. When every stage is done the pilot is *completed* and offers **Mark goal achieved**. Deleting
the goal cancels its pipeline.

---

## The planner is a cartridge

NeonCore has no LLM client, deliberately — generated text is produced where every other prompt is,
by a cartridge, so its cost lands in `session_usage` and counts toward the goal. Each planner step
is a **request** dispatched to the planner cartridge:

```
[NeonCore goal pilot · scope request <id>]   (also · pipeline · report · tests · review)
… the goal, your answers, the decisions so far, the rules …
SUBMIT with the MCP tool `neoncore_submit_goal_pilot`, requestId "<id>", result = …
Fallback ONLY if that tool is unavailable: curl -s -X POST ".../api/goal-pilots/requests/<id>/submit" …
PILOT-DATA (the same information as above, machine-readable):
```json
{ … }
```
```

The submission is validated (`normalizeScopeResult` / `normalizePipelineResult`) and stored as a
proposal; anything validation drops or changes is recorded and shown ("Adjusted on arrival").
A rejected submission is answered with the reason so the planner can submit again.

- **Busy planner** — the request is queued as its own queue kind, `goal-pilot`: it waits behind the
  cartridge's running work, is delivered without the work standard (planning edits nothing), and
  the lane moves on when the planner **submits** — not on a NEONCORE-DONE report.
- **Unreachable planner** — the request fails at once and the panel offers **Ask again**, with any
  other cartridge.
- **Silent planner** — if the planner goes idle for 3 minutes after receiving the request without
  submitting, the request is marked failed so the pilot does not say "thinking…" forever.
- **What was it asked?** — the panel shows the exact prompt of the current request.
- The same machinery carries the contract's requests: **tests** (to the test writer — the submission
  names the files it wrote) and **review** (to the checklist reviewer — a verdict + evidence per item).
  A test writer or reviewer that goes quiet fails its stage the same way.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/goal-pilots/meta` | The registries: intake questions, involvement levels, brief fields, engines, limits, templates |
| `GET /api/goal-pilots?goalId=` | Pilots (with stages, current request, live run progress and attention) |
| `GET /api/goal-pilots/candidates?goalId=` | Repos a pipeline can run in, with the engines seen there |
| `POST /api/goal-pilots` | `{ intake, plannerAgentId, goalId?, replace?, files?, repos? }` — start; creates the goal when `goalId` is absent; `files` are kept with the feature before the first scoping request |
| `POST /api/goal-pilots/:id/answers` | `{ answers: { [questionId]: { value, delegated? } } }` |
| `POST /api/goal-pilots/:id/retry` | `{ agentId? }` — ask the planner again (optionally another one) |
| `POST /api/goal-pilots/:id/accept-plan` | `{ brief, stages, criteria }` — the only write from planner output to the goal; freezes the criteria |
| `POST /api/goal-pilots/:id/revise` | back from staffing to the plan |
| `POST /api/goal-pilots/:id/start` | `{ repos: [{ repoPath, agentType }], assignments: { [stageKey]: repoPath }, isolate? }` — `isolate: true` = its own branch, a worktree + cartridge per repo |
| `POST /api/goal-pilots/:id/pause` · `/resume` · `/cancel` | steer the pipeline (and its current run) |
| `POST /api/goal-pilots/:id/stages/:stageId/retry` · `/skip` | recover a stage |
| `GET /api/goal-pilots/requests/:requestId` | a planner request, including the prompt it was sent |
| `POST /api/goal-pilots/requests/:requestId/submit` | `{ result }` — where the planner answers (MCP tool / curl) |
| `POST /api/goal-pilots/:id/acceptance/run` | run the tests under review now (202; results by socket) |
| `POST /api/goal-pilots/:id/acceptance/approve` | `{ confirmPassing? }` — approve & lock (after a red baseline) |
| `POST /api/goal-pilots/:id/acceptance/changes` | `{ feedback }` — back to the test writer |
| `POST /api/goal-pilots/:id/acceptance/request` | ask the test writer again after its request failed |
| `POST /api/goal-pilots/:id/acceptance/criteria/:cid/unlock` | `{ reason, text?, expect? }` — an amendment |
| `POST /api/goal-pilots/:id/acceptance/restore` · `/accept-change` | a locked test changed: put it back, or `{ reason }` accept it |
| `POST /api/goal-pilots/:id/acceptance/checklist` | `{ confirmations: { [cid]: { accepted, note? } } }` |
| `POST /api/goal-pilots/:id/stages/:stageId/verify` | check a stage's work again after the check could not run |
| `GET /api/goal-pilots/:id/report` · `/report/html` · `/report/markdown` | the goal report, as JSON, a page, or a download |
| `POST /api/goal-pilots/:id/report` | build (or rebuild) the report now — e.g. for a pipeline cancelled part-way |
| `DELETE /api/goal-pilots/:id` | delete the record (a live pipeline is cancelled first) |
| `GET/POST /api/goals/:id/files` | The feature's files; add `{ files: [{ name, mimeType, size, dataBase64 }] }` |
| `GET/DELETE /api/goals/:id/files/:fileId` | Download / remove one |
| `POST /api/goal-pilots/:id/workspace/prs` | Push the feature's branches and open its PRs now |
| `POST /api/goal-pilots/:id/workspace/cleanup` | `{ force? }` — end the worktree cartridges and remove the worktrees whose PRs merged |

Socket event: `goal_pilot_updated { id }` whenever a pilot changes.

## Code map

| File | What it owns |
|---|---|
| `server/src/lib/goal-pilot.ts` | registries, validation of planner output, records, person/planner transitions |
| `server/src/lib/goal-pilot-prompts.ts` | the scope and pipeline prompts (+ PILOT-DATA) |
| `server/src/lib/goal-pilot-runner.ts` | dispatching planner requests, starting the pipeline, advancing stages, steering |
| `server/src/lib/goal-pilot-report.ts` | the goal report: compile, render (HTML/Markdown), save |
| `server/src/lib/acceptance-contract.ts` | criteria, the contract record, submission rules, tamper detection, the verdict, the prompt block |
| `server/src/lib/acceptance-runner.ts` | tests/review requests, baseline, lock, the check after each stage, restore/accept/unlock, checklist |
| `server/src/lib/repo-access.ts` | NeonCore reading, writing and running in a repo — locally or through a machine's runner |
| `agent/runner/repo-ops.js` | the runner's side of repo access (`repo_op` over its socket) |
| `server/src/lib/run-events.ts` | "a run finished" — how the next stage starts immediately |
| `server/src/lib/queue-kinds.ts` | the `goal-pilot` queue kind |
| `server/src/routes/goal-pilots.ts` | the HTTP API |
| `server/src/mcp-server.ts` | `neoncore_submit_goal_pilot` |
| `dashboard/src/components/GoalPilotPanel.tsx` | the guided form and the five steps |
| `dashboard/src/components/AcceptanceContractPanel.tsx` | the criteria editor and the contract card (review, lock, tamper, unlock, checklist) |
| `dashboard/src/lib/goalPilot.ts` | the panel's pure logic |

Tests: `server/test/goal-pilot.test.ts`, `server/test/acceptance-contract.test.ts` (every contract
state through the routes with real files and real commands; tampering; the runner path),
`dashboard/src/lib/__tests__/goalPilot.test.ts`, and
`dashboard/src/components/__tests__/GoalPilotPanel.test.tsx`.
