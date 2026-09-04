# Hermes ↔ NeonCore ↔ Film Engine

Date: 2026-09-04
Status: design. Nothing installed yet — Hermes is not present on this machine (`~/.hermes` absent).

---

## The finding that shapes this

**NeonCore already solves most of "work doesn't progress while I'm away."** It has a task
queue with pull semantics, three autonomy modes, an approval gate, APNs push and a phone
dashboard. What it does *not* have is:

1. **An always-on worker.** Every cartridge is a Claude Code / Codex session sitting in a
   repo. Film Engine production work — generate a strip, review it, re-roll a bad station —
   is not a coding session. Tasks queued for it have nobody to claim them, so the queue holds
   and nothing moves.
2. **A chat front door.** APNs push notifies; it does not let you *start* work from Discord
   or WhatsApp.
3. **Autonomous initiation.** Dispatch targets agents that are already connected.

Hermes is exactly those three things. And the two systems' weaknesses cancel:

| Gap | Filled by |
|---|---|
| Hermes cron has **no approval mechanism** for unattended runs (their docs say so plainly) | `neoncore_request_permission` — blocks up to 600s waiting for dashboard approval, delivered to the phone by APNs |
| NeonCore has no always-on worker and no chat gateway | Hermes gateway (Discord/Telegram/Slack/WhatsApp) + cron scheduler |
| Neither can spend safely alone | Film Engine's own gates: free `*_plan` tools, 402 budget refusal, 409 STALE fingerprints |

## Architecture

```
Discord / WhatsApp / Telegram
        │
        ▼
  Hermes gateway ──────────► POST /tasks            (NeonCore queue)
        │                          │
        │  cron: every 5 min       │
        ▼                          ▼
  Hermes worker ── neoncore_my_queue / neoncore_claim_task
        │
        ├── film-engine MCP tools (plan → generate)
        ├── neoncore_request_permission  ← anything that spends
        └── neoncore_report_task_done → result → Discord + dashboard
```

**The rule that keeps this sane: NeonCore's queue is the single source of truth.** A message
in Discord creates a *NeonCore task*, it does not start work directly. Otherwise you get two
queues, two histories and two places to look when something stalls — and the phone dashboard
stops being the answer to "what is happening right now".

---

## Prerequisites

1. Install Hermes (`curl` one-liner from hermes-agent.org, then `hermes setup`). **Not done.**
2. Build NeonCore's MCP server: `npm run build` → `server/dist/mcp-server.js`.
3. NeonCore server running (default `http://localhost:4040`).
4. Film Engine MCP at `backend/mcp-server.js` (already stdio, JSON-RPC, no SDK).

---

## Hermes config

`~/.hermes/config.yaml`

```yaml
mcp_servers:

  neoncore:
    command: "node"
    args: ["/Users/mannyhenri/code/neoncore/server/dist/mcp-server.js"]
    env:
      NEONCORE_URL: "http://localhost:4040"
      NEONCORE_AGENT_TYPE: "hermes"
    enabled: true
    trust: full
    timeout: 900          # neoncore_request_permission blocks up to 600s
    connect_timeout: 60
    supports_parallel_tool_calls: false

  film-engine:
    command: "node"
    args: ["/Users/mannyhenri/code/film-engine/backend/mcp-server.js"]
    env:
      FILM_DATA_DIR: "/Users/mannyhenri/.gridlight/film-engine/data"
      # Provider keys MUST be listed explicitly — Hermes does not inherit the shell
      # environment for stdio servers. Missing keys look like a provider outage.
      RUNWAY_API_KEY: "***"
      ANTHROPIC_API_KEY: "***"
    enabled: true
    trust: untrusted
    timeout: 900          # generation routes use 600s provider timeouts
    connect_timeout: 60
    supports_parallel_tool_calls: false
    tools:
      include:
        - "*_plan*"
        - "*_list"
        - "*_get"
        - "dry_run"
        - "scale_check"
        - "staleness_report"
        - "shot_prompt"
        - "video_preview"
        - "previs_to_storyboard"
        - "sequence_plan*"
        - "spend_*"
        - "export_preflight"
        - "compliance_check"
```

### Why these values

- **`timeout: 900` on both.** Hermes defaults to 300s. `neoncore_request_permission` blocks
  for up to 600s and Film Engine's generation routes pass `{ timeout: 600000 }` to providers.
  At 300s Hermes abandons a generation that Runway is still running *and still billing*.
