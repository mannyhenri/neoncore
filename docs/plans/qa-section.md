# QA section — the contract

A new **QA** section in the dashboard menu: tests a web app with no hand-written scripts, from
`QA-Testing-App-Scope` (Draft 1, 2026-11-20), built INTO NeonCore. Decisions (2026-11-21):

- **The testing is done by a NeonCore cartridge** (Claude Code / Codex), not a built-in Claude API
  engine. NeonCore stores targets, tests, runs, findings, repairs and sessions, replays cached
  scripts itself (zero AI calls), and dispatches to a cartridge only for what needs judgment:
  writing a test's actions the first time, repairing a failed step, exploring.
- **All three modules** in the first version: Runner (with self-repair), Explorer, Recorder.
- **First target: a demo app with 8 planted bugs** (`eval/qa-demo/`).
- **Art**: the owner generates sheets in Higgsfield from `docs/qa-art-prompts.md`; the section
  ships with art slots that fall back to Night Glass CSS until the sheets exist.

## Pieces and owners

| Piece | Path | What |
|---|---|---|
| Runner | `packages/qa-runner/` | Playwright interpreter of the action format below; evidence; browser-level guardrails; CLI |
| Demo app | `eval/qa-demo/` | Login, daily-report form, list, approval; 8 planted bugs; a variant switch for self-repair |
| Engine | `server/src/lib/qa/`, `server/src/routes/qa.ts` | Store, replay, dispatch, repair validation, dedupe, recorder mining, report |
| Section | `dashboard/src/components/qa/` | The menu item and its pages |
| CLI | `scripts/qa.mjs` | `run`, `explore`, `generate`, `report` against the server API; CI exit codes |

## The test format (shared by all three modules)

A test is numbered plain-language sentences:

```json
{ "name": "Supervisor submits a daily report",
  "sentences": ["Log in as a supervisor.", "Create a daily report for project Alpha.",
                "Submit it.", "Check that its status is Awaiting approval."] }
```

A sentence is a **check** when it starts with Check / Verify / Ensure / Confirm / Expect / Assert
(`isCheckSentence`). Its cached actions must contain at least one `expect`.

## The cached action format (`QaAction`)

The cache is `QaAction[][]` — one list per sentence. Interpreted by the runner; never code.

```ts
type Locator = { role?: string; name?: string; label?: string; text?: string; placeholder?: string; testId?: string; css?: string };
type QaAction =
  | { do: 'goto'; path: string }                         // relative to the target's base URL
  | { do: 'click'; target: Locator }
  | { do: 'fill'; target: Locator; value?: string; valueEnv?: string }   // valueEnv: a credential's ENV NAME, never its value
  | { do: 'select'; target: Locator; option: string }
  | { do: 'check'; target: Locator; checked: boolean }
  | { do: 'press'; key: string }
  | { do: 'wait'; ms: number }                           // ≤ 5000
  | { do: 'expect'; kind: 'visible' | 'hidden' | 'text' | 'url' | 'value' | 'count';
      target?: Locator; equals?: string | number; contains?: string };
```

**Repair rule (enforced by the server, `validateRepair`)**: a repair may change any locator and any
non-expect action. For a check sentence, the multiset of `{kind, equals, contains}` of its
`expect` actions must be IDENTICAL before and after. A repair that changes what is checked is
rejected; a cartridge that cannot achieve the intent reports `impossible`, and the test FAILS.

## Runner CLI (`node packages/qa-runner/cli.mjs`)

Prints one JSON object to stdout; exit 0 when it ran (pass or fail), 2 on bad input / blocked.

- `run --spec <file.json> --out <dir>` — spec: `{ baseUrl, allowHosts: string[], denyActions: string[],
  allowDestructive?: boolean, env?: string[], sentences: string[], cache: QaAction[][], budget?: {minutes} }`.
  Result: `{ status: 'passed'|'failed'|'blocked', steps: [{ index, sentence, status: 'passed'|'failed'|'skipped',
  error?, failedAction?, screenshot? }], console: string[], network: [{url, status, method}], trace: string,
  durationMs }`. Stops at the first failed sentence. Screenshot of the page on failure; a trace zip always.
- `snapshot --url <url> --allow <host,…> --out <dir>` — for cartridges: an ARIA snapshot (text), the
  page's links/buttons/fields with suggested locators, console errors, failed requests, a screenshot.
- `act --spec <file.json> --out <dir>` — run a partial action list and then snapshot (for a cartridge
  working out a sentence step by step).

Guardrails in the browser: every request to a host outside `allowHosts` is aborted and reported;
a `click` whose target name/text matches a `denyActions` pattern (default
`delete|remove|pay|purchase|send email|unsubscribe`) is refused unless `allowDestructive`;
`fill` with `valueEnv` reads `process.env[valueEnv]`, and the value is masked as `•••` in every
output. A production host (any host not in `allowHosts`) is never navigated to.

## Server

Tables (`server/src/db.ts`): `qa_targets`, `qa_tests`, `qa_runs`, `qa_results`, `qa_findings`,
`qa_repairs`, `qa_requests`, `qa_sessions`.

