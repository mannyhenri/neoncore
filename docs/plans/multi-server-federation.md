# Plan: Multi-Server Federation

Status: REVIEWED (plan-eng-review, 2026-07-27)
Branch: feat/prompt-attachments-and-cartridge-controls
Baseline: 99 tests passing (53 dashboard vitest + 46 server node:test)

## Goal

Run a full NeonCore server on every computer, each with its own SQLite database, and see
**all** projects from **all** servers in one grid — from the web app on any computer, from
the iOS app, on the LAN and remotely.

## Topology

```
        BEFORE                                  AFTER

  ┌────────────────┐                  ┌──────────┐      ┌──────────┐
  │ machines/repos │                  │ desktop  │◀────▶│  studio  │
  │ hooks + relay  │                  │ server   │gossip│  server  │
  └───────┬────────┘                  │ 10 repos │ 15s  │  5 repos │
          │ WS/HTTP                   │ own DB   │      │  own DB  │
          ▼                           └────┬─────┘      └────┬─────┘
  ┌────────────────┐                       │                 │
  │ NeonCore :4040 │                       └────────┬────────┘
  │ ONE server     │                                │ token-authed
  │ ONE database   │                       ┌────────┴────────┐
  └────────────────┘                       │  any client     │
                                           │  web / iOS      │
                                           │  MERGED GRID    │
                                           │  15 cartridges  │
                                           └─────────────────┘

  Clients talk to every server DIRECTLY. No hub, no proxy, no single point of failure.
  A client needs no local server of its own.
```

Servers stay independent: separate databases, separate task queues, separate goals and
cost rollups. The merge happens in the client, at read time.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Scope | Merged view + token auth. Server-side roster *sync* deferred (superseded by D3). |
| D3 | Peer discovery | Heartbeat gossip, 15s, union merge, staleness prune |
| D4 | Write routing | Per-server client factory, origin tagged on arrival |
| D5 | Degraded UX | `allSettled` + last-known-good cache, writes disabled while stale |
| D6 | Sockets | One per server, always. Revisit at ~5 servers. |
| D7 | Token model | One shared fleet token |
| D8 | Version skew | Declare + warn, never block |
| D9 | Errors | Typed error union at the client boundary |
| D10 | Client DRY | Extract shared `packages/client` **now** |
| D11 | Auth rollout | Ship token to agents + permissive grace period, then strict |
| D12 | No token set | Generate on first launch, print loudly |
| D13 | Test harness | Two real servers in-process + vitest for UI |
| D14 | Activity merge | Per-server buffer, capped independently |

## Discovery (D3)

```
  every 15s, for each known peer:
    POST /api/peers/ping  { me: <my url>, peers: [...] }
                       ->  { you: <their url>, peers: [...] }
    roster = union(local, received) - self

  SEED     runner installer already takes --server <url>
  PRUNE    N consecutive failures -> stale;  stale > 7d -> drop + log
  BONUS    the same tick yields per-server liveness for free
```

Deliberately NOT doing: auto-registration, conflict resolution, tombstone reconciliation.
A peer list is a grow-only set of URLs; union is the whole merge algorithm. Removal is a
staleness rule, not consensus.

## Auth (D7, D11, D12)

```
  MODE: permissive  (default on upgrade)
    authed          -> allow
    NO auth header  -> allow + log "[auth] unauthenticated POST /api/agents from
                       192.168.4.31 (studio) — update this machine"
    WRONG token     -> 401   (only ABSENT is grandfathered, never invalid)

  MODE: strict  (flip once the log is quiet)
    no/wrong auth   -> 401

  ALWAYS EXEMPT: /api/health

  NO TOKEN CONFIGURED -> generate on first launch, print a banner, store in settings.
```

The fleet token authenticates three directions with one secret: client→server,
server→server (gossip), and agent→server (hooks, relay, runner). The peer list therefore
carries **no secrets**, only URLs.

## Files

```
SERVER
  lib/auth.ts                  NEW   bearer middleware, permissive|strict
  routes/peers.ts              NEW   GET roster, POST ping
  lib/peer-scheduler.ts        NEW   15s tick (mirror lib/heartbeat-scheduler.ts)
  lib/first-launch.ts          EDIT  generate + print fleet token
  lib/server-url.ts            EDIT  stable serverId, name
  index.ts                     EDIT  mount middleware + peers route; CORS comment
  ws.ts                        EDIT  handshake auth; origin:'*' comment
  routes/push.ts               EDIT  serverId in payload (notification attribution)
  db.ts                        EDIT  peers table, server identity, migration

SHARED
  packages/client/             NEW   req wrapper, error taxonomy, types, all methods
  package.json                 EDIT  workspaces += mobile, packages/*

WEB
  lib/api.ts                   EDIT  -> apiFor(base, token) from packages/client
  hooks/useAgents.ts           EDIT  N-server fan-out, allSettled, per-server buffers
  hooks/useSocket.ts           EDIT  N sockets, per-server connection state
  components/ServerPicker.tsx  NEW   add/edit/remove servers
  App.tsx, types.ts, CartridgeGrid, CartridgeCard  EDIT  origin badge, routing

MOBILE
  config.ts                    EDIT  single key -> roster list + MIGRATION
  NeonCoreProvider.tsx         EDIT  N sockets, merged state
  api.ts                       EDIT  -> re-export packages/client
  screens/*                    EDIT  server list UI
  metro.config.js              EDIT  watchFolders + nodeModulesPaths

AGENT
  hooks/*.py, *.sh             EDIT  send Authorization: Bearer
  relay/, runner/              EDIT  same
  install.py, bootstrap.*      EDIT  bake token alongside the URL it already writes

DOCS
  Readme.md:9-14               EDIT  topology diagram now shows federation
```