- **`supports_parallel_tool_calls: false`.** Film Engine's `generateSequence` deliberately
  stops at the first provider refusal rather than buying the same failure N times. Parallel
  calls defeat that.
- **`trust: untrusted` on film-engine.** Write-capable tools require approval in interactive
  sessions. It does nothing in cron — see below — which is why the whitelist matters more.
- **The `include` list is a quality control, not only a guardrail.** Film Engine's MCP surface
  is 300+ tools; registering all of it into an agent's tool registry degrades tool selection
  regardless of safety.
- **`NEONCORE_AGENT_TYPE: "hermes"`** so the worker is distinguishable from Claude Code
  cartridges on the dashboard.

---

## The autonomy rule

Hermes's own cron docs: *"There is no approval mechanism for unattended runs."* `trust:
untrusted` is therefore inert in a scheduled job — there is nobody to approve at 3am.

**So a cron job may only call tools that cannot spend.** Anything that generates must first
call `neoncore_request_permission`, which routes the decision to the dashboard and the phone,
and blocks. That is the *only* approval path that works unattended, and it is NeonCore's, not
Hermes's.

Enforce it two ways, belt and braces: the `include` whitelist above (no generating tools at
all), plus `enabled_toolsets` per cron job.

---

## Cron jobs to start with

### 1. Nightly sweep — free, zero spend risk

```
Schedule: 0 3 * * *
Toolsets: film-engine (read-only whitelist), neoncore
Prompt:   For every active Film Engine project run staleness_report, scale_check,
          export_preflight and sequence_plan_inbetweens. Summarise what is stale,
          what is missing a size, what would be refused, and what the next run
          would cost. Do not generate anything.
Deliver:  Discord #film-engine
```

This is the one that turns "nothing happened overnight" into a morning briefing, and it
cannot spend a credit.

### 2. Queue worker — every 5 minutes

```
Schedule: */5 * * * *
Toolsets: neoncore, film-engine (read-only whitelist)
Prompt:   Call neoncore_my_queue. If a task is claimable and its instructions are a
          Film Engine planning task, claim it, carry it out using only free planning
          tools, and report the result with neoncore_report_task_done. If the task
          requires generation, call neoncore_request_permission with the exact tool,
          the shot codes and the credit estimate from the plan, and only proceed if
          approved. Never generate without an approval id.
Deliver:  origin chat
```

### 3. Weekly spend report

```
Schedule: 0 9 * * MON
Toolsets: film-engine (spend_*), neoncore
Prompt:   Report spend by project and by capability for the last 7 days against budget.
Deliver:  Discord + Slack
```

Note: cron sessions start fresh with **no memory of previous runs**. That is correct here —
approval state, fingerprints and take history live in Film Engine's and NeonCore's databases,
not in the agent's head.

---

## NeonCore-side work

Small, but needed:

1. **Accept `hermes` as an agent type.** `NEONCORE_AGENT_TYPE` defaults to `codex`; confirm
   an unknown type registers cleanly rather than being silently coerced
   (`docs/gridlight-strategy.md:253` notes both defaults are silent).
2. **A task template for Film Engine work** so a Discord message maps onto a task shape the
   worker can recognise — project id, scene or shot codes, and whether generation is in scope.
3. **Surface the approval reason.** `neoncore_request_permission` should carry the credit
   estimate and shot codes into the dashboard card, so a phone approval is an informed one
   rather than a yes/no on an opaque tool name.

## Film Engine-side work

None required for the read-only path. For the generating path later, the useful addition is a
**hard per-run credit ceiling** passed into the run so a mistake in the prompt cannot walk past
the budget check one 402 at a time.

---

## Risks

- **WhatsApp is unverified.** The Hermes WhatsApp doc page 404s. WhatsApp automation is either
  the official Business API (paid, restricted outside a 24h window) or a bridge driving a
  personal account (risks the account). Confirm which before depending on it. Discord and
  Telegram are ordinary bot tokens and carry none of this.
- **Self-evolving skills + credit-spending tools.** A skill Hermes writes for itself can only
  call tools that were registered, so the `include` whitelist is the real boundary. Keep
  generating tools out of it until the approval loop has been exercised for a while.
- **Two dashboards.** If Hermes's own history becomes where you look for what happened, the
  integration has failed. Everything of consequence should be visible in NeonCore.

## Done when

A Discord message creates a NeonCore task; a Hermes cron run claims it, plans it with free
tools, asks for permission on the phone before spending, and posts the result back to Discord
— with the whole thing visible as a cartridge on the NeonCore dashboard.
