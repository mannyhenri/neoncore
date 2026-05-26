# AI Feature Delivery Workflow
# Compound Engineering × gstack — production-ready, project-agnostic
#
# HOW THIS FILE WORKS
# ─────────────────────────────────────────────────────────────────────────
# Claude Code reads this file at the start of every session.
# Each phase ends with one of two signals:
#
#   AUTO-CONTINUE  →  proceed immediately to the next phase
#   AWAIT-HUMAN    →  write a summary to todos/AWAITING-HUMAN.md and STOP
#
# The orchestrator (or a simple shell watcher) monitors todos/AWAITING-HUMAN.md.
# When it appears, a notification is sent to the engineer.
# The engineer reviews, then re-invokes Claude Code with one of:
#   "approved, continue to phase N"
#   "rejected: [reason] — restart from phase N"
#
# CONTEXT PERSISTENCE ACROSS PHASES
# ─────────────────────────────────────────────────────────────────────────
# Context is never held in memory between sessions. It is always file-based:
#
#   docs/brainstorms/[feature].md   ← Phase 1 output
#   docs/plans/[feature].md         ← Phase 2 output
#   todos/p1-[feature].md           ← Phase 4 P1 findings
#   todos/p2-[feature].md           ← Phase 4 P2 findings
#   docs/solutions/[feature].md     ← Phase 7 compound output
#   todos/AWAITING-HUMAN.md         ← human gate signal file
#
# At the start of each phase, load the relevant file for context.
# CLAUDE.md is always read first — it carries cross-sprint institutional memory.
#
# CURRENT SPRINT CONTEXT
# ─────────────────────────────────────────────────────────────────────────
# Feature:        [FEATURE_NAME]
# Branch:         feature/[FEATURE_SLUG]
# Staging URL:    [STAGING_URL]
# Jira ticket:    [TICKET_ID]
# Started:        [DATE]
# Current phase:  [CURRENT_PHASE]


# ══════════════════════════════════════════════════════════════════════════
# PHASE 1 — INTERROGATE THE IDEA
# Goal: challenge the framing before any planning begins
# ══════════════════════════════════════════════════════════════════════════

## Steps (run in order)

1. Load CLAUDE.md and docs/solutions/ — search for prior work related to this feature.

2. Run gstack /office-hours
   - Ask the 6 forcing questions
   - Challenge premises
   - Surface hidden assumptions
   - Generate 2-3 implementation approaches with effort estimates

3. Run CE /workflows:brainstorm
   - Lightweight repo research
   - Clarify purpose, users, constraints, edge cases
   - Identify what "done" looks like

4. Merge outputs into: docs/brainstorms/[feature].md
   - Include: problem statement, scoped definition, approaches considered,
     recommended approach, open questions, effort estimate

## Gate
AWAIT-HUMAN
Write to todos/AWAITING-HUMAN.md:
  - Phase: 1 — Interrogate
  - Feature: [feature name]
  - Recommended approach: [one sentence]
  - Key assumptions being made: [bullet list]
  - Estimated effort: [S/M/L]
  - File to review: docs/brainstorms/[feature].md
  - To proceed: "approved phase 1, continue to phase 2"
  - To revise: "rejected phase 1: [reason]"


# ══════════════════════════════════════════════════════════════════════════
# PHASE 2 — MULTI-AGENT PLAN REVIEW
# Goal: pressure-test the plan from three angles before code is written
# ══════════════════════════════════════════════════════════════════════════

## Prerequisite
Load docs/brainstorms/[feature].md before starting.

## Steps (run in parallel where possible)

1. Run gstack /plan-ceo-review
   - Scope check, 10-star product test
   - Four modes: expansion / selective expansion / hold scope / reduction
   - Output: scope recommendation + risk flags

2. Run gstack /plan-eng-review
   - Architecture, data flow, ASCII diagrams
   - Edge cases, test matrix, failure modes
   - Security concerns at design level