## Failure modes

| Codepath | Realistic production failure | Test? | Handled? | Silent? |
|---|---|---|---|---|
| auth middleware | agents not yet updated → fleet-wide blackout | REQUIRED | permissive mode | would be silent — **the P0** |
| gossip tick | one peer hangs, blocks the others | REQUIRED | allSettled | yes, silent |
| gossip merge | `host:4040` vs `host:4040/` → duplicate peers | REQUIRED | normalize | yes, silent |
| gossip merge | server adds itself → self-ping loop | REQUIRED | self-exclude | yes, silent |
| useAgents fan-out | one asleep server blanks the grid | REQUIRED | allSettled | yes — **regression** |
| activity merge | chatty server evicts quiet server entirely | REQUIRED | per-server buffer | yes, silent |
| client errors | 401 renders as "unreachable", stale forever | REQUIRED | typed errors | yes, silent |
| serverId | regenerated on boot → every restart looks new | REQUIRED | persist in settings | yes, silent |
| mobile config | upgrade loses stored server URL | REQUIRED | migration | yes — **regression** |
| version skew | old server 404s a new endpoint | REQUIRED | warn + degrade | partly |
| Metro resolve | shared package breaks the iOS build | REQUIRED | build verification | no, loud |

Every silent failure above has a required test. No critical gaps remain (a critical gap =
no test AND no handling AND silent).

## Testing (D13)

- **Server + gossip + auth**: two real servers in-process, two ports, two temp SQLite
  files, inside the existing `node --import tsx --test` suite. No new dependencies.
- **Client states**: vitest + jsdom with a mocked `apiFor` (already configured at
  `dashboard/vite.config.ts:21`).
- **iOS**: Metro resolution + archive build, gating.
- 47 paths enumerated in the test plan artifact under `~/.gstack/projects/neoncore/`.

Also add the missing `"test": "vitest run"` script to `dashboard/package.json` — vitest is
configured and 53 tests pass, but there is no npm script to run them.

## Remote access

Tailscale on each server plus `tailscale serve 4040`. Not currently installed.

`tailscale serve` matters specifically because `mobile/ios/NeonCore/Info.plist:33` sets
`NSAllowsArbitraryLoads=false` with `NSAllowsLocalNetworking=true`. That permits plain
`http://` only to RFC1918 / link-local / `.local` addresses. Tailscale hands out
`100.64.0.0/10` CGNAT addresses, which are **not** covered — plain http to a `100.x` address
would be blocked by App Transport Security. `tailscale serve` terminates TLS with a real
certificate on `*.ts.net`, so no Info.plist change is needed.

## NOT in scope

| Deferred | Why |
|---|---|
| Server-side roster sync w/ conflict resolution | Gossip union + staleness covers it; consensus is unwarranted for a set of URLs |
| Per-device revocable tokens | Tailscale device removal already revokes at the network layer |
| Cross-server tasks, goals, cost rollup | Servers are independent by design; a shared queue implies a hub, which contradicts the topology |
| Playwright browser E2E | No harness exists; in-process two-server tests cover the integration risk |
| Cloud relay / rendezvous broker | Weeks of work; Tailscale solves remote access today |
| mDNS discovery | Link-local only, cannot see a remote machine, so the manual step survives anyway |
| Fair-share activity display | Per-server buffers fix the data loss; reshaping read order is a separate design call |

## What already exists

| Existing | Reused or rebuilt? |
|---|---|
| `mobile/src/api.ts` takes `base` as arg 1 | **Reused** — mobile is already server-agnostic; web converges onto its shape |
| `lib/server-url.ts` URL precedence chain | **Reused** — server identity extends it, no new module |
| `machine_pairing_token` (`routes/machines.ts:15`) | **Reused as pattern** — fleet token copies it rather than inventing a second scheme |
| `useSocket.ts` reconnect + backoff | **Reused** — N instances of proven logic, no new connection code |
| `lib/heartbeat-scheduler.ts`, `lib/cleanup-scheduler.ts` | **Reused as pattern** — peer scheduler mirrors them |
| `lib/first-launch.ts` | **Reused** — natural hook for token generation |
| `agent/runner/` launch dispatch | **Untouched** — still the right answer for extra machines behind one server |
| `lib/apns-push.ts` | **Extended** — gains serverId for notification attribution |
| Mobile's per-call `.catch` inside `Promise.all` (`NeonCoreProvider.tsx:52`) | **Generalized** — web adopts this pattern per-server |

## Notes carried from review

- `index.ts:48` `cors()` and `ws.ts:22` `origin:'*'` must **stay open**. Federation is
  cross-origin by definition; the bearer token is the gate, not the origin. Comment both
  lines so a future "harden CORS" change doesn't silently break the merged grid.
- Back the 10s fallback poll (`useAgents.ts:18`) off while a server's socket is healthy —
  N servers multiply it per open tab.
- Gossip is N² pings per tick. Negligible at N≤10. Documented next to the socket ceiling.
