# NeonCore crash-recovery subsystem — plan

**Status:** design locked, pre-implementation
**Branch:** feature/dual-runtime-parity-eval
**Author:** Manny + Claude (via /plan-eng-review)
**Date:** 2026-07-03

## Problem

A workflow run killed mid-stream is unrecoverable today. Real crash observed:

```
[NeonCore] Launching Gridlight Terminal Code...
Resume this session with:  claude --resume d6106f74-ea7e-441e-807c-bc2d9f1274ca
launch.sh: line 8: 52132 Terminated: 15   node ".../agent/relay/launch.js"
```

`Terminated: 15` = SIGTERM (parent app quit / power loss / OOM). The step stays
`running` forever: standard claude-code/command/connector/decision steps complete
only via webhook (`workflow-executor-v2.ts:1283`), the dispatched command was lost,
and nothing re-sends it or times it out. Claude's own `claude --resume` is
unreliable — SIGTERM can truncate its session JSONL mid-write.

## Decisions locked

- **D1 — Recovery mechanism: transcript replay (NeonCore-owned).** Rebuild context
  from the transcript NeonCore already stores and inject into a fresh agent session.
  NOT native `--resume` (that is the fragile path already failing us; it can be
  added later as a fidelity optimization).
- **D2 — Automation posture: auto-recover by trust mode.** Trust-mode agents
  auto-replay on detection; Manual/Plan-mode agents surface a Resume action and
  wait for a human click.

## What already exists (reuse, don't rebuild)

- **Full transcript is already captured.** `messages` table (`db.ts:352-373`):
  per-turn role/text/thinking/tool_use/tool_result + tokens, keyed by native
  session id, unified claude+gridlight via `engine`. Ingested by `reporter.py`
  → `POST /api/agents/transcript` (`agents.ts:284-401`), idempotent on
  `(session_id, seq)`. **But it is write-only — nothing SELECTs it.**
- **Native session id is known** server-side (via hooks; `agents.session_id`,
  `sessions.session_id`, `messages.session_id`).
- **Periodic 30s sweep** exists (`index.ts:138-167`) demoting agent status
  (working→idle→offline) — extend it, don't add a new scheduler.
- **Command delivery + drain-on-reconnect** exists: `sendCommandToAgent`
  (`send-command.ts`) enqueues; the relay drains pending on connect
  (`relay/index.js:198 drainPending`). Recovery enqueues; existing delivery ships it.
- **Context injection** exists: `context-injector.ts` already dispatches a
  context blob as a prompt — extend it to build from `messages` instead of summaries.

## What's missing (the actual work)

1. Read path for `messages` (build replay context).
2. Reconciliation of `running` steps whose agent is offline.
3. Recovery dispatch + trust-mode branching.
4. Relay: POST an interrupt signal on SIGTERM before killing the PTY.
5. Dashboard surface for interrupted / recovering / recovered / failed steps.

## Architecture

```
┌─ DETECTION ─ startup + existing 30s sweep (index.ts:138-167) ─────────┐
│  scan workflow_steps WHERE status='running'                           │
│    AND agent has no live socket   (ws.ts hasActiveSocket = false)     │
│    AND started_at older than GRACE_MS (90s, avoids false positives    │
│        on a brief disconnect)                                          │
│  ⇒ step: running → interrupted   (set interrupted_at, resolve+store   │
│                                    native_session_id from messages)   │
└────────────────────────────────────────────────────────────────────────┘
                              │
┌─ RECOVERY ─ per interrupted step (lib/recovery.ts) ───────────────────┐
│  CAS guard: recovery_status  null → 'recovering'  (idempotent;        │
│             skip if already recovering / a live socket appeared)      │
│  build replay context from messages:                                  │
│    SELECT role,content,seq FROM messages WHERE session_id=? ORDER seq │
│    ⇒ recent N turns verbatim + older turns condensed (respect caps)   │
│    ⇒ "You were mid-task. Here is the conversation so far, including   │
│       tool results you already produced. Continue from where you      │
│       left off; do not repeat work already done."                     │
│  branch on agent trust mode:                                          │
│    trust → enqueue replay command now (auto-recover)                  │
│    manual/plan → mark interrupted, surface Resume in dashboard        │
│  delivery: sendCommandToAgent enqueues; relay drainPending ships it   │
│            on (re)connect. Optionally auto-relaunch cartridge (trust).│
│  on delivery+completion ⇒ recovery_status='recovered', step resumes   │
│    normal webhook completion path                                     │
└────────────────────────────────────────────────────────────────────────┘
                              │
┌─ RELAY hardening (agent/relay/index.js:228) ──────────────────────────┐
│  on SIGTERM/SIGHUP, BEFORE killing the PTY:                           │
│    POST /api/agents/interrupted {machine, repoPath, agentType}        │
│  ⇒ server marks that agent's running step interrupted instantly,      │
│    not on the next 30s tick. Relay need NOT know the session id;      │
│    server resolves agent → latest session → messages.                 │
└────────────────────────────────────────────────────────────────────────┘
```