3. Run CE /workflows:plan
   - Spawns three parallel research agents:
     · repo-research-analyst (existing patterns in this codebase)
     · framework-docs-researcher (official documentation)
     · best-practices-researcher (industry standards)
   - Merges into structured plan with affected files and implementation steps

4. Merge all three outputs into: docs/plans/[feature].md
   - Sections: overview, affected files, implementation steps,
     test plan, rollback plan, open decisions

## Gate
AWAIT-HUMAN
Write to todos/AWAITING-HUMAN.md:
  - Phase: 2 — Plan
  - Feature: [feature name]
  - Affected files: [count] files across [list repos/modules]
  - Implementation steps: [count]
  - Risks identified: [bullet list, max 5]
  - Open decisions requiring human input: [bullet list]
  - File to review: docs/plans/[feature].md
  - To proceed: "approved phase 2, continue to phase 3"
  - To revise: "rejected phase 2: [reason]"


# ══════════════════════════════════════════════════════════════════════════
# PHASE 3 — ISOLATED IMPLEMENTATION
# Goal: agent builds in an isolated branch; output is a PR, not a diff
# ══════════════════════════════════════════════════════════════════════════

## Prerequisite
Load docs/plans/[feature].md. Do not begin without an approved plan.

## Steps (run in order — NOT parallel)

1. Create git worktree and branch
   git worktree add ../[feature]-work feature/[feature-slug]
   cd ../[feature]-work

2. Run CE /workflows:work
   - Execute each step in docs/plans/[feature].md sequentially
   - Run tests + linting after each changed file
   - Track progress: check off completed steps in the plan
   - If something breaks: adapt the plan, document the deviation

3. Run gstack /ship (pre-PR mode)
   - Run full test suite
   - Run linter and type checker
   - Audit test coverage — flag if below project threshold
   - Do NOT open PR yet (that happens after review)

4. Checkpoint: write build summary to todos/build-summary-[feature].md
   - Tests: X passing, Y failing
   - Coverage: N%
   - Linting: clean / issues found
   - Deviations from plan: [list any]

## Gate
AUTO-CONTINUE to Phase 4
(No human gate here — review catches issues. Human sees the PR in Phase 4.)


# ══════════════════════════════════════════════════════════════════════════
# PHASE 4 — PARALLEL SPECIALIST REVIEW
# Goal: 14+ agents find issues humans and CI miss; human sees triage, not raw findings
# ══════════════════════════════════════════════════════════════════════════

## Prerequisite
Load todos/build-summary-[feature].md and the current branch diff.

## Steps (run ALL simultaneously — this is the parallel fan-out)

### Security track
- CE security-sentinel: OWASP Top 10, injection, auth flaws, authorization bypasses
- gstack /cso: OWASP + STRIDE threat model, 8/10+ confidence gate, verified findings only

### Performance track
- CE performance-oracle: N+1 queries, missing indexes, caching, algorithmic bottlenecks
- gstack /benchmark: baseline page load, Core Web Vitals, resource sizes

### Data track
- CE data-integrity-guardian: migrations, transaction boundaries, referential integrity
- CE data-migration-expert: ID mappings, rollback safety, production data validation

### Architecture track
- CE architecture-strategist: system design, component boundaries, dependency direction
- CE pattern-recognition-specialist: design patterns, anti-patterns, code smells

### Quality track
- CE code-simplicity-reviewer: YAGNI, unnecessary complexity, readability
- gstack /review: production bugs that pass CI, completeness gaps

### Second opinion track
- gstack /codex: independent review from OpenAI Codex (cross-model)

## Triage findings
Classify every finding:
  P1 — must fix before merge (security, data loss, broken functionality)
  P2 — should fix before merge (performance, design debt)
  P3 — nice to fix (style, minor improvements) → auto-resolve now

Auto-resolve all P3 findings.
Write P1 findings to: todos/p1-[feature].md
Write P2 findings to: todos/p2-[feature].md

