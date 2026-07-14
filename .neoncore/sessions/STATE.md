# Session STATE — live snapshot

> Overwritten on each meaningful step. Read this FIRST on resume: it is
> "where we are right now." If its **Next step** looks stale, cross-check the
> tail of `journal.md` (append-only) to see what actually happened last.

- **Updated:** 2026-07-13 (late)
- **Branch:** `main` (default; `dev` deleted). Working tree clean, pushed.

## ⚠️ FIRST THING ON RESUME — the relay is probably DEAD
I started the relay for `gridlight-1.1.4-fixes` as a **background process of the previous
session**. It dies when that session ends. Commands/workflows to that cartridge will go back
to failing silently until it's restarted:

```bash
cd ~/code/gridlight-1.1.4-fixes
NEONCORE_URL=http://localhost:4040 node ~/.neoncore/agent/relay/index.js
```

Verify it's live: send a command, then check `delivered_at` is stamped —
`sqlite3 server/neoncore.db "SELECT status, delivered_at FROM commands ORDER BY created_at DESC LIMIT 1;"`
`delivered` = the socket path worked. `pending` = no relay, command went nowhere.

## THE BIG FIND (2026-07-13) — why workflows "ran" but nothing happened
**The relay's npm deps were NEVER INSTALLED in `~/.neoncore/agent/relay`.** It crashed
instantly on `socket.io-client`, so **no relay had ever run on this Mac.** Fixed by
`npm install` in that dir.

Consequences, which cost an hour of wrong theories:
- With no relay socket, `sendCommandToAgent` falls back to `typeIntoTerminal()`
  (`server/src/lib/send-command.ts:22`) — AppleScript that types into the **FRONTMOST**
  Terminal window. Its signature is `typeIntoTerminal(text)`: **no agent, no repo — it
  cannot address a terminal at all.**
- Hand-typed prompts *looked* fine because the terminal you were watching was in front.
  A workflow dispatches asynchronously → its prompt went to whatever window was forward.
  (This is why the user's dashboard/mobile messages kept landing in the Claude Code session
  that was writing the code.)
- Workflows and simple prompts use the **SAME** dispatch — `workflow-executor-v2.ts:249`
  calls `sendCommandToAgent`. There was never a separate workflow path. Don't go looking for
  one again.
- `delivered_at` is stamped **only on the socket path**. A `pending` row does NOT prove
  nothing arrived — the AppleScript path never stamps it. Misreading this sent me down a
  blind alley.

**The relay is the only addressed channel.** It owns one PTY per agent and injects with
bracketed paste (`relay/index.js:177` — `PASTE_START + text + PASTE_END`, then one `\r`), so a
big multiline workflow prompt arrives as ONE prompt, not line-by-line. Hooks are outbound
only; they can never receive.

