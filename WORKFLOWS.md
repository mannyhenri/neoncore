# NeonCore Workflow Templates

## Overview

NeonCore ships 5 pre-built workflow templates. They are seeded automatically on first server boot and appear in the **Workflows** panel under **Templates**. Each template is reusable — run it as many times as needed on any cartridge or project.

All templates follow a **TDD-first** approach: tests are written after the design/architecture step and before any implementation. Quality gate steps include automatic routing — if a gate returns `STATUS: FAIL`, the preceding implementation step resets and re-runs (up to the configured cycle limit).

---

## Templates

### 1. Code Improvement
**Purpose:** Optimize existing code for performance and architecture.

**Pipeline:**
```
Performance Audit → Architecture Review → Write Tests → Implement Fixes → Quality Gate
                                                                 ↑ (loops back on STATUS: FAIL, max 2×)
```

**What you enter at run time:**
- **Cartridge** for each step
- **Objective** on the Performance Audit step — describe what area to analyze

**Example objective:**
> "Analyze the NeonCore workflow executor (server/src/lib/workflow-executor-v2.ts) for performance bottlenecks and architectural improvements."

**How it works:**
1. Performance expert identifies top bottlenecks ranked by impact
2. Architect reviews structure and proposes refactoring steps
3. Test Writer writes failing tests covering the areas to be improved (TDD)
4. Backend dev implements improvements until tests pass
5. Full quality gate (lint + test + security) — if it fails, Implement Fixes resets and retries (max 2 cycles)

---

### 2. Bug Hunter
**Purpose:** Find and fix a known bug with automated verification.

**Pipeline:**
```
Investigate & Reproduce → Write Regression Test → Implement Fix → Tests + Security (parallel)
                                                         ↑ (loops back on STATUS: FAIL, max 2×)
```

**What you enter at run time:**
- **Cartridge** for each step
- **Objective** on the Investigate step — describe the bug

**Example objective:**
> "The workflow step output is not being passed to the next step even when includeDepOutput is enabled. The downstream step receives empty dependency context."

**How it works:**
1. Code reviewer traces the bug without touching code — finds root cause with file paths and line numbers
2. Test Writer writes a **failing regression test** that reproduces the exact bug (TDD)
3. Backend dev implements the minimal fix until the regression test passes
4. Tests and Security run **in parallel** — if tests fail, Implement Fix resets and retries (max 2 cycles)

---

### 3. Feature Fix
**Purpose:** Fix a feature that exists but is not working as expected.

**Pipeline:**
```
Diagnose Issue → Plan the Fix → Write Tests → Implement Fix → Verify
                                                      ↑ (loops back on STATUS: FAIL, max 2×)
```

**What you enter at run time:**
- **Cartridge** for each step
- **Objective** on the Diagnose step — describe what's broken

**Example objective:**
> "The Configure & Run popup appears behind the canvas editor when starting a workflow from the template list. It should appear on top of everything."

**How it works:**
1. Code reviewer diagnoses exactly where behavior diverges from intent
2. Architect designs the minimal fix with exact file paths and edge case analysis
3. Test Writer writes tests that capture the expected (fixed) behavior (TDD)
4. Backend dev implements the fix until tests pass
5. Verify gate runs full lint + test suite — if it fails, Implement Fix resets and retries (max 2 cycles)

---

### 4. New Feature
**Purpose:** Build something new from research through implementation and testing.

**Pipeline:**
```
Research → Architect* → Write Tests → Develop → Quality Gate → Notify (connector) + Summary (parallel)
                                          ↑ (loops back on STATUS: FAIL, max 3×)
```
*\* Manual advance — review the architecture before tests are written*

**What you enter at run time:**
- **Cartridge** for each step
- **Objective** on the Research step — describe what to build

**Example objective:**
> "We need to allow users to delete connections between workflow steps in the canvas to reorganize or make new connections if a step was not connected properly."

**How it works:**
1. Researcher searches for the latest approaches and patterns
2. Architect designs the implementation plan — **manual advance** so you can review before writing tests
3. Test Writer writes failing tests that define the acceptance criteria (TDD)
4. Developer builds the feature until all tests pass
5. Full quality gate — if it fails, Develop resets and retries (max 3 cycles)
6. On success, **Notify** (HTTP connector) and **Summary** run in parallel
   - Configure the Notify step's webhook URL in the step settings to send a completion ping
   - Summary documents all changes and manual testing instructions

---

### 5. CI/CD Pipeline *(new)*
**Purpose:** Full automated pipeline — review, test, secure, notify.

**Pipeline:**
```
Code Review → Unit Tests  ──┐
           → Integration  ──┴→ Security Scan → Slack Notify (connector)
              Tests
```

**What you enter at run time:**
- **Cartridge** for each step
- Configure the **Notify** step's Slack webhook URL in step settings

