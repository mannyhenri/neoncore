# NeonCore Workflow Templates

## Overview

NeonCore seeds ~20 reusable **canvas workflow templates** on first server boot. They appear in the
**Workflows** panel under **Templates**; run any of them as many times as you like on any cartridge
or project. You can also **generate a new workflow from a sentence** (AI Workflow Generator) or build
one by hand in the canvas editor.

Many templates follow a **TDD-first** approach (tests after design, before implementation) and use
**quality-gate** steps with automatic routing — if a gate returns `STATUS: FAIL`, the preceding
implementation step resets and re-runs up to a cycle limit.

> **Workflows vs. tasks vs. goals.** A *workflow* is a multi-step recipe run on a cartridge or
> project. A *task* (see [docs/TASKS.md](docs/TASKS.md)) is a single queued unit of work for an
> agent. Both run against a project, and their cost rolls up to that project's *goal* (see
> [docs/GOALS.md](docs/GOALS.md)). For the gstack session *template* (not a NeonCore workflow) see
> [docs/gstack-feature-delivery-workflow.md](docs/gstack-feature-delivery-workflow.md).

---

## Template catalog

The dashboard is the source of truth for each template's exact steps. Current seeded templates:

**Core dev loop**
- **Bug Hunter** — find and fix a known bug with a regression test (detailed below).
- **Bug Investigation** — root-cause a bug without necessarily fixing it.
- **New Feature** — research → architect → test → build → gate (detailed below).
- **Feature Validation** — verify an existing feature behaves as intended.
- **Code Review & Audit** — structured multi-lens review of a change.
- **Full QA Review** — comprehensive QA pass across the app.

**Pipelines & research**
- **CI/CD Pipeline** — review → tests → security → notify (detailed below).
- **Deep Research** — multi-source investigation and synthesis.
- **Product Strategy Session** — strategy/scoping deliberation.
- **Engineering Architecture Review** — architecture evaluation and recommendations.

**Jira**
- **Jira Tasks Validation** — validate Jira issues against acceptance criteria.
- **Jira Tasks Completion** — drive Jira tasks to completion.

**Compound Engineering (CE) delivery pipeline**
- **CE: Phase 1 — Interrogate**, **Phase 2 — Plan**, **Phase 3 — Implement**,
  **Phase 4 — Review**, **Phase 5 — QA**, **Phase 6 — Ship**, **Phase 7 — Compound**, and
  **CE: Full Delivery** (the end-to-end chain).

> Templates named **Code Improvement**, **Feature Fix**, and **Refactor** were **removed** and are
> deleted on boot if present in an older DB — don't rely on them.

---

## Featured templates

### Bug Hunter
**Purpose:** Find and fix a known bug with automated verification.

**Pipeline:**
```
Investigate & Reproduce → Write Regression Test → Implement Fix → Tests + Security (parallel)
                                                         ↑ (loops back on STATUS: FAIL, max 2×)
```

**At run time:** pick a **cartridge** per step and enter an **objective** on the Investigate step
describing the bug.

**How it works:**
1. Reviewer traces the bug without touching code — root cause with file paths and line numbers.
2. Test Writer writes a **failing regression test** reproducing the bug (TDD).
3. Backend dev implements the minimal fix until the regression test passes.
4. Tests and Security run **in parallel** — if tests fail, Implement Fix resets and retries (max 2×).

---

### New Feature
**Purpose:** Build something new from research through implementation and testing.

**Pipeline:**
```
Research → Architect* → Write Tests → Develop → Quality Gate → Notify + Summary (parallel)
                                          ↑ (loops back on STATUS: FAIL, max 3×)
```
*\* Manual advance — review the architecture before tests are written.*

**How it works:**
1. Researcher surveys current approaches and patterns.
2. Architect designs the plan — **manual advance** so you can review before tests are written.
3. Test Writer writes failing tests that define acceptance criteria (TDD).
4. Developer builds until all tests pass.
5. Full quality gate — on `STATUS: FAIL`, Develop resets and retries (max 3×).
6. On success, a **system-notify** connector fires and a **Summary** step runs in parallel.

---

### CI/CD Pipeline
**Purpose:** Full automated pipeline — review, test, secure, notify.

**Pipeline:**
```
Code Review → Unit Tests  ──┐
           → Integration  ──┴→ Security Scan → Notify (system-notify)
              Tests
```

