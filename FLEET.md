# One server per machine

NeonCore runs **one server on the machine you work on**, with its own database, queue, goals and
cost rollups. Servers are **not linked to each other**: there is no gossip between machines, no
merged grid, and no forwarding of prompts or confers to an agent another server owns. (Server
federation was removed on 2026-11-19 — see [docs/plans/multi-server-federation.md](docs/plans/multi-server-federation.md)
for what it was.)

The server stays reachable on your network, so these still talk to it:

- the **web dashboard** — on this machine, or from another browser on the LAN;
- the **iOS app** — point it at this machine's address (`machine.local:4040`);
- **relays and runners** on other computers that you deliberately point at this server
  (`NEONCORE_URL`) — their cartridges register here like local ones.

Running NeonCore on a second computer gives you a second, separate server. The two do not know
about each other; open each one's own dashboard.

---

## The fleet token

Every client presents it: relays, runners, the dashboard and the apps. It is printed once in the
server's startup banner. If it has scrolled away:

```bash
sqlite3 server/neoncore.db "SELECT value FROM settings WHERE key='fleet_token';"
```

In the dashboard, the pill in the header (`Live` / `Polling`) shows the connection to this
server; click it to set the token. A rejected token is called out as **"Token rejected"** —
it looks like an outage otherwise, and only one of the two is fixed by waiting.

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

One token authenticates everything that talks to this server: the dashboard, the apps,
relays and runners, and the agents' own calls.

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

`/api/health` stays open in both modes — it is how you diagnose a server that has gone
quiet.

> The web app stores the token in `localStorage`, so any script on the page can read it.
> That is an accepted trade for a LAN tool with one shared secret; do not reuse this token
> for anything beyond the fleet.

---

## Troubleshooting

**The pill says "Token rejected".** The token the dashboard holds is not this server's. Set
it from the pill, or restart the server with `NEONCORE_FLEET_TOKEN=<token> npm start`
(it is saved on first launch).

**The phone or a relay on another computer cannot reach the server.** Check the address
from that machine: `curl http://this-machine.local:4040/api/health`. Firewalls and VPN
split-tunnelling are the usual causes.

**A cartridge lingers after you close the session.** Claude and Codex report their own
exit and disappear immediately. If Codex ones linger, re-run the install-hooks flow for
Codex — `SessionEnd` was added and existing `~/.codex/hooks.json` files predate it.
