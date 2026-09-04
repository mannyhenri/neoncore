# NeonCore build order — remote control

Date: 2026-09-04
Owns: `discord-remote-control.md` (which is a *driver* spec, not this architecture)

**No phase depends on another repository or on any particular application.** Discord is the
first driver written against an interface, not the design. Swapping it for Slack, Telegram, a
webhook, or your own app must not touch anything below N1.

---

## State

| | |
|---|---|
| `server/src/lib/discord-bot.ts` | Written, typechecks clean, **not wired.** Has the right surface (`isConfigured`, send-with-files-and-buttons, handler registries) but is currently a standalone module, not a driver. |
| discord.js 14.27.0 | Installed, uncommitted. |
| `lib/apns-push.ts` | Shipped. Already a channel in all but name. |
| Channel abstraction | Does not exist. Call sites import `sendPushToAll` directly. |
| Autonomy levels | Not started. |
| Attachments on permission requests | Not started. |

---

## N1 — Channels · the phase that keeps every app replaceable

Today `stuck-detector.ts`, `workflow-executor-v2.ts` and `routes/permissions.ts` import
`sendPushToAll` from `lib/apns-push.js` directly. One more direct import of a second app and
every future channel means editing every call site.

Create `lib/channels.ts`:

```ts
export interface Notice {
  title: string;
  body: string;
  attachments?: string[];                  // absolute paths on this machine
  detail?: Record<string, string>;         // ordered, rendered as labelled lines
  actions?: { id: string; label: string; style?: string }[];
  data?: Record<string, unknown>;          // routing metadata, e.g. workflowId
}

export interface Channel {
  readonly name: string;
  isConfigured(): boolean;
  send(notice: Notice): Promise<boolean>;
}

export function registerChannel(c: Channel): void;
export async function notifyAll(notice: Notice): Promise<void>;
```

Then:

1. **Port APNs to it.** `apns-push.ts` becomes a `Channel` — it already has `isPushConfigured()`
   and a `(title, body, data)` send. A channel that cannot carry a field **says so in its return
   rather than pretending**: APNs drops `attachments` and reports it, so a missing picture is a
   known limitation and not a mystery.
2. **Wrap `discord-bot.ts` as a second `Channel`.** Its `sendToDiscord` already takes files and
   buttons; the adapter is thin.
3. **Replace every direct import** at the three call sites with `notifyAll`.

Do the same on the way in. A command arriving to drive NeonCore is a `CommandSource`:

```ts
export interface CommandSource {
  readonly name: string;
  isConfigured(): boolean;
  start(): Promise<void>;
  // dispatch is shared: registerCommand / registerAction stay app-agnostic
}
```

`registerCommand` and `registerAction` already live in `discord-bot.ts` and mention nothing
app-specific — **move them into `lib/commands-registry.ts`** so the dashboard, a webhook, or a
future app registers against the same table.

**Done when:** `notifyAll` fans one notice to every configured channel, and no file outside
`lib/channels/` imports an app SDK.

## N2 — First driver + transport proof · needs N1

Configure and wire one driver end to end. Discord is the one specified in
`discord-remote-control.md`; the steps there (bot token, operator id, Message Content intent,
`startDiscordBot()` in `index.ts`) are that driver's setup, not NeonCore's requirements.

Register `!cartridges` and `!prompt <cartridge> <text>` against the shared registry.

**Done when:** from your phone, off the LAN, you list cartridges and drop a prompt into a live
session — through the abstraction, not around it.

## N3 — Attention events · needs N2

Fan the five reasons in `lib/workflow-attention.ts` out as notices: `failed`, `interrupted`,
`decision`, `agent-waiting`, `manual-advance`. Each carries `actions` for what can resolve it —
answer a question, approve/reject a plan, resolve a decision gate, advance a held step.

Actions resolve through the endpoints that already exist. **This is the phase that ends work
stalling while you are away**, and it is written once for all channels.

## N4 — Autonomy levels · needs N3 for its notifications

```sql
ALTER TABLE workflows ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE workflows ADD COLUMN autonomy_expires_at TEXT;
ALTER TABLE projects  ADD COLUMN default_autonomy TEXT NOT NULL DEFAULT 'manual';
CREATE TABLE workflow_auto_resolutions (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, step_id TEXT NOT NULL,
  reason TEXT NOT NULL, chose TEXT NOT NULL, autonomy TEXT NOT NULL,
  overridden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
```

The audit table is not optional. The first time a `full` run picks something you disagree with,
the only useful question is what it chose and on what basis.

In order: **`advance`** (reason 5 only — releases a finished step, decides nothing), the
`autonomy` command with its time-box, then **`full`** with the hold-if-no-default rule and the
override window. `failed` and `interrupted` are never auto-resolved at any level — that is
breakage, not a gate.

## N5 — Rich permission requests · a generic capability

`neoncore_request_permission` takes only strings, so no agent can show you anything. A coding
cartridge cannot show the diff it wants to apply; a screenshot task cannot show the screen.

Add `attachments` and `detail` to the permission record, carried on the `Notice`. **NeonCore
does not interpret either** — it renders what it is handed and returns a decision plus an
approval id. It never validates a requester's payload and never re-checks whether an approval is
still valid for its inputs: only the requester knows what its inputs are.

Also: **stop coercing unknown agent types.** `NEONCORE_AGENT_TYPE` defaults to `codex` and an
unrecognised value is silently accepted (`docs/gridlight-strategy.md:253`), which is how any
non-Claude, non-Codex worker ends up mislabelled on the grid. Accept arbitrary types and record
them as given.

---

## Integration boundary

NeonCore orchestrates agents. It exposes generic capabilities — a queue, approvals, notices,
autonomy — and knows nothing about any domain it orchestrates or any app it delivers through.

- **No shape from another repository** is imported, referenced or version-matched here.
- **No application SDK outside `lib/channels/`.** If `discord.js` appears in an executor or a
  route, the abstraction has failed.
- **No field named after a domain concept.** If it is not useful to a Claude Code cartridge, it
  belongs in the requesting agent, not here.

An agent that wants a picture in front of you flattens its own payload into `attachments` and
`detail`. That mapping is the agent's or its adapter's — machine configuration, not code here.

## Do not

- Write N3 against one app. It is written once, against `Notice`.
- Ship `full` before `advance`. Live with `advance` for a week.
- Skip N1 to get a bot working sooner. The one-app version is the version you rewrite.

## First 30 minutes

```bash
cd ~/code/neoncore
git add -A && git commit -m "docs: remote control plan; add discord.js"
cd server && npx tsc --noEmit          # expect 0 errors
```

Then N1. It is small — one interface, one registry, and porting a module that already has the
right shape.
