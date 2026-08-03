---
name: "source-command-challenge"
description: "Challenge the current plan - play devil's advocate and identify risks"
---

# source-command-challenge

Use this skill when the user asks to run the migrated source command `challenge`.

## Command Template

# Challenge This Plan

Critically review the current plan by questioning assumptions and identifying risks.

## Step 1: Identify the Current Plan

Read the active plan file at `.Codex/plans/` or reference the most recent plan discussed in conversation.

## Step 2: Devil's Advocate Analysis

For each major decision in the plan, systematically question:

### Assumptions
- What assumptions is this plan making?
- What if those assumptions are wrong?
- Are we solving the right problem?
- Are we solving the problem at the right layer?

### Risks
- What could go wrong during implementation?
- What are the edge cases we haven't considered?
- What happens if this fails in production?
- Are there security implications?
- Performance concerns at scale?
- What are the failure modes?

### Alternatives
- Is there a simpler way to achieve this?
- What would a 10x simpler solution look like?
- What would we do if we had half the time?
- Are there existing patterns in the codebase we could reuse?
- What would a senior engineer critique about this approach?

### Gaps
- What's missing from this plan?
- What questions haven't been answered?
- Are there dependencies we haven't identified?
- What about testing strategy?
- What about rollback plan?
- What about monitoring/observability?

### Complexity Check
- Is this over-engineered for the problem?
- Are we adding unnecessary abstractions?
- Will future developers understand this?
- Are we building for hypothetical future requirements?

## Step 3: Present Findings

Format the challenge using these severity levels:

### 🔴 Critical Concerns
Issues that could derail the implementation or cause serious problems.
- Must be addressed before proceeding
- Could cause production incidents
- Security vulnerabilities
- Data loss risks

### 🟡 Moderate Risks
Things worth addressing but not blockers.
- Could cause issues down the road
- Technical debt
- Maintainability concerns

### 🟢 Minor Considerations
Nice-to-haves or small improvements.
- Polish items
- Documentation gaps
- Minor optimizations

### 💡 Alternative Approaches
Different ways to solve the same problem.
- Simpler solutions
- Different trade-offs
- Patterns from other parts of codebase

### ❓ Open Questions
Things that need clarification before proceeding.
- Ambiguous requirements
- Missing context
- Decisions that need stakeholder input

## Step 4: Discuss with User

After presenting the challenge, engage in discussion:
- Which concerns resonate with you?
- Should we revise the plan to address any of these?
- Are any alternative approaches worth exploring further?
- What's the acceptable level of risk for this change?

The goal is collaborative refinement, not blocking progress. Help find the right balance between thoroughness and shipping.
