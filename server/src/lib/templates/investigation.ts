/** Standard workflow templates: Bug Hunter, Feature Validation, Deep Research and Jira Tasks Validation. Seeded on every boot by ./index.ts. */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

export function seedInvestigation({ now, stableId, insertWorkflow, step, cc, gate }: SeedKit): void {
  // ── 1. Bug Hunter ────────────────────────────────────────────────────────
  {
    const wfId = stableId('Bug Hunter');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Bug Hunter',
      'Proactive bug hunt: static analysis → dead code → bug pattern scan → prioritize & plan → implement fixes → verify → notify.', now);

    step(wfId, s1, 'Static & Lint Analysis',
      'Run the compiler and linter to surface all type errors, lint violations, and build warnings. No code changes.',
      300, 80, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Run a full static analysis pass on this codebase. Do NOT make any code changes — only identify and document issues.\n\n1. DETECT LANGUAGE & TOOLS — Check what\'s available: TypeScript (`tsc --noEmit`), ESLint (`npx eslint . --format compact`), Rust (`cargo check`, `cargo clippy`), Python (`ruff check .` or `flake8`), etc. Run whatever applies to this project.\n\n2. RUN EACH TOOL and capture all output.\n\n3. OUTPUT all findings grouped by file in this format:\n```\n## Static Analysis Findings\n\n### [file:line]\nSEVERITY: error | warning | info\nISSUE: [description]\n```\n\nEnd with a count: `Total findings: N (errors: X, warnings: Y)`\n\nIf no issues found, say "STATIC: CLEAN".',
      }, []);

    step(wfId, s2, 'Dead Code Scan',
      'Find all unused code: imports, variables, functions, exports, unreachable branches, empty catch blocks, and commented-out code.',
      300, 310, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Scan the entire codebase for dead code. Do NOT make any changes — only identify and document. Use Read, Grep, and Glob tools extensively.\n\nLook for all of the following:\n\n**Unused imports** — imported but never referenced in the file.\n**Unused variables** — declared but never read after assignment.\n**Unused functions/methods** — defined but never called anywhere in the project.\n**Unreachable code** — code after a `return`, `throw`, or `break`; branches that can never be true.\n**Empty or swallowed catch blocks** — `catch (e) {}` or `catch { /* ignore */ }` with no logging or handling.\n**Dead exports** — symbols exported but never imported by any other file.\n**Commented-out code blocks** — large sections of code left as comments (not doc comments).\n**Redundant conditions** — `if (true)`, `if (false)`, always-truthy/falsy guards.\n\nFor each finding:\n```\n### [file:line]\nTYPE: unused-import | unused-var | unused-function | unreachable | empty-catch | dead-export | commented-code | redundant-condition\nDETAIL: [what it is and why it\'s dead]\n```\n\nEnd with: `Dead code findings: N`',
      }, [s1]);

    step(wfId, s3, 'Bug Pattern Hunt',
      'Systematically scan for common bug patterns: null access, missing awaits, race conditions, silent failures, incorrect comparisons, and missing error handling.',
      300, 540, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Scan the codebase for common bug patterns. Do NOT make any changes — only document findings. Use Read, Grep, and Glob tools.\n\nCheck for each of these patterns:\n\n**Null/undefined access without guards** — `obj.property` or `arr[i]` where the value could be null/undefined/out-of-bounds.\n**Missing await** — async functions called without `await`; promises returned but never resolved or caught.\n**Unhandled promise rejections** — `.then()` chains without `.catch()`; `async` functions whose returned promise is not awaited or caught by the caller.\n**Race conditions** — shared state mutated across async boundaries; multiple concurrent writes without locking.\n**Off-by-one errors** — loop bounds, array slices, index comparisons using `<` vs `<=`.\n**Incorrect equality** — `==` instead of `===` in JS/TS; comparison of different types.\n**Silent failures** — operations that can fail but have no error path (missing `try/catch`, ignoring return codes, swallowing errors).\n**Missing input validation** — user-facing functions or API handlers that don\'t validate/sanitize their inputs.\n**Incorrect state updates** — mutating state directly instead of via setState/reducers; stale closures capturing outdated values.\n**Memory leaks** — event listeners added but never removed; timers/intervals not cleared; large objects held in long-lived scope.\n**Hardcoded values** — URLs, credentials, magic numbers that should be config or constants.\n\nFor each finding:\n```\n### [file:line]\nPATTERN: [pattern name from list above]\nSEVERITY: critical | high | medium | low\nDETAIL: [what the bug is and what could go wrong at runtime]\n```\n\nEnd with: `Bug patterns found: N (critical: X, high: Y, medium: Z, low: W)`',
      }, [s2]);

    step(wfId, s4, 'Prioritize & Plan Fixes',
      'Collate all findings from the three scans, rank by severity, and write a concrete fix plan. Manual advance — review before any code changes.',
      300, 770, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the findings from the three previous steps (Static Analysis, Dead Code Scan, Bug Pattern Hunt), compile a prioritized fix plan.\n\n1. COLLATE ALL FINDINGS — List every unique issue found across all three steps. Deduplicate overlaps.\n\n2. RANK BY PRIORITY:\n   - **P0 — Critical**: crashes, data corruption, security holes, broken core paths\n   - **P1 — High**: wrong behavior under normal conditions, data loss risk, unhandled errors in prod paths\n   - **P2 — Medium**: edge case failures, incorrect logic that usually works, bad UX paths\n   - **P3 — Low**: style, minor inefficiency, non-critical dead code\n\n3. OUTPUT THE PLAN in this format:\n\n```\n## Bug Fix Plan\n\n### P0 — Critical ([count])\n| File:Line | Issue | Fix |\n|-----------|-------|-----|\n| [path:line] | [what the bug is] | [exact change to make] |\n\n### P1 — High ([count])\n[same table]\n\n### P2 — Medium ([count])\n[same table]\n\n### P3 — Low / Dead Code ([count])\n[same table]\n\n## Summary\nTotal issues: N | Estimated risk of fixing: low/medium/high\n```\n\nBe specific about the exact change for each fix — the next step will implement directly from this plan.',
      }, [s3], false);

    step(wfId, s5, 'Implement Fixes',
      'Apply all fixes from the plan in priority order (P0 → P1 → P2 → P3). Remove dead code. Document each change.',
      300, 1000, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'Using the prioritized fix plan from the previous step, implement all fixes.\n\nWork through them in order: P0 first, then P1, P2, and finally P3 (dead code removal).\n\nFor each fix:\n1. Apply the minimal correct change — do not refactor beyond what is needed to fix the issue.\n2. For dead code (unused imports, variables, functions, unreachable branches): remove them entirely.\n3. For empty catch blocks: add at minimum a `console.error` or appropriate error logging.\n4. Log each change in this format:\n```\nFIXED [file:line] — [brief description of what was changed and why]\n```\n\nAfter all fixes are applied, output:\n```\n## Fixes Applied\n[list of all FIXED log lines]\n\nTotal fixed: N\nDead code removed: N items\n```\n\nDo not add new features. Do not refactor code beyond the fix. Do not change tests.',
      }, [s4]);

    step(wfId, s6, 'Verify',
      'Run the full test suite to confirm all fixes are correct and nothing was broken.',
      300, 1230, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s5 }], maxCycles: 2 }, [s5]);

    step(wfId, s7, 'Notify',
      'System notification: Bug Hunter workflow complete.',
      300, 1460, 'connector',
      { connectorType: 'system-notify', title: 'Bug Hunter — Done', message: '{{workflowName}} finished. Check NeonCore for the full bug report.' }, [s6]);
  }

  // ── 6. Feature Validation ─────────────────────────────────────────────────
  {
    const wfId = stableId('Feature Validation');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Feature Validation',
      'TDD-based feature validation: specify → define/review tests (human gate) → evaluate code → implement gaps → run tests → final report. Enter the feature description (and optional Jira epic key) in the launch prompt.', now);

    // Step 1: Feature Specification — spec is entered at launch time; step enriches it with Jira data if provided
    step(wfId, s1, 'Feature Specification',
      'Reads the specification entered at launch. If a Jira epic key was included, fetches the epic and all its tasks and merges requirements into the spec. Outputs a structured Feature Spec document passed to every subsequent step.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The feature specification has been provided at launch (shown above). Your job is to structure it clearly and, if a Jira epic key was included, enrich it with the full epic task details.\n\n**STEP 1 — PARSE THE PROVIDED SPEC**\nRead the specification above carefully. Extract:\n- Feature name and functional description\n- Architectural expectations (layers, components, routes, DB tables, APIs)\n- Acceptance criteria\n- Edge cases and error states\n\n**STEP 2 — FETCH JIRA EPIC (if a key was provided)**\nIf the spec contains a Jira epic key (e.g. GRD-500):\n1. Discover the Jira CLI (`jira --version`, `jira-cli --version`, or project scripts).\n2. Fetch the epic and ALL its child tasks (stories, bugs, tasks, subtasks — recurse fully).\n3. For each task: collect title, status, description, and acceptance criteria.\n\n**STEP 3 — OUTPUT THE STRUCTURED FEATURE SPEC**\n\n```\n## Feature Specification\n\n### Feature Overview\n[What the feature does from a user perspective]\n\n### Architecture\n[Which layers, services, files, DB tables, API routes, and UI components are involved]\n\n### Functional Requirements\n[Numbered list of every requirement — each must be testable]\n\n### Acceptance Criteria\n- [ ] [every condition that must be true for the feature to be complete]\n\n### Edge Cases & Error States\n[Every edge case and expected handling]\n\n### Jira Epic Tasks (if applicable)\n| Key | Title | Status | Requirements |\n|-----|-------|--------|---------------|\n[one row per task]\n```\n\nOutput this document in full — it is the source of truth for all subsequent steps.',
      }, []);

    // Step 2: Test Discovery & Creation — find existing tests, write missing ones, STOP for human review
    step(wfId, s2, 'Test Discovery & Creation',
      'Find all existing tests related to this feature, identify gaps against the spec, write new tests for uncovered behaviors. STOPS for human review — you must confirm the tests truly validate the feature before the workflow continues.',
      300, 310, 'claude-code',
      {
        ...cc('tester'),
        prompt: 'Using the Feature Specification from the previous step, you must (1) find all existing tests related to this feature, (2) identify coverage gaps, and (3) write new tests for anything not already covered.\n\n**RULE: This step must NOT auto-advance. You will output a test manifest and wait for human approval.**\n\n### PHASE 1 — DISCOVER EXISTING TESTS\n1. Use Grep, Glob, and Read to search the entire test suite for tests related to this feature.\n   - Search by feature name, component names, route paths, function names, DB table names, and key terms from the Feature Specification.\n   - Look in all test directories: `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `__tests__/`, `test/`, `spec/` and any other test file patterns in this project.\n2. For each relevant test found, record:\n   - File path and test name/describe block\n   - What behavior it validates\n   - Whether it maps to a requirement in the Feature Spec\n\n### PHASE 2 — IDENTIFY GAPS\nCross-reference every requirement and acceptance criterion from the Feature Spec against the existing tests.\nFor each requirement, answer: Is it covered? If YES — by which test(s)? If NO — what test is needed?\n\n### PHASE 3 — WRITE MISSING TESTS\nFor every gap identified:\n1. Write real, runnable tests that assert the behavior described in the spec.\n2. Each new test must cover: happy path + at least 2 edge cases + at least 1 error state per requirement.\n3. Tests must be written so they FAIL before the implementation is correct — do not write tests that trivially pass.\n4. Follow the existing test patterns, frameworks, and conventions used in this project (detect from existing test files).\n5. Save new tests to the appropriate test file(s) — either extending an existing file or creating a new one following the project conventions.\n\n### PHASE 4 — OUTPUT THE TEST MANIFEST\nOutput the complete manifest in this exact format — do NOT advance automatically:\n\n```\n## Test Manifest for: [Feature Name]\n\n### Existing Tests (covers this feature)\n| File | Test Name | Requirement Covered |\n|------|-----------|--------------------|\n[one row per relevant test]\n\n### New Tests Written\n| File | Test Name | Requirement Covered | Status |\n|------|-----------|---------------------|--------|\n[one row per new test, Status = NEW]\n\n### Coverage Summary\n- Requirements from spec: N\n- Fully covered by existing tests: N\n- Covered by new tests: N\n- Remaining gaps (if any): N — [list them]\n\n### Instructions for Human Review\nPlease review the test manifest above and confirm:\n1. Do the existing tests truly validate the listed requirements?\n2. Do the new tests cover the gaps accurately?\n3. Are there any additional scenarios you want tested?\n\nOnce you are satisfied, advance this step manually to continue the workflow.\n```',
      }, [s1], false);

    // Step 3: Code Evaluation — deep analysis of current implementation vs spec
    step(wfId, s3, 'Code Evaluation',
      'Thoroughly evaluate the current codebase against the Feature Specification. Identify every gap, incorrect behavior, and missing implementation.',
      300, 540, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Using the Feature Specification (step 1) and the Test Manifest (step 2), perform a deep, thorough evaluation of the current codebase to determine how well the feature is implemented.\n\n**Do NOT make any code changes in this step — only investigate and report.**\n\n### PHASE 1 — MAP THE IMPLEMENTATION\nTrace every file, function, route, component, hook, and DB query involved in this feature using Read, Grep, and Glob.\nFollow the data flow end-to-end: from the user trigger → through every layer → to the final output/state change.\n\n### PHASE 2 — EVALUATE EACH REQUIREMENT\nFor every requirement and acceptance criterion in the Feature Spec, answer:\n- Is it implemented? (YES / PARTIAL / NO)\n- If YES: which code handles it and does it match the spec exactly?\n- If PARTIAL: what part is missing or wrong?\n- If NO: what needs to be built?\n\n### PHASE 3 — IDENTIFY BUGS & GAPS\nAlso check for:\n- Logic errors that would cause wrong behavior\n- Missing error handling on async calls, DB queries, or API responses\n- Race conditions or state inconsistencies\n- Missing input validation\n- Edge cases from the spec that are not handled\n- Architectural mismatches (wrong layer, wrong data flow)\n\n### PHASE 4 — OUTPUT THE EVALUATION REPORT\n```\n## Code Evaluation Report\n\n### Implementation Status per Requirement\n| Requirement | Status | Files | Notes |\n|-------------|--------|-------|-------|\n[one row per requirement from the Feature Spec — Status: ✅ Implemented / ⚠️ Partial / ❌ Missing]\n\n### Gaps & Issues Found\n| Severity | File:Line | Description | Fix Needed |\n|----------|-----------|-------------|------------|\n[one row per gap or bug — Severity: critical / high / medium / low]\n\n### Summary\n- Fully implemented: N/N requirements\n- Partially implemented: N requirements\n- Not implemented: N requirements\n- Bugs/issues found: N (critical: X, high: Y, medium: Z, low: W)\n\n### Verdict\n[STATUS: COMPLETE — all requirements fully implemented with no issues]\n[STATUS: INCOMPLETE — list the top items that must be fixed]\n```',
      }, [s2]);

    // Step 4: Code Implementation — fix gaps, never touch tests
    step(wfId, s4, 'Code Implementation',
      'Implement all missing or incorrect code identified in the Code Evaluation. Fix every gap in priority order. Do NOT modify any test files.',
      300, 770, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'Using the Code Evaluation Report from the previous step, implement all fixes and additions needed to make the feature fully comply with the Feature Specification.\n\n**CRITICAL RULE: You must NEVER modify, delete, or weaken any test file. If a test exposes a bug in the implementation, fix the implementation — not the test.**\n\n### IMPLEMENTATION ORDER\nWork through issues in this priority order:\n1. **Critical** — crashes, data corruption, completely missing core paths\n2. **High** — wrong behavior on the happy path, missing required logic\n3. **Medium** — edge cases not handled, partial implementations\n4. **Low** — minor issues, missing error state handling\n\nFor each gap from the evaluation report:\n1. Read the relevant files to understand the existing patterns and conventions.\n2. Implement the minimal correct change — do not refactor beyond what is needed.\n3. Follow the architecture described in the Feature Specification.\n4. Handle all error states and edge cases specified.\n5. Log each change: `IMPLEMENTED [file:line] — [brief description of what was changed and why]`\n\n### AFTER ALL CHANGES\nOutput:\n```\n## Implementation Summary\n\n### Changes Made\n[List of all IMPLEMENTED log lines]\n\n### Gaps Resolved\n[Map each fix to the requirement it addresses]\n\n### Remaining Issues (if any)\n[Anything that could not be implemented and why]\n\nTotal files changed: N | Requirements now fully implemented: N/N\n```',
      }, [s3]);

    // Step 5: Run Tests — quality-gate loops back to implementation if tests fail
    step(wfId, s5, 'Run Tests',
      'Execute all tests from the Test Manifest. If any fail, the code is fixed — tests are never changed. Loops back to Code Implementation on failure (max 3 cycles).',
      300, 1000, 'quality-gate',
      {
        ...gate('test'),
        routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s4 }],
        maxCycles: 3,
        includeDepOutput: true,
      }, [s4]);

    // Step 6: Final Report — full summary, requires human review before closing
    step(wfId, s6, 'Final Report',
      'Compile the complete validation report: what was specified, what tests were written, what code was changed, and the final test results. Requires human review.',
      300, 1175, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Compile the final Feature Validation report using all outputs from every previous step. Be thorough and precise.\n\n```\n## Feature Validation Report\n\n### Feature\n[Feature name and 1-sentence description]\n\n### Specification Summary\n[Bullet list of the key requirements from the Feature Spec]\n\n### Tests\n#### Existing Tests (pre-existing, related to this feature)\n| File | Test | Requirement |\n|------|------|-------------|\n\n#### New Tests Written\n| File | Test | Requirement |\n|------|------|-------------|\n\n### Code Changes\n#### What was already implemented correctly\n[Bullet list]\n\n#### What was fixed or added\n| File | Change | Requirement |\n|------|--------|-------------|\n\n### Test Results\n| Test | Result | Detail |\n|------|--------|--------|\n[one row per test from the run — PASS or FAIL]\n\n### Requirements Coverage\n| Requirement | Tests | Code | Status |\n|-------------|-------|------|--------|\n[one row per requirement from the Feature Spec]\n\n### Summary\n- Requirements: N total | N fully validated | N with gaps\n- Tests: N existing + N new = N total | N passed | N failed\n- Code changes: N files modified\n\n### Overall Verdict\n**STATUS: PASS** — all requirements implemented and all tests passing\n**STATUS: FAIL** — list the specific requirements or tests that are still not satisfied\n\n### Next Steps (if STATUS: FAIL)\n[Numbered list of remaining action items, highest severity first]\n```',
      }, [s5], false);

    // Step 7: Notify
    step(wfId, s7, 'Notify',
      'System notification: Feature Validation workflow complete.',
      300, 1350, 'connector',
      { connectorType: 'system-notify', title: 'Feature Validation — Done', message: '{{workflowName}} finished. Check NeonCore for the full validation report.' }, [s6]);
  }

  // ── 7. Deep Research ──────────────────────────────────────────────────────
  {
    const wfId = stableId('Deep Research');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Deep Research',
      'Set the workflow description to the research subject — it is automatically injected into the first step. Web + local research → synthesis → your review → epic planning → save epic → optional Jira creation → notify.', now);

    // Step 1: Deep Research — search web + local dirs
    step(wfId, s1, 'Deep Research', 'Search the web and local codebase for papers, articles, and ideas on the subject.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'You are conducting deep research on the subject described above.\n\nDo both of the following:\n\n1. WEB RESEARCH — Use the WebSearch and WebFetch tools to find: academic papers, technical articles, blog posts, GitHub repos, documentation, and any other relevant online resources. Go at least 3 levels deep on the most promising leads. For each source: note the title, URL, key insights, and how it relates to the subject.\n\n2. LOCAL RESEARCH — Search the local project files for any existing work, prior art, related features, or relevant patterns using Read, Glob, and Grep tools.\n\nOutput all findings in a structured document:\n## Web Findings\n[Source-by-source: title, URL, key insight]\n\n## Local Findings\n[File paths and relevant code/content]\n\n## Key Ideas & Themes\n[Synthesized list of the most important concepts discovered]',
      }, []);

    // Step 2: Idea Synthesis — compile into a clean research brief
    step(wfId, s2, 'Idea Synthesis', 'Compile all research findings into a structured brief organized by theme, opportunity, and approach.',
      300, 310, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the research findings above, compile a clean, structured research brief:\n\n## Research Brief: [Subject]\n\n### Executive Summary\n[2-3 sentences on what the research found and why it matters]\n\n### Key Themes\n[Bullet list of the major themes that emerged]\n\n### Top Ideas & Opportunities\n[Numbered list of the most promising ideas, each with: what it is, why it matters, how it could apply]\n\n### Technical Approaches\n[Concrete implementation approaches found in research]\n\n### Open Questions\n[Things that need further investigation or user decisions]\n\n### Recommended Direction\n[Your top recommendation based on the research, with rationale]',
      }, [s1]);

    // Step 3: Your Review — agent surfaces the brief and asks for user input via AskUserQuestion
    step(wfId, s3, 'Your Review', 'Read the research brief. The agent will ask for your comments and direction — respond via the question prompt in NeonCore.',
      300, 540, 'claude-code',
      {
        ...cc('general'), autoAdvance: false,
        prompt: 'The research brief from the previous step is ready for human review. Do the following:\n\n1. Present the research brief clearly and in full so the user can read it.\n\n2. Then use the AskUserQuestion tool with this exact question:\n"Please share your comments, direction, and priorities for the epic. What should be the focus? Any constraints, preferences, or ideas you want incorporated? (Your response will be passed directly to the epic planning step.)"\n\n3. After the user responds, output their response verbatim under a heading:\n## User Direction\n[user\'s response here]\n\nDo not advance or do anything else — end there.',
      }, [s2]);

    // Step 4: Epic Planning — write full scoped epic based on research + user direction
    step(wfId, s4, 'Epic Planning', 'Write the full scoped epic document based on the research brief and your review comments.',
      300, 770, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Using the research brief and the user\'s direction from the previous step, write a comprehensive epic scope document in this exact format:\n\n# Epic: [Subject Name]\n\n## Overview\n[2-3 paragraphs: what this epic is, why it matters, what it delivers]\n\n## Business Goals\n- **[Goal 1]**: [description]\n- **[Goal 2]**: [description]\n(continue for all key goals)\n\n## Current State\n| Component | Current State |\n|-----------|---------------|\n[table of what exists today]\n\n## Target State\n| Component | Target State |\n|-----------|---------------|\n[table of what we\'re building toward]\n\n## Constraints\n- **[Constraint 1]**: [description]\n(list all technical, product, or business constraints)\n\n## Task Breakdown\n\n### Phase 1: [Phase Name]\n| Task | Title | Description | Size | Dependencies |\n|------|-------|-------------|------|--------------|\n| [ID]-001 | [Title] | [Description] | S/M/L | None |\n(continue for all tasks)\n\n### Phase 2: [Phase Name]\n[same format]\n\n## Open Questions\n[Numbered list of unresolved decisions]\n\n## Success Metrics\n[How we\'ll know this epic is done and working]',
      }, [s3]);

    // Step 5: Save Epic — write the file to the scoping folder
    step(wfId, s5, 'Save Epic', 'Write the completed epic document to /Users/mannyhenri/Documents/Git/gridlight/.claude/scoping/',
      300, 1000, 'claude-code',
      {
        ...cc('general'),
        prompt: 'Take the epic document written in the previous step and save it as a file.\n\n1. Derive a short kebab-case slug from the epic subject (e.g. "mcp-integration", "voice-search", "offline-mode").\n\n2. Write the full epic content to:\n/Users/mannyhenri/Documents/Git/gridlight/.claude/scoping/EPIC-[slug].md\n\nUse the Write tool to create the file. Do not modify the epic content — copy it exactly.\n\n3. Confirm with: "✅ Epic saved to /Users/mannyhenri/Documents/Git/gridlight/.claude/scoping/EPIC-[slug].md"',
      }, [s4]);

    // Step 6: Create in Jira? — ask user YES/NO, then create epic + tasks if YES
    step(wfId, s6, 'Create in Jira?',
      'Ask whether to create this epic and all its tasks in Jira. If YES: creates the Jira epic, creates every task linked to it, and saves task files to .claude/tasks/.',
      300, 1230, 'claude-code',
      {
        ...cc('general'),
        prompt: 'The epic is saved. Ask whether to create it in Jira.\n\n**A — SUMMARIZE** from the Epic Planning output: epic title, total task count, and tasks per phase.\n\n**B — ASK** with AskUserQuestion, exactly:\n"Create this epic and all [N] tasks in Jira?\n\nReply YES to create everything (you can include your Jira project key, e.g. YES GRD).\nReply NO to skip Jira and finish the workflow."\n\n**C — ACT**\nAnything other than YES → output "⏭️ Skipping Jira — epic saved locally only." and stop.\n\nOn YES:\n1. Find the Jira CLI (`jira --version`, `jira-cli --version`, or the project\'s scripts) and the project key (from the reply, or the project\'s Jira config/env).\n2. Create the epic: summary = epic title, description = the Overview section. Note its key (e.g. GRD-500).\n3. Create one issue per task in every phase of the Task Breakdown, linked to the epic: summary = task title, description = task description, labels/story points = Size (S=1, M=3, L=5, XL=8). Note each key.\n4. SAVE TASK FILES — for each created Jira issue, save a task file to /Users/mannyhenri/Documents/Git/gridlight/.claude/tasks/[ISSUE-KEY].md using this exact format:\n```\n# [ISSUE-KEY]: [Task ID] - [Title]\n\n## Task Details\n- **Jira:** [ISSUE-KEY]\n- **Branch:** [ISSUE-KEY-lowercase-kebab-title]\n- **Created:** [today\'s date YYYY-MM-DD]\n- **Epic:** [Epic title]\n- **Phase:** [Phase number and name from Task Breakdown]\n- **Size:** [S/M/L/XL]\n- **Dependencies:** [Dependencies from table, or None]\n\n## Description\n[Full description from the Task Breakdown table]\n\n## Acceptance Criteria\n- [ ] [Derive 3-5 acceptance criteria from the description]\n\n## Technical Notes\n[Any relevant technical context from the epic document]\n\n## Progress\n- [ ] Task started\n```\n\n5. OUTPUT a completion report:\n```\n✅ Jira Epic created: [EPIC-KEY] — [Epic Title]\n\nTasks created ([total]):\n| Issue | Phase | Title | Size |\n|-------|-------|-------|------|\n[one row per task]\n\nTask files saved to /Users/mannyhenri/Documents/Git/gridlight/.claude/tasks/\n```',
      }, [s5]);

    // Step 7: Notify — system notification when research is complete
    step(wfId, s7, 'Notify', 'System notification: Deep Research workflow complete.',
      300, 1460, 'connector',
      { connectorType: 'system-notify', title: 'Deep Research — Done', message: '{{workflowName}} finished. Your epic is ready in NeonCore.' }, [s6]);
  }

  // ── 8. Jira Tasks Validation ──────────────────────────────────────────────
  {
    const wfId = stableId('Jira Tasks Validation');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID();
    insertWorkflow.run(wfId, 'Jira Tasks Validation',
      'Enter the Jira epic name or key in the launch prompt — each task in the epic is checked against the codebase and transitioned to In QA if requirements are met.', now);

    // Step 1: Fetch all tasks and save to file — output only path + count, not the full dump
    step(wfId, s1, 'Fetch & Save Tasks',
      'Query Jira for every task in the epic, save full details to a local MD file, and output only the file path and task count.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The Jira epic to validate is specified above.\n\n**IMPORTANT: Do NOT output task details to this conversation. Write everything to a file — the next step reads from disk. Process tasks one by one to stay within context limits.**\n\n1. DISCOVER JIRA CLI — Try `jira --version`, `jira-cli --version`, or look for jira scripts in package.json / Makefile. Identify the exact command syntax for this project.\n\n2. FIND PROJECT ROOT — Run `git rev-parse --show-toplevel` to get the absolute project root path.\n\n3. DERIVE SLUG — Convert the epic name to kebab-case (e.g. "Document Generation" → "document-generation").\n\n4. CREATE OUTPUT FILE — Create the directory and initialize the file with a header only:\n   Path: `{project-root}/.gridlight/jira-validation/{epic-slug}-tasks.md`\n   Header:\n   ```\n   # Jira Tasks — [Epic Name]\n   Fetched: [today\'s date]\n   ---\n   ```\n\n5. COLLECT ALL LEAF TASKS (recursive, any depth):\n   Start with the specified epic key. Use a queue/stack approach:\n   a. Fetch the direct children of the current item (use the Jira CLI to list child issues or search by parent/epic-link).\n   b. For each child: if it is itself an epic or has its own children (sub-epic), add it to the queue to recurse into — do NOT add it as a task.\n   c. If it is a leaf task (story, task, subtask, bug — no children of its own), add it to the task list.\n   d. Continue until the queue is empty. You now have all leaf-level tasks from the entire hierarchy.\n   Do not include parent epics in the task list — only leaf issues.\n   Order the final list by creation date.\n   Note the total count.\n\n6. ITERATE THROUGH EACH LEAF KEY — For every issue key, one at a time:\n   a. Fetch the full details for that single issue: title, current status, created date, description, acceptance criteria, technical notes.\n   b. IMMEDIATELY APPEND to the tasks file in this format:\n      ```\n      ## [ISSUE-KEY] — [Title]\n      **Status:** [current status] | **Created:** [date]\n      **Requirements:**\n      [full description and acceptance criteria]\n      ---\n      ```\n   c. Do not accumulate details in memory — fetch one, write one, move on.\n\n7. OUTPUT ONLY these two lines when done:\n   ```\n   Tasks file: {absolute path to the saved file}\n   Total tasks: N\n   ```',
      }, []);

    // Step 2: Read tasks from file, validate each, append results to a second file incrementally
    step(wfId, s2, 'Validate & Save Results',
      'Read the saved tasks file, validate each task against the codebase one by one, append results to a results file as it goes, and transition to "In QA" in Jira when requirements are met.',
      300, 310, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'The previous step saved all Jira tasks to a file. Its output contains the file path.\n\n**IMPORTANT: Read the tasks from disk — do NOT rely on the task content being in the conversation context.**\n\n1. READ THE TASKS FILE — From the previous step output, extract the "Tasks file:" path and read it using the Read tool. This gives you the full task list with all requirements.\n\n2. READ THE EPIC SLUG — Derive it from the tasks filename (e.g. `document-generation-tasks.md` → slug is `document-generation`).\n\n3. PREPARE RESULTS FILE (MERGE MODE) — The results file path is:\n   `{same directory}/{epic-slug}-results.md`\n   Check if it already exists:\n   - **If it does NOT exist**: create it with this header:\n     ```\n     # Jira Validation Results — [Epic Name]\n     Validated: [today\'s date]\n     ---\n     ```\n   - **If it DOES exist**: read it and extract every ISSUE-KEY that already has a `VERDICT:` line. These tasks are already validated — skip them in this run. Then append a re-run separator:\n     ```\n     --- Re-run: [today\'s date] ---\n     ```\n   Do not delete or overwrite existing results — only append new ones.\n\n4. FOR EACH TASK in the tasks file (in order) that has NOT already been validated:\n\n   a. READ its requirements from the tasks file.\n\n   b. INVESTIGATE the codebase — use Read, Grep, and Glob to find the relevant implementation. Check:\n      - Is the feature/fix implemented?\n      - Do all details match the requirements exactly?\n      - Are edge cases and error states handled as specified?\n      - Are tests present if required?\n\n   c. DECIDE and ACT:\n      - **MEETS ALL REQUIREMENTS** → run the Jira CLI transition to move it to "Done"\n      - **DOES NOT FULLY MEET** → run the Jira CLI transition to move it to "To Do"\n\n   d. IMMEDIATELY APPEND this result to the results file (do not wait until all tasks are done):\n      ```\n      ## [ISSUE-KEY] — [Title]\n      VERDICT: ✅ Done | ❌ To Do\n      REASON: [1-2 sentences on what was found or what is specifically missing]\n      ---\n      ```\n\n5. After all tasks are processed, OUTPUT ONLY:\n   ```\n   Results file: {absolute path to results file}\n   ✅ Marked Done: N\n   ❌ Marked To Do: N\n   ⏭️ Skipped (already validated): N\n   ```\n\nDo not output individual task verdicts to the conversation — they are saved in the results file.',
      }, [s1]);

    // Step 3: Read results file from disk, compile final report — fresh context, no accumulated data
    step(wfId, s3, 'Summary Report',
      'Read the results file from disk and compile the final validation report with ✅/📋 tables and a summary paragraph.',
      300, 540, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'The previous step saved all validation results to a file. Its output contains the file path.\n\n1. READ THE RESULTS FILE — From the previous step output, extract the "Results file:" path and read it using the Read tool.\n\n2. ALSO READ THE TASKS FILE — Replace "-results.md" with "-tasks.md" in the path to get the tasks file. Read it to get the epic name and any task titles you need.\n\n3. COMPILE THE REPORT in this exact format:\n\n---\n## Jira Epic Validation Report\n**Epic:** [epic name]\n**Validated:** [date from results file] | **Total tasks:** N | **✅ Done:** N | **📋 To Do:** N\n\n### ✅ Done ([count])\n| Issue | Title |\n|-------|-------|\n| [KEY] | [Title] |\n\n### 📋 To Do ([count])\n| Issue | Title | What\'s Missing |\n|-------|-------|----------------|\n| [KEY] | [Title] | [REASON from results file] |\n\n### What\'s Left — Summary\n[Write 2-4 sentences: overall completion state of the epic, the main areas of remaining work, any patterns in what\'s incomplete, and recommended next steps for the team.]\n\n---\n\nThe report above is your full output. Be precise — use the exact issue keys and reasons from the results file.',
      }, [s2], false);

    // Step 4: Notify
    step(wfId, s4, 'Notify',
      'System notification: Jira Tasks Validation workflow complete.',
      300, 770, 'connector',
      { connectorType: 'system-notify', title: 'Jira Validation — Done', message: '{{workflowName}} finished. Check NeonCore for the epic status report.' },
      [s3]);
  }
}
