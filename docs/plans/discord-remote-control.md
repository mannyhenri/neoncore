# Discord as the remote control for NeonCore + Film Engine

Date: 2026-09-04
Status: design. Supersedes the NeonCore half of `hermes-integration.md`
(that doc is now scoped to Film Engine daily automation only).

---

## Why Discord and not a tunnel

A Discord bot holds a **persistent outbound WebSocket** to Discord's gateway. Nothing
listens, nothing is port-forwarded, nothing is exposed to the internet, and no VPN client is
needed on the phone. `SETUP.md:16` currently requires "same LAN or VPN" for reachability;
a bot removes that requirement for the human channel without weakening the network posture.

**The trade you are accepting, stated once.** With no tunnel there is no link home that
resolves from outside, so review media must be *uploaded to Discord* and will live on their
CDN. Discord attachment URLs are effectively unauthenticated — anyone holding the link can
fetch the file. For a production aiming at theatrical release, decide deliberately what is
allowed to leave the building. Mitigations in "Media" below.

---

## What actually stops a run — from `lib/workflow-attention.ts`

Trust mode gates `PreToolUse`. It does **not** resolve any of these. This is the real list:

| # | Reason | Trigger | Auto-continuable? |
|---|---|---|---|
| 1 | `failed` | a step failed | **No** — breakage, not a gate |
| 2 | `interrupted` | executor died mid-step, `recovery_status = 'interrupted'` | **No** — needs recovery |
| 3 | `decision` | step with `executor_type = 'decision'`; "nothing was dispatched and nothing ever will be until someone chooses" | Yes, by policy |
| 4 | `agent-waiting` | the cartridge asked a question (agent status `waiting`) | Yes, by policy |
| 5 | `manual-advance` | step `completed` with `auto_advance = 0`, and work remains | **Yes, safely** |

Quality gates are already handled — a `FAIL` verdict resets the preceding step and re-runs to
a cycle limit. They are not what is blocking you.

**Reason 5 is the important one.** Nothing is being decided there; a finished step is simply
held. Auto-advancing it makes no choice on your behalf. That is likely most of the waiting you
experience, and it is the safest thing to automate.

---

## The autonomy control

`auto_advance` already exists as a per-step column. What is missing is a run-level override.

Add `autonomy` to a workflow run (and as a project default):

| Level | Behaviour |
|---|---|
| `manual` | today's behaviour — every reason above waits for you |
| `advance` | auto-resolves **reason 5 only**. No decision is ever made for you. |
| `full` | also resolves **3** and **4**: a decision gate takes its configured default branch; an agent question takes its stated default answer |

Never auto-resolve 1 or 2 at any level — a failed or interrupted run needs recovery, and
"continuing" past it produces work built on a broken step.

**`full` at a decision gate with no configured default holds and notifies.** Do not invent a
branch. This is the one tunable worth arguing about; the safe default is to hold.

**Time-boxing.** `autonomy` carries an optional `expires_at`. "Full authority for the next two
hours" is what "in certain cases I'm willing to take the risk" actually means — a mode you
forget to flip back is unbounded risk. On expiry it reverts to the project default.

**The soft gate.** Every auto-resolution posts to Discord as it happens: what was chosen, why,
and an Override button live for N minutes. Work continues immediately; you get a window. This
is the difference between automation you trust and automation you monitor.

---

## The bot

One process, sibling to `lib/apns-push.ts`, bidirectional. APNs stays — this is an additional
channel, not a replacement.

### Outbound (NeonCore → Discord)

- **Attention events** — the five reasons above, one message each, with buttons. The message
  names the workflow, step, cartridge and repo.
- **Permission requests** — `neoncore_request_permission` fans out here as well as to the
  dashboard and phone. Approve / Deny buttons resolve the same long-poll (600s).
- **Film Engine approvals** — media attached, full details in the body (see Media).
- **Digests** — nightly Film Engine sweep, weekly spend, workflow completions.

### Inbound (Discord → NeonCore)

| Command | Maps to |
|---|---|
| `/prompt <cartridge> <text>` | existing send-a-prompt into the live session |
| `/workflow start <template> <project>` | workflow launch |
| `/workflow status [id]` | run state + current attention |
| `/autonomy <target> <manual\|advance\|full> [duration]` | the control above |
| `/queue add <title> <instructions>` | `POST /tasks` |
| `/cartridges` | grid summary |
| Buttons | answer a question, approve/reject a plan, resolve a decision gate, advance a held step, approve/deny a permission |

**Everything routes through NeonCore's existing endpoints and tables.** The bot is a transport,
never a second source of truth — no state lives in Discord.

### Identity

Bind one Discord user id to the operator in settings and **reject commands from anyone else**,
including in a channel someone else can post in. The bot can start agent work on your machines;
channel membership is not an authorisation model.

---

## Media

Film Engine assets are files on disk. With no tunnel they must be uploaded.

- **Stills** — post directly. A keyframe or plate is well inside any limit.
- **Footage** — never the master. Post a compressed proxy (720p, a few seconds) plus a still.
  Discord's attachment ceiling is 10MB on the free tier, higher with Nitro or a boosted
  server — verify the current number before sizing the proxy.
- **Audio** — Discord plays attachments inline; post the cue, not the session.
- **Full details** in the message body, because the picture alone is not an approval: shot
  code, project, the prompt actually sent, references attached, `style_applied`, credit
  estimate, and the tool about to run.
- **Retention** — a channel used for approvals accumulates unreleased assets indefinitely.
  Set a retention policy or use a private channel you prune.

---

## Build order

1. **Bot skeleton + identity binding + `/cartridges`, `/prompt`.** Proves the outbound socket
   and the command path. Immediately useful on its own.
2. **Attention events outbound, with buttons for reasons 3, 4 and 5.** This alone ends "work
   stops while I'm away" for NeonCore.
3. **`autonomy` field + `advance` level + time-box.** The safe half of the button you asked for.
4. **`full` level**, with the hold-if-no-default rule and the override window.
5. **Permission fan-out to Discord.**
6. **Film Engine media approvals** — needs the Hermes worker from `hermes-integration.md` and
   a media-carrying permission payload.

Steps 1–3 deliver most of the value and touch nothing that spends money.

---

## Schema

```sql
-- workflow run autonomy
ALTER TABLE workflows ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE workflows ADD COLUMN autonomy_expires_at TEXT;
-- project default
ALTER TABLE projects  ADD COLUMN default_autonomy TEXT NOT NULL DEFAULT 'manual';
-- audit: every auto-resolution, so "why did it do that" is answerable
CREATE TABLE workflow_auto_resolutions (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, step_id TEXT NOT NULL,
  reason TEXT NOT NULL, chose TEXT NOT NULL, autonomy TEXT NOT NULL,
  overridden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
```

The audit table is not optional. The first time a `full` run makes a choice you disagree with,
the only useful question is what it chose and on what basis.

## Done when

From a phone, with no VPN: you see a workflow stop, you read why, you answer it or grant
two hours of full authority, and the run continues — and a Film Engine approval arrives as a
picture with the numbers beside it and clears with one tap.
