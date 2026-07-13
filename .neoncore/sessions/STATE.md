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

## NEXT — the thing that caused all this pain
**NeonCore lies when a cartridge has no command channel.** It queues commands into the void and
reports the workflow as "running". Proposed (not built):
- Warn/refuse at launch if the target cartridge has no relay/extension socket.
- Mark a step **failed** ("no command channel — start a relay"), not `running` forever.
- Badge hooks-only cartridges in both UIs so it's visible BEFORE you rely on one.
- Consider auto-starting a relay (`openInTerminal()` in `lib/open-directory.ts` exists but has
  **zero callers** — orphaned).

## Also outstanding
- Other Mac + Windows box need re-bootstrapping from `dist/` zips (they carry the SessionEnd
  hook + the corrected URL). **Also `npm install` in their relay dir** — same bug will hit them.
- Never fired against live cartridges: mode toggle, Send command (now proven via relay).
- Parked: crash-recovery P2 (auto-recover Trust-mode agents; mass-crash throttle).
- User will test NeonCore driving **Gridlight** (their own AI) soon.