### Lost-webhook case (agent finished but completion was lost)
Replay hands the agent its own prior `tool_result`s. It sees the work is done,
confirms/no-ops, and completes normally. No special-casing needed.

## Data model changes

`workflow_steps` — add:
- `native_session_id TEXT` — resolved from the agent's session at detection.
- `interrupted_at INTEGER` — unix ms when marked interrupted.
- `recovery_status TEXT` — null | `interrupted` | `recovering` | `recovered` | `recovery_failed`.
- `recovery_attempts INTEGER NOT NULL DEFAULT 0` — bound retries (cap 3).

No new tables. `messages` gains a read path only.

## New/changed surfaces

- `server/src/lib/recovery.ts` — detection query, `buildReplayContext(sessionId)`,
  `recoverStep(step)`, trust-mode branch. (new)
- `server/src/index.ts` — call reconciler on startup + inside the 30s sweep.
- `server/src/routes/agents.ts` — `POST /api/agents/interrupted`.
- `server/src/routes/workflows.ts` — `POST /steps/:id/recover` (Resume button + auto).
- `agent/relay/index.js` — SIGTERM handler posts interrupt before PTY kill.
- Dashboard — interrupted/recovering badges + Resume action.

Files touched: ~6-7. Bounded.

## Safety / idempotency (blast-radius controls for the auto path)

- **CAS on `recovery_status`** prevents double-dispatch across restarts and
  across the sweep firing while a recovery is in flight.
- **Never recover an agent with a live socket** (`hasActiveSocket`) — it may
  still be working; the grace window + socket check guard this.
- **`recovery_attempts` cap (3)** → `recovery_failed`, surfaced, never silent.
- **Mass-crash throttle:** auto-recover at most K steps per sweep (e.g. 5) so a
  power outage doesn't fan out destructive re-runs all at once; remainder queue.
- **Replay includes tool_results** so the agent avoids repeating side effects;
  residual risk (non-idempotent tools) is why Manual mode stays human-gated.

## Test plan (coverage target: all new paths)

```
lib/recovery.ts
  buildReplayContext()
    ├── [★★★] empty session → minimal prompt, no crash
    ├── [★★★] single turn → verbatim
    ├── [★★★] many turns → recent verbatim + older condensed, ordered by seq
    └── [★★★] capped/truncated blocks → still valid prompt (note truncation)
  detectInterrupted()
    ├── [★★★] running + offline + past grace → interrupted
    ├── [★★★] running + LIVE socket → untouched (guard)
    ├── [★★★] running + offline but within grace → untouched
    └── [★★★] idempotent: second sweep does not re-mark 'recovering' steps
  recoverStep()
    ├── [★★★] trust mode → enqueues replay command
    ├── [★★★] manual mode → stays interrupted, no dispatch
    ├── [★★★] CAS: concurrent recover → one wins, one skips
    └── [★★★] attempts > 3 → recovery_failed
routes
  └── [★★ →E2E] POST /api/agents/interrupted marks running step interrupted
relay
  └── [★★] SIGTERM handler POSTs interrupt before exit (mock server)
integration
  └── [→E2E] crash → detect → recover → step completes (full loop)
```

## Failure modes

| Path | Failure | Test? | Handled? | User sees |
|------|---------|-------|----------|-----------|
| Replay build | messages truncated by caps | yes | accepted, older turns condensed | slightly lossy resume |
| Delivery | agent never reconnects | yes | step stays `interrupted`, surfaced | Resume still available |
| Reconciler | double-recover race | yes | CAS on recovery_status | one recovery only |
| Auto path | non-idempotent tool re-run | partial | tool_results in replay + attempts cap | rare repeated side effect |
| Relay | interrupt POST fails (server down) | yes | 30s sweep catches it on next boot | recovery delayed, not lost |

No failure mode is both silent AND unhandled.

## Phased rollout

- **P1 (this PR):** detection + reconciler + `messages` read path + relay SIGTERM
  POST + Resume action (human-gated for ALL agents). Solves "nothing is
  unrecoverable" end to end.
- **P2:** trust-mode auto-recover + mass-crash throttle (D2 in full).
- **P3 (later, optional):** native `--resume` fast-path as a fidelity boost when
  the JSONL survives, with replay as fallback (the hybrid).

## NOT in scope

- Native `claude --resume` orchestration — deferred to P3; replay is the backbone.
- Byte-identical transcript fidelity — caps make the copy lossy by design; acceptable.
- V1 phase-workflow executor (`workflow-executor.ts`) — V2 steps first; V1 shares
  the same reconciler pattern later if needed.
- Epic autopilot recovery — executor is commented out (`index.ts:185`).
- Cursor/Codex/Gemini/AmazonQ runtimes — claude + gridlight first (unified table
  already supports the others when their hooks land).

## Open implementation details (decided, not blocking)

- GRACE_MS = 90s; sweep reuses existing 30s cadence.
- native_session_id resolved server-side (relay stays dumb).
- replay: keep last ~10 turns verbatim, condense older into a summary line.
```
```
