# Workflow prompt review — what was cut, and what was not

The 22 standard templates (`server/src/lib/templates/`) and the role preambles
(`ROLE_PROMPTS` in `server/src/lib/workflow-executor-v2.ts`), reviewed for text that costs tokens
on every run without changing what an agent does. Enforced by
`server/test/workflow-prompt-lean.test.ts`, which iterates the seeded registry.

## Result

| | Before | After |
|---|---|---|
| Template text (prompts + notify messages, without the shared Completion Report step) | 128,578 chars | 110,693 chars (−14%) |
| Agent steps across all templates | 103 | 98 |
| Role preambles, all ten | 1,837 chars | 393 chars |

## Applied

1. **One report per run.** Every run already ends with the engine's Workflow Completion Report.
   Feature Validation's *Final Report* and Jira Tasks Validation's *Summary Report* are gone. Jira's
   Notify now carries the validate step's tally (`{{result}}`).
2. **Each question asked once.**
   - Product Strategy: "why now" and the riskiest assumption are asked in Context & Premise, the
     smallest version in Alternatives. *Dream State* is gone; its 3-year picture is in Action Plan.
     Dual Voice lost its three repeated topics and the "minimum 3 exchanges" rule. Strategy Review is
     a one-table scorecard.
   - CE Phase 4: *Security Sentinel* and *CSO / STRIDE Review* are one *Security Review* step.
   - Bug Investigation: *Reproduce the Bug* and *Root Cause Analysis* are one *Reproduce & Root
     Cause* step.
   - Architecture Review: the migration path is written only in the Implementation Roadmap.
   - CE Phase 7: CLAUDE.md is checked only in *Update CLAUDE.md*.
3. **Role preambles are one clause.** They contradicted their steps: "[PLAN MODE] create a plan"
   on the step that opens a PR, "up to 5 improvements" on scans asking for every finding, "write
   comprehensive tests" on steps writing a manual QA guide. *Open PR* now uses the backend role.
4. **Long loop prompts.** Epic: Two Repos *Work Repo A/B* 3,892 → 2,576 chars each side; CE
   Develop and Optimize's loop 6,273 → 4,060. Every phrase the loop engine reads survives
   (`TASKS:`, `[k] remaining`, `ALL … TASKS COMPLETE`, `SWITCHED to`, `WAITING ON`, …), checked by
   `template-tightening.test.ts` and the epic / CE template tests.
5. **Filler.** "do NOT advance" / "advance manually" (the engine already holds manual steps), lists
   of Claude tool names (meaningless to Codex), made-up parallel sub-agents and "Runs in parallel"
   descriptions (steps run in sequence), "You are running /x" openers (real skill commands such as
   `/ce-brainstorm` stay), pep lines ("The system is smarter").

## Not applied

- **Agent steps that only ask you something** — Deep Research's *Create in Jira?*, CE Phase 6's
  *Merge Gate* and *Recovery Action* could be decision steps with no agent. Held while that is
  explored; only their filler lines went.
- **Jira Tasks Validation says it moves tasks to "In QA", its prompt moves them to "Done".**
  Behaviour, not tokens; needs a decision on which is right.
- **Gate loop-back rules that never trigger** in four templates. The steps still retry the right
  thing, so nothing breaks.
- **One shared definition of the progress-doc format** — upkeep only, no token saving.
