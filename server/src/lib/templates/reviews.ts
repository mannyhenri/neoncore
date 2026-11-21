/** Standard workflow templates: Product Strategy, Architecture Review, Super QA, Bug Investigation. Seeded on every boot by ./index.ts. */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

export function seedReviews({ now, stableId, insertWorkflow, step, cc, gate }: SeedKit): void {
  // ── 10. Product Strategy Session ─────────────────────────────────────────
  {
    const wfId = stableId('Product Strategy Session');
    const s1 = randomUUID(), s2 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID(), s9 = randomUUID();
    insertWorkflow.run(wfId, 'Product Strategy Session',
      'Set the workflow description to the product/feature being reviewed. Premise challenge → alternatives → dual-voice analysis (CEO vs PM) → 10-dimension scorecard → action plan with a 3-year picture → capture learnings.', now);

    // Each question is asked ONCE: "why now" and the riskiest assumption in Context & Premise,
    // the smallest version in Alternatives. "Dream State" re-asked all three and is folded into
    // the Action Plan's 3-year picture.
    step(wfId, s1, 'Context & Premise',
      'Understand what is being built and challenge the core premise. Surface hidden assumptions before the team gets attached.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The product or feature to review is described above. Understand it, then challenge its premise.\n\n**1 — UNDERSTAND.** Read the description (and the local codebase, if relevant). Identify what is being built or changed, who the target user is and what problem they have, and what success looks like to them.\n\n**2 — CHALLENGE.**\n1. Why does this need solving NOW? What changes if we wait 6 months?\n2. Is the proposed solution the most direct path to the user\'s underlying need, or a proxy?\n3. Which assumptions about user behavior are baked in? Are they validated?\n4. What is the riskiest assumption — the one that would invalidate the whole approach?\n5. Could something 10x simpler that already exists solve it?\n\n**OUTPUT**\n```\n## Subject\n[1-2 sentences: what this is]\n\n## Core Premise\n[The fundamental bet]\n\n## Premise Challenges\n| Assumption | Why It Could Be Wrong | Risk Level |\n|------------|----------------------|------------|\n[3-5 rows]\n\n## Riskiest Assumption\n[The one that, if wrong, kills the idea — and why]\n```',
      }, []);

    step(wfId, s2, 'Alternatives Analysis',
      'Explore all competing approaches — including doing nothing, buying vs building, and radically different framings.',
      300, 255, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Using the context and premise above, map the solution space with genuinely different approaches, not variations of one idea:\n\n1. **Do Nothing** — can users work around it? What does inaction cost?\n2. **Buy / Integrate** — does an existing product, library or API solve 80% of it? At what cost, and what do we lose?\n3. **Narrow Scope** — the smallest possible version that still delivers meaningful value. What are we overbuilding?\n4. **Reframe** — ask "what is the user\'s deeper need?" instead of "how do we build X?". What different solution appears?\n5. **The Original Proposal** — with the same rigor as the others.\n\n**OUTPUT**\n```\n## Solution Alternatives\n\n| Alternative | Core Idea | Biggest Advantage | Biggest Risk | Effort |\n|-------------|-----------|-------------------|--------------|--------|\n[one row per alternative]\n\n## Head-to-Head\n[The 2 most interesting alternatives and their key trade-off, in 2-3 sentences]\n\n## Recommendation\n[Which looks strongest and why — be direct]\n```',
      }, [s1]);

    step(wfId, s4, 'Dual Voice Analysis',
      'CEO lens vs PM lens — two distinct perspectives debate the product in a structured dialogue.',
      300, 430, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Run a debate between two opinionated voices on the recommended approach. Premise, risk and scope are settled above — do not re-argue them.\n\n**CEO** — business model, market size, competitive moat, defensibility, burn, investor narrative.\n**PM** — pain intensity, behavior change required, retention loops, what users asked for vs need, shipping velocity.\n\nEach voice responds to the other.\n\n**Topics:**\n1. What does success look like in 6 months?\n2. Where should the moat come from — and is it real?\n\n**OUTPUT**\n```\n## Dual Voice Analysis\n\n### 1. [topic]\n**CEO:** [position]\n**PM:** [pushback]\n**CEO:** [rebuttal]\n**PM:** [synthesis or escalation]\n\n[repeat per topic]\n\n### Resolution\n[Where they agree, where they still disagree, and the open question only data can answer.]\n```',
      }, [s2]);

    step(wfId, s5, 'Strategy Review',
      '10-dimension scorecard: market fit, technical feasibility, UX, competition, risk, timing, monetization, team, metrics, and moat.',
      300, 605, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Score the product strategy on 10 dimensions in ONE table, using the analysis above. Be direct — weaknesses as clearly as strengths.\n\nDimensions: Market Fit, Technical Feasibility, User Experience, Competitive Position, Risk Profile, Timing, Monetization, Team Readiness, Success Metrics, Moat & Defensibility.\n\n```\n## Product Strategy Review: [Name]\n\n| Dimension | Score (1-10) | Assessment (1-2 sentences) | Key action |\n|-----------|--------------|----------------------------|------------|\n[one row per dimension]\n\n## Overall Score: [average]/10\n## Verdict: [GO / GO WITH CHANGES / NO-GO]\n## Top 3 Priorities Before Moving Forward:\n1. [Highest-leverage action]\n2. [Second priority]\n3. [Third priority]\n```',
      }, [s4]);

    step(wfId, s6, 'Action Plan',
      'Concrete next steps with clear owners, deadlines, and success criteria. Requires human review before accepting.',
      300, 780, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Compile an opinionated action plan from the analysis above. Pick the best path and commit to it.\n\n```\n## Action Plan: [Name]\n\n### Strategic Decision\n[GO / NO-GO / CHANGE, and one paragraph on why]\n\n### 3-Year Picture\n[If this succeeds: the user\'s day and the product, in present tense, 3-5 sentences]\n\n### Immediate Actions (next 2 weeks)\n| Priority | Action | Owner | Done When |\n|----------|--------|-------|----------|\n\n### Phase 1 (first 6 weeks)\n| Week | Milestone | Success Criteria |\n|------|-----------|------------------|\n\n### Key Decisions Still Open\n| Decision | Who Decides | Deadline | Impact If Wrong |\n|----------|-------------|----------|-----------------|\n\n### What We Are NOT Building\n[Out of scope]\n\n### North Star Metric\n[The one number that says in 6 months whether this worked]\n```',
      }, [s5], false);

    step(wfId, s7, 'Capture Learnings',
      'Save the key strategy insights to project learnings for future workflow context.',
      300, 955, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s6]);

    step(wfId, s8, 'Save to Project',
      'Write the full strategy session output as a Markdown file in the linked project repo.',
      300, 1130, 'connector',
      { connectorType: 'save-to-project' }, [s7]);

    step(wfId, s9, 'Notify',
      'System notification: Product Strategy Session complete.',
      300, 1305, 'connector',
      { connectorType: 'system-notify', title: 'Product Strategy Session — Done', message: '{{workflowName}} complete. Review the action plan in NeonCore.' }, [s8]);
  }

  // ── 11. Engineering Architecture Review ──────────────────────────────────
  {
    const wfId = stableId('Engineering Architecture Review');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID();
    insertWorkflow.run(wfId, 'Engineering Architecture Review',
      'Set the workflow description to the system or feature under review. Architecture mapping → bottleneck analysis → alternative approaches → recommendation → implementation roadmap → human review → capture learnings.', now);

    step(wfId, s1, 'Architecture Mapping',
      'Map the current system architecture: components, data flows, dependencies, and boundaries.',
      300, 80, 'claude-code',
      {
        ...cc('architect'), workflowContext: true,
        prompt: 'The system or feature to review is described above. Map its current architecture from the codebase.\n\n**PHASE 1 — COMPONENT INVENTORY**\nList every significant component involved: files, modules, services, APIs, DB tables, queues, caches, external dependencies.\n\n**PHASE 2 — DATA FLOW TRACE**\nTrace the primary data flows end-to-end. For each flow:\n- Start point (user action / event / cron)\n- Each layer it passes through\n- Final state change or output\n- Where errors can occur\n\n**PHASE 3 — DEPENDENCY MAP**\nIdentify:\n- Internal dependencies (what depends on what within the codebase)\n- External dependencies (third-party services, APIs, packages)\n- Circular dependencies or tight coupling\n\n**OUTPUT**\n```\n## Architecture Map: [System/Feature Name]\n\n### Components\n| Component | Type | File(s) | Responsibility |\n|-----------|------|---------|----------------|\n[one row per component]\n\n### Primary Data Flows\n[Flow 1: name]\n→ [step1] → [step2] → [step3] → [output]\n[repeat per flow]\n\n### Dependency Graph (prose)\n[Describe the most critical dependencies and coupling points in 3-5 bullet points]\n\n### External Dependencies\n| Service/Package | Purpose | Risk if Unavailable |\n|-----------------|---------|---------------------|\n[one row per external dep]\n```',
      }, []);

    step(wfId, s2, 'Bottleneck & Risk Analysis',
      'Identify structural weaknesses, performance bottlenecks, scalability limits, and technical debt hotspots.',
      300, 255, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Using the architecture map from the previous step, identify everything that is likely to cause problems as the system scales or changes.\n\n**Check each of the following categories:**\n\n**Performance Bottlenecks**\n- N+1 query patterns\n- Synchronous operations that should be async\n- Missing indexes or inefficient queries\n- Large payloads or over-fetching\n- Missing caching on hot read paths\n\n**Scalability Limits**\n- Single points of failure\n- Shared mutable state that prevents horizontal scaling\n- In-memory storage that won\'t survive a restart\n- Tight coupling that prevents independent scaling of components\n\n**Technical Debt Hotspots**\n- Files with too many responsibilities (God objects/files)\n- Duplicated logic that should be centralized\n- Hardcoded configuration that should be dynamic\n- Missing abstraction layers that make change expensive\n\n**Security Risks**\n- Missing auth checks on internal routes\n- Unvalidated inputs flowing into queries or commands\n- Sensitive data in logs or error messages\n- Missing rate limiting on expensive endpoints\n\n**OUTPUT**\n```\n## Bottleneck & Risk Analysis\n\n| Category | Issue | Severity | Impact |\n|----------|-------|----------|--------|\n[critical/high/medium/low — one row per issue]\n\n## Top 3 Risks (Detailed)\n### Risk 1: [Name]\n[What it is, why it matters, what breaks when it does]\n\n[repeat for risks 2 and 3]\n\n## Overall Health: [Good / Needs Work / Critical]\n```',
      }, [s1]);

    step(wfId, s3, 'Alternative Approaches',
      'Explore fundamentally different ways to solve the same problem, including industry patterns and trade-off analysis.',
      300, 430, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Given the current architecture and the risks identified, explore alternative architectural approaches.\n\nDo not just propose minor variations — consider genuinely different designs:\n\n**Alternative 1: Minimal Change**\nWhat is the smallest refactor that eliminates the top risks without restructuring?\n\n**Alternative 2: Industry Pattern**\nWhat well-established pattern (CQRS, event sourcing, hexagonal architecture, micro-frontends, etc.) addresses the identified problems? How would it apply here?\n\n**Alternative 3: Full Redesign**\nIf we started from scratch with everything we know now, what would we build? What does the ideal architecture look like?\n\n**Alternative 4: Incremental Migration**\nA phased approach that moves toward Alternative 3 without a big-bang rewrite. What are the phases?\n\n**OUTPUT**\n```\n## Architectural Alternatives\n\n| Alternative | Core Idea | Pros | Cons | Effort |\n|-------------|-----------|------|------|--------|\n[one row per alternative — Effort: days/weeks/months]\n\n## Trade-off Analysis\n[For the 2 most interesting alternatives, write 3-4 sentences on the fundamental trade-off]\n\n## Recommended Direction\n[Direct recommendation with rationale]\n```',
      }, [s2]);

    step(wfId, s4, 'Architecture Recommendation',
      'Concrete design proposal with component diagram, interfaces, and explicit trade-off decisions. Requires human review.',
      300, 605, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Based on the analysis so far, write the concrete architecture recommendation. Be specific — include actual file paths, interface names, and data structures.\n\n```\n## Architecture Recommendation: [System/Feature Name]\n\n### Proposed Design\n[2-3 paragraphs describing the recommended architecture in plain English. Why this over the alternatives.]\n\n### Component Changes\n| Component | Current State | Proposed State | Reason |\n|-----------|--------------|----------------|--------|\n[one row per component that changes — "NEW" for additions, "REMOVE" for deletions]\n\n### New Interfaces / Contracts\n[For each new interface, type, or API contract being introduced]\n```typescript\n// or the relevant language\ninterface [Name] {\n  [fields]\n}\n```\n\n### Explicit Trade-offs\n| We are choosing | Over | Because |\n|-----------------|------|---------|\n[list the deliberate trade-offs in this design]\n\n### What This Does NOT Solve\n[Things explicitly out of scope — to prevent scope creep in implementation]\n\n### Success Criteria\n[How will we know the new architecture is working? Metrics and observable behaviors.]\n```',
      }, [s3], false);

    step(wfId, s5, 'Implementation Roadmap',
      'Phased implementation plan with milestones, dependencies, and rollback strategies.',
      300, 780, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the Architecture Recommendation, write the implementation roadmap — the migration path from today\'s system to the proposed one without breaking prod.\n\n```\n## Implementation Roadmap\n\n### Phase 1: Foundation (estimated: [timeframe])\n**Goal:** [What this phase achieves and why it must come first]\n\n| Task | File(s) | Description | Done When |\n|------|---------|-------------|----------|\n[one row per task — keep tasks small enough to complete in 1 day]\n\n**Phase 1 Definition of Done:**\n- [ ] [observable criterion 1]\n- [ ] [observable criterion 2]\n**Rollback plan:** [How to undo Phase 1 if it causes problems]\n\n### Phase 2: Core Changes (estimated: [timeframe])\n[same structure]\n\n### Phase 3: Cleanup & Optimization (estimated: [timeframe])\n[same structure]\n\n---\n### Critical Path\n[The 3-5 tasks that everything else depends on — these are the highest-risk items]\n\n### Total Estimated Effort\n[Sum of all phases with confidence range — e.g. "8-12 engineering days"]\n```',
      }, [s4]);

    step(wfId, s6, 'Capture Learnings',
      'Save architecture decisions and rationale to project learnings.',
      300, 955, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s5]);

    step(wfId, s7, 'Save to Project',
      'Write the full architecture review as a Markdown file in the linked project repo.',
      300, 1130, 'connector',
      { connectorType: 'save-to-project' }, [s6]);

    step(wfId, s8, 'Notify',
      'System notification: Engineering Architecture Review complete.',
      300, 1305, 'connector',
      { connectorType: 'system-notify', title: 'Architecture Review — Done', message: '{{workflowName}} complete. Review the implementation roadmap in NeonCore.' }, [s7]);
  }

  // ── 12. Super QA ──────────────────────────────────────────────────────────
  //
  // ONE QA WORKFLOW. "Full QA Review" and "Code Review & Audit" were both static reads of the
  // code ending in an issue table and a verdict — one aimed at a feature or URL (golden path,
  // edge cases, errors, performance, accessibility), the other at a branch or PR (logic,
  // security, test coverage). Merged, the target decides the scope: a change is reviewed as a
  // change, a feature or app is tested as a whole, and every lens runs either way.
  //
  // Security is a review STEP here, not a quality gate. As a gate it scanned only uncommitted
  // changes (`git diff HEAD`), and a FAIL re-ran the step before it — in Full QA Review that was
  // Performance Assessment — before failing the run. Findings belong in the report, where the
  // human gate on "QA Report" decides what happens next. This template changes no product code,
  // so it is launched without the Work Standard Check (NO_STANDARD_GATE_TEMPLATES).
  {
    const wfId = stableId('Super QA');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID(), s9 = randomUUID();
    insertWorkflow.run(wfId, 'Super QA',
      'Put what to QA in the context: a branch, PR or files (reviewed as a change) or a feature, URL or the whole app (tested as a product). Read the code → functional testing (golden paths, edge cases) → logic & error handling → security → performance & accessibility → test coverage → QA report with one verdict (human gate) → capture learnings.', now);

    step(wfId, s1, 'Scope & Read the Code',
      'Work out what is being QA\'d, read all of it end to end, and list the user journeys to test. No judgments yet.',
      300, 80, 'claude-code',
      {
        ...cc('reviewer'), workflowContext: true,
        prompt: `What to QA is described above. Understand it completely before judging anything.

**1 — SCOPE.** Decide what the target is:
- A CHANGE (branch, PR, commit range or files): \`git diff main...HEAD\` (or the comparison named above). The changed files are the scope, read in full — not just the diff.
- A FEATURE, URL or the whole app: find every file, route, component and table it involves. If a URL or running app is given, note it for functional testing.

**2 — READ.** For each file in scope: its role, how it connects to the rest, and the data flow through it (input → transformation → output, side effects).

**3 — JOURNEYS.** List the 3–5 primary user journeys through the scope (start → steps → expected end state). The next step tests them.

**OUTPUT**
\`\`\`
## Scope: [CHANGE | FEATURE | APP] — [name]
### Files in scope
| File | Role | New/Modified |
### What it does
[2–4 sentences: intent and mechanism]
### Data flow
[enters → transformed → exits]
### Journeys to test
1. [journey]: [start] → [steps] → [expected end state]
### First impressions
[surprising, more or less complex than expected — no judgments yet]
\`\`\``,
      }, []);

    step(wfId, s2, 'Functional Testing',
      'Golden paths first, then edge cases. Against the running app when a URL is given and a browser is available; otherwise by tracing the code.',
      300, 255, 'claude-code',
      {
        ...cc('tester'),
        prompt: `Test the journeys from "Scope & Read the Code". If a URL or running app was given and you have a browser tool, exercise it for real; otherwise trace each path through the code step by step. Say which you did.

**GOLDEN PATHS** — each journey end to end: does every step produce the expected output, and does the final state match what the user expects?

**EDGE CASES** — the cases that work in demos and fail in production:
- Empty / zero / null: empty lists, no data yet, first use
- Boundaries: min/max, exactly at vs one over the limit, 100+ items, very long strings
- Concurrency: two operations at once, rapid repeated clicks, navigating away mid-request
- Unusual but valid input: special characters, unicode and emoji, large numbers
- State transitions: status changes mid-operation, refresh during a long operation, back after a destructive action

**OUTPUT**
\`\`\`
## Functional Testing — [live app | code trace]
| Journey / Case | Expected | Actual | PASS/FAIL | File:Line |
### Failures
[each: expected vs actual, file:line, severity critical/high/medium/low]
Golden paths: N/N passed · Edge cases: N tested, N failed
\`\`\``,
      }, [s1]);

    step(wfId, s3, 'Logic & Error Handling',
      'Correctness bugs, async and state mistakes, and every error path: does it fail gracefully and recover?',
      300, 430, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: `Find bugs in the code in scope — not style issues.

**LOGIC** — does it do what the author intended? Wrong boolean conditions (AND/OR, negation), off-by-one comparisons (< vs <=), type coercion, null/undefined inputs, a list of exactly one item.
**ASYNC & STATE** — promises not awaited or not caught, updates after unmount, races between concurrent calls, side effects in the wrong order, shared state mutated in place, references escaping their scope.
**ERROR HANDLING** — for each failure: network timeout, 500, malformed response; validation errors (is the user told what went wrong and how to fix it?); expired session and 401/403 mid-operation; loading states cleared on failure; partial writes (transactions where several writes must succeed together); undo for destructive operations. Are errors propagated, or silently swallowed?

**OUTPUT**
\`\`\`
## Logic & Error Handling
| Severity | File:Line | Issue | Impact | Suggested fix |
[one row per issue — critical/high/medium/low/nitpick]
Error paths checked: N · well handled: N · weak: N · missing: N
Total issues: N | Critical: N | High: N | Medium: N | Low: N
\`\`\``,
      }, [s2]);

    step(wfId, s4, 'Security Review',
      'OWASP Top 10, auth and access control, input validation, secrets and vulnerable dependencies — in the code in scope.',
      300, 605, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: `Security review of the code in scope (the whole scope, not only uncommitted changes).

1. **Secrets** — API keys, passwords, tokens or private keys in code, config or history; .env files committed.
2. **Injection** — SQL, shell command, XSS, template injection, path traversal. Follow untrusted input to where it is used.
3. **Auth & access control** — is every route and action checked for the right user? Can one user reach another's data by changing an id?
4. **Data exposure** — PII or secrets in logs, responses or error messages; sensitive data unencrypted.
5. **Dependencies** — run the project's audit (\`npm audit --audit-level=high\`, \`pip-audit\`, \`cargo audit\`) and report HIGH/CRITICAL findings.

**OUTPUT**
\`\`\`
## Security Review
| Severity | Category | File:Line | Finding | Fix |
[CRITICAL/HIGH/MEDIUM/LOW — one row per finding]
Dependency audit: [command] → [N high, N critical]
Security: CLEAN | N findings (N critical, N high)
\`\`\``,
      }, [s3]);

    step(wfId, s5, 'Performance & Accessibility',
      'Patterns that break at 1000 users, and whether the UI works by keyboard and screen reader. Accessibility is skipped when there is no UI in scope.',
      300, 780, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: `**PERFORMANCE** — what works for 10 users and fails for 1000:
- Database: N+1 queries, queries in loops, missing indexes on filtered columns, unbounded queries with no LIMIT, SELECT *
- Network: over-fetching, chatty APIs, missing pagination, large payloads
- Rendering: expensive work on every render, missing memoization, long lists without virtualization
- Memory: stores that grow unbounded, listeners and timers never removed

**ACCESSIBILITY** — only if the scope has a UI; otherwise write "No UI in scope" and skip:
- Labels on interactive elements, semantic HTML, dialogs with role="dialog" and aria-modal
- Keyboard: everything reachable by Tab in a logical order, Escape closes modals, focus trapped in and returned from modals, visible focus styles
- Contrast (WCAG AA 4.5:1) and nothing conveyed by colour alone
- Screen readers: loading and error states announced, icon-only buttons labelled

**OUTPUT**
\`\`\`
## Performance
| Priority | Issue | File:Line | Estimated impact |
Top performance risk: [the single most important one]
## Accessibility
| Severity | Issue | Element/File | WCAG criterion |
Accessibility score: N/10 (or "No UI in scope")
\`\`\``,
      }, [s4]);

    step(wfId, s6, 'Test Coverage',
      'Map which behaviours in scope are tested, and write the missing tests that matter most.',
      300, 955, 'claude-code',
      {
        ...cc('tester'),
        prompt: `Evaluate the tests for the code in scope.

1. **Find** the existing tests for it (same module, component or route) and read them.
2. **Map** each function, branch and behaviour: is there a test that exercises it AND asserts the right result (not just that it runs)? Are the edge cases and error states from the earlier steps tested?
3. **Write** the missing tests for the highest-risk gaps — every failure found in Functional Testing or Logic & Error Handling that has no test should get one. Run them and paste the real output. Do not change product code in this step: a new test that fails because of a real bug stays failing and goes in the report.

**OUTPUT**
\`\`\`
## Test Coverage
| Behaviour | Test file / name | ✅ Covered / ⚠️ Partial / ❌ Not covered |
### Tests written
[file — test — what it proves — PASS/FAIL]
Coverage score: N/10 — [why]
\`\`\``,
      }, [s5]);

    step(wfId, s7, 'QA Report',
      'One report, one verdict: health score, every issue from every step, what must be fixed before shipping. Requires human review.',
      300, 1130, 'claude-code',
      {
        ...cc('planner'),
        prompt: `Compile the QA report from every previous step. Be direct — one clear verdict.

\`\`\`
## QA Report: [target] — [CHANGE | FEATURE | APP]
**Date:** [today]

## Verdict: [SHIP | SHIP WITH FIXES | DO NOT SHIP]
[one sentence why — for a CHANGE this is the merge decision: SHIP = approve, SHIP WITH FIXES = approve with changes, DO NOT SHIP = request changes]

## Health score: N/100
[Start at 100: critical −15, high −8, medium −3, low −1]

## Summary
[2–3 sentences: overall quality, biggest concerns, what works well]

## All issues
| ID | Severity | Category | File:Line | Issue |
[QA-001… — every issue from every step, deduplicated]

## Must fix before shipping
[file:line and the exact change for each critical/high issue]
## Should fix
## Nice to have

## Scorecard
- Functional: golden paths N/N · edge cases N failed
- Logic & errors: N issues · error paths N missing
- Security: CLEAN | N findings
- Performance: N issues · Accessibility: N/10 or n/a
- Tests: coverage N/10 · N written

## What works well
[2–3 specific things]
\`\`\``,
      }, [s6], false);

    step(wfId, s8, 'Capture Learnings',
      'Save the findings and quality patterns to project learnings.',
      300, 1305, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s7]);

    step(wfId, s9, 'Notify',
      'System notification: Super QA complete.',
      300, 1480, 'connector',
      { connectorType: 'system-notify', title: 'Super QA — Done', message: '{{workflowName}} complete. Review the QA report in NeonCore.' }, [s8]);
  }

  // ── 13. Bug Investigation ─────────────────────────────────────────────────
  {
    const wfId = stableId('Bug Investigation');
    const s1 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Bug Investigation',
      'Set the workflow description to the bug being investigated. Reproduce & root cause → impact assessment → fix plan (human gate) → implement → verify → capture learnings.', now);

    // Reproduce and Root Cause were two steps tracing the same code path; one pass does both.
    step(wfId, s1, 'Reproduce & Root Cause',
      'Establish a reliable reproduction, then trace it to the deepest cause. Distinguish symptom from root cause.',
      300, 80, 'claude-code',
      {
        ...cc('reviewer'), workflowContext: true,
        prompt: 'The bug to investigate is described above. Reproduce it, then find its root cause.\n\n**1 — SYMPTOMS.** Extract: the triggering action, what the user observes, the correct behavior, when it first appeared, how reliably it occurs.\n\n**2 — TRACE.** Find the entry point (route, handler, component, cron) and follow execution until actual behavior diverges from expected. Note the exact inputs, preconditions (state, role, data) and whether it depends on timing/environment.\n\n**3 — ROOT CAUSE.** From the point of failure, ask "why?" backward until you reach the original source. Classify it: logic error, missing null handling, race/timing, wrong data-shape assumption, missing boundary validation, state bug, misread API contract, or regression (check git blame). Then trace it forward: does it fully explain the symptoms?\n\n**OUTPUT**\n```\n## Bug Reproduction Report\n\n### Bug Summary\n[1-2 sentences]\n\n| | Description |\n|--|-------------|\n| **Symptom (actual)** | [what happens] |\n| **Expected behavior** | [what should happen] |\n\n### Reproduction Steps\n1. [Step 1]\n[continue]\n**Preconditions:** [required state]\n**Reliability:** [always / ~X% / specific conditions]\n\n### Code Path Traced\n[entry point] → [function] → ... → [point of failure]\n\n## Root Cause Analysis\n\n### The 5 Whys Chain\n1. **Why** did [symptom] occur? → Because [reason 1]\n[continue until root]\n\n### Root Cause\n**Classification:** [type]\n**Location:** [file:line]\n**Description:** [precise explanation]\n\n### Confidence\n[HIGH / MEDIUM / LOW — and why]\n```',
      }, []);

    step(wfId, s3, 'Impact Assessment',
      'Determine how many users are affected, what data is at risk, and whether related bugs exist.',
      300, 255, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Assess the full impact of this bug before designing a fix.\n\n**PHASE 1 — USER IMPACT**\n- Who is affected? (all users / specific roles / specific conditions)\n- How frequently does this occur? (every request / daily / rare edge case)\n- What is the user experience impact? (broken feature / wrong data / data loss / security issue)\n- Is there a workaround users can use?\n\n**PHASE 2 — DATA IMPACT**\n- Has incorrect data been written to the database?\n- Is any user data at risk of being lost or corrupted?\n- Does this bug affect historical records or only new operations?\n- Is a data migration or cleanup needed as part of the fix?\n\n**PHASE 3 — RELATED BUGS**\nUsing the root cause identified, grep for similar patterns in the codebase:\n- Are there other places where the same mistake was made?\n- Are there related code paths that have the same vulnerability?\n- Are there similar functions that should be checked for the same issue?\n\n**PHASE 4 — SEVERITY CLASSIFICATION**\nClassify overall severity:\n- **Critical**: data loss, security breach, complete feature outage for all users\n- **High**: incorrect behavior on the happy path for many users\n- **Medium**: edge case failure, usually with a workaround\n- **Low**: cosmetic or very rare condition\n\n```\n## Impact Assessment\n\n### User Impact\n- **Affected users:** [all / specific segment / edge case]\n- **Frequency:** [every time / often / rarely]\n- **UX impact:** [description]\n- **Workaround:** [exists / none]\n\n### Data Impact\n- **Data at risk:** [YES — description / NO]\n- **Cleanup needed:** [YES — description / NO]\n\n### Related Bugs Found\n| File:Line | Issue | Severity |\n|-----------|-------|----------|\n[rows if any related bugs found]\n\n### Overall Severity: [critical / high / medium / low]\n### Priority: [fix immediately / fix in next release / backlog]\n```',
      }, [s1]);

    step(wfId, s4, 'Fix Plan',
      'Design the minimal correct fix. Requires human review before any code is changed.',
      300, 430, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the root cause and impact assessment, design the fix. Keep it minimal — fix the root cause, not just the symptom.\n\n**Principles for a good bug fix:**\n1. Fix the root cause, not the symptom\n2. Make the minimal change that resolves the issue — do not refactor or improve surrounding code in the same commit\n3. The fix should be understandable to someone reading it without the bug report context\n4. Consider: could the fix break anything else?\n\n**OUTPUT**\n```\n## Fix Plan\n\n### The Fix\n**File:** [path]\n**Line(s):** [line range]\n**Change:** [describe the exact change in one sentence]\n\n### Why This Fix Works\n[How the change addresses the root cause — not just the symptom]\n\n### Code Sketch\n```[language]\n// BEFORE:\n[current code]\n\n// AFTER:\n[proposed code]\n```\n\n### What Could Break\n[Any other code paths that rely on the current (buggy) behavior]\n[Tests that may need updating]\n\n### Data Cleanup (if needed)\n[SQL or script to fix any corrupted data]\n\n### Tests to Add\n[New test cases that would have caught this bug]\n\n### Related Fixes\n[The related bugs found in impact assessment — should they be fixed in the same PR or separately?]\n```',
      }, [s3], false);

    step(wfId, s5, 'Implement Fix',
      'Apply the fix exactly as planned. No refactoring beyond the fix scope.',
      300, 605, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'Implement the fix from the Fix Plan. Follow the plan precisely — do not make changes beyond the defined scope.\n\n**Rules:**\n1. Implement exactly what is in the Fix Plan — no more, no less\n2. If you discover the fix plan is wrong or incomplete, STOP and explain why rather than improvising\n3. Do not fix other issues you notice — log them but do not change them\n4. Add the test cases specified in the Fix Plan\n5. Do not reformat or restyle code you are not fixing\n\n**For each change made:**\n```\nCHANGED [file:line] — [brief description of what changed]\n```\n\n**For any issues noticed but NOT fixed:**\n```\nNOTED (not fixed) [file:line] — [brief description]\n```\n\n**Summary output:**\n```\n## Fix Applied\n\n### Changes Made\n[list of CHANGED lines]\n\n### Tests Added\n[list of new tests]\n\n### Scope Boundary\n[Confirm: "All changes are within the scope defined by the Fix Plan. No other changes were made."]\n```',
      }, [s4]);

    step(wfId, s6, 'Verify Fix',
      'Run the full test suite and confirm the bug no longer reproduces.',
      300, 780, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s5 }], maxCycles: 2 }, [s5]);

    step(wfId, s7, 'Capture Learnings',
      'Save bug root cause and fix pattern to project learnings.',
      300, 955, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s6]);
  }

  // ══════════════════════════════════════════════════════════════════════
  // COMPOUND ENGINEERING × GSTACK — 7-phase feature delivery templates
  // Launch context: enter the feature slug (e.g. "user-auth-v2") so
  // every step can read/write to docs/[slug]/ and todos/[slug]/.
  // ══════════════════════════════════════════════════════════════════════
}
