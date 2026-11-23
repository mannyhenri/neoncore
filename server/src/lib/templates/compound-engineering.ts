/**
 * Standard workflow templates: the CE phase templates. Seeded on every boot by ./index.ts.
 *
 * There is no Phase 1 — Interrogate any more. Feature scoping asks the person the questions and
 * writes the brief every stage receives, so Phase 1 re-ran the same interrogation with an agent
 * answering its own questions. Phase 2 plans from that scope; the phases keep their numbers so a
 * name the person knows still means the same thing.
 */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

export function seedCompoundEngineering({ now, stableId, insertWorkflow, step, cc, gate }: SeedKit): void {
  // ── CE Phase 2 — Plan ─────────────────────────────────────────────────
  {
    const wfId = stableId('CE: Phase 2 — Plan');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 2 — Plan',
      'Pressure-test the plan from 3 angles before any code is written. Load the feature scope → CEO review → Eng review → CE Plan research → merge to docs/[slug]/plan.md.', now);

    step(wfId, s1, 'Load Scope',
      'Read the feature scope from the workflow context (and docs/[slug]/brainstorm.md when one exists) and prepare a structured summary for the three reviews.',
      450, 80, 'claude-code',
      { ...cc('researcher'), workflowContext: true, prompt: 'The feature scope is in workflow context above — the brief, in/out of scope, assumptions and the decisions the person made while scoping. Treat it as settled.\n\nIf docs/[slug]/brainstorm.md exists, read it too (older features have one). Read CLAUDE.md and docs/solutions/ for patterns and prior decisions that touch this feature.\n\nOutput a structured summary:\n```\n## Scope Summary for Plan Review\n\nFeature: [name] | Slug: [slug]\nApproach: [one sentence]\nEffort: [S/M/L]\n\n### Files / Modules Affected\n[list]\n\n### Key Constraints\n[list]\n\n### Still Open\n[list — or "None"]\n\n### Definition of Done\n[checklist]\n```' }, []);

    step(wfId, s2, '/plan-ceo-review',
      'Scope check, 10-star product test, 4 scope modes.',
      150, 255, 'claude-code',
      { ...cc('planner'), prompt: 'Run /plan-ceo-review. The scope summary is above.\n\nPick ONE of 4 scope modes and argue it:\n- EXPANSION: should we build MORE? What value are we leaving on the table?\n- SELECTIVE EXPANSION: core + one high-value addition. What is the addition?\n- HOLD SCOPE: the proposal is right as stated. Defend it.\n- REDUCTION: we are overbuilding. What is the minimum that still delivers real value?\n\nRun the 10-star product test:\n- 7/10 version (mediocre but ships): [description]\n- 10/10 version (legendary, 10x longer): [description]\n- Recommended target: [N/10] — [why]\n\nOutput:\n```\n## CEO Review\n\n### Mode: [NAME]\n[3-4 sentence argument]\n\n### 10-Star Test\n7/10: [description]\n10/10: [description]\nTarget: [N/10] — [why]\n\n### Scope Recommendation\nIn: [list] | Out: [list]\n\n### Risk Flags\n- [flag]\n- [flag]\n```' }, [s1]);

    step(wfId, s3, '/plan-eng-review',
      'Architecture, data flow diagram, edge cases, test matrix, security concerns.',
      450, 255, 'claude-code',
      { ...cc('architect'), prompt: 'Run /plan-eng-review. The scope summary is above.\n\nWhen the design depends on an uncertain interface, interaction, or feasibility question, run CE /ce-prototype to answer it cheaply. When two viable implementations remain and evidence can choose between them, run CE /ce-bakeoff against the same acceptance criteria. Record the evidence and discard exploratory code.\n\n1. DATA FLOW — draw ASCII diagram: User action → [layers] → DB/API → response → UI state\n\n2. AFFECTED FILES — table: File | Change Type | Why\n\n3. KEY INTERFACES — types/interfaces to create or modify\n\n4. EDGE CASES — top 5: Case | Input | Expected behavior | Failure mode\n\n5. TEST MATRIX — minimum test coverage: Test | Type (unit/integration/e2e) | What it verifies\n\n6. FAILURE MODES — what breaks in production if this fails?\n\n7. SECURITY CONCERNS — auth, authorization, input validation, data exposure at design level\n\nOutput all sections clearly labeled.' }, [s1]);

    step(wfId, s4, 'CE Plan Research',
      'Research repo patterns, framework docs, and best practices.',
      750, 255, 'claude-code',
      { ...cc('researcher'), prompt: 'Run /ce-plan research. The scope summary is above.\n\n**REPO PATTERNS**: existing patterns for this feature type, prior similar implementations, naming/file/test conventions.\n\n**FRAMEWORK DOCS**: for each framework/library this feature uses: official approach, version constraints, recommended patterns.\n\n**BEST PRACTICES**: industry-standard approaches, what senior engineers get wrong on this type of feature, security/performance best practices.\n\nSynthesize into:\n```\n## CE Plan Research\n\n### Existing Codebase Patterns\n[what to follow, what already exists]\n\n### Framework Guidance\n[official approach + version constraints]\n\n### Industry Best Practices\n[key patterns + pitfalls to avoid]\n\n### Implementation Recommendations\n- [specific recommendation]\n- [specific recommendation]\n- [specific recommendation]\n```' }, [s1]);

    step(wfId, s5, 'Write Plan Doc',
      'Merge CEO review, Eng review, and CE research into docs/[slug]/plan.md. Pauses for human review.',
      450, 430, 'claude-code',
      { ...cc('planner'), prompt: 'Merge the three review outputs into a canonical plan document.\n\nWRITE docs/[slug]/plan.md:\n- ## Overview (what, why, how — one paragraph)\n- ## Scope (in / out — from CEO review)\n- ## Architecture (data flow ASCII + interfaces — from Eng review)\n- ## Affected Files (table: file | change type | why)\n- ## Implementation Steps (numbered, ordered, each step is one actionable task)\n- ## Test Plan (table: test | type | what it verifies)\n- ## Security Checklist (from Eng review)\n- ## Rollback Plan (how to revert if something goes wrong)\n- ## Open Decisions (items still requiring human input)\n\nOutput gate summary:\n```\n## Phase 2 — AWAITING HUMAN REVIEW\n\nFeature: [name] | Slug: [slug]\nAffected files: [count]\nImplementation steps: [count]\nRisks identified:\n- [risk]\nOpen decisions:\n- [decision]\nFile written: docs/[slug]/plan.md\n```', }, [s2, s3, s4], false);

    step(wfId, s6, 'Phase 2 Complete',
      'Phase 2 — Plan complete. Plan doc is ready for review.',
      450, 605, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 2 — Plan Done', message: 'Plan ready. Review docs/[slug]/plan.md then advance to Phase 3.' }, [s5]);
  }

  // ── CE Phase 3 — Implement ────────────────────────────────────────────
  {
    const wfId = stableId('CE: Phase 3 — Implement');
    const s1 = randomUUID(), s1b = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 3 — Implement',
      'Isolated implementation in a git worktree. Load plan → write failing tests (TDD) → implement → run tests → build summary. When the build summary passes, CE: Phase 4 — Review starts automatically on the same project and cartridge.', now);

    step(wfId, s1, 'Load Plan + Worktree',
      'Read docs/[slug]/plan.md, create isolated git worktree on feature branch, and output a step checklist.',
      300, 80, 'claude-code',
      { ...cc('architect'), workflowContext: true, prompt: 'The feature slug is in workflow context above.\n\n1. READ docs/[slug]/plan.md in full.\n2. Create an isolated git worktree:\n   git worktree add ../[slug]-work feature/[slug]\n   If it already exists, verify it is on the correct branch.\n3. Safety mode: before any destructive operation (file deletion, DROP TABLE, force-push), state what you are about to do and confirm via the plan.\n\nOutput:\n```\n## Phase 3 Setup\n\nFeature: [name] | Slug: [slug]\nWorktree: ../[slug]-work\nBranch: feature/[slug]\nPlan loaded: [N] implementation steps\n\n### Step Checklist\n[ ] Step 1: [name]\n[ ] Step 2: [name]\n[all steps from plan]\n```' }, []);

    step(wfId, s1b, 'Write Failing Tests',
      'TDD: write real failing tests for every item in the plan\'s test matrix before any implementation code exists. Commit the test files.',
      300, 255, 'claude-code',
      { ...cc('tester'), prompt: 'Read the Test Plan section from docs/[slug]/plan.md. Write real, runnable tests for every item in that plan — before any implementation code exists.\n\n### PHASE 1 — FIND TEST CONVENTIONS\n1. Search the project for existing test files: `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `__tests__/`, `test/`, `spec/`.\n2. Read 2-3 representative test files to understand: framework (Jest, Vitest, etc.), assertion style, mock patterns, file naming, and import conventions.\n\n### PHASE 2 — WRITE FAILING TESTS\nFor each row in the Test Plan table from docs/[slug]/plan.md:\n1. Write a real test using the project\'s framework and conventions.\n2. Each test must cover: happy path + at least 2 edge cases + at least 1 error state per requirement.\n3. Place each test in the correct file — extend an existing test file or create a new one following project conventions.\n4. Do NOT write implementation code. Import the functions/modules by their final intended path — they may not exist yet, and that is expected.\n\n### PHASE 3 — CONFIRM THEY FAIL\nRun the test suite (or just the new test files) and confirm that every new test FAILS.\n- If a test passes before any implementation: the test is wrong — rewrite it so it actually verifies the behavior.\n- If a test fails with "module not found": that is acceptable — the implementation file does not exist yet.\n\n### OUTPUT\n```\n## TDD Test Manifest\n\n### Tests Written\n| File | Test Name | Plan Row | Status |\n|------|-----------|----------|--------|\n[one row per test — Status must be FAIL or MODULE NOT FOUND]\n\n### Test Run Output\n[paste relevant test runner output]\n\n### Summary\nTests written: N | All failing: [YES / NO — if NO, list the ones that incorrectly pass]\n```\n\nCommit the test files: "test: [slug] — write failing TDD tests for Phase 3"' }, [s1]);

    step(wfId, s2, 'CE Implement',
      'Execute every step in the plan sequentially. WIP commits after each step. Adapt and document any deviations.',
      300, 430, 'claude-code',
      { ...cc('backend'), prompt: 'Run /ce-work. Plan, worktree setup, and failing tests are above.\n\nRules:\n1. Execute implementation steps IN ORDER from the plan. Do not skip.\n2. After each file changed: run the relevant linter/type-checker for that file.\n3. After each step: WIP commit — format: "WIP: [slug] — step N: [name]"\n4. If a step reveals a problem with the plan: adapt, implement the better approach, and document the deviation.\n5. Do NOT modify the test files written in the previous step — make the implementation satisfy them.\n6. Do NOT open a PR.\n7. After behavior is correct, run CE /ce-simplify-code over the changed implementation. Remove needless complexity and duplication without changing behavior, rerun focused tests, and revert any simplification that changes behavior.\n\nOutput after all steps:\n```\n## Implementation Complete\n\n### Steps Executed\n[numbered list — each: ✅ done or ⚠️ DEVIATED: [what changed and why]]\n\n### Files Changed\n[list]\n\n### Deviations from Plan\n[list — or "None"]\n```' }, [s1b]);

    step(wfId, s3, 'Run Tests',
      'Execute full test suite. Routes back to CE Implement if any tests fail (max 3 cycles).',
      300, 605, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s2 }], maxCycles: 3 }, [s2]);

    step(wfId, s4, 'Build Summary',
      'Run type check, lint, and coverage check. Write todos/[slug]/build-summary.md. STATUS: PASS starts Phase 4.',
      300, 780, 'claude-code',
      { ...cc('reviewer'), prompt: 'Run full pre-merge verification. Do NOT open a PR.\n\n1. TYPE CHECK: run tsc --noEmit (or equivalent). Report: clean / N errors.\n2. LINT: run the linter. Report: clean / N issues.\n3. COVERAGE: check test coverage. Report: N%. Flag if below project threshold.\n\nWRITE todos/[slug]/build-summary.md with:\n- Tests: [N passing / N failing]\n- Type check: [clean / N errors]\n- Lint: [clean / N issues]\n- Coverage: [N%]\n- Files changed: [list]\n- Deviations from plan: [list or "None"]\n\nOutput:\n```\nSTATUS: [PASS — ready for Phase 4] | [FAIL — resolve before continuing]\n\n[If FAIL: list each blocking issue with file:line]\n```' }, [s3]);

    step(wfId, s5, 'Phase 3 Complete',
      'Phase 3 — Implement complete.',
      300, 955, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 3 — Implement Done', message: 'Build complete. Phase 4 — Review starts automatically if the build summary passed.' }, [s4]);

    // THE PHASE CONTINUES. This description always said "Auto-continues to Phase 4" while the run
    // ended on a notification. The connector starts Phase 4 on the same project and cartridge with
    // the same launch context (the slug) — but only when Build Summary reported STATUS: PASS: a
    // build that failed its checks must not go on to open a PR. See lib/workflow-continue.ts.
    step(wfId, s6, 'Continue to Phase 4',
      'Starts CE: Phase 4 — Review when the build summary reported STATUS: PASS.',
      300, 1130, 'connector',
      { connectorType: 'launch-workflow', templateName: 'CE: Phase 4 — Review', continueIfStep: 'Build Summary', continueIfContains: 'STATUS: PASS' }, [s5]);
  }

  // ── CE Phase 4 — Review ───────────────────────────────────────────────
  {
    const wfId = stableId('CE: Phase 4 — Review');
    const s1 = randomUUID(), s2 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID(), s8b = randomUUID(), s9 = randomUUID(), s10 = randomUUID(), s11 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 4 — Review',
      'Specialist reviews (security, perf, architecture, quality, codex) → triage P1/P2/P3 → decision checkpoint → resolve P2s → open PR.', now);

    step(wfId, s1, 'Load Diff + Build Summary',
      'Read the feature plan and current git diff. Prepare review context for the specialist reviews.',
      650, 80, 'claude-code',
      { ...cc('reviewer'), workflowContext: true, prompt: 'The feature slug is in workflow context above.\n\n1. READ docs/[slug]/plan.md\n2. READ todos/[slug]/build-summary.md\n3. Run: git diff main...HEAD to get the full diff.\n\nOutput structured dispatch context:\n```\n## Review Dispatch Context\n\nFeature: [name] | Slug: [slug]\nBranch: feature/[slug]\nFiles changed: [count] — [list]\nTests: [passing/failing]\nCoverage: [N%]\n\n### Diff Summary\n[brief description of what changed, organized by file]\n\n### Plan Reference\ndocs/[slug]/plan.md\n```' }, []);

    step(wfId, s2, 'Security Review',
      'CE security-sentinel + /cso: OWASP Top 10 and a STRIDE threat model, verified findings only.',
      100, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'Run CE security-sentinel and /cso on this change. Diff and context are above.\n\nOWASP Top 10: injection (SQL, command, XSS, template); broken authentication/session management; sensitive data exposure; broken access control or missing authorization checks; security misconfiguration; insecure deserialization; missing input validation on user-controlled values; hardcoded credentials or API keys; error messages that leak internals; insecure transport.\n\nSTRIDE: spoofing, tampering, repudiation (is there an audit trail?), information disclosure, denial of service, elevation of privilege.\n\nReport only findings with 8/10+ confidence; exclude false positives. For each: file:line | category | severity (critical/high/medium) | description | fix\n\nEnd with: SECURITY: CLEAN or SECURITY: N FINDINGS (critical: X, high: Y, medium: Z)' }, [s1]);

    step(wfId, s4, 'Performance Oracle',
      'CE performance-oracle: N+1 queries, missing indexes, caching gaps, algorithmic bottlenecks.',
      560, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'You are CE performance-oracle. Diff and context are above.\n\nAnalyze for performance issues:\n1. N+1 QUERIES — loops that trigger per-iteration DB calls\n2. MISSING INDEXES — WHERE clauses on un-indexed columns\n3. FULL TABLE SCANS — queries without WHERE or with non-selective conditions\n4. MISSING CACHING — expensive operations that run on every request unnecessarily\n5. ALGORITHMIC COMPLEXITY — O(n²) or worse where O(n) or O(log n) is feasible\n6. BLOCKING OPERATIONS — sync calls in hot paths, missing pagination\n7. MEMORY LEAKS — objects retained in long-lived scope, event listeners not cleaned up\n8. UNNECESSARY RE-RENDERS — React/UI components re-rendering on every tick\n\nFor each finding: file:line | issue type | severity | description | suggested fix\n\nEnd with: PERFORMANCE: CLEAN or PERFORMANCE: N FINDINGS' }, [s1]);

    step(wfId, s5, 'Architecture Review',
      'CE architecture-strategist + pattern-recognition: system design, component boundaries, anti-patterns.',
      790, 255, 'claude-code',
      { ...cc('architect'), prompt: 'You are CE architecture-strategist and pattern-recognition-specialist combined. Diff and context are above.\n\nARCHITECTURE:\n1. Does this respect existing component boundaries and separation of concerns?\n2. Does data flow in the right direction? (no circular dependencies, no leaking internals)\n3. Does this create inappropriate coupling between modules?\n4. Does this belong at the right layer? (UI logic in UI, business logic in services, etc.)\n5. Will this scale? Any bottlenecks at the architectural level?\n\nPATTERNS:\n1. Does this follow the patterns already established in this codebase?\n2. Any anti-patterns: God objects, anemic models, magic numbers, shotgun surgery?\n3. Any code smells: duplicated logic, long functions, deep nesting, inconsistent naming?\n4. Any YAGNI violations: abstractions for hypothetical future requirements?\n\nFor each finding: file:line | category | severity | description | recommendation\n\nEnd with: ARCHITECTURE: CLEAN or ARCHITECTURE: N FINDINGS' }, [s1]);

    step(wfId, s6, 'Code Quality Review',
      'CE code-simplicity-reviewer + /review: production bugs that pass CI, completeness gaps, readability.',
      1020, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'You are CE code-simplicity-reviewer and staff-engineer reviewer combined. Diff and context are above.\n\nSIMPLICITY CHECK:\n1. Is there code that is more complex than it needs to be?\n2. Any premature abstractions — base classes, factories, registries for one use case?\n3. Any dead code introduced in this PR?\n4. Are variable/function names clear without needing comments?\n\nPRODUCTION READINESS (bugs that pass CI):\n1. Unhandled error states — what happens when this fails in production?\n2. Missing loading/empty states in UI\n3. Race conditions on concurrent requests\n4. Hard-coded values that should be config\n5. Missing logging for production debugging\n6. Incomplete feature — does the implementation fully satisfy the plan?\n\nFor each finding: file:line | category | severity | description | fix\n\nEnd with: QUALITY: CLEAN or QUALITY: N FINDINGS' }, [s1]);

    step(wfId, s7, 'Codex — Cross-Model Review',
      '/codex: independent review from a second model, with no shared context with the other reviews.',
      1250, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'Run /codex — an independent cross-model review. You have NOT seen the other reviews.\n\nReview the diff and plan with completely fresh eyes:\n1. Read the diff carefully. Understand what it does.\n2. Read the plan. Does the implementation match the intent?\n3. Without being primed by other reviewers: what are the top 3 issues you notice?\n4. PASS/FAIL verdict: would you merge this into production as-is?\n\nOutput:\n```\n## Codex Review\n\n### Top Findings\n1. [file:line] SEVERITY: [level] — [description]\n2. [file:line] SEVERITY: [level] — [description]\n3. [file:line] SEVERITY: [level] — [description]\n\n### Implementation vs. Plan\n[Does the code do what the plan says? Any gaps?]\n\n### Verdict\nCODEX: [PASS | PASS WITH NOTES | FAIL]\n[one sentence rationale]\n```' }, [s1]);

    step(wfId, s8, 'Triage — P1 / P2 / P3',
      'Consolidate the review findings. Classify P1/P2/P3. Auto-resolve P3. Write todos/[slug]/p1.md and p2.md.',
      650, 430, 'claude-code',
      { ...cc('planner'), prompt: 'The five review outputs are above. Consolidate and classify.\n\nClassification:\n- P1 — must fix before merge: security holes, data loss, broken core functionality, critical logic errors\n- P2 — should fix before merge: performance issues, architectural debt, incomplete error handling\n- P3 — nice to fix: style, naming, minor simplification → auto-resolve these now\n\nSteps:\n1. Deduplicate overlapping findings across agents.\n2. Classify every unique finding as P1, P2, or P3.\n3. AUTO-RESOLVE all P3 findings now (make the changes).\n4. WRITE todos/[slug]/p1.md — one finding per line: file:line | issue | severity | agent that found it\n5. WRITE todos/[slug]/p2.md — same format.\n\nOutput:\n```\n## Triage Complete\n\nP1 findings: [count] — [bullet list of each]\nP2 findings: [count] — [bullet list of each]\nP3 findings: [count] — auto-resolved\n\nFiles written:\n- todos/[slug]/p1.md ([count] items)\n- todos/[slug]/p2.md ([count] items)\n```' }, [s2, s4, s5, s6, s7]);

    step(wfId, s8b, 'Review Decision',
      'Human decision: review triage results and choose how to proceed. Pick "Fix P1s" even if the list is empty — the next step handles it gracefully.',
      650, 605, 'decision',
      {
        question: 'Triage complete. How do you want to proceed?',
        eli10: 'The review agents found issues, which are now classified. P3s were auto-fixed. P2s will be resolved next. P1s are blockers — read todos/[slug]/p1.md before choosing.',
        stakes: 'P1 findings include security holes, data loss risks, or broken functionality. Proceeding with known P1s is a deliberate risk decision.',
        recommendation: 'fix-p1s',
        options: [
          { id: 'fix-p1s', label: 'Fix P1s, then proceed', description: 'Address all P1 findings before opening the PR. The next step will fix them alongside P2s.' },
          { id: 'proceed-as-is', label: 'Accept risk and proceed', description: 'No blocking P1s, or they are confirmed false positives. Proceed directly to opening the PR.' },
          { id: 'abandon-pr', label: 'Abandon this PR', description: 'Findings are too severe. Close the branch and re-plan from Phase 2.' },
        ],
      }, [s8]);

    step(wfId, s9, 'Resolve P1s + P2s',
      'Fix all P1 findings (if any) and all P2 findings from the triage. Each fix gets its own focused commit.',
      650, 780, 'claude-code',
      { ...cc('backend'), prompt: 'The review decision and triage results are above.\n\nIf the human chose "Fix P1s, then proceed":\n1. READ todos/[slug]/p1.md — fix every P1 first, in priority order.\n2. Commit each fix: "fix: [slug] P1 — [description]"\n\nIf the human chose "Accept risk and proceed":\n1. Skip P1 fixes — they are accepted as-is.\n\nThen fix ALL P2 findings regardless of the P1 decision:\n1. READ todos/[slug]/p2.md\n2. Fix each P2 with a focused commit: "fix: [slug] P2 — [description]"\n\nDo not introduce new logic beyond the fixes.\n\nOutput:\n```\n## Resolutions\n\nP1s fixed: [count] | [list]\nP2s fixed: [count] | [list]\n```' }, [s8b]);

    step(wfId, s10, 'Open PR',
      'Squash WIP commits and run /ship to open the PR. Human reviews before merge.',
      650, 955, 'claude-code',
      { ...cc('backend'), prompt: 'Open the PR for this feature.\n\n1. Squash WIP commits: git rebase -i to collapse all "WIP:" prefixed commits.\n2. Run /ship (push branch + open PR) with this PR body:\n\n```\n## [Feature Name]\n\n**Plan:** docs/[slug]/plan.md\n**Build:** Tests [N passing] | Coverage [N%] | Lint [clean]\n\n### What changed\n[2-3 bullet points from the implementation]\n\n### P1 findings\n[resolved list — or "None / accepted as-is"]\n\n### P2 findings resolved\n[count] fixed\n\n### Test coverage delta\n[N% → N%]\n```\n\n3. Check the PR once for existing review comments and failed checks. Run CE /ce-resolve-pr-feedback for every actionable comment, add or update regression tests when behavior changes, push the fixes, and name every unresolved thread.\n4. Output the PR URL and unresolved-feedback count.\n\nDo NOT merge. Human reviews the PR.', }, [s9], false);

    step(wfId, s11, 'Phase 4 Complete',
      'Phase 4 — Review complete. PR is open.',
      650, 1130, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 4 — Review Done', message: 'PR is open. Advance to Phase 5 — QA.' }, [s10]);
  }

  // ── CE Phase 5 — QA ───────────────────────────────────────────────────
  {
    const wfId = stableId('CE: Phase 5 — QA');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 5 — QA',
      'Real-browser QA on staging. Walk every user flow, fix bugs with atomic commits, write regression tests. Enter [slug] and [staging URL] in launch context.', now);

    step(wfId, s1, 'QA Browser Run',
      'Run /qa [staging URL]: real Chromium, walk all flows from the plan, fix each bug atomically, write regression tests.',
      300, 80, 'claude-code',
      { ...cc('tester'), workflowContext: true, prompt: 'The feature slug and staging URL are in workflow context above.\n\nRun /qa on the staging URL:\n1. Launch a real browser and navigate to the staging environment.\n2. Read docs/[slug]/plan.md — identify every user flow defined there.\n3. Walk through EVERY flow systematically:\n   - Happy path\n   - Each edge case from the plan\n   - Error states (invalid input, network failure, empty state)\n4. For each bug found:\n   a. Document: what you did → what happened → what was expected\n   b. Fix it with one atomic commit: "fix: [slug] QA — [description]"\n   c. Write a regression test that would have caught it\n   d. Re-verify the fix in the browser before moving on\n5. Continue until all flows pass.\n\nOutput:\n```\n## QA Run — [feature name]\n\n### Flows Tested\n[list each flow with ✅ PASS or 🐛 BUG FOUND + FIXED]\n\n### Bugs Found and Fixed\n[bug description | commit | regression test written]\n\n### Flows Failing (if any)\n[description + what was tried]\n\nSTATUS: [ALL FLOWS PASSING] | [N FLOWS FAILING]\n```' }, []);

    step(wfId, s2, 'CE Three Questions',
      'Ask the 3 CE implementation quality questions. Answers expose hidden uncertainty before shipping.',
      300, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'Answer these 3 CE quality questions about this implementation honestly:\n\n**Q1 — HARDEST DECISION**: What was the hardest technical decision made in this implementation? Why was it hard? What was the alternative?\n\n**Q2 — REJECTED ALTERNATIVES**: What other approaches were considered and rejected? For each: what was it, why was it rejected, and could rejecting it turn out to be wrong?\n\n**Q3 — LEAST CONFIDENT**: What part of this implementation are you least confident about? What could go wrong with it in production that you have not fully accounted for?\n\nBe honest. The goal is to surface real uncertainty, not to look good.\n\nAppend answers to todos/[slug]/qa-report.md.' }, [s1]);

    step(wfId, s3, 'Investigate Uncertainties',
      'Run /investigate on anything flagged as uncertain. Iron Law: no fixes without root cause first. Escalate after 3 failed attempts.',
      300, 430, 'claude-code',
      { ...cc('reviewer'), prompt: 'Read the CE Three Questions output above. For each item flagged as uncertain:\n\nRun /investigate — Iron Law: never fix before understanding root cause.\n\nFor each uncertain item:\n1. Form a hypothesis: "I think X because Y"\n2. Test the hypothesis: read the relevant code, add a debug log, check the failing test\n3. If hypothesis is wrong: form a new one. Max 3 attempts per item.\n4. If confirmed: document the root cause and either fix it or escalate.\n\nEscalation rule: if after 3 attempts you cannot determine root cause → write to todos/[slug]/escalations.md and mark for human review. Do NOT attempt a fix.\n\nOutput:\n```\n## Investigation Results\n\n### [Uncertainty 1]\nHypothesis: [what you thought]\nFindings: [what you found]\nOutcome: [RESOLVED: fix applied] | [ESCALATED: see todos/[slug]/escalations.md]\n```' }, [s2]);

    step(wfId, s4, 'QA Report',
      'Write final todos/[slug]/qa-report.md. Pauses for human review if any flows are failing or escalations exist.',
      300, 605, 'claude-code',
      { ...cc('planner'), prompt: 'Compile the final QA report.\n\nWRITE todos/[slug]/qa-report.md:\n- ## QA Summary\n- ## Flows Tested (count + list with pass/fail)\n- ## Bugs Found and Fixed (count + descriptions + commits)\n- ## Regression Tests Added (count + file locations)\n- ## CE Three Questions Answers\n- ## Escalations (if any — link to todos/[slug]/escalations.md)\n- ## Status: ALL PASSING | N FAILING\n\nOutput gate summary:\n```\n## Phase 5 — QA REPORT\n\nFlows tested: [count]\nBugs found and fixed: [count]\nRegression tests added: [count]\nEscalations: [count — or "None"]\n\nSTATUS: [ALL FLOWS PASSING — advance to Phase 6] | [ESCALATIONS EXIST — human decision required]\n```', }, [s3], false);

    step(wfId, s5, 'Phase 5 Complete',
      'Phase 5 — QA complete. All flows passing.',
      300, 780, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 5 — QA Done', message: 'QA passed. Review qa-report then advance to Phase 6 — Ship.' }, [s4]);
  }

  // ── CE Phase 6 — Ship ─────────────────────────────────────────────────
  {
    const wfId = stableId('CE: Phase 6 — Ship');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s4b = randomUUID(), s4c = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 6 — Ship',
      'Document release → human merge approval → land & deploy → 10-min canary → decision checkpoint (all clear / rollback / hotfix).', now);

    step(wfId, s1, 'Document Release',
      'Run /document-release: cross-reference the diff against all docs, update stale content, flag gaps.',
      300, 80, 'claude-code',
      { ...cc('planner'), workflowContext: true, prompt: 'Run /document-release for the [slug] feature.\n\n1. Read the full diff: git diff main...HEAD\n2. Read every documentation file in the project: README.md, ARCHITECTURE.md, CONTRIBUTING.md, CLAUDE.md, any docs/ files.\n3. For each doc file: does the diff change anything this document describes? If yes, update it.\n4. Cross-reference the implementation against the docs. Flag any documentation that:\n   - Describes behavior that no longer exists\n   - Is missing documentation for new behavior\n   - Has stale file paths, function names, or configuration keys\n5. Update what you can automatically. Flag what requires human judgment.\n\nOutput:\n```\n## Document Release Report\n\n### Files Updated\n[file | what was updated]\n\n### Stale Docs Flagged (require human update)\n[file | what is stale | why it needs human judgment]\n\n### Coverage\n[All docs current] | [N items flagged for human review]\n```' }, []);

    step(wfId, s2, 'Merge Gate',
      'Human merge approval gate. Review the PR, QA report, and doc release report before approving merge.',
      300, 255, 'claude-code',
      { ...cc('planner'), prompt: 'Prepare the merge approval summary for human review.\n\nCollect and summarize:\n1. PR URL and title\n2. QA status from todos/[slug]/qa-report.md\n3. Doc release status from above\n4. Build summary: tests, coverage, lint\n5. Any remaining P1 findings\n\nOutput:\n```\n## Phase 6 — AWAITING MERGE APPROVAL\n\nPR: [URL]\nQA: [ALL FLOWS PASSING]\nDocs: [updated / N items flagged]\nBuild: Tests [N] | Coverage [N%] | Lint [clean]\nP1 findings: [None | list]\n```\n\nDo NOT merge.', }, [s1], false);

    step(wfId, s3, 'Land & Deploy',
      'Run /land-and-deploy: merge PR, wait for CI, deploy, verify production health endpoint.',
      300, 430, 'claude-code',
      { ...cc('backend'), prompt: 'Human has approved the merge. Run /land-and-deploy:\n\n1. MERGE the PR (do not squash unless project convention requires it).\n2. Wait for CI to complete — poll every 30 seconds. Fail loudly if CI fails.\n3. Wait for the deploy to complete — check the deploy pipeline status.\n4. VERIFY production health: hit the health endpoint and confirm 200 OK.\n5. Do a quick smoke test: navigate to the feature in production, confirm it loads.\n\nOutput:\n```\n## Deploy Status\n\nMerge: [commit SHA]\nCI: [PASSED in Nm]\nDeploy: [COMPLETED at HH:MM]\nHealth check: [200 OK]\nSmoke test: [PASS]\n\nProduction is live.\n```' }, [s2]);

    step(wfId, s4, 'Canary Watch',
      'Monitor production for 10 minutes post-deploy. Watch for console errors, performance regressions, page failures.',
      300, 605, 'claude-code',
      { ...cc('reviewer'), prompt: 'Monitor production for 10 minutes after deploy.\n\nWatch for:\n1. Console errors / JS exceptions in the browser\n2. API error rate increase (check logs or monitoring)\n3. Page load time regression (>20% slower than baseline)\n4. Any 4xx or 5xx errors from the new feature endpoints\n5. User-visible failures in the feature flows\n\nCheck every 2 minutes. After 10 minutes, report:\n\n```\n## Canary Report — [feature name]\n\nDuration: 10 minutes\nErrors found: [count]\nPerformance regression: [None | description]\nPage failures: [None | description]\n\nCANARY STATUS: [CLEAN] | [REGRESSION: description]\n```' }, [s3]);

    step(wfId, s4b, 'Canary Decision',
      'Human decision: review the 10-minute canary report and choose the recovery path.',
      300, 780, 'decision',
      {
        question: 'Canary watch complete. What is the production status?',
        eli10: 'The canary ran for 10 minutes watching production. Read the Canary Report above before choosing. When in doubt, rollback — it\'s always reversible.',
        stakes: 'A regression in production affects real users right now. Rollback is safe and reversible. Hotfix is riskier but avoids downtime.',
        recommendation: 'all-clear',
        options: [
          { id: 'all-clear', label: 'All clear — proceed to Compound', description: 'Canary is clean. No errors, no regressions. The feature is stable in production.' },
          { id: 'rollback', label: 'Rollback immediately', description: 'Regression confirmed. Revert the merge and restore the previous production state.' },
          { id: 'hotfix', label: 'Ship a hotfix', description: 'Regression is minor and fixable in-place. Patch and redeploy without reverting.' },
        ],
      }, [s4]);

    step(wfId, s4c, 'Recovery Action',
      'Execute the chosen recovery: pass through on all-clear, rollback the merge, or implement and deploy a hotfix.',
      300, 955, 'claude-code',
      { ...cc('backend'), prompt: 'The canary decision is above. Execute based on the choice:\n\n**If ALL CLEAR:**\nNo action needed. Output: "Production is stable. Proceeding to Phase 7."\n\n**If ROLLBACK:**\n1. Revert the merge commit: `git revert <merge-sha> --no-edit`\n2. Push the revert: `git push`\n3. Wait for CI and deploy to complete.\n4. Verify the health endpoint returns 200 OK.\n5. Output: "Rollback complete. Feature reverted. Re-plan from Phase 2 if you want to retry."\n\n**If HOTFIX:**\n1. Identify the regression from the canary report.\n2. Implement the minimal fix.\n3. Commit: "hotfix: [slug] — [description of regression fix]"\n4. Push and wait for CI + deploy.\n5. Verify the regression is gone in production.\n6. Output: "Hotfix deployed. Verify production before proceeding."' }, [s4b]);

    step(wfId, s5, 'Phase 6 Complete',
      'Phase 6 — Ship complete. Feature is live in production.',
      300, 1130, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 6 — Shipped!', message: 'Phase 6 complete. Advance to Phase 7 — Compound.' }, [s4c]);
  }

  // ── CE Phase 7 — Compound ─────────────────────────────────────────────
  {
    const wfId = stableId('CE: Phase 7 — Compound');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 7 — Compound',
      'Make the next feature cheaper. CE compound → update CLAUDE.md → retro → learn. The most important phase — do not skip.', now);

    step(wfId, s1, 'CE Compound',
      'Run /ce-compound: extract what was learned and write docs/solutions/[slug].md.',
      300, 80, 'claude-code',
      { ...cc('researcher'), workflowContext: true, prompt: 'Run /ce-compound for the [slug] feature. Canary is clean.\n\nCover:\n\n**Context**: What problem did this feature solve? What was the real user need vs. the stated requirement?\n\n**Solution**: What worked well in this implementation? What did not work and had to be abandoned? What surprised you?\n\n**Related docs**: Search docs/solutions/ for existing compound docs. What prior learnings applied here? What was missing?\n\n**Prevention**: What mistakes were made or nearly made? How would you detect this class of problem earlier next time?\n\n**Categories**: Tag this solution for future retrieval. Categories: auth | data | performance | ui | api | testing | architecture | devops | other. Also tag: language, framework, scope (component/service/system).\n\nWRITE docs/solutions/[slug].md with YAML frontmatter:\n```yaml\n---\ntitle: [feature name]\nslug: [slug]\ncategories: [list]\ntags: [list]\ndate: [today]\n---\n```\nThen sections: ## Problem, ## Solution, ## What Worked, ## What Did Not Work, ## Prevention, ## Related Docs, ## Key Code References' }, []);

    step(wfId, s2, 'Update CLAUDE.md',
      'Add new patterns, anti-patterns, taste decisions, and caveats discovered in this sprint to CLAUDE.md.',
      300, 255, 'claude-code',
      { ...cc('planner'), prompt: 'Read the compound doc from the previous step and the full git log for this sprint.\n\nUpdate CLAUDE.md — add to the relevant sections:\n- NEW PATTERNS: things that worked well that should be repeated\n- ANTI-PATTERNS: things that went wrong or nearly went wrong — include early detection signals\n- TASTE DECISIONS: naming, structure, approach choices made — and why\n- CAVEATS: project-specific constraints discovered\n\nRule: if an agent made a mistake during this sprint that another agent or human had to correct, add a note so it will not happen again next sprint.\n\nDo not remove existing content unless it is now factually wrong. Mark superseded patterns as deprecated with a note.\n\nOutput: list of sections updated and what was added.' }, [s1]);

    step(wfId, s3, 'Retro',
      'Run /retro: velocity vs estimate, top 3 blockers, coverage trend. Write docs/retros/[date]-[slug].md.',
      300, 430, 'claude-code',
      { ...cc('planner'), prompt: 'Run /retro for the [slug] sprint.\n\nGather from git log, todos, and build summary:\n1. VELOCITY: estimated effort (in the plan) vs. actual time spent\n2. COVERAGE TREND: coverage at start of sprint vs. end\n3. PHASE ANALYSIS: which phase took longest? Which was smoothest?\n4. TOP 3 BLOCKERS: what slowed the team down most?\n5. WHAT TO REPEAT: what went well that we should do more of?\n6. WHAT TO CHANGE: what would we do differently?\n\nToday\'s date: use the current date.\n\nWRITE docs/retros/[today-date]-[slug].md with all sections.\n\nOutput a summary: velocity ratio (estimated/actual), coverage delta, top 3 blockers.' }, [s2]);

    step(wfId, s4, 'Learn & Final Review',
      'Run /learn: review new learnings, prune superseded ones. Final human sign-off.',
      300, 605, 'claude-code',
      { ...cc('planner'), prompt: 'Run /learn for the [slug] sprint, then run CE /ce-compound-refresh so stored guidance is checked against the current codebase instead of accumulating stale or duplicate lessons.\n\n1. Review the learnings added in this sprint (previous step).\n2. Mark existing learnings this sprint superseded as deprecated.\n3. Confirm docs/solutions/[slug].md is written and well-structured.\n\nOutput final compound summary:\n```\n## Phase 7 — COMPOUND COMPLETE\n\nFeature: [name] is live in production\nCompound doc: docs/solutions/[slug].md\nGuidance: [N] new patterns, [N] anti-patterns\nRetro: docs/retros/[date]-[slug].md\nNew learnings added: [N]\nSuperseded learnings pruned: [N]\n```', }, [s3], false);

    step(wfId, s5, 'Sprint Complete',
      'Full Compound Engineering sprint complete. Feature live, learnings captured, system improved.',
      300, 780, 'connector',
      { connectorType: 'system-notify', title: 'CE Sprint Complete 🎯', message: 'Feature is live, compound doc written, CLAUDE.md updated, retro done.' }, [s4]);
  }
}
