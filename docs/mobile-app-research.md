# NeonCore Mobile Companion — Phase 1 Research

**Status:** Phase 1 (research) complete · **Date:** 2026-07-11
**Decisions locked:** LAN-only MVP · Mirror + full control · React Native (Expo)

A phone app to (A) mirror what the terminal shows — Claude's latest comments/questions and
live message stream — and (B) control the orchestrator (commands, approvals, trust mode, tasks,
workflows). It is a second, touch-optimized client of the **existing** server API.

---

## Feasibility

Highly feasible. The server already exposes everything needed:
- Binds `0.0.0.0` and prints a LAN URL (`server/src/index.ts:234`) — a phone on the same Wi-Fi connects directly.
- Same Socket.io + REST surface the web dashboard uses — no orchestrator changes for read + basic control.
- A mobile-push path already exists (ntfy, `server/src/lib/push-notify.ts`).

**One required server addition:** a transcript-history GET endpoint (see Gaps).

---

## Goal A — Mirror terminal messages

Terminal content reaches the server via the reporter hook → `POST /api/agents/transcript`
(`server/src/routes/agents.ts:297`). Each event is:
- persisted to the `messages` table (role + content blocks: `text`/`thinking`/`tool_use`/`tool_result`, model, tokens);
- broadcast live as Socket.io **`transcript_event`** (`server/src/types.ts:441`).

Summary signals on the agent object (ride on **`agent_updated`**):
- **`lastMessage`** — latest assistant text, 500-char summary (`agents.ts:401`).
- **`pendingQuestion`** — open `AskUserQuestion`.

## Goal B — Control the orchestrator (REST)

| Action | Endpoint |
|---|---|
| Send prompt/command into a live agent | `POST /api/commands/send` `{agentId, text}` |
| Approve/deny · answer AskUserQuestion · approve plan | `POST /api/permissions/decide` `{id, decision, response}` |
| List pending approvals | `GET /api/permissions/pending` |
| Set autonomy mode (manual/plan/trust) | `/api/trust/*` |
| Task queue | `/api/tasks/*` |
| Workflows (run/steer/pause) | `/api/workflows/*` |
| Agents / goals / cost / git | `/api/agents`, `/api/goals`, `/api/git` |

---

## Real-time events the app subscribes to

Passive Socket.io subscriber (no `register_extension` handshake — that's for agent-hosting clients only).
Mobile-relevant subset of `ServerToClientEvents` (`types.ts:437`):

- `transcript_event` — live message blocks (Goal A)
- `agent_updated` / `agent_registered` — status, `lastMessage`, `pendingQuestion`
- `permission_requested` / `permission_decided` — approvals inbox (Goal B)
- `agent_stuck` / `agent_unstuck` — top push trigger
- `turn_complete` — token/cost meter
- `task_updated`, `workflow_step_updated`, `workflow_step_log` — job progress

---

## Gaps / findings

1. **No transcript-history GET endpoint.** `messages` is written but never read back over HTTP; the
   dashboard accumulates `transcript_event`s live in memory only. A phone reconnects constantly, so it
   needs history-on-open. **Required Phase-2 task:** `GET /api/agents/:id/messages?limit=&before=`.
2. **No auth / open CORS** (`ws.ts:17`). Acceptable for LAN-only MVP; revisit before any off-LAN reach.
3. **LAN-only by default.** Off-network use (later) needs a tunnel (Tailscale) — out of MVP scope.
4. **Payloads are phone-friendly** — content pre-parsed into typed blocks; summaries pre-truncated.
5. **Interactive push** — plain ntfy shows text only; approve-from-notification needs Expo push (FCM/APNs)
   or ntfy action buttons. Deferred past MVP.

---

## Chosen approach

- **Stack: React Native (Expo).** Reuse the dashboard's `types.ts`, Socket.io client, and REST shapes.
- **Connectivity: LAN-only.** Enter server URL (e.g. `http://192.168.x.x:4040`) on first launch; no auth.
- **Scope: mirror + full control.**

---

## Phase-2 build roadmap (proposed)

1. **Server (small):** add `GET /api/agents/:id/messages?limit=&before=` reading the `messages` table,
   normalized to the `TranscriptEvent` shape. Only backend change required for the MVP.
2. **App scaffold:** Expo + TypeScript; port `dashboard/src/types.ts`; server-URL onboarding screen;
   Socket.io client + REST fetch wrapper.
3. **Screen 1 — Cartridge grid:** live from `GET /api/agents` + `agent_updated`; status, `lastMessage`,
   cost; pending-approval badge.
4. **Screen 2 — Cartridge detail:** message stream (history endpoint + live `transcript_event`),
   rendered by content-block type; command box (`POST /api/commands/send`); trust-mode toggle.
5. **Screen 3 — Approvals inbox:** `GET /api/permissions/pending` + `permission_requested`;
   approve/deny, answer AskUserQuestion, approve plan via `POST /api/permissions/decide`.
6. **Control surfaces:** task push + workflow run/steer.
7. **Notifications:** subscribe phone to the ntfy topic immediately for value; add Expo push later.

**Fastest interim win:** subscribe the phone to the ntfy topic now (no app) for stuck/permission alerts.
