# NeonCore agent relay

Run a **bare-terminal** Claude Code session that can receive NeonCore workflow
commands — **no VS Code required**, on **macOS, Linux, or Windows**.

## What it does

The relay launches your agent CLI inside a pseudo-terminal (PTY) that it owns,
connects to the orchestrator over Socket.io, and types dispatched workflow
prompts directly into that PTY's stdin.

Because each relay owns exactly one PTY, delivery is perfectly addressed —
**one relay = one agent = one PTY** — so you can run a dozen of these in a dozen
terminals and each only ever receives its own commands. This is the same
delivery channel the VS Code extension uses (`agent:<id>` socket room), minus the
editor.

| | VS Code extension | AppleScript fallback | This relay |
|---|---|---|---|
| Windows / Linux | ✅ / ✅ | ❌ / ❌ | ✅ / ✅ |
| Targets the right window among many | ✅ | ❌ (frontmost only) | ✅ |
| Needs an editor | yes | no | no |

## Install

```bash
cd agent/relay
npm install        # builds node-pty (needs a C/C++ toolchain — see below)
```

`node-pty` is a native module. If `npm install` fails to build:
- **macOS:** `xcode-select --install`
- **Linux:** install `python3`, `make`, `g++` (e.g. `build-essential`)
- **Windows:** install the "Desktop development with C++" workload (Visual Studio
  Build Tools); prebuilt binaries usually avoid this.

## Run

From inside the repo you want the agent to work in:

```bash
node /path/to/agent/relay/index.js
```

Or link it once and use the `neoncore-agent` command anywhere:

```bash
cd agent/relay && npm link
neoncore-agent                 # launches `claude` in the current repo
neoncore-agent -- --resume     # everything after `--` is passed to the agent
```

You'll get a normal interactive Claude Code session. When a workflow dispatches
a step to this agent, the prompt is typed in and submitted automatically.

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `NEONCORE_URL` | `http://localhost:4040` | Orchestrator base URL |
| `NEONCORE_AGENT_CMD` | `claude` (`claude.cmd` on Windows) | Binary to launch |
| `NEONCORE_AGENT_TYPE` | `claude` | Agent type to register as |
| `NEONCORE_RELAY_DEBUG` | _(unset)_ | Set `1` to mirror relay logs to stderr |

Relay logs are written to `~/.neoncore/relay.log` so they don't corrupt the
agent's TUI.

## How it fits together

1. `POST /api/agents/register` → creates/finds this agent, returns its id.
2. Socket connects and emits `join_agent_room` → this socket becomes the
   **primary** for `agent:<id>`.
3. The server's `sendCommandToAgent` emits `command_send` to that primary socket
   (`server/src/lib/send-command.ts`).
4. The relay writes the prompt into the PTY (bracketed paste + Enter) and marks
   the command delivered.
5. On (re)connect it also drains `/api/commands/pending/:agentId` to catch
   anything queued while it was offline.

No server changes are required — the relay reuses the same endpoints and socket
events as the VS Code extension.