Run gstack /resolve_pr_parallel on P2s (agent fixes, human reviews fixes).

## Open PR
After P2s are resolved:
  gstack /ship → opens PR with:
    - Link to docs/plans/[feature].md
    - Build summary
    - P1 findings list (if any remain for human decision)
    - P2 resolution summary
    - Test coverage delta

## Gate
AWAIT-HUMAN if P1 findings exist
AUTO-CONTINUE to Phase 5 if P1 list is empty

Write to todos/AWAITING-HUMAN.md:
  - Phase: 4 — Review
  - Feature: [feature name]
  - PR: [PR URL]
  - P1 findings requiring human decision: [list from todos/p1-[feature].md]
  - P2 findings resolved automatically: [count]
  - P3 findings auto-resolved: [count]
  - To proceed: "approved phase 4, continue to phase 5"
  - To fix P1s: "fix p1s: [specific instruction]"


# ══════════════════════════════════════════════════════════════════════════
# PHASE 5 — REAL-BROWSER QA
# Goal: find what automated review misses by actually using the feature
# ══════════════════════════════════════════════════════════════════════════

## Prerequisite
Load the PR diff and docs/plans/[feature].md.
Staging URL is defined in .env.staging or passed by the orchestrator.

## Steps (run in order)

1. Run gstack /qa [STAGING_URL]
   - Launch real Chromium browser
   - Walk through every user flow defined in the plan
   - For each bug found:
     · Fix it with an atomic commit
     · Write a regression test
     · Re-verify the fix before moving on
   - Generate QA report: todos/qa-report-[feature].md

2. Ask CE three QA questions against the implementation:
   "What was the hardest decision you made in this implementation?"
   "What alternatives did you reject, and why?"
   "What are you least confident about?"
   Record answers in todos/qa-report-[feature].md

3. Run gstack /investigate on anything flagged as uncertain above
   - Iron Law: no fixes without investigation first
   - Stop after 3 failed fix attempts — escalate to human

## Gate
AUTO-CONTINUE to Phase 6 if QA report shows all flows passing
AWAIT-HUMAN if any flow is failing or /investigate escalated

Write to todos/AWAITING-HUMAN.md:
  - Phase: 5 — QA
  - Feature: [feature name]
  - Flows tested: [count]
  - Bugs found and fixed: [count]
  - Regression tests added: [count]
  - Escalations requiring human decision: [list]
  - File to review: todos/qa-report-[feature].md
  - To proceed: "approved phase 5, continue to phase 6"


# ══════════════════════════════════════════════════════════════════════════
# PHASE 6 — SHIP AND VERIFY
# Goal: merge → CI → deploy → production health confirmed
# ══════════════════════════════════════════════════════════════════════════

## Prerequisite
QA report must show all flows passing. Do not ship a failing QA.

## Steps (run in order)

1. gstack /document-release
   - Read every doc file in the project
   - Cross-reference the diff
   - Update README, ARCHITECTURE, CONTRIBUTING, CLAUDE.md, TODOS
   - Flag any stale documentation that couldn't be auto-updated

2. AWAIT-HUMAN — PR merge approval
   Write to todos/AWAITING-HUMAN.md:
     - Phase: 6 — Ship (merge gate)
     - PR: [PR URL]
     - QA: all flows passing
     - Docs: updated
     - Coverage: [N%] ([+/-N%] from main)
     - To merge: "approved, merge and deploy"
     - To hold: "hold: [reason]"

3. After human approves merge:
   gstack /land-and-deploy
   - Merge PR
   - Wait for CI to pass
   - Wait for deploy to complete
   - Verify production health endpoint

4. gstack /canary (run for 10 minutes post-deploy)
   - Watch for console errors
   - Watch for performance regressions
   - Watch for page failures
   - Write canary report to todos/canary-[feature].md

## Gate
AUTO-CONTINUE to Phase 7 if canary is clean
AWAIT-HUMAN if canary catches a regression