**`neoncore` cartridge has NO relay** (it's the bare session Claude Code runs in). Testing
workflows against it will fail the same way. Use `gridlight-1.1.4-fixes`.

## Shipped today (all on main, mobile all OTA'd to runtime 0.2.0)
- **Expo SDK 52 → 57** — Apple rejected build 4 (ITMS-90725: iOS 18.2 SDK; requires iOS 26).
  The EAS build image follows the Expo SDK, so the SDK had to move. Build 5 accepted + installed.
  HABIT: before submitting, `unzip` the IPA and PlistBuddy `Payload/*.app/Info.plist` →
  check `DTSDKName`/`DTXcode`. 5-second local check vs a 30-min Apple round trip.
- **Agent lifecycle** — death is REPORTED (new `SessionEnd` hook / socket drop / relay SIGTERM
  / 24h zombie reaper), not inferred from 5 min of silence. Cartridges no longer vanish mid-session.
- **Dismiss a cartridge** — swipe right (mobile) / ✕ (web). `agents.dismissed_at` is a SEPARATE
  column from `status` (view preference vs liveness — a hidden cartridge is often still working).
- **Workflows: pick ONE cartridge** — run-level `agentId` on `POST /v2/:id/start` fills every
  step whose executor is unset or `__deferred__` (and a review-gate's deferred reviewer).
  Per-step `agentOverrides` still wins.
- **`__deferred__` silent hang (CRITICAL)** — it's a TRUTHY string, so it sailed past
  `if (!step.executorId)`, hit `sendCommandToAgent('__deferred__')` → null → step stuck
  `running` forever, and recovery skips deferred steps. **Every mobile-launched workflow hung
  at step 1 with no error.** Now throws and marks the step failed.
- **Mobile**: markdown rendering, newest-first transcript, safe-area gaps, keyboard traps
  (KeyboardAvoidingView measures PARENT-relative but compares to SCREEN coords — needs a
  measured `keyboardVerticalOffset`; hit this TWICE, in the detail screen and the workflow sheet).
- Docs rewritten (SessionEnd, lifecycle, `<SERVER>` = hostname OR IP, the mobile app).

## DONE (2026-07-13 late) — branch `fix/workflow-executor-hardening`, NOT yet merged
Workflows now run end-to-end via the relay (proved: a 4-step review workflow dispatched,
executed and self-advanced through `neoncore_report_step_done`). A 5-step audit of the repo
produced `docs/fix-plan-2026-07-13.md` (read that for the full findings). Fixed on the branch:

- **`idle` no longer means "done" (was CRITICAL).** `idle` = "no hook fired for 2 min", and hooks
  only fire *after a tool returns* — so an agent in one long op (test suite, build, permission
  prompt) got marked idle **while working**, and the executor completed its step by harvesting
  mid-work chatter. Review gates were parsing PASS/FAIL out of "Let me check the files...".
  Idle-based completion is **deleted**. Every prompt now carries an explicit completion
  instruction; a step completes ONLY on `report_step_done`/webhook → `completeStepFromSignal()`.
  Deliberation panels report per-agent via a new `/webhook/:stepId/panel/:agentId/complete`.
- **The executor could kill the server (was CRITICAL).** `tick()` ran a bare loop in a
  `setInterval` with no try/catch, and `normalizeStep` did an unguarded `JSON.parse` of
  `executor_config` — one malformed row = uncaught exception = process death = crash loop on
  restart. Now: per-workflow try/catch, guarded parse, and global `uncaughtException` /
  `unhandledRejection` handlers. **Verified by injecting a poisoned row — server survived.**
- **Runs are no longer destroyed.** They were hard-deleted 30s after finishing, which is why a
  finished workflow's results vanished and mobile had nothing to drill into. Now retained and
  pruned at 7 days by `cleanup-scheduler.ts`.
- **Undelivered commands now FAIL the step** ("no command channel — start a relay") instead of
  sitting `running` forever. `sendCommandToAgent` reports `delivered`; AppleScript errors are
  logged, not swallowed.
- Dead code: epic autopilot deleted (it was dead on both ends — `failEpic` was uncalled because
  its only caller was inside the commented-out block, so **epics could never be marked failed**),
  5 orphaned dashboard components (1,829 lines), 35 unused symbols. `noUnusedLocals` +
  `noUnusedParameters` now ON in both tsconfigs so it can't regress. **Net −2,676 / +466 lines.**
- **`message-reader` hook removed — and this was a live trap.** It posted to `/api/agents/message`,
  an endpoint that no longer exists. `install.sh` has `set -e` and did `chmod +x` on it, so
  deleting the file would have **aborted the installer**. Both `install.sh` and `install.py` fixed.
  The `is_neoncore_hook` detector still matches `message-reader` ON PURPOSE — that's what strips
  the stale hook from settings.json on machines installed before this.

Green: 4/4 tsc clean, ruff clean, 20/20 server tests, health OK after hot-reload.

## NEXT
- **Merge the branch** (still uncommitted/unmerged as of this writing).
- **Re-bootstrap the other Mac + Windows box** from `dist/` — but REBUILD the zips first, they
  still ship the old `message-reader` hook. Also `npm install` in their relay dir.
- **NOT fixed, by decision:** the API has **no auth** and binds `0.0.0.0` — anyone on the LAN can
  forge step completions or inject a prompt into a live agent (RCE by proxy). Fine on a trusted
  home network; fix before this box is on untrusted wifi.
- Mobile still can't drill into workflow steps — the screen was never built (`WorkflowsScreen.tsx`
  run rows aren't tappable; no Step type, no per-run fetch). Backend is ready (`GET /v2/:id`
  returns steps). Now actually worth building, since runs are no longer deleted.
- `openInTerminal()` is NOT orphaned any more (3 callers in `lib/open-directory.ts`) — it's what
  auto-launches the relay. Earlier note in this file was wrong.

## Also outstanding
- Other Mac + Windows box need re-bootstrapping from `dist/` zips (they carry the SessionEnd
  hook + the corrected URL). **Also `npm install` in their relay dir** — same bug will hit them.
- Never fired against live cartridges: mode toggle, Send command (now proven via relay).
- Parked: crash-recovery P2 (auto-recover Trust-mode agents; mass-crash throttle).
- User will test NeonCore driving **Gridlight** (their own AI) soon.
