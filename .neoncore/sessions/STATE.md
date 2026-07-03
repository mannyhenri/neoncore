# Session STATE — live snapshot

> Overwritten on each meaningful step. Read this FIRST on resume: it is
> "where we are right now." If its **Next step** looks stale, cross-check the
> tail of `journal.md` (append-only) to see what actually happened last.

- **Updated:** 2026-07-03
- **Branch:** `feature/dual-runtime-parity-eval`
- **Base:** `main`

## Goal
Dual-runtime parity eval work + NeonCore Guide modal copy accuracy pass.
NEW THREAD (active): design a crash-recovery subsystem so a run killed
mid-stream (SIGTERM to relay, power loss) resumes like `claude --resume` in a
terminal — with NeonCore as the durable store of the agent interaction.

## Recovery design — key findings so far
- Relay (`agent/relay/index.js`) owns a PTY running `claude`/`gridlight` and
  just pipes bytes; conversation lives inside the agent's own session JSONL.
- ROOT GAP: relay registers `sessionId: relay-${pid}` (index.js:115) — it never
  captures the NATIVE claude session id (e.g. d6106f74-...). So NeonCore cannot
  resume today; the `claude --resume` hint is printed by claude, not stored.
- BUT: relay already supports `-- --resume <id>` passthrough (index.js:23,67).
  On SIGTERM it just kills the PTY + exits (index.js:228) — no capture/relaunch.
- Fix shape: capture native session id → persist mid-flight step+session →
  on recovery relaunch relay with `--resume`. Belt-and-suspenders fallback:
  replay NeonCore-stored transcript into a fresh session if --resume fails
  (feasibility depends on hook transcript-capture audit — IN PROGRESS).
- Real crash observed: launch wrapper `node agent/relay/launch.js` got
  `Terminated: 15` (SIGTERM), dumped resume hint, exited unrecoverably.

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
- Recovery P1: BUILT + GREEN (18/18 recovery tests, server tsc clean, migration
  ran on real db). UNCOMMITTED code, awaiting user's ok to commit.

## Recovery P1 — files changed (uncommitted)
- NEW server/src/lib/recovery-core.ts (pure, DI'd: render/detect/mark/recover)
- NEW server/src/lib/recovery.ts (wiring: db+sockets+sendCommandToAgent)
- NEW server/test/recovery-core.test.ts (18 tests, `npm test` in server/)
- server/src/db.ts (migration: native_session_id, interrupted_at,
  recovery_status, recovery_attempts + index)
- server/src/index.ts (reconcile in 30s sweep + on startup)
- server/src/routes/agents.ts (POST /api/agents/interrupted — relay fast path)
- server/src/routes/workflows.ts (POST /api/workflows/steps/:stepId/recover)
- server/src/types.ts (workflow_step_recovery socket event)
- server/package.json (test script: node --import tsx --test)
- agent/relay/index.js (SIGTERM/SIGHUP → POST /interrupted before PTY kill)

## Next step
- Offer to commit P1 as a clean commit (separate from eval/guide work).
- REMAINING P1 slice: dashboard Resume button + interrupted badge (React,
  consumes `workflow_step_recovery` socket event). Backend fully exposes it.
- Also still uncommitted from earlier: eval probe rewrite + GuideModal copy (green).

## Open questions / blockers
- None.

## Uncommitted files
- `dashboard/src/components/GuideModal.tsx`
- `eval/src/cli.mjs`, `eval/src/probe.mjs`, `eval/src/runner.mjs`
- `eval/test/probe.test.mjs`
- (new) `.neoncore/sessions/*` — this worklog system