Write to todos/AWAITING-HUMAN.md (canary failure only):
  - Phase: 6 — Canary failure
  - Regression: [description]
  - Recommended action: rollback / hotfix
  - To rollback: "rollback [feature]"
  - To hotfix: "hotfix: [instruction]"


# ══════════════════════════════════════════════════════════════════════════
# PHASE 7 — COMPOUND
# Goal: make the next feature cheaper than this one
# This is the most important phase. Do not skip it.
# ══════════════════════════════════════════════════════════════════════════

## Prerequisite
Canary must be clean. Do not compound an unsuccessful deploy.

## Steps (run in order)

1. Run CE /workflows:compound
   Spawns six parallel subagents:
   - context-analyzer: understands the problem that was solved
   - solution-extractor: captures what worked and what didn't
   - related-docs-finder: links to existing knowledge in docs/solutions/
   - prevention-strategist: documents how to avoid recurrence
   - category-classifier: tags for future retrieval (YAML frontmatter)
   - documentation-writer: formats the final searchable markdown
   Output: docs/solutions/[feature].md

2. Update CLAUDE.md
   Add to the relevant sections:
   - Any new patterns discovered
   - Any anti-patterns encountered (and how to detect them early)
   - Any taste decisions made (naming, structure, approach)
   - Any caveats specific to this codebase
   Rule: if the agent made a mistake during this sprint, add a note
   so it won't repeat it next sprint.

3. Run gstack /retro
   - Per-person contribution summary
   - Test coverage trend
   - Velocity vs. estimate
   - Top 3 things that slowed us down
   Output: docs/retros/[date]-[feature].md

4. Run gstack /learn
   - Review new learnings from this sprint
   - Prune any learnings that are now superseded
   - Verify CLAUDE.md reflects current state

5. Close Jira ticket [TICKET_ID]
   - Link PR, compound doc, and retro in the ticket
   - Update sprint velocity

## Gate
AWAIT-HUMAN — final compound review
Write to todos/AWAITING-HUMAN.md:
  - Phase: 7 — Compound (complete)
  - Feature: [feature name] is live in production
  - Compound doc: docs/solutions/[feature].md
  - CLAUDE.md: updated with [N] new patterns
  - Retro: docs/retros/[date]-[feature].md
  - Jira [TICKET_ID]: ready to close
  - To close: "approved, close ticket [TICKET_ID]"

# ══════════════════════════════════════════════════════════════════════════
# WORKFLOW COMPLETE
# The system is now smarter than it was before this feature was built.
# ══════════════════════════════════════════════════════════════════════════


# ── ERROR HANDLING ────────────────────────────────────────────────────────
# If anything fails unexpectedly at any phase:
# 1. Write error to todos/ERROR-[phase]-[feature].md
# 2. AWAIT-HUMAN immediately — do not attempt to self-heal across phases
# 3. Include: what failed, last successful step, recommended recovery action
#
# If /investigate fails after 3 attempts:
# 1. Write findings to todos/ESCALATION-[feature].md
# 2. AWAIT-HUMAN — do not proceed


# ── PARALLELISM RULES ─────────────────────────────────────────────────────
# These phases CAN run in parallel across different features:
#   Phase 3, Phase 4, Phase 5 (different features, same repo — use worktrees)
#
# These phases must NEVER run in parallel on the same feature:
#   Any two consecutive phases
#
# These steps within Phase 4 run in parallel (same feature):
#   All review agents fire simultaneously — this is by design


# ── DEFINITION OF DONE ───────────────────────────────────────────────────
# A feature is NOT done until ALL of the following are true:
#   ✓ PR merged and CI passing
#   ✓ Canary clean for 10 minutes post-deploy
#   ✓ docs/solutions/[feature].md committed
#   ✓ CLAUDE.md updated
#   ✓ Jira ticket closed with links
#   ✓ Retro written
#
# Skipping Phase 7 means the next sprint starts from the same baseline.
# This is not acceptable.
