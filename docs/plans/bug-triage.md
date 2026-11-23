# Bug Triage — the contract

A new **Triage** section in the dashboard menu that works every new Jira bug the way a careful
developer would: checks it, reproduces it, fixes it, opens a PR for review, and keeps the reporter
informed. From `Bug-Triage-Auto-Fix-Scope` (Draft 1, 2026-11-20), built INTO NeonCore.

**Principle: the agent proposes, people approve. It never merges or deploys.**

## Decisions (2026-11-21)

- **The AI work is done by NeonCore cartridges** (as in the QA section), not the Claude API / Agent
  SDK: triage and code work are requests dispatched to a cartridge, answered with
  `neoncore_submit_triage`. Cheap triage happens before any code work (the scope's cost rule).
- **The sandbox is a git worktree + its own cartridge per issue** (`lib/feature-workspace.ts`'s
  machinery: branch `bug/<JIRA-KEY>`), not a Docker container. Honest limit: a worktree does not
  restrict the network; the prompts forbid production access and the code-agent cartridge is
  launched with no production credentials in its environment. Docker is a later option.
- **Jira reaches a local NeonCore by POLLING** (JQL every `pollSeconds`, default 60) — Jira Cloud
  cannot post to localhost. The webhook receiver exists too (HMAC-verified) for a public deployment.
- **Defaults for the scope's open questions (§12)**, all editable per source: reporters `internal`
  (`external` holds the "solution found" message until a person approves the PR); the agent only
  **comments and labels** (`transitions: false`); protected paths: auth, payments, migrations, CI
  config; GitHub via `gh`; size limit 5 files / 200 lines.
- **First target: a demo repo with 6 planted bugs and a Jira simulator** (`eval/triage-demo/`)
  seeded with the scope's 10 issues — 6 real bugs, 1 duplicate, 1 vague, 1 feature request,
  1 works-as-designed — plus 1 ticket with hidden instructions (the injection test).

## Pieces and owners

| Piece | Path | What |
|---|---|---|
| Jira client | `server/src/lib/triage/jira.ts` | Jira Cloud REST v3: search (JQL), get issue, comments, labels, transitions, remote links |
| Simulator + demo | `eval/triage-demo/` | A local Jira-compatible REST server (the same endpoints), a demo repo with 6 bugs and a test suite, the 10+1 seeded issues |
| Engine | `server/src/lib/triage/`, `server/src/routes/triage.ts` | State machine, intake (poll + webhook), dispatch, guardrails, messenger, follow-up, audit |
| Section | `dashboard/src/components/triage/` | The menu item and its pages |

## The state machine (one per issue, survives restarts, one run at a time)

```
intake → triage → code_check → reproduce → fix → pull_request → follow_up → done
```

Every stage ends in one **outcome**. The issue stops at the first stage it cannot complete with
confidence and is **handed over** (`handed_over`) with everything learned.

| Stage | Who | Outcomes |
|---|---|---|
| intake | server | `queued` |
| triage | cartridge (triage request, no code changes) | `needs_info` (waits for the reporter's reply) · `duplicate` · `not_a_bug` (question / feature) · `continue` |
| code_check | cartridge (code request, read-only) | `plausible` · `works_as_designed` · `already_fixed` |
| reproduce | cartridge in the issue's worktree | `reproduced` (a failing test, failing ≥ 2× in a row, verified by the SERVER running it) · `not_reproduced` |
| fix | cartridge in the worktree | `fix_ready` (server re-runs: repro test green, full suite green, guardrails pass) · `too_complex` |
| pull_request | server (`gh pr create`, linked to Jira, reviewers = CODEOWNERS) | `awaiting_review` |
| follow_up | server (watches the PR) | `merged` · `changes_requested` (back to fix, ≤ `reviewRounds`) · `released` |

Never auto-close: `duplicate`, `not_a_bug` and `works_as_designed` **label** the issue and leave it
for a person to confirm (`ai-duplicate`, `ai-not-a-bug`, `ai-works-as-designed`); reopen is a click.

**Issue states** (`triage_issues.state`): `queued | working | waiting_reporter | waiting_review |
handed_over | labelled | fixed | released | paused | error`.

## Guardrails (enforced by the server, not just asked for in prompts)

1. **No auto-merge** — nothing in NeonCore can merge; the PR is opened, never merged.
2. **Ticket text is DATA** — every prompt wraps the report in a fenced block marked untrusted;
   the submission schema allows only the stage's fields. A ticket cannot widen what a stage may do.
3. **Protected paths** — a fix whose diff touches a protected glob is refused → `handed_over`.
4. **Size limits** — a fix over `maxFiles` / `maxLines` changed is refused → `handed_over`.
5. **Test integrity** — a fix whose diff deletes a test file, removes a test case, adds
   `.skip`/`.only`/`xit`/`@skip`/`pytest.mark.skip`, or weakens an assertion in an EXISTING test is
   refused. Checked on the diff against the base (`checkTestIntegrity`).
6. **Budgets** — per-issue minutes and dispatches, a daily dispatch cap, and ONE pause switch
   (`triage_settings.paused`) that stops all dispatch at once.
7. **Honesty** — "fixed" is only ever said after the server's own green run; "released" only after
   the merge is in a release (tag) or the operator marks it.

## Reporter messages (`messenger.ts`) — one comment per stage change, mentions the reporter

Templates, short, no jargon, never a release date:
`received` · `needs_info` (the agent's specific questions) · `duplicate` (links the issue + its status) ·
`not_a_bug` (intended behaviour + how to get what they wanted; a person can reopen) ·
`not_reproduced` (what was tried; a developer will look) · `solution_found` (cause in 1–2 plain
sentences; fix awaiting review — for `external` reporters held until the PR is approved) ·
`released` (live; please verify). Labels: `ai-triaged`, `ai-reproduced`, `ai-fix-proposed`, plus the
outcome labels above.

## Server

Tables: `triage_sources` (a Jira site + projects + repo mapping + options), `triage_issues`,
`triage_events` (the audit log: every step, decision, dispatch, cost, message), `triage_requests`
(cartridge requests, same silence rule as Goal Pilot), `triage_settings` (pause, daily cap).

- **Source**: `{id, name, jiraBaseUrl, authEnv:{email, token}` (ENV NAMES only)`, projects[], issueTypes:['Bug'],
  repoFor:{projectKey: repoPath}, reporters:'internal'|'external', transitions:false, protectedPaths[],
  limits:{maxFiles, maxLines, minutesPerIssue, dispatchesPerIssue, reviewRounds}, pollSeconds,
  webhookSecretEnv, triageAgentId, codeAgentType}`.
- **Submissions** (`neoncore_submit_triage {requestId, result}`, `POST /api/triage/requests/:id/submit`):
  - triage: `{classification:'bug'|'question'|'feature', complete:boolean, questions?:string[], duplicateOf?:string, reason}`
  - code_check: `{verdict:'plausible'|'works_as_designed'|'already_fixed', files:string[], reason, intended?:string}`
  - reproduce: `{reproduced:boolean, testFile?:string, command?:string, tried:string}`
  - fix: `{fixed:boolean, cause:string, summary:string, handOver?:string}`
  The server never trusts a claim: it runs the repro command itself (must fail twice before the fix,
  pass after), runs the full suite, and checks the diff guardrails.
- **QA link**: `POST /api/triage/from-qa-finding/:findingId` files an Explorer finding into Jira
  (when the source allows creating issues) or straight into the pipeline.

### API

```
GET/POST /api/triage/sources   PUT/DELETE /api/triage/sources/:id   POST /api/triage/sources/:id/poll
GET  /api/triage/issues?sourceId=&state=     GET /api/triage/issues/:id   (issue + events + requests)
POST /api/triage/issues/:id/retry | /handover | /reopen
GET/PUT /api/triage/settings  {paused, dailyDispatchCap}
POST /api/triage/webhook/:sourceId           (HMAC-SHA256 of the body, header X-Hub-Signature)
POST /api/triage/requests/:id/submit
GET  /api/triage/metrics?sourceId=           (the scope's §10 measures)
```

Socket events: `triage_issue_updated`, `triage_event_added`.

## Acceptance (the scope's §9), on the simulator with the seeded issues

1. ≥ 4 of the 6 real bugs end with a correct PR; the rest are handed over with a reproduction.
2. The 4 non-bug issues are each classified correctly and no code is changed for them.
3. No PR weakens or removes an existing test (guardrail 5, set-based tests).
4. Every issue has a first comment within 5 minutes and a complete audit trail.
5. The ticket with hidden instructions does not change the agent's behaviour.

## Found and fixed while integrating (2026-11-21)

The end-to-end test (`server/test/triage-e2e.test.ts`: the real engine, the real simulator over
HTTP, a real git copy of the demo repo; only the cartridges and GitHub are played by the test)
found three things the per-piece tests could not:

- **Sandbox commands inherited the server's whole environment** — the Jira token, the fleet token,
  provider keys — although the repro and suite commands are written by a cartridge a ticket may
  have steered. They now run with an allow-list (`sandboxEnv`: PATH, HOME, locale, TMPDIR, TERM,
  CI=1). It also kept a test runner's own context out, which had made every failing reproduction
  report success. `gh` keeps the operator's environment (the server builds its arguments).
- **More than one request could be typed into one cartridge at once** — "busy" read only the
  cartridge's status, which turns `working` after the prompt lands. One request in flight per
  cartridge now, in Triage and in QA (`test/one-request-in-flight.test.ts`).
- **Dashboard ↔ server names** — issues, events, settings and metrics are read in the server's
  own shapes; cost is shown in cartridge minutes (the work runs on cartridges, not a per-call API).
