# NeonCore Workflow Templates

## Overview

NeonCore includes 4 pre-built workflow templates for common development tasks. Each template is a reusable pipeline — you define it once and run it on any project/cartridge as many times as needed.

## Templates

### 1. Code Improvement
**Purpose:** Optimize existing code for performance and architecture.

**Pipeline:**
```
Performance Audit → Architecture Review → Implement Top Fixes → Full Quality Gate
```

**What you enter at run time:**
- **Cartridge** for each step (can be the same for all)
- **Objective** on the first step — describe what area to analyze

**Example objective:**
> "Analyze the NeonCore workflow executor (server/src/lib/workflow-executor-v2.ts) for performance bottlenecks and architectural improvements. Focus on the polling loop and step dispatch logic."

**How it works:**
1. Performance expert identifies top 5 bottlenecks ranked by impact
2. Architect reviews structure and proposes refactoring steps (builds on perf findings)
3. Backend dev implements the top improvements
4. Full quality gate (lint + security + tests) verifies nothing broke — retries on failure

---

### 2. Bug Hunter
**Purpose:** Find and fix a known bug with automated verification.

**Pipeline:**
```
Investigate & Reproduce → Implement Fix → Tests + Security Check (parallel)
```

**What you enter at run time:**
- **Cartridge** for each step
- **Objective** on the first step — describe the bug

**Example objective:**
> "The workflow step output is not being passed to the next step even when includeDepOutput is enabled. The downstream step receives empty dependency context."

**How it works:**
1. Code reviewer traces the bug without touching code — finds root cause with file paths and line numbers
2. Backend dev implements the minimal fix based on the investigation
3. Tests and Security run **in parallel** after the fix
4. If either gate fails, the fix step is re-run with feedback (up to 2 retries)

---

### 3. Feature Fix
**Purpose:** Fix a feature that exists but is not working as expected.

**Pipeline:**
```
Diagnose Issue → Plan the Fix → Implement Fix → Test & Verify
```

**What you enter at run time:**
- **Cartridge** for each step
- **Objective** on the first step — describe what's broken

**Example objective:**
> "The Configure & Run popup appears behind the canvas editor when starting a workflow from the template list. It should appear on top of everything."

**How it works:**
1. Code reviewer diagnoses exactly where behavior diverges from intent
2. Architect designs the minimal fix with exact file paths and edge case analysis
3. Backend dev implements the fix following the plan precisely
4. Test gate verifies the fix — retries on failure

---

### 4. New Feature
**Purpose:** Build something new from research through implementation and testing.

**Pipeline:**
```
Research → Architect (manual advance) → Develop → Test (2 loops) → Summary
```

**What you enter at run time:**
- **Cartridge** for each step
- **Objective** on the Research step — describe what to build

**Example objective:**
> "We need to allow users to delete connections between workflow steps in the canvas to reorganize or make new connections if a step was not connected properly."

**How it works:**
1. Researcher searches online for the latest approaches and patterns
2. Architect designs the implementation plan with file paths and interfaces — **manual advance** so you can review the plan before proceeding
3. Developer builds the feature based on research + architecture
4. Tester writes and runs comprehensive tests (runs **twice** for thorough coverage)
5. Summary documents all changes, test results, and manual testing instructions

---

## How to Run a Workflow

1. Open the NeonCore dashboard (http://localhost:4040)
2. Scroll to the **Workflows** section
3. Find your template under **Templates**
4. Click the **Run** button (▶)
5. The **Configure & Run** popup appears:
   - **Select a cartridge** for each step — pick which VS Code agent (project) runs it
   - **Enter the objective** for the first step — this is your task description
6. Click **Run Workflow**
7. A new run is created — watch steps execute in real time
8. Each step passes its result summary to the next step automatically

## Running on Multiple Projects

You can run the same template on different projects simultaneously:

1. Click ▶ on a template → assign cartridges for **Project A** → Run
2. While it's running, click ▶ on the same template → assign cartridges for **Project B** → Run
3. Both runs execute independently with their own step progress
4. Completed runs auto-delete after 30 seconds

## Key Behaviors

| Behavior | Description |
|----------|-------------|
| **Context flow** | Each step receives the result summary from its dependencies when "Include output from previous step" is enabled |
| **Webhook completion** | Every step includes a webhook URL — the agent calls it with a structured summary when done |
| **Auto-advance** | Most steps auto-start when dependencies complete. The Architect step in "New Feature" requires manual advance so you can review the plan |
| **Quality gate retries** | If a quality gate fails, it resets dependency steps with feedback and re-runs them automatically |
| **Parallel steps** | Steps with the same dependencies run simultaneously (e.g., Tests + Security in Bug Hunter) |
| **Deferred cartridges** | All steps use deferred agent selection — you pick the cartridge at run time for maximum flexibility |

## Customizing Templates

Open any template by clicking its name in the dashboard. The canvas editor lets you:

- **Add/remove steps** — click "+ Add Step" and drag connections between handles
- **Delete connections** — hover over an edge and click the red X button
- **Change expert roles** — pick from: general, architect, backend, frontend, reviewer, security, tester, performance, researcher, planner
- **Switch prompt mode** — toggle between free-text prompt and structured intent (objective + acceptance criteria + constraints)
- **Add quality gates** — choose from: test, lint, security, build, full-review, or custom
- **Set loop counts** — make a step repeat 2-10 times for iterative refinement
- **Toggle auto-advance** — turn off for steps where you want to review before proceeding

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
