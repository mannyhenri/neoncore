# Session STATE — live snapshot

> Overwritten on each meaningful step. Read this FIRST on resume: it is
> "where we are right now." If its **Next step** looks stale, cross-check the
> tail of `journal.md` (append-only) to see what actually happened last.

- **Updated:** 2026-07-03
- **Branch:** `feature/dual-runtime-parity-eval`
- **Base:** `main`

## Goal
Dual-runtime parity eval work + NeonCore Guide modal copy accuracy pass.

## Done
- Parity-eval harness landed (commits `c13db0a`, `f8e8d75`).
- Backend-aware probe rewrite (`eval/src/probe.mjs`): `gridlight` backend does
  liveness-only via `GET /health`; `openai-compatible` verifies the model via
  `GET /v1/models`. Defaults flipped to Gridlight gateway (`localhost:8080`,
  backend `gridlight`) in `cli.mjs` + `runner.mjs`. **All 17 eval tests pass.**
- `dashboard/src/components/GuideModal.tsx`: doc-copy accuracy pass (PreToolUse
  hook, `waiting` status, real-USD cost rollups, Gridlight agent type,
  Save-to-Project step, Trust-mode `AskUserQuestion`/`ExitPlanMode` carve-out,
  decision-step routing wording).

## In progress
- Worklog system just wired: `Stop` hook in `.claude/settings.json` runs
  `.neoncore/sessions/snapshot.sh` each turn. Heartbeat verified manually
  (commit `bef1f3b`). Hook itself may need a session reload to activate.

## Next step
- Confirm the Stop hook auto-fires (watch for a `chore(worklog): heartbeat`
  commit after a turn I did NOT run the script manually).
- Decide commit strategy for the eval + guide code (one commit vs. split
  eval-harness / guide-copy).

## Open questions / blockers
- None.

## Uncommitted files
- `dashboard/src/components/GuideModal.tsx`
- `eval/src/cli.mjs`, `eval/src/probe.mjs`, `eval/src/runner.mjs`
- `eval/test/probe.test.mjs`
- (new) `.neoncore/sessions/*` — this worklog system