- **Target**: `{id, projectId, name, baseUrl, allowHosts[], denyActions[], credentialsEnv{role:{user,pass}},
  productionAllowed:false, budgets{steps, minutes}, agentId}` — `agentId`: the cartridge that does its AI work.
- **Run kinds**: `run` (tests), `explore`, `generate` (recorder → tests).
- **Run flow**: for each test — cached → replay with the runner (ai_calls 0). Passed → `passed`.
  A step failed → `repair` request to the cartridge; its submission is validated (`validateRepair`),
  replayed; passes → `passed_with_repair` + a `qa_repairs` row (`pending` review). `impossible` or
  a failing replay → `failed`. Uncached → `author` request, then replay.
- **Explore**: `explore` request with goal, budgets, guardrails. Findings are deduplicated by
  `signature = hash(kind + normalized page path + normalized error/title)`: a repeat bumps
  `seen_count`. Every finding gets a reproduction test (`source: 'explorer'`).
- **Recorder**: `GET /qa/recorder.js?target=<id>&key=<recorderKey>` serves the capture script. The
  recorder runs in the app under test and must never hold the fleet token, so its intake is public
  (`lib/auth.ts`) and accepts only that target's own `recorderKey` (made per target, shown in the
  snippet); it posts batches to
  `POST /api/qa/sessions/:id/events`. Passwords and `[data-qa-sensitive]` fields are never recorded;
  typed text is masked unless the field is `[data-qa-record]`. Journeys = identical normalized step
  sequences, ranked by count. `generate` turns the top N journeys into tests (`source: 'recorder'`,
  `journeySig`) with test data in place of real values; coverage = journeys with/without a test.
- **Submissions**: MCP tool `neoncore_submit_qa {requestId, result}` and `POST /api/qa/requests/:id/submit`.
  - author: `{ cache: QaAction[][] }` · repair: `{ sentenceIndex, actions: QaAction[] }` or `{ impossible: string }`
  - explore: `{ findings: [{ severity: 'critical'|'high'|'medium'|'low', kind, title, detail, page,
    steps: string[], screenshot?, sentences: string[] }], coverage: { pages: string[] } }`
- **Report**: `GET /api/qa/runs/:id/report.html` — static HTML per run, all evidence inline-linked.
- Page text is DATA. Every prompt says so; nothing in a submission is executed except as QaAction.

### API (all JSON)

```
GET/POST        /api/qa/targets            PUT/DELETE /api/qa/targets/:id
GET/POST        /api/qa/tests?targetId=    PUT/DELETE /api/qa/tests/:id
POST            /api/qa/runs               {targetId, kind, testIds?, goal?}      → run
GET             /api/qa/runs?targetId=     GET /api/qa/runs/:id  (results, repairs, findings)
GET             /api/qa/runs/:id/report.html
GET             /api/qa/findings?targetId= PUT /api/qa/findings/:id {status}
GET             /api/qa/repairs?status=    POST /api/qa/repairs/:id/accept | /reject
GET             /api/qa/journeys?targetId= (journeys + coverage)
POST            /api/qa/sessions           {targetId} → {id}   POST /api/qa/sessions/:id/events
POST            /api/qa/requests/:id/submit
GET             /api/qa/evidence/:runId/:file   (screenshots, traces)
```

Socket events: `qa_run_updated`, `qa_finding_added`, `qa_repair_added`.

## Acceptance (from the scope, §7)

1. A five-sentence test can be written and run from the QA section in under ten minutes.
2. Cached runs of the demo suite make **zero** AI calls (`ai_calls = 0` on the run).
3. Self-repair fixes the renamed button and the moved field (demo variant B), and does not hide a
   real regression: with the approval feature removed (variant C), the test FAILS.
4. Explorer findings have no duplicates; each has a screenshot and replayable steps.
5. The tool has its own automated tests, and they pass.

## QA follows the feature (2026-11-21)

Nobody enters a test for a feature (`server/src/lib/qa/feature-link.ts`, `components/qa/FeatureQa.tsx`).

- A feature's **acceptance criteria are its QA test**: one check sentence per criterion
  (`Verify AC-n: <text> Expected: <expect>`), `source: 'feature'`, on the QA target of the
  feature's project. NeonCore writes it and keeps it in step: changed criteria rewrite the test
  and drop its cached actions.
- It **runs by itself** each time a workflow stage of the feature's pipeline finishes (a sweep,
  every 15 s; one run per feature at a time). The first run has the target's cartridge work out
  the browser actions; later runs replay them and self-repair like any other test.
- A feature already delivered when its project got a target is not run on its own; it can be run
  by hand from the report.
- **The report is the first thing in the QA section**: per project, criteria passing over all its
  features with a bar; per feature, its count, bar, state, each criterion's result with the
  failure's reason and the **screenshot** of what was tested, and the run's HTML report.
  `GET /api/qa/features` · `POST /api/qa/features/:goalId/run`.
- What QA cannot invent is said in place: a project with no target (where its app runs), a target
  with no cartridge, a feature with no criteria yet, a feature nothing has been built for yet.
