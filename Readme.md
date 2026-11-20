<div align="center">

# NeonCore

**An orchestrator for AI coding agents.**
Run, watch and coordinate many Claude Code and Codex sessions — across repos, across
machines — from one dashboard and from your phone.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-18%E2%80%9323-brightgreen.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey.svg)](INSTALL.md)

</div>

![The Agents home screen: your agents as a crew on a map of this machine, with each project's base and the feature its team is on](docs/images/agents-map.jpg)

---

## The problem it solves

One coding agent is easy to supervise: you watch the terminal. Five are not. They finish at
different times, they block on questions you don't see, they burn budget while you're in a
meeting, and the moment you step away from the desk you lose the thread entirely.

NeonCore turns that pile of terminals into something you can actually run:

- every agent becomes a **cartridge** — a live tile with status, branch, cost and a scrolling log
- risky tool calls **pause for approval** instead of happening while you're not looking
- work you queue **keeps moving** when one agent stalls
- and all of it is on **your phone**, so being away from the desk isn't the same as being blind

It runs entirely on your own machines. No cloud service, no account, no telemetry.

### What's in it

| | |
|---|---|
| **Agents** | The home screen. Your agents as a crew on a map of this machine: who is working, who waits on you, and which feature each team is on. Every agent is also a cartridge with its live log, prompt box and approvals. |
| **Projects and features** | A project holds the list of features to build. Each feature runs as a pipeline: scope it with a planner, lock acceptance tests, then run the workflows that build, check and review it. Several features can run side by side, each on its own branch and worktree. |
| **Confer** | Several agents across several repos build one feature together: they agree the split, build their parts, review each other and land it. |
| **Workflows** | A canvas of steps, gates and decisions. Start from a template or describe one in a sentence. |
| **The work standard** | Every task an agent takes on ends with a completion report: what was in scope, the real test output, anything left undone. A Stop hook enforces it. |
| **iOS app** | Watch the crew, read transcripts and answer approvals from your phone. |

---

## Table of contents

- [How it works](#how-it-works)
- [Quick start](#quick-start) · [Connect your first agent](#connect-your-first-agent)
- [Using it: cartridges, approvals, queue, flows](#using-it)
- [Projects, features and tasks](#projects-features-and-tasks)
- [One server per machine](#one-server-per-machine)
- [The mobile app](#the-mobile-app)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting) · [Contributing](#contributing) · [License](#license)

---

## How it works

Three moving parts. The agent machine reports **in** over HTTP, the dashboard talks **back**
through a command channel, and the server holds the state.

```
   YOUR MACHINE (any number of repos)                      NEONCORE SERVER (:4040)
  ┌──────────────────────────────────┐                   ┌────────────────────────────┐
  │  Claude Code / Codex             │                   │  Express + SQLite          │
  │             │                    │                   │                            │
  │   ┌─────────┴─────────┐          │   hooks POST      │   • cartridge registry     │
  │   │  hooks            │──────────┼──────────────────▶│   • activity + transcripts │
  │   │  PreToolUse       │  activity, permission asks   │   • permission gate        │
  │   │  PostToolUse      │          │                   │   • queue · goals · tasks  │
  │   │  Stop / Session   │          │                   │   • workflow executor      │
  │   └───────────────────┘          │                   │                            │
  │                                  │                   │   serves the dashboard     │
  │   ┌───────────────────┐          │   WebSocket       │   at :4040                 │
  │   │  command channel  │◀─────────┼───────────────────│                            │
  │   │  relay PTY  ─or─  │   prompts, approvals, runs   │                            │
  │   │  VS Code ext      │          │                   └─────────────┬──────────────┘
  │   └───────────────────┘          │                                 │
  └──────────────────────────────────┘                    ┌────────────┴────────────┐
                                                          │  browser        iOS app │
                                                          └─────────────────────────┘
```

**Why two channels?** Hooks are how Claude Code tells you what it is *about* to do — that is what
makes approval possible, because a `PreToolUse` hook can block until a human answers. But hooks
only talk outward. To send a prompt back *into* a session you need something attached to the
terminal, which is the relay (a PTY wrapper) or the VS Code extension. You need both halves for a
cartridge to be interactive rather than just observable.

**What's stored:** one SQLite file (`neoncore.db`) next to the server. Cartridges, activity,
transcripts, permissions, queue, goals, tasks, workflows. Delete it and you're back to zero.

---

## Quick start

### What to install first

On the computer that runs the server:

| Install | Why | How |
|---|---|---|
| **Node.js 23** (with npm) | Runs the server and builds the dashboard. The repo pins 23.11.0 in `.nvmrc`. Node 18–23 work; **Node 26 does not** (the `better-sqlite3` database driver doesn't build on it yet). | [nodejs.org](https://nodejs.org) or `nvm install && nvm use` in the repo |
| **git** | To clone the repo | macOS: `xcode-select --install` · Linux: your package manager |
| **C/C++ build tools** | `better-sqlite3` compiles itself when no prebuilt binary matches your Node | macOS: `xcode-select --install` · Debian/Ubuntu: `sudo apt install build-essential python3` · Windows: Visual Studio Build Tools ("Desktop development with C++") |

On every computer whose agents should appear in NeonCore (often the same one):

| Install | Why | How |
|---|---|---|
| **Claude Code** | The agent NeonCore watches and drives | `npm install -g @anthropic-ai/claude-code` |
| **Python 3** | Runs the hook installer, `agent/install.py` | macOS ships it with the Xcode tools · [python.org](https://www.python.org) |

Only for the iOS app: **Xcode** — see [mobile/RELEASE.md](mobile/RELEASE.md).

### Install and run

```bash
git clone https://github.com/mannyhenri/neoncore.git
cd neoncore
npm install
npm run build      # builds the dashboard into server/public/
npm start          # dashboard + API on http://localhost:4040
```

Open **http://localhost:4040**. The grid will be empty — that's expected until you connect an
agent, which is the next step.

> **Save the fleet token.** On first launch the server prints one in its banner. You only need it
> to add a second computer, and it is **redacted from the settings API afterwards** — so copy it
> now or you'll be regenerating it later.

<details>
<summary><b>One-command install instead</b> (checks Node, installs, builds, starts)</summary>

```bash
./install-neoncore.sh                                              # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\install-neoncore.ps1     # Windows
```
</details>

<details>
<summary><b>Development mode</b> (hot-reload dashboard)</summary>

```bash
npm run dev        # API on :4040, dashboard with HMR on :4041
```

Running a **second** server while one is already installed? Set
`NEONCORE_NO_FIRST_LAUNCH=1`. Otherwise the new instance rewrites this machine's hooks to point at
*its* port, and your existing cartridges silently stop appearing — see [Security model](#security-model).
</details>

---

## Connect your first agent

A cartridge needs **hooks** (to report) and a **command channel** (to receive). Pick one:

| | Hooks | Command channel | Best for |
|---|---|---|---|
| **Terminal relay** | auto-installed | `agent/relay` PTY wrapper | any terminal, headless boxes |
| **VS Code extension** | `agent/install.py` | `neoncore-extension` | working inside VS Code |

Fastest path — from inside the repo you want to work in:

```bash
cd ~/code/my-project
NEONCORE_URL=http://localhost:4040 python3 ~/neoncore/agent/install.py   # once per machine
node ~/neoncore/agent/relay/launch.js                                    # launches Claude Code, bridged
```

Within a second or two the repo appears as a cartridge. If it doesn't, jump to
[Troubleshooting](#troubleshooting).

> ### ⚠️ Get `<SERVER>` right the first time
>
> The installer **bakes the URL as a literal string** into `~/.claude/settings.json` and never
> re-reads it. If that address later changes, every hook POST goes nowhere — the cartridge just
> stops appearing, **with no error on either side**.
>
> | Use | How to get it | Notes |
> |---|---|---|
> | **Hostname** — `studio.local` | `hostname` | **Preferred.** Survives DHCP changes. |
> | **IP** — `192.168.4.24` | `ipconfig getifaddr en0` · `hostname -I` | Only if mDNS is blocked. **Reserve it on your router.** |
>
> Confirm it answers *from the other machine* before installing anything:
> ```bash
> curl http://<SERVER>:4040/api/health     # → {"status":"ok"}
> ```

---

## Using it

### Cartridges

Each tile is one agent in one repo. The header carries branch, status, machine and tool; the
**Live Log** underneath streams every tool call as it happens.

![Cartridges in the list view: live logs, a pending question, and the Plan / Manual / Trust modes](docs/images/agents-cartridges.jpg)

A cartridge leaves the grid when its session actually **ends** — going quiet does not remove it.
That distinction is deliberate: an agent that has stopped talking is usually the one you most need
to look at.

Three modes per cartridge, switchable mid-session:

| Mode | Behaviour |
|---|---|
| **Manual** | every gated tool call waits for you |
| **Trust** | auto-approves — for work you've already scoped |
| **Plan** | the agent plans, and you approve the plan rather than each step |

### Approvals

With hooks installed, a `PreToolUse` on a risky call **blocks the agent** and raises an approval —
in the dashboard and as a push notification on your phone. Nothing destructive happens while you
aren't looking. Answer from either surface and the agent resumes.

### The queue

Send work to a busy cartridge and it queues behind the current job rather than interleaving.
Lanes drain independently, a failure **halts its own lane with a reason** instead of failing
silently, and you can hold one item without stopping the rest.

### Flows

The Flows view shows the workflows that are running, with their progress, above the template
library you start new ones from. See [WORKFLOWS.md](WORKFLOWS.md).

![The Flows view: an active run above the template library](docs/images/workflows.jpg)

---

## Projects, features and tasks

A **project** is the thing you are building: its name and the repos (cartridges) it lives in. It
holds the **list of features** you want built — add them one by one or paste the whole list — and
you take them **one at a time**: a planner cartridge scopes the feature with you, writes the brief
and acceptance criteria, proposes the workflows, and runs them in the project's repos once you
accept. See [docs/GOALS.md](docs/GOALS.md) and [docs/GOAL-PILOT.md](docs/GOAL-PILOT.md).

![A project open on its features: progress, spend, and which one is waiting on you](docs/images/projects.jpg)

The pipeline for a feature has stages: **acceptance tests** first (one failing test per criterion,
approved by you and then locked), then the **workflow stages** that do the work, then an
**independent review** by an agent that did not do the work. Each stage leaves out the workflow
steps that are not its job, which you can see and change on the plan before you accept it.

**Features run side by side.** Each running feature gets its own branch and worktree in every repo
it touches, so two features in one project never share a working copy. On the Agents map each
feature shows as a plate above the team working on it, with its stage and whether it needs you.

<p align="center"><img src="docs/images/feature-pipeline.jpg" width="560" alt="A feature's pipeline: its stages, the acceptance contract, and the run stages with one waiting on a decision"></p>

Beside the list, each project keeps its **spec, roadmap, changelog and architecture** — generated from
the records as features are built, and for a codebase new to NeonCore written by a cartridge from the
repos (**✦ Generate with AI**) — and can publish them into the repo as `docs/product/`. See
[docs/PROJECT-SPEC.md](docs/PROJECT-SPEC.md).

A feature's brief is not decoration — **it is injected into the agent's prompt at dispatch**.
Acceptance criteria, no-gos, rabbit holes and invariants are how you fight over-reach; the feature
page tracks how many are filled.

Progress has **three** states, not two: real progress, genuine zero, and *nothing to measure yet*.
A feature with no runs never renders as 0% — that would claim work started and got nowhere.

**Tasks** are discrete units of work you can dispatch to a cartridge.

![The task queue](docs/images/tasks.jpg)

Priority sorts them, and a **dependency gate** refuses to dispatch a task whose prerequisite hasn't
finished — overridable with `force`, but deliberately, not by default.

---

## One server per machine

NeonCore runs one server on the machine you work on — its own database, its own queue. Servers are
**not linked**: no gossip between machines, no merged grid, no forwarding to another server's
agents. The server stays reachable on your network for the dashboard, the iOS app, and relays you
point at it. Details: **[FLEET.md](FLEET.md)**.

---

## The mobile app

A native iOS app (React Native — **not** Expo; see [mobile/RELEASE.md](mobile/RELEASE.md)) that
mirrors the dashboard over your LAN. Point it at the server on the machine you work on.

Six destinations: **Cartridges · Goals · Workflows · Queue · Tasks · Approvals.**

The phone is deliberately **not** a second dashboard. It is for the things that matter when you're
away from the desk — checking whether the overnight run is still moving, and unblocking it:

| On the phone | Left on the desk | Why |
|---|---|---|
| Read transcripts, answer approvals | — | the whole point of carrying it |
| Watch goals, pause a misfiring one | Drafting and decomposing goals | intent reaches every agent at dispatch — that's writing, not glancing |
| Dispatch or cancel a task | Creating and editing tasks | work is described where there's a keyboard |
| Watch the queue | Pausing a whole lane | administering a fleet is desk work |

**Setup:** install from TestFlight, open the app, enter `http://<SERVER>:4040`. It must be on the
same network — there is no cloud relay, by design. Push notifications for approvals need APNs
configured on the server (`APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`).

Build and release instructions: **[mobile/RELEASE.md](mobile/RELEASE.md)**.

---

## Security model

Read this before exposing anything beyond your LAN.

- **Designed for a trusted network.** There is no user model — anyone who can reach `:4040` can
  drive your agents. Do not port-forward it. For remote access use a VPN or a tunnel such as
  Tailscale.
- **Fleet auth is `permissive` by default**, meaning an un-tokened client is allowed but logged.
  Switch to `strict` in Settings once every client and agent carries the token. Check the server
  log for `unauthenticated` lines first — flipping to strict with a client still un-tokened takes
  that client offline instantly.
- **Agents run with your permissions.** Trust mode auto-approves tool calls, including shell
  commands. It is a real delegation of authority, so scope the work before you enable it.
- **Secrets stay out of the repo.** The fleet token lives in the database and is redacted from the
  settings API after first display. APNs keys are referenced by path via environment variables and
  are never read into the database.
- **`NEONCORE_NO_FIRST_LAUNCH=1`** stops a second server instance from rewriting this machine's
  `~/.claude/settings.json` to its own port. Set it for any dev, demo or test instance.

---

## Troubleshooting

<details>
<summary><b>A cartridge never appears</b></summary>

Almost always the baked-in URL. Check what the installer wrote:

```bash
grep -o 'http://[^"]*' ~/.claude/settings.json | sort -u
curl http://<SERVER>:4040/api/health          # from the AGENT machine, not the server
```

If the address is wrong or the server moved, re-run `agent/install.py` with the right `--url`.
</details>

<details>
<summary><b>A cartridge appears but won't take prompts</b></summary>

Hooks are working and the command channel isn't — that's the two-channel design. Launch the session
through `agent/relay/launch.js`, or install the VS Code extension. Attaching to an already-running
bare terminal is not supported.
</details>

<details>
<summary><b>Everything is slow, or one machine hangs the view</b></summary>

Check what the app is pointed at: a machine that is *asleep* accepts the connection and never
answers, which is far worse than one that is off. Point the app at the machine you work on.
</details>

<details>
<summary><b>Approvals never arrive on the phone</b></summary>

APNs isn't configured, or the environment is mismatched: TestFlight builds use the **production**
gateway while Xcode debug builds use **sandbox**. That mismatch is the classic
"works in Xcode, silent in TestFlight."
</details>

---

## Repository layout

```
server/        Express + better-sqlite3 API and Socket.io (:4040)
dashboard/     React + Tailwind dashboard (Vite → server/public/)
packages/
  client/      Shared typed API client — the contract both UIs read
mobile/        Native iOS app (React Native, ejected from Expo)
agent/
  hooks/       Claude Code hooks: activity, permissions, session lifecycle
  relay/       PTY relay — the terminal command channel
  install.py   Cross-platform hook installer
extension/     VS Code extension (alternative command channel)
docs/          Feature docs, images, the work standard
```

> **One contract, two clients.** The dashboard and the mobile app both read
> `packages/client` types, and a test drives the real router to prove the client's declared
> response shapes match what the server actually sends. When they drifted, the failure was a
> screen that rendered wrong rather than an error — hence the test.

---

## Contributing

Every change follows **[docs/WORK-STANDARD.md](docs/WORK-STANDARD.md)**: enumerate the complete set
from the code, write a test that fails on a partial fix, fix the whole set, and paste real output.
It is enforced by hooks, not by good intentions. (This copy ships without the test suites.)

## Documentation

| Doc | What's in it |
|---|---|
| [FEATURES.md](FEATURES.md) | Complete map of what NeonCore does |
| [INSTALL.md](INSTALL.md) | Install and distribute, per-OS agent packages |
| [SETUP.md](SETUP.md) | Connecting machines: hooks, extension, relay, trust mode |
| [FLEET.md](FLEET.md) | One server per machine, the fleet token, remote access |
| [WORKFLOWS.md](WORKFLOWS.md) | Canvas workflow reference |
| [docs/GOALS.md](docs/GOALS.md) · [docs/TASKS.md](docs/TASKS.md) | Projects, features, budgets, the task queue |
| [mobile/RELEASE.md](mobile/RELEASE.md) | Building and shipping the iOS app |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Manny Henri