**How it works:**
1. Quality gate reviews code quality, patterns, and edge cases
2. Unit Tests and Integration Tests run **in parallel** after the review passes
3. Security scan audits for OWASP issues and auth flaws
4. Slack Notify sends the pipeline result to your configured webhook

**Setup:** Open the Notify step in the canvas editor and enter your Slack Incoming Webhook URL. The message uses `{{workflowName}}` and `{{result}}` substitution.

---

## How to Run a Workflow

1. Open the NeonCore dashboard (`http://localhost:4040`)
2. Scroll to the **Workflows** section
3. Find your template under **Templates**
4. Click the **Run** button (▶)
5. The **Configure & Run** popup appears:
   - Select a **cartridge** for each step — pick which VS Code agent runs it
   - Enter the **objective** for the first step — your task description
6. Click **Run Workflow**
7. Watch steps execute in real time on the canvas

## Running on Multiple Projects

Click ▶ on the same template multiple times to run it on different projects simultaneously. Each run is independent with its own step progress.

---

## Key Behaviors

| Behavior | Description |
|----------|-------------|
| **TDD ordering** | Tests are written after design and before implementation in all templates |
| **Conditional routing** | Quality gate steps loop back to the implementation step on `STATUS: FAIL` (up to configured max cycles) |
| **Context flow** | Each step receives its dependency results when "Include output from previous step" is enabled |
| **Webhook completion** | Agents call their step's webhook URL with a result when done |
| **Auto-advance** | Most steps start automatically when dependencies complete. The Architect step in New Feature requires manual advance |
| **Parallel steps** | Steps with the same dependencies run simultaneously (e.g., Tests + Security in Bug Hunter) |
| **External connectors** | Connector steps (Notify steps) call external APIs — Slack, Discord, GitHub, Linear, or any HTTP endpoint |
| **Deferred cartridges** | All steps use deferred agent selection — pick the cartridge at run time |

---

## Routing Rules (Cyclic Graphs)

Routing rules let steps loop back to earlier steps based on the result string. This is how quality gates retry on failure:

- The gate step includes a rule: **`contains` → `STATUS: FAIL` → reset Implement step**
- When the gate's webhook fires with `STATUS: FAIL` in the result, the Implement step resets to pending and re-runs
- A `maxCycles` limit prevents infinite loops (default: 2–3 depending on template)
- After exhausting cycles, normal downstream activation resumes

Routing edges appear as **dashed amber lines** on the canvas.

**Agents signal status** by including a prefix in their webhook result:
```
STATUS: PASS — All tests green, deployed to staging.
STATUS: FAIL — Unit tests failed in auth module. See test output above.
```

---

## External Connectors

Connector steps execute immediately (no cartridge needed) and call external APIs. Configure them in the canvas sidebar under **Connector Settings**.

| Connector | Config needed | Use case |
|-----------|--------------|----------|
| **Slack** | Incoming Webhook URL | Notify a channel when a workflow completes |
| **Discord** | Incoming Webhook URL | Same as Slack |
| **GitHub** | PAT token, repo, action | Create issues, comment on PRs, trigger workflows |
| **Linear** | API key, team ID, action | Create or update Linear issues |
| **HTTP** | URL, method, body template | Generic webhook — RequestBin, Zapier, Make, etc. |

**Template variables** available in message/body templates:
`{{result}}`, `{{stepName}}`, `{{workflowName}}`, `{{agentName}}`, `{{timestamp}}`

---

## Customizing Templates

Open any template by clicking its name. The canvas editor lets you:

- **Add/remove steps** — click "+ Add Step" and drag connections between handles
- **Delete connections** — hover an edge and click the red X button
- **Add routing rules** — select a step → "Routing Rules" section in the sidebar
- **Add connector steps** — choose "External Connector" from the step type selector
- **Change expert roles** — general, architect, backend, frontend, reviewer, security, tester, performance, researcher, planner
- **Switch prompt mode** — free-text or structured (objective + acceptance criteria + constraints)
- **Add quality gates** — test, lint, security, build, full-review, or custom
- **Set loop counts** — repeat a step 2–10× for iterative refinement
- **Toggle auto-advance** — pause before a step proceeds for manual review

---

## Expert Roles Reference

| Role | Best for |
|------|----------|
| **General** | Default — no role prefix |
| **Architect** | System design, implementation planning, module interfaces |
| **Backend Dev** | Server logic, APIs, databases, error handling |
| **Frontend Dev** | UI components, state management, responsive design |
| **Code Reviewer** | Code quality, edge cases, improvements ranked by impact |
| **Security Auditor** | Injection risks, auth, OWASP top 10, credential exposure |
| **Test Writer** | Comprehensive tests, edge cases, integration scenarios |
| **Performance** | N+1 queries, memory leaks, bundle size, bottlenecks |
| **Researcher** | Investigation, comparison, trade-off evaluation |
| **Planner** | Detailed step-by-step plans with milestones |
