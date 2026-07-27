# Running NeonCore on several computers

One NeonCore server per computer, each with its own database. Every client — the web app
on any machine, and the iOS app — talks to **all** of them and shows one merged grid.

```
        ┌──────────┐   gossip 15s   ┌──────────┐
        │ desktop  │◀──────────────▶│  studio  │
        │ :4040    │                │  :4040   │
        │ own DB   │                │  own DB  │
        └────┬─────┘                └────┬─────┘
             │                           │
             └─────────────┬─────────────┘
                           │  token-authed
                  ┌────────┴────────┐
                  │  web  /  iOS    │
                  │  MERGED GRID    │
                  └─────────────────┘
```

Servers stay independent: separate databases, task queues, goals and cost rollups. The
merge happens **in the client, at read time** — there is no hub and no primary. Any
server going down costs you that server's cartridges and nothing else.

---

## Add a second computer

**1. Get the fleet token from the machine you already run.**

It was printed once in that server's startup banner. If it has scrolled away:

```bash
sqlite3 server/neoncore.db "SELECT value FROM settings WHERE key='fleet_token';"
```

All machines share one token. It is what lets servers gossip, and what the apps present.

**2. On the new computer**, unzip `neoncore-full.zip` and run one command:

```bash
./install-neoncore.sh --start \
  --fleet-token <TOKEN> \
  --peer http://first-machine.local:4040
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-neoncore.ps1 -Start `
  -FleetToken <TOKEN> -Peer http://first-machine.local:4040
```

That installs, builds, starts, and introduces itself to your existing server.

Requirements: Node.js 18+ and npm. Nothing else.

**3. Done.** Open `http://localhost:4040` on either machine — both machines' cartridges
appear in one grid, each labelled with the server it came from.

### Why those two flags matter

- **`--fleet-token`** — without it the new machine mints its *own* token on first launch
  and the two servers reject each other with `401`. It is saved on first launch, so you
  pass it once and every later `npm start` keeps it.
- **`--peer`** — one introduction in one direction is enough. Gossip teaches the rest of
  the fleet about the new machine, and teaches the new machine about everyone else,
  within a tick.

You can skip `--peer` and add the address later from the fleet panel instead.

---

## Managing the fleet

**Web** — the pill in the header, where "Live / Polling" used to be. With one server it
still reads `Live`; with more it reads `2/3 servers`. Click it to:

- add a server by address (`studio.local:4040` — the scheme is optional)
- see per-server health
- hide or forget a server
- set the fleet token for every server at once

**iOS** — the same panel behind the `2/3 SERVERS` pill in the app header.

Servers discovered through gossip appear on their own, marked `found`. **Forgetting** a
discovered server only hides it until the next discovery re-learns it — use **hide** to
keep one out of the grid for good.

---

## What you will see when something is down

A machine being asleep is normal, not an error, and the apps are built for it:

| State | What happens |
|---|---|
| A server sleeps | Its cartridges keep showing, marked stale. The grid never blanks. |
| A server 401s | Called out as **"Token rejected — not a network problem"** |
| A server is slow | 5s per-peer timeout; it cannot stall the others |

That distinction is deliberate. A rejected token and an unreachable laptop look identical
otherwise, and only one of them is fixed by waiting.

---

## Access from outside your network

On the LAN, `machine.local:4040` is enough. For remote access, use
[Tailscale](https://tailscale.com) on each server:

```bash
tailscale up
tailscale serve --bg 4040
```

Then use the `https://<machine>.ts.net` address as the server URL.

**`tailscale serve` is required for iOS, not optional.** The app ships
`NSAllowsArbitraryLoads=false`, which permits plain `http://` only to LAN addresses.
Tailscale's `100.64.0.0/10` range is **not** covered, so plain http to a `100.x` address
is blocked by App Transport Security. `tailscale serve` terminates TLS with a real
Let's Encrypt certificate on `*.ts.net`, which the app accepts.

Two things that are easy to miss:

- **HTTPS Certificates are off by default per tailnet.** Enable them at
  [the admin console](https://login.tailscale.com/admin/dns). Until you do,
  `tailscale cert` returns `500 ... does not support getting TLS certs` and plain
  `tailscale serve` **hangs** rather than erroring — it blocks trying to provision a
  certificate it cannot get.
- `tailscale serve` publishes **inside your tailnet only**. Every device on the tailnet
  can reach the server; the fleet token is still the gate. Do not use
  `tailscale funnel`, which is public-internet exposure.

---

## Security

One shared token authenticates three directions: client→server, server→server, and
agent→server. The peer list therefore carries **no secrets** — only URLs.

Auth ships in **permissive** mode:

| Credential | permissive | strict |
|---|---|---|
| Correct token | allow | allow |
| **No** header | allow + log the caller's IP | 401 |
| **Wrong** token | **401** | **401** |

Permissive exists because every already-deployed hook, relay and runner sends no
Authorization header — flipping straight to strict takes the whole fleet quiet at once,
with nothing crashing to point at the cause. A *wrong* token is rejected in both modes:
grandfathering that would make any wrong guess as good as the real secret.

Once `[auth] unauthenticated …` stops appearing in your logs, switch over:

```bash
NEONCORE_AUTH_MODE=strict npm start
```

`/api/health` stays open in both modes — it is how you diagnose a fleet that has gone
quiet, and how peers check reachability.

> The web app stores the token in `localStorage`, so any script on the page can read it.
> That is an accepted trade for a LAN tool with one shared secret; do not reuse this token
> for anything beyond the fleet.

---

## Troubleshooting

**Every cartridge appears twice.** A server reached by two names (`localhost` and
`mac.local`) used to be adopted as two servers. Fixed by de-duplicating on the server's
stable id — reload the page and it heals itself.

**A peer sits at `401`.** The two machines have different tokens. Set one for all servers
from the fleet panel, or restart the odd one out with
`NEONCORE_FLEET_TOKEN=<token> npm start` (it is saved on first launch).

**A peer never appears.** Check the address is reachable from the *other* machine:
`curl http://this-machine.local:4040/api/health`. Firewalls and VPN split-tunnelling are
the usual causes.

**A cartridge lingers after you close the session.** Claude and Codex report their own
exit and disappear immediately. Gemini, Amazon Q and Cursor have no session-end hook, so
theirs clear on a 2-hour timeout instead. If Codex ones linger, re-run the install-hooks
flow for Codex — `SessionEnd` was added and existing `~/.codex/hooks.json` files predate it.
