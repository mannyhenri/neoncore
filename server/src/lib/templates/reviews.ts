/** Standard workflow templates: Product Strategy, Architecture Review, Full QA Review, Bug Investigation, Code Review & Audit. Seeded on every boot by ./index.ts. */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

export function seedReviews({ now, stableId, insertWorkflow, step, cc, gate }: SeedKit): void {
  // ── 10. Product Strategy Session ─────────────────────────────────────────
  {
    const wfId = stableId('Product Strategy Session');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID(), s9 = randomUUID();
    insertWorkflow.run(wfId, 'Product Strategy Session',
      'Set the workflow description to the product/feature being reviewed. Premise challenge → alternatives → dream state → dual-voice analysis (CEO vs PM) → 10-dimension strategy review → action plan → capture learnings.', now);

    step(wfId, s1, 'Context & Premise',
      'Understand what is being built and challenge the core premise. Surface hidden assumptions before the team gets attached.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The product or feature to review is described above. Your first job is to deeply understand it and then challenge its premise.\n\n**PHASE 1 — UNDERSTAND THE SUBJECT**\nRead the description carefully. Research the local codebase (if relevant) using Grep/Glob/Read to understand current state. Identify:\n- What exactly is being built or changed\n- Who the target user is and what problem they have\n- What success looks like from the user\'s perspective\n\n**PHASE 2 — CHALLENGE THE PREMISE**\nEvery product assumption deserves scrutiny. Challenge each one:\n1. Why does this problem need solving NOW? What changes if we wait 6 months?\n2. Is the proposed solution the most direct path to the user\'s underlying need — or is it solving a proxy problem?\n3. What assumptions about user behavior are baked in? Are they validated?\n4. What is the riskiest assumption in this plan? What would invalidate the whole approach?\n5. Could this be solved with something 10x simpler that already exists?\n\n**OUTPUT**\n```\n## Subject\n[1-2 sentences: what this is]\n\n## Core Premise\n[The fundamental bet this product/feature is making]\n\n## Premise Challenges\n| Assumption | Why It Could Be Wrong | Risk Level |\n|------------|----------------------|------------|\n[3-5 rows]\n\n## Riskiest Assumption\n[The single assumption that, if wrong, kills the whole idea — and why]\n```',
      }, []);

    step(wfId, s2, 'Alternatives Analysis',
      'Explore all competing approaches — including doing nothing, buying vs building, and radically different framings.',
      300, 255, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Using the context and premise from the previous step, map the full solution space.\n\nDo NOT just list minor variations of the same idea. Explore genuinely different approaches:\n\n**Alternative 1: Do Nothing**\nWhat happens if we ship nothing? Can users work around this? What is the cost of inaction?\n\n**Alternative 2: Buy / Integrate**\nIs there an existing product, library, or API that already solves 80% of this? What would it cost? What would we lose?\n\n**Alternative 3: Narrow Scope Dramatically**\nWhat is the smallest possible version that still delivers meaningful value? What are we overbuilding?\n\n**Alternative 4: Reframe the Problem**\nIf we asked "what is the user\'s deeper need?" rather than "how do we build X?" — what entirely different solution appears?\n\n**Alternative 5: The Original Proposal**\nDescribe the proposed approach as a distinct option with the same rigor as the others.\n\n**OUTPUT**\n```\n## Solution Alternatives\n\n| Alternative | Core Idea | Biggest Advantage | Biggest Risk | Effort |\n|-------------|-----------|-------------------|--------------|--------|\n[one row per alternative]\n\n## Head-to-Head\n[Pick the 2 most interesting alternatives and explain the key trade-off between them in 2-3 sentences]\n\n## Recommendation\n[Which alternative looks strongest and why — be direct]\n```',
      }, [s1]);

    step(wfId, s3, 'Dream State',
      'Articulate the ideal end-state with all constraints removed. What does complete success look like in 3 years?',
      300, 430, 'claude-code',
      {
        ...cc('researcher'),
        prompt: 'Imagine it is 3 years from now and this product/feature has succeeded beyond expectations. Constraints of time, team size, and technical debt have been removed. What does the world look like?\n\nThis is not a roadmap — it is a north star. Write it in present tense as if it has already happened.\n\n**DREAM STATE DOCUMENT**\n\n```\n## Dream State: [Product/Feature Name]\n\n### The User Experience (in 3 years)\n[Write 2-3 paragraphs from the perspective of a user in the ideal future. What does their day look like? How does this product fit into it? Be concrete and specific — use a real user story, not abstract language.]\n\n### The Product (in 3 years)\n[What has been built? What metrics prove success? What does the product do that seemed impossible 3 years ago?]\n\n### What Had to Be True\n[The 3-5 things that had to happen for this dream state to be reached — these are the strategic bets]\n\n### The Gap\n[What is the distance between today and this dream state? What is the hardest thing to close?]\n\n### The Minimum Viable Dream\n[What is the smallest version of this that preserves the soul of the dream? Where is the line between "not enough" and "enough to validate the bet"?]\n```',
      }, [s2]);

    step(wfId, s4, 'Dual Voice Analysis',
      'CEO lens vs PM lens — two distinct perspectives debate the product in a structured dialogue.',
      300, 605, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Conduct a dual-voice debate between two distinct perspectives on this product/feature. Write as if two smart, opinionated people are actually disagreeing.\n\n**THE CEO VOICE** — thinks about: business model, market size, competitive moat, burn rate, defensibility, timing, investor narrative, existential risk.\n\n**THE PM VOICE** — thinks about: user pain intensity, behavior change required, retention loops, feedback cycles, what users actually asked for vs what they need, scope creep risk, shipping velocity.\n\nFormat as a real dialogue. Each voice gets to respond to the other. Minimum 3 exchanges per topic.\n\n**Topics to debate:**\n1. Is this the right thing to build right now?\n2. What does success look like in 6 months?\n3. What would we cut if we had to ship in half the time?\n4. What is the most likely way this fails?\n\n**OUTPUT**\n```\n## Dual Voice Analysis\n\n### 1. Is this the right thing to build right now?\n**CEO:** [position]\n**PM:** [response / pushback]\n**CEO:** [rebuttal]\n**PM:** [synthesis or escalation]\n\n[repeat for each topic]\n\n### Resolution\n[Where the two voices agree. Where they still disagree. What question remains open that only data can answer.]\n```',
      }, [s3]);

    step(wfId, s5, 'Strategy Review',
      '10-dimension review: market fit, technical feasibility, UX, competition, risk, timing, monetization, team, metrics, and moat.',
      300, 780, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Conduct a structured 10-dimension product strategy review. Be direct — call out weaknesses as clearly as strengths.\n\nFor each dimension: give a 2-4 sentence assessment, a score (1-10), and the single most important action.\n\n```\n## Product Strategy Review: [Name]\n\n### 1. Market Fit (Score: N/10)\n[Does this solve a real pain for a large enough market? Is the market growing or shrinking?]\n**Key action:** [Most important thing to do here]\n\n### 2. Technical Feasibility (Score: N/10)\n[Can we build this with our current team and stack? What are the hardest technical challenges?]\n**Key action:** [Most important thing to do here]\n\n### 3. User Experience (Score: N/10)\n[How much behavior change is required? Is the UX intuitive? Where will users get stuck?]\n**Key action:** [Most important thing to do here]\n\n### 4. Competitive Position (Score: N/10)\n[Who else is solving this? What is our differentiation? Could a well-funded competitor copy this in 6 months?]\n**Key action:** [Most important thing to do here]\n\n### 5. Risk Profile (Score: N/10)\n[What are the top 3 risks? Technical, market, execution? Which is most likely to kill the project?]\n**Key action:** [Most important thing to do here]\n\n### 6. Timing (Score: N/10)\n[Why now? What has changed that makes this possible or necessary today vs 2 years ago?]\n**Key action:** [Most important thing to do here]\n\n### 7. Monetization (Score: N/10)\n[Is there a clear path to revenue? Does the pricing model match user psychology?]\n**Key action:** [Most important thing to do here]\n\n### 8. Team Readiness (Score: N/10)\n[Does the team have the skills, capacity, and context to execute this well?]\n**Key action:** [Most important thing to do here]\n\n### 9. Success Metrics (Score: N/10)\n[Are the success metrics clear, measurable, and leading indicators — not just lagging vanity metrics?]\n**Key action:** [Most important thing to do here]\n\n### 10. Moat & Defensibility (Score: N/10)\n[What keeps competitors from copying this once it works? Network effects, data, switching costs, brand?]\n**Key action:** [Most important thing to do here]\n\n---\n## Overall Score: [average]/10\n## Verdict: [GO / GO WITH CHANGES / NO-GO]\n## Top 3 Priorities Before Moving Forward:\n1. [Highest-leverage action]\n2. [Second priority]\n3. [Third priority]\n```',
      }, [s4]);

    step(wfId, s6, 'Action Plan',
      'Concrete next steps with clear owners, deadlines, and success criteria. Requires human review before accepting.',
      300, 955, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using all the analysis from the previous steps, compile a concrete action plan. This should be opinionated — don\'t hedge. Pick the best path and commit to it.\n\n```\n## Action Plan: [Product/Feature Name]\n\n### Strategic Decision\n[State the GO/NO-GO/CHANGE recommendation clearly. One paragraph on why.]\n\n### Immediate Actions (next 2 weeks)\n| Priority | Action | Owner | Done When |\n|----------|--------|-------|----------|\n[3-5 rows — these are the blockers and validators that determine the path]\n\n### Phase 1 (first 6 weeks)\n[What gets built? What gets validated? What gets cut?]\n\n| Week | Milestone | Success Criteria |\n|------|-----------|------------------|\n[one row per key milestone]\n\n### Key Decisions Still Open\n| Decision | Who Decides | Deadline | Impact If Wrong |\n|----------|-------------|----------|-----------------|\n[decisions that must be made before building starts]\n\n### What We Are NOT Building\n[Explicit list of things that are out of scope — to prevent scope creep]\n\n### North Star Metric\n[The single number that tells you in 6 months whether this worked]\n```',
      }, [s5], false);

    step(wfId, s7, 'Capture Learnings',
      'Save the key strategy insights to project learnings for future workflow context.',
      300, 1130, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s6]);

    step(wfId, s8, 'Save to Project',
      'Write the full strategy session output as a Markdown file in the linked project repo.',
      300, 1305, 'connector',
      { connectorType: 'save-to-project' }, [s7]);

    step(wfId, s9, 'Notify',
      'System notification: Product Strategy Session complete.',
      300, 1480, 'connector',
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
        prompt: 'The system or feature to review is described above. Map its current architecture using Read, Grep, and Glob tools to explore the codebase.\n\n**PHASE 1 — COMPONENT INVENTORY**\nList every significant component involved: files, modules, services, APIs, DB tables, queues, caches, external dependencies.\n\n**PHASE 2 — DATA FLOW TRACE**\nTrace the primary data flows end-to-end. For each flow:\n- Start point (user action / event / cron)\n- Each layer it passes through\n- Final state change or output\n- Where errors can occur\n\n**PHASE 3 — DEPENDENCY MAP**\nIdentify:\n- Internal dependencies (what depends on what within the codebase)\n- External dependencies (third-party services, APIs, packages)\n- Circular dependencies or tight coupling\n\n**OUTPUT**\n```\n## Architecture Map: [System/Feature Name]\n\n### Components\n| Component | Type | File(s) | Responsibility |\n|-----------|------|---------|----------------|\n[one row per component]\n\n### Primary Data Flows\n[Flow 1: name]\n→ [step1] → [step2] → [step3] → [output]\n[repeat per flow]\n\n### Dependency Graph (prose)\n[Describe the most critical dependencies and coupling points in 3-5 bullet points]\n\n### External Dependencies\n| Service/Package | Purpose | Risk if Unavailable |\n|-----------------|---------|---------------------|\n[one row per external dep]\n```',
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
        prompt: 'Based on the analysis so far, write the concrete architecture recommendation. Be specific — include actual file paths, interface names, and data structures.\n\n```\n## Architecture Recommendation: [System/Feature Name]\n\n### Proposed Design\n[2-3 paragraphs describing the recommended architecture in plain English. Why this over the alternatives.]\n\n### Component Changes\n| Component | Current State | Proposed State | Reason |\n|-----------|--------------|----------------|--------|\n[one row per component that changes — "NEW" for additions, "REMOVE" for deletions]\n\n### New Interfaces / Contracts\n[For each new interface, type, or API contract being introduced]\n```typescript\n// or the relevant language\ninterface [Name] {\n  [fields]\n}\n```\n\n### Migration Path\n[How do we get from current state to proposed state without breaking prod?]\n1. [Step 1 — can be done independently]\n2. [Step 2 — depends on step 1]\n[continue]\n\n### Explicit Trade-offs\n| We are choosing | Over | Because |\n|-----------------|------|---------|\n[list the deliberate trade-offs in this design]\n\n### What This Does NOT Solve\n[Things explicitly out of scope — to prevent scope creep in implementation]\n\n### Success Criteria\n[How will we know the new architecture is working? Metrics and observable behaviors.]\n```',
      }, [s3], false);

    step(wfId, s5, 'Implementation Roadmap',
      'Phased implementation plan with milestones, dependencies, and rollback strategies.',
      300, 780, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the Architecture Recommendation, create a detailed implementation roadmap that a team can follow.\n\n```\n## Implementation Roadmap\n\n### Phase 1: Foundation (estimated: [timeframe])\n**Goal:** [What this phase achieves and why it must come first]\n\n| Task | File(s) | Description | Done When |\n|------|---------|-------------|----------|\n[one row per task — keep tasks small enough to complete in 1 day]\n\n**Phase 1 Definition of Done:**\n- [ ] [observable criterion 1]\n- [ ] [observable criterion 2]\n**Rollback plan:** [How to undo Phase 1 if it causes problems]\n\n### Phase 2: Core Changes (estimated: [timeframe])\n[same structure]\n\n### Phase 3: Cleanup & Optimization (estimated: [timeframe])\n[same structure]\n\n---\n### Critical Path\n[The 3-5 tasks that everything else depends on — these are the highest-risk items]\n\n### Parallel Work\n[Tasks that can be done simultaneously without blocking each other]\n\n### Total Estimated Effort\n[Sum of all phases with confidence range — e.g. "8-12 engineering days"]\n```',
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

  // ── 12. Full QA Review ────────────────────────────────────────────────────
  {
    const wfId = stableId('Full QA Review');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID();
    insertWorkflow.run(wfId, 'Full QA Review',
      'Set the workflow description to the feature or URL being tested. Golden path → edge cases → error handling → performance → security → accessibility → QA report → notify.', now);

    step(wfId, s1, 'Golden Path Testing',
      'Test the primary happy path end-to-end. Every core user journey must work correctly.',
      300, 80, 'claude-code',
      {
        ...cc('tester'), workflowContext: true,
        prompt: 'The feature or system to QA test is described above. Begin with the golden path — the primary happy path that most users will take.\n\n**PHASE 1 — IDENTIFY GOLDEN PATHS**\nFrom the description (and by reading the relevant code with Grep/Glob/Read), identify the 3-5 primary user journeys. For each journey: start point → steps → expected end state.\n\n**PHASE 2 — TEST EACH GOLDEN PATH**\nFor each journey, trace through the code to verify it works correctly:\n1. Follow the code execution path step by step\n2. Check that each step produces the expected output\n3. Verify the final state matches what the user would expect\n4. Check that error states are handled gracefully\n\n**PHASE 3 — OUTPUT RESULTS**\n```\n## Golden Path Test Results\n\n| Journey | Steps Tested | Result | Notes |\n|---------|-------------|--------|-------|\n| [name] | [N steps] | ✅ PASS / ❌ FAIL | [what works or what broke] |\n\n### Failures (if any)\n#### [Journey Name]\n- **Expected:** [what should happen]\n- **Actual:** [what actually happens]\n- **File:Line:** [where the bug is]\n- **Severity:** critical / high / medium\n\n### Golden Path Summary\nPassed: N/N | Failed: N/N\n```',
      }, []);

    step(wfId, s2, 'Edge Case Testing',
      'Test boundary conditions, empty states, maximum values, concurrent operations, and unusual but valid inputs.',
      300, 255, 'claude-code',
      {
        ...cc('tester'),
        prompt: 'Test edge cases and boundary conditions. These are the cases that work in demos but fail in production.\n\n**Edge case categories to test:**\n\n**Empty / Zero / Null States**\n- Empty lists, zero counts, null/undefined values\n- What shows when there is no data?\n- What happens on first use before any data exists?\n\n**Boundary Values**\n- Minimum and maximum allowed values\n- Exactly at the limit vs one over/under\n- Very large datasets (100+ items)\n- Very long strings in text fields\n\n**Concurrent / Race Conditions**\n- Two operations happening at the same time\n- Rapid repeated clicks/calls\n- Navigation away during an async operation\n\n**Unusual But Valid Inputs**\n- Special characters in text fields\n- Unicode and emoji in string fields\n- Very large numbers where numbers are expected\n- Unexpected but valid data types\n\n**State Transitions**\n- What happens when status changes mid-operation?\n- Refresh during a long operation\n- Back button after a destructive action\n\nFor each edge case tested, document: input → expected behavior → actual behavior → PASS/FAIL.\n\n```\n## Edge Case Results\n| Category | Case | Expected | Actual | Status |\n|----------|------|----------|--------|--------|\n[one row per test]\n\n### Critical Failures\n[Detailed description of any FAIL results with file:line pointers]\n\nEdge Cases: N tested | N passed | N failed\n```',
      }, [s1]);

    step(wfId, s3, 'Error Handling Review',
      'Verify that every error path surfaces a useful message, fails gracefully, and recovers correctly.',
      300, 430, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Review all error handling paths in the feature or system. Poor error handling is the most common source of production incidents.\n\n**Check these error categories:**\n\n**Network / API Failures**\n- What happens when an API call times out?\n- What happens when the server returns 500?\n- What happens when the response is malformed?\n\n**User Input Errors**\n- Are validation errors surfaced clearly to the user?\n- Are form fields reset correctly after an error?\n- Is the user told specifically what went wrong and how to fix it?\n\n**Auth / Permission Errors**\n- What happens when a session expires mid-operation?\n- Are 401/403 responses handled with a redirect to login?\n- Are permission errors shown as helpful messages vs cryptic failures?\n\n**Async Operation Failures**\n- Are all promises awaited and their rejections caught?\n- Are loading states cleared when operations fail?\n- Does the UI recover to a usable state after an error?\n\n**Data Corruption Prevention**\n- Is there protection against partial writes?\n- Are transactions used where multiple DB operations must succeed together?\n- Is there a way to undo a destructive operation?\n\n```\n## Error Handling Review\n| Error Type | Handler Found | Quality | Notes |\n|------------|--------------|---------|-------|\n| [category] | YES/NO/PARTIAL | ✅ Good / ⚠️ Weak / ❌ Missing | [file:line if relevant] |\n\n### Unhandled Error Paths\n[Detailed description of any missing error handlers with file:line pointers]\n\n### Summary\nError paths checked: N | Well-handled: N | Weakly handled: N | Missing: N\n```',
      }, [s2]);

    step(wfId, s4, 'Performance Assessment',
      'Identify slow queries, large payloads, missing indexes, and operations that will not scale.',
      300, 605, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Assess the performance characteristics of the feature or system. Look for patterns that work fine with 10 users but fail with 1000.\n\n**Check for:**\n\n**Database Performance**\n- N+1 query patterns (fetching one item per loop iteration)\n- Missing WHERE clause indexes on frequently-queried columns\n- SELECT * where specific columns suffice\n- Queries inside loops or map/forEach calls\n- Unbounded queries with no LIMIT\n\n**Network Performance**\n- Over-fetching (large responses where small ones suffice)\n- Chatty APIs (many small requests where one batch request would work)\n- Missing pagination on list endpoints\n- Large payloads in WebSocket events\n\n**Rendering / UI Performance**\n- Expensive computations on every render\n- Missing memoization on computed values\n- Large lists without virtualization\n- Unnecessary re-renders from unstable references\n\n**Memory**\n- Long-lived in-memory stores that grow unbounded\n- Event listeners added but never removed\n- Timers/intervals not cleared on component unmount\n\n```\n## Performance Assessment\n| Category | Issue | File:Line | Estimated Impact | Priority |\n|----------|-------|-----------|-----------------|----------|\n[one row per issue found — Priority: critical/high/medium/low]\n\n### Top Performance Risk\n[The single most impactful performance issue found — describe it in detail]\n\n### Summary\nIssues found: N (critical: X, high: Y, medium: Z, low: W)\n```',
      }, [s3]);

    step(wfId, s5, 'Security Scan',
      'Check for OWASP Top 10, auth gaps, input validation, and credential exposure.',
      300, 780, 'quality-gate',
      gate('security'), [s4]);

    step(wfId, s6, 'Accessibility Review',
      'Verify ARIA labels, keyboard navigation, color contrast, focus management, and screen reader compatibility.',
      300, 955, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Review the accessibility of the feature or system. Accessibility is not optional — it is a quality bar.\n\n**Check each category:**\n\n**ARIA & Semantic HTML**\n- Do interactive elements (buttons, links, inputs) have descriptive labels?\n- Are `aria-label` or `aria-labelledby` used where the visual label is not in the DOM?\n- Is semantic HTML used (button, nav, main, section, h1-h6) rather than divs with click handlers?\n- Are modal dialogs marked with `role="dialog"` and `aria-modal="true"`?\n\n**Keyboard Navigation**\n- Can all interactive elements be reached with Tab?\n- Is the tab order logical (top-to-bottom, left-to-right)?\n- Do modals trap focus correctly (Tab cycles within the modal)?\n- Is there a way to close every modal with Escape?\n- Are custom components (dropdowns, sliders) keyboard-operable?\n\n**Focus Management**\n- Does focus move to the modal when it opens?\n- Does focus return to the trigger element when a modal closes?\n- Are focus styles visible (not hidden with `outline: none` without replacement)?\n\n**Color & Contrast**\n- Do text/background combinations meet WCAG AA (4.5:1 for normal text, 3:1 for large text)?\n- Is information conveyed by color alone (without a secondary indicator)?\n\n**Screen Reader**\n- Do loading states have appropriate `aria-busy` or live region announcements?\n- Are error messages announced to screen readers (not just visually displayed)?\n- Are icon-only buttons labeled?\n\n```\n## Accessibility Review\n| Category | Issue | Element/File | WCAG Criterion | Severity |\n|----------|-------|-------------|----------------|----------|\n[one row per issue — Severity: critical/high/medium/low]\n\n### Summary\nIssues found: N | Critical: N | High: N | Medium: N | Low: N\nOverall accessibility score: N/10\n```',
      }, [s5]);

    step(wfId, s7, 'QA Report',
      'Compile the full QA report with health score, issue table, and recommendations. Requires human review.',
      300, 1130, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Compile the complete QA report using all findings from every previous step.\n\n```\n## QA Report: [Feature/System Name]\n**Date:** [today]\n\n---\n\n## Health Score: N/100\n[Deduct points: Critical issue = -15, High = -8, Medium = -3, Low = -1. Start at 100.]\n\n## Summary\n[2-3 sentences: overall quality, biggest concerns, what works well]\n\n---\n\n## All Issues\n| ID | Severity | Category | Description | File:Line |\n|----|----------|----------|-------------|----------|\n| QA-001 | critical | [category] | [description] | [file:line] |\n[one row per issue found across all steps]\n\n---\n\n## Golden Path: [✅ All Pass / ❌ N Failures]\n## Edge Cases: N tested, N failed\n## Error Handling: N paths, N gaps\n## Performance: N issues (N critical)\n## Security: [Clean / N issues]\n## Accessibility: N/10\n\n---\n\n## Critical Issues (fix before ship)\n[Bulleted list — each with file:line and exact fix needed]\n\n## Recommended Fixes (high priority)\n[Bulleted list]\n\n## Nice to Have (medium/low)\n[Bulleted list]\n\n---\n\n## Verdict\n**[SHIP / SHIP WITH FIXES / DO NOT SHIP]**\n[One sentence rationale]\n```',
      }, [s6], false);

    step(wfId, s8, 'Notify',
      'System notification: Full QA Review complete.',
      300, 1305, 'connector',
      { connectorType: 'system-notify', title: 'Full QA Review — Done', message: '{{workflowName}} complete. Review the QA report in NeonCore.' }, [s7]);
  }

  // ── 13. Bug Investigation ─────────────────────────────────────────────────
  {
    const wfId = stableId('Bug Investigation');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Bug Investigation',
      'Set the workflow description to the bug being investigated. Reproduce → root cause → impact assessment → fix plan (human gate) → implement → verify → capture learnings.', now);

    step(wfId, s1, 'Reproduce the Bug',
      'Establish a reliable reproduction case. Understand exactly what happens vs what should happen.',
      300, 80, 'claude-code',
      {
        ...cc('reviewer'), workflowContext: true,
        prompt: 'The bug to investigate is described above. Your first job is to understand and reproduce it.\n\n**PHASE 1 — UNDERSTAND THE SYMPTOMS**\nFrom the description, extract:\n- What action triggers the bug\n- What the user observes (the symptom)\n- What the correct behavior should be\n- When it first appeared (if known)\n- How reliably it occurs (always / sometimes / rarely)\n\n**PHASE 2 — EXPLORE THE CODE PATH**\nUsing Grep, Glob, and Read tools, trace the code path that handles the action described in the bug:\n1. Find the entry point (API route, event handler, component, cron job, etc.)\n2. Follow execution through every function call\n3. Identify where the actual behavior diverges from the expected behavior\n4. Note any conditions, flags, or state that could affect the behavior\n\n**PHASE 3 — IDENTIFY REPRODUCTION CONDITIONS**\nDetermine:\n- The exact inputs that trigger the bug\n- Any preconditions (specific state, user role, data configuration)\n- Whether the bug is deterministic or dependent on timing/environment\n\n**OUTPUT**\n```\n## Bug Reproduction Report\n\n### Bug Summary\n[1-2 sentences: what it is]\n\n### Symptom vs Expected Behavior\n| | Description |\n|--|-------------|\n| **Symptom (actual)** | [what happens] |\n| **Expected behavior** | [what should happen] |\n\n### Reproduction Steps\n1. [Step 1]\n2. [Step 2]\n[continue]\n**Preconditions:** [any required state]\n**Reliability:** [always / ~X% of the time / specific conditions]\n\n### Code Path Traced\n[entry point] → [function] → [function] → ... → [point of failure]\n\n### Point of Failure\n**File:Line:** [path:linenum]\n**Why:** [brief explanation of what the code does wrong here]\n```',
      }, []);

    step(wfId, s2, 'Root Cause Analysis',
      'Trace the bug to its deepest cause. Distinguish symptom from root cause.',
      300, 255, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Using the reproduction report from the previous step, dig to the root cause.\n\n**The 5 Whys approach:** Ask "why did this happen?" repeatedly until you reach the true origin.\n\n**PHASE 1 — TRACE THE FAILURE CHAIN**\nStarting from the point of failure identified in the reproduction step, trace backward:\n- Why does this code do the wrong thing?\n- What data or state is it operating on that causes the wrong behavior?\n- Where does that incorrect data or state come from?\n- Continue until you reach the original source of the error\n\n**PHASE 2 — CLASSIFY THE ROOT CAUSE**\nIs this:\n- A logic error in a specific function?\n- Missing null/undefined handling?\n- A race condition or timing issue?\n- Incorrect assumptions about the data shape?\n- Missing validation at a system boundary?\n- A state management bug?\n- A misunderstood API contract?\n- A regression introduced by a recent change? (check git blame if relevant)\n\n**PHASE 3 — CONFIRM THE ROOT CAUSE**\nVerify your hypothesis by tracing it forward: if the root cause is what you identified, does that explanation fully account for the symptoms described in the bug report?\n\n**OUTPUT**\n```\n## Root Cause Analysis\n\n### The 5 Whys Chain\n1. **Why** did [symptom] occur? → Because [reason 1]\n2. **Why** [reason 1]? → Because [reason 2]\n3. **Why** [reason 2]? → Because [reason 3]\n[continue until root]\n\n### Root Cause\n**Classification:** [type from phase 2]\n**Location:** [file:line]\n**Description:** [precise explanation of the original cause]\n\n### Confidence\n[HIGH / MEDIUM / LOW — and why]\n\n### Confirmation\n[Does this root cause fully explain the observed symptoms? How?]\n```',
      }, [s1]);

    step(wfId, s3, 'Impact Assessment',
      'Determine how many users are affected, what data is at risk, and whether related bugs exist.',
      300, 430, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Assess the full impact of this bug before designing a fix.\n\n**PHASE 1 — USER IMPACT**\n- Who is affected? (all users / specific roles / specific conditions)\n- How frequently does this occur? (every request / daily / rare edge case)\n- What is the user experience impact? (broken feature / wrong data / data loss / security issue)\n- Is there a workaround users can use?\n\n**PHASE 2 — DATA IMPACT**\n- Has incorrect data been written to the database?\n- Is any user data at risk of being lost or corrupted?\n- Does this bug affect historical records or only new operations?\n- Is a data migration or cleanup needed as part of the fix?\n\n**PHASE 3 — RELATED BUGS**\nUsing the root cause identified, grep for similar patterns in the codebase:\n- Are there other places where the same mistake was made?\n- Are there related code paths that have the same vulnerability?\n- Are there similar functions that should be checked for the same issue?\n\n**PHASE 4 — SEVERITY CLASSIFICATION**\nClassify overall severity:\n- **Critical**: data loss, security breach, complete feature outage for all users\n- **High**: incorrect behavior on the happy path for many users\n- **Medium**: edge case failure, usually with a workaround\n- **Low**: cosmetic or very rare condition\n\n```\n## Impact Assessment\n\n### User Impact\n- **Affected users:** [all / specific segment / edge case]\n- **Frequency:** [every time / often / rarely]\n- **UX impact:** [description]\n- **Workaround:** [exists / none]\n\n### Data Impact\n- **Data at risk:** [YES — description / NO]\n- **Cleanup needed:** [YES — description / NO]\n\n### Related Bugs Found\n| File:Line | Issue | Severity |\n|-----------|-------|----------|\n[rows if any related bugs found]\n\n### Overall Severity: [critical / high / medium / low]\n### Priority: [fix immediately / fix in next release / backlog]\n```',
      }, [s2]);

    step(wfId, s4, 'Fix Plan',
      'Design the minimal correct fix. Requires human review before any code is changed.',
      300, 605, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the root cause and impact assessment, design the fix. Keep it minimal — fix the root cause, not just the symptom.\n\n**Principles for a good bug fix:**\n1. Fix the root cause, not the symptom\n2. Make the minimal change that resolves the issue — do not refactor or improve surrounding code in the same commit\n3. The fix should be understandable to someone reading it without the bug report context\n4. Consider: could the fix break anything else?\n\n**OUTPUT**\n```\n## Fix Plan\n\n### The Fix\n**File:** [path]\n**Line(s):** [line range]\n**Change:** [describe the exact change in one sentence]\n\n### Why This Fix Works\n[How the change addresses the root cause — not just the symptom]\n\n### Code Sketch\n```[language]\n// BEFORE:\n[current code]\n\n// AFTER:\n[proposed code]\n```\n\n### What Could Break\n[Any other code paths that rely on the current (buggy) behavior]\n[Tests that may need updating]\n\n### Data Cleanup (if needed)\n[SQL or script to fix any corrupted data]\n\n### Tests to Add\n[New test cases that would have caught this bug]\n\n### Related Fixes\n[The related bugs found in impact assessment — should they be fixed in the same PR or separately?]\n```\n\n⚠️ This step has manual advance — human review required before implementation.',
      }, [s3], false);

    step(wfId, s5, 'Implement Fix',
      'Apply the fix exactly as planned. No refactoring beyond the fix scope.',
      300, 780, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'Implement the fix from the Fix Plan. Follow the plan precisely — do not make changes beyond the defined scope.\n\n**Rules:**\n1. Implement exactly what is in the Fix Plan — no more, no less\n2. If you discover the fix plan is wrong or incomplete, STOP and explain why rather than improvising\n3. Do not fix other issues you notice — log them but do not change them\n4. Add the test cases specified in the Fix Plan\n5. Do not reformat or restyle code you are not fixing\n\n**For each change made:**\n```\nCHANGED [file:line] — [brief description of what changed]\n```\n\n**For any issues noticed but NOT fixed:**\n```\nNOTED (not fixed) [file:line] — [brief description]\n```\n\n**Summary output:**\n```\n## Fix Applied\n\n### Changes Made\n[list of CHANGED lines]\n\n### Tests Added\n[list of new tests]\n\n### Scope Boundary\n[Confirm: "All changes are within the scope defined by the Fix Plan. No other changes were made."]\n```',
      }, [s4]);

    step(wfId, s6, 'Verify Fix',
      'Run the full test suite and confirm the bug no longer reproduces.',
      300, 955, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s5 }], maxCycles: 2 }, [s5]);

    step(wfId, s7, 'Capture Learnings',
      'Save bug root cause and fix pattern to project learnings.',
      300, 1130, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s6]);
  }

  // ── 14. Code Review & Audit ───────────────────────────────────────────────
  {
    const wfId = stableId('Code Review & Audit');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID();
    insertWorkflow.run(wfId, 'Code Review & Audit',
      'Set the workflow description to the branch, PR, or files to review. Deep code reading → logic review → security audit → test coverage → review report (human gate) → capture learnings.', now);

    step(wfId, s1, 'Code Reading',
      'Understand every change end-to-end before evaluating anything. No judgments yet.',
      300, 80, 'claude-code',
      {
        ...cc('reviewer'), workflowContext: true,
        prompt: 'The branch, PR, or code to review is described above. Before forming any opinions, deeply understand what the code does.\n\n**PHASE 1 — IDENTIFY THE CHANGES**\nUse Bash to run `git diff main...HEAD` (or the relevant branch comparison) to see what changed, or use Grep/Glob/Read to find the files described.\n\n**PHASE 2 — READ EVERY CHANGED FILE**\nFor each changed file:\n1. Read the full file (not just the diff)\n2. Understand its role in the system\n3. Trace how it connects to other files\n4. Follow the data flow through the changed code\n\n**PHASE 3 — BUILD A MENTAL MODEL**\nAfter reading all changes, describe:\n- What the code does (the intent)\n- How it does it (the mechanism)\n- What it depends on (inputs, state, external calls)\n- What it produces (outputs, side effects)\n\n**OUTPUT**\n```\n## Code Reading Summary\n\n### Files Changed\n| File | Change Type | Lines Changed | Role |\n|------|-------------|---------------|------|\n[one row per file — Change Type: new/modified/deleted]\n\n### What This Code Does\n[2-4 sentences: the intent and mechanism in plain English]\n\n### Data Flow\n[How data enters → is transformed → exits through the changed code]\n\n### Dependencies\n[What this code depends on that could be affected by bugs here]\n\n### First Impressions\n[No judgments yet — just: is this more complex than expected, simpler, surprising in any way?]\n```',
      }, []);

    step(wfId, s2, 'Logic Review',
      'Find logic errors, incorrect assumptions, missing edge cases, and code that could fail under real conditions.',
      300, 255, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Now that you understand the code, evaluate its correctness. Look for bugs, not style issues.\n\n**What to check:**\n\n**Logic Correctness**\n- Does the code do what its author intended?\n- Are there conditions where the logic produces the wrong result?\n- Are boolean conditions correct? (AND vs OR, negation errors)\n- Are comparison operators correct? (< vs <=, type coercion in ==)\n\n**Edge Cases**\n- What happens with empty arrays or empty strings?\n- What happens with null/undefined inputs?\n- What happens when the value is at the boundary (0, -1, MAX_INT)?\n- What happens when the list has exactly 1 item?\n\n**Async Correctness**\n- Are all promises awaited?\n- Could a state update happen after a component unmounts?\n- Could two concurrent calls produce a race condition?\n- Are side effects triggered in the right order?\n\n**State Mutations**\n- Is any shared state mutated without proper synchronization?\n- Are objects or arrays mutated directly instead of creating new ones?\n- Could a reference escape its intended scope?\n\n**Error Handling**\n- What happens when an API call fails?\n- Are errors propagated correctly or silently swallowed?\n- Does the code recover to a usable state after an error?\n\n**OUTPUT**\n```\n## Logic Review\n\n| Severity | File:Line | Issue | Impact |\n|----------|-----------|-------|--------|\n[one row per issue — Severity: critical/high/medium/low/nitpick]\n\n### Detailed Issues\n#### [Issue 1 — Title]\n**File:Line:** [path:line]\n**Severity:** [level]\n**Issue:** [what is wrong]\n**Impact:** [what breaks if this is not fixed]\n**Suggested Fix:** [concrete fix]\n\n[repeat for each medium+ severity issue]\n\nTotal issues: N | Critical: N | High: N | Medium: N | Low/Nitpick: N\n```',
      }, [s1]);

    step(wfId, s3, 'Security Audit',
      'Check for injection vulnerabilities, auth gaps, data exposure, and OWASP Top 10 issues in the changed code.',
      300, 430, 'quality-gate',
      gate('security'), [s2]);

    step(wfId, s4, 'Test Coverage Check',
      'Evaluate whether the changed code is adequately tested. Identify missing test cases.',
      300, 605, 'claude-code',
      {
        ...cc('tester'),
        prompt: 'Evaluate the test coverage for the code changes under review.\n\n**PHASE 1 — FIND EXISTING TESTS**\nSearch for test files related to the changed code (same module, same component, same API route). Read them.\n\n**PHASE 2 — MAP COVERAGE**\nFor each function, branch, or behavior in the changed code, determine:\n- Is there a test that exercises this code path?\n- Does the test assert the correct behavior (not just that the function runs)?\n- Are edge cases tested (empty input, error states, boundary values)?\n\n**PHASE 3 — IDENTIFY GAPS**\nList every behavior in the changed code that is not covered by existing tests.\n\n**PHASE 4 — WRITE MISSING TESTS (optional but recommended)**\nIf significant gaps exist, write the missing tests. Prefer writing tests over just reporting gaps.\n\n**OUTPUT**\n```\n## Test Coverage Report\n\n### Coverage Map\n| Function/Behavior | Test File | Test Name | Status |\n|-------------------|-----------|-----------|--------|\n[one row per testable behavior — Status: ✅ Covered / ⚠️ Partial / ❌ Not covered]\n\n### Missing Tests\n| Behavior | Why It Matters | Suggested Test |\n|----------|----------------|----------------|\n[one row per gap]\n\n### Tests Written (if any)\n[List new test files/functions written]\n\n### Coverage Score: N/10\n[Brief rationale for the score]\n```',
      }, [s3]);

    step(wfId, s5, 'Review Report',
      'Compile the full code review with verdict and action items. Requires human review and approval.',
      300, 780, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Compile the complete code review report. Be direct — give a clear verdict.\n\n```\n## Code Review Report\n\n### Summary\n[2-3 sentences: overall quality of the changes, main strengths, main concerns]\n\n### Verdict\n**[APPROVE / APPROVE WITH CHANGES / REQUEST CHANGES / REJECT]**\n[One sentence rationale]\n\n---\n\n### All Issues\n| ID | Severity | Category | File:Line | Issue |\n|----|----------|----------|-----------|-------|\n| CR-001 | critical | logic | [path:line] | [description] |\n[one row per issue found across all review steps]\n\n---\n\n### Blocking Issues (must fix before merge)\n[Bulleted list with specific file:line and exact change required]\n\n### Recommendations (should fix)\n[Bulleted list]\n\n### Minor Comments (can fix or explain)\n[Bulleted list]\n\n---\n\n### What Works Well\n[2-3 specific things done well — be specific, not generic]\n\n---\n\n### Checklist\n- [ ] Logic correct: [YES / NO — N issues]\n- [ ] Security: [CLEAN / N issues]\n- [ ] Tests adequate: [YES / PARTIAL / NO — score N/10]\n- [ ] Error handling complete: [YES / PARTIAL / NO]\n- [ ] No breaking changes: [YES / NO — describe if NO]\n```',
      }, [s4], false);

    step(wfId, s6, 'Capture Learnings',
      'Save review findings and code quality patterns to project learnings.',
      300, 955, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s5]);
  }

  // ══════════════════════════════════════════════════════════════════════
  // COMPOUND ENGINEERING × GSTACK — 7-phase feature delivery templates
  // Launch context: enter the feature slug (e.g. "user-auth-v2") so
  // every step can read/write to docs/[slug]/ and todos/[slug]/.
  // ══════════════════════════════════════════════════════════════════════
}