**How it works:**
1. Quality gate reviews code quality, patterns, and edge cases.
2. Unit and Integration tests run **in parallel** after review passes.
3. Security scan audits for OWASP issues and auth flaws.
4. A **system-notify** connector posts the result (desktop / ntfy push). Swap it for a Slack,
   Discord, GitHub, Linear, or generic HTTP connector in the canvas editor if you want an external
   destination.

---

## How to run a workflow

1. Open the dashboard (`http://<server>:4040`) and scroll to **Workflows**.
2. Find your template under **Templates** and click **Run** (▶).
3. In **Configure & Run**: pick the **project** (a run cartridge) once, and enter the first
   step's **objective**. By default every step runs on that one tool. To fan the workflow
   across tools, use **assign per step** to choose which **tool** (Claude / Codex / Gridlight)
   runs each step — it resolves to a live cartridge of that engine in the project. (You can also
   bake a tool into a step in the editor via its **Tool** field; steps left on *Default* use the
   run cartridge.)
4. Optionally **attach files** — a screenshot, a log, a spec. They are copied into the repo of
   every cartridge the run touches (under `.neoncore/attachments/`, gitignored) and referenced by
   path in **every** step's prompt, so a later reviewer opens the same evidence the implementer had.
   Up to 10 files, 20 MB total. This works for seeded templates and workflows you build yourself.
5. Click **Run Workflow** and watch steps execute on the canvas in real time.

Click ▶ on the same template multiple times to run it on different projects simultaneously — each
run is independent with its own `runNumber` and step progress.

---

## Key behaviors

| Behavior | Description |
|----------|-------------|
| **TDD ordering** | Tests are written after design and before implementation in the dev templates. |
| **Conditional routing** | Quality-gate steps loop back to the implementation step on `STATUS: FAIL` (up to a max-cycle limit). |
| **Context flow** | Each step receives its dependency results when "Include output from previous step" is enabled. |
| **Webhook completion** | Agents call their step's webhook URL (`/api/workflows/webhook/:stepId/complete`) with a result when done. |
| **Auto-advance** | Most steps start automatically when dependencies complete; some (e.g. New Feature's Architect) require manual advance. |
| **Parallel steps** | Steps sharing dependencies run simultaneously. |
| **Per-step tool** | Pick the project once at launch; each step runs on it by default, or choose a specific tool (Claude/Codex/Gridlight) per step. A pinned tool with no live cartridge falls back to the run cartridge. |
| **Deferred cartridges** | Agent steps use deferred selection — pick the cartridge/tool at run time. |
| **Launch attachments** | Files attached in Configure & Run are materialized into each repo the run touches and named in every step's prompt. |

Agents signal gate status with a prefix in their webhook result: `STATUS: PASS …` / `STATUS: FAIL …`.
Routing edges render as **dashed amber lines** on the canvas.

---

## Connectors

Connector steps run without a cartridge and execute immediately. The executor
(`server/src/lib/workflow-executor-v2.ts`) supports:

| Connector | Config | Use case |
|-----------|--------|----------|
| **system-notify** | none (uses global/per-cartridge ntfy) | Desktop / mobile push on completion — **used by the seeded templates** |
| **capture-learnings** | none | Extract learnings from the run into the project |
| **save-to-project** | none | Persist step output to project knowledge |
| **slack** / **discord** | Incoming Webhook URL | Post to a channel |
| **github** | PAT, repo, action | Create issues, comment on PRs, trigger workflows |
| **linear** | API key, team ID, action | Create/update Linear issues |
| **http** | URL, method, body template | Generic webhook — RequestBin, Zapier, Make, etc. |

**Template variables** in message/body templates:
`{{result}}`, `{{stepName}}`, `{{workflowName}}`, `{{agentName}}`, `{{timestamp}}`.

---

## Customizing templates

Open a template by clicking its name. The canvas editor lets you:

- **Add/remove steps** and drag connections between handles; **delete a connection** via the red X on an edge.
- **Add routing rules** (select a step → Routing Rules) for cyclic retry graphs.
- **Add connector steps** from the step-type selector.
- **Change expert roles** — architect, backend, frontend, reviewer, security, tester, performance, researcher, planner, or general.
- **Switch prompt mode** — free-text or structured (objective + acceptance criteria + constraints).
- **Add quality gates** — test, lint, security, build, full-review, or custom, with typed outputs.
- **Toggle auto-advance** to pause before a step for manual review.
