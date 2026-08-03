
## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore

## The work standard

Every task in this repo — and every task NeonCore dispatches to a cartridge — runs under
`docs/WORK-STANDARD.md`: SCOPE (enumerate the complete set from the code, state the count,
state the test) → REPRODUCE (set-based failing test first) → FIX (the whole set, no silent
deferrals) → VERIFY (run it, paste real output) → REPORT (end with the NEONCORE-DONE block).

It is enforced, not advisory:
- The standard is injected into dispatched prompts (`server/src/lib/send-command.ts`),
  which OFFERS the contract. It becomes binding only when the agent first edits a file
  (`armOnWork`, called from the activity route) — investigating and answering a question
  never arms it.
- The Stop hook refuses to let an agent finish without a completion report
  (`agent/hooks/reporter.py` → `POST /api/agents/completion-check`), capped at 2 blocks,
  after which the cartridge is flagged `needs_review` in the dashboard.
- `neoncore_report_task_done` / the workflow webhook reject a "done" with no verification.
- New workflows get a Work Standard gate appended automatically.

Read the doc before changing any of that machinery.
