# iOS parity — implementation plan

Date: 2026-09-05
Run: `New Feature` 76ae0fb3 · Research → Architecture → Define Tests → Develop → Run Tests → Security → **Summary**
Status: **1 of 6 components shipped.** C1 is on main. C2–C6 are specified, unstarted, and ordered below.

---

## The problem, measured today

Every number here was re-derived from the code while writing this document, not copied from the
Research step. That matters, because they moved:

| | Research (14:3x) | Now | |
|---|---|---|---|
| `packages/client` capabilities | 151 | **156** | +5 |
| `mobile/src/api.ts` methods | 61 | **58** | |
| Absent on iOS (name-normalised) | 100 | **105** | +5 |

The gap grew by five **during the session that measured it.** Those five are exactly the
capabilities added that afternoon — `getBurnRate`, `getUsageSeries`, `getAgentTokenUsage`,
`getWorkflowAutonomy`, `setWorkflowAutonomy`. Nobody decided the phone should not have them; the
phone was simply never considered, and nothing failed.

That is the actual defect. The 105 missing capabilities are a symptom; the disease is that
**adding a capability to the desktop cannot break the build.** `server/test/` holds four parity
guards — `mobile-queue`, `mobile-tasks`, `mobile-memory`, `memory-scoping` — covering three
domains. Everything outside those three grows unchecked.

Root cause, from the Research step and still true: `packages/client` was created to end "two
hand-maintained copies of this surface; one had endpoints the other lacked," and mobile still
keeps its own 453-line `api.ts`, importing only *types* from the shared package.

Sample of what a phone cannot currently do: `addPeer`, `removePeer`, `enqueueItem`,
`pauseQueueLane`, `resumeQueueLane`, `tickQueue`, `deleteAgent`, `updateAgent`.

---

## M1 — Hermes-safe deadline · SHIPPED (`362819c`)

**Why it was first.** `mobile/src/api.ts` documents that Hermes' `AbortController` polyfill has
the constructor but not the statics, so `AbortSignal.timeout` throws on device while every Node
test passes. The shared client's deadline used `AbortSignal.timeout` behind a
`'timeout' in AbortSignal` guard — which on Hermes returns `undefined`: no crash, and **no
timeout**. Adopting the shared client naively would have handed iOS the exact
"Connecting to orchestrator" hang that was fixed for the desktop that morning, silently.

So the port direction is **mobile → shared**, not shared → mobile. This inverts the naive reading
of "delete mobile's client and use the shared one."

**Proven, not asserted.** `dashboard/src/__tests__/client.hermes.test.ts` (6 cases) simulates the
Hermes *shape* — `AbortSignal` present, `AbortSignal.timeout` deleted. Against the old code two
cases failed **by timing out at 5004ms and 5002ms**: not an assertion failure, the request never
settled at all.

**Second defect found while testing:** `signal: options?.signal ?? deadline()` *substituted* — so
a caller passing its own signal silently disabled the timeout. Now additive.

**Acceptance criteria — all met:** `deadline()` built from `AbortController` + `setTimeout`;
`done()` clears the timer (without it every request leaks a pending timer on Hermes and React
Native will not exit a screen cleanly); a timeout reports *as* a timeout, naming the origin.

---

## M2 — Adopt the shared client on mobile · C2 + C3

**Depends on:** M1. Do not start before it — the migration's whole value is that the client it
migrates to is correct on device.

**Precondition, verified:** mobile is already a workspace member (`workspaces: server, dashboard,
packages/*, mobile`) and already resolves `@neoncore/client` for types. The comment in
`api.ts:5` saying otherwise is stale. Nothing blocks the runtime import.

- **C2** — new `mobile/src/lib/clients.ts`: `clientFor(server: ServerEntry): NeonCoreClient`,
  cached by `url+token`, mirroring `dashboard/src/lib/api.ts:apiFor` so there is one pattern
  rather than two.
- **C3** — delete `mobile/src/api.ts` (453 lines, 58 methods). Its only irreplaceable content is
  the Hermes note, which has already moved into C1 as the comment explaining the deadline's shape.

**Size, measured now:** 62 `api.*` call sites across 16 non-test files. Mechanical, but a
rewrite per site (`api.method(base, …)` → `clientFor(server).method(…)`), not a rename.

**Acceptance criteria**
1. `mobile/src/api.ts` does not exist.
2. `grep -rn "from '../api'" mobile/src` returns nothing.
3. `npx tsc --noEmit` clean in mobile — this is the safety net for all 62 sites.
4. `npm test -w @neoncore/mobile` still 71/71.
5. Every screen that previously caught an error still catches it — see risk (a).

---

## M3 — The guard that stops it recurring · C4

**Depends on:** M2. Do it while "why isn't this on the phone" is still fresh.

New `server/test/mobile-parity.test.ts`, copying `mobile-queue-parity.test.ts`'s shape **exactly**,
including its `DESK_ONLY: Record<string, string>` name → reason map.

This is the component that matters most for the long run. It converts 105 missing capabilities
from an invisible accident into **stated decisions**: a capability that is neither on the phone
nor in `DESK_ONLY` fails the build. Pause/resume/tick are legitimately desk work; they go in
`DESK_ONLY` with that reason written down. What must never happen again is a capability going
missing because nobody looked.

**Acceptance criteria**
1. The test enumerates all 156 capabilities from `packages/client` — set-based, not a sample.
2. Adding a capability to `packages/client` and running the suite **fails** until it is either
   reachable on mobile or named in `DESK_ONLY`. Verify by actually doing it, then reverting.
3. `DESK_ONLY` entries each carry a human reason string, not a bare name.

---

## M4 — Bottom menu · C5

**Depends on:** M3 only by ordering — regroup *before* adding a screen, not after.

Six tabs today: `list`, `goals`, `workflows`, `queue`, `tasks`, `approvals`. `TabBar.tsx:16`
already predicts the ceiling: "A seventh would need a 'More'." M5 adds a seventh.

Regroup to five: **Cartridges / Work / Queue / Approvals / More**. `Approvals` stays primary —
it is the only tab with a deadline attached to it.

**Acceptance criteria**
1. `TABS` has 5 entries; `Goals`, `Workflows` and `Tasks` are reachable within two taps via `More`.
2. `mobile/src/__tests__/navigation.test.ts` extended to assert every screen stays reachable —
   a screen that exists but is not routed is a file, not a feature.

---

## M5 — Tokens and autonomy on the phone · C6

**Depends on:** M2 (capabilities must be reachable) and M4 (a seventh tab needs `More`).

New `mobile/src/screens/TokensScreen.tsx` plus an autonomy control.

**Decision required before starting, not during.** `fanOut.ts` and `usageSeries.ts` live in
`dashboard/src/lib/`. C6 either duplicates them — a fourth copy of a surface, in a codebase that
has spent this whole session deleting a third — or they move to `packages/client` first.
**Recommendation: move them first.** Take the decision at the start of M5.

**Acceptance criteria**
1. Burn rate and the hour/day/week series render on device against a live server.
2. Autonomy is settable from the phone and the change is visible in `workflow_auto_resolutions`.
3. No copy of `fanOut`/`usageSeries` exists in more than one package.

---

## Test results from this run

| Suite | Result |
|---|---|
| server | 759 / 760 |
| dashboard | 277 / 277 |
| mobile | 71 / 71 |
| eval | 17 / 17 |
| `tsc --noEmit` | clean in server, dashboard, mobile — **and on a detached worktree of HEAD** |

The one server failure is `mobile-singleton-deps`: react `19.2.3` (mobile's exact pin) against
`19.2.4` (hoisted). Pre-existing, not caused by this work. `react-native@0.86` peer-requires
`^19.2.3`, so `19.2.4` satisfies it and the one-word fix is to align mobile's pin — deliberately
**not** done here, because it moves the mobile react version underneath an iOS archive that is
waiting to go to TestFlight.

**Two process failures worth carrying forward**, both found by re-running rather than trusting:

1. *Main did not compile.* Every local check passed because the working tree supplied exports
   that were never committed. Typechecking a detached worktree of `HEAD` caught it; the working
   tree is not the thing that ships.
2. *Scanners that match nothing read exactly like scanners that found nothing.* Writing this
   document, the component detector reported C1 outstanding (it matched a **comment** explaining
   why `AbortSignal.timeout` is unused) and C5 done (it matched a **comment** predicting a future
   "More" tab). Both were wrong in opposite directions. Every scan here strips comments before
   matching and was re-run against a known-present string until it produced a hit.

---

## Manual testing instructions

**Build** — Expo is ejected; build locally via Xcode archive and upload through Organizer. Do not
use EAS or `prebuild`.

```
cd mobile/ios && xcodebuild -workspace NeonCore.xcworkspace -scheme NeonCore \
  -configuration Release -archivePath ~/Library/Developer/Xcode/Archives/NeonCore.xcarchive archive
```

**After M1 (shippable now).** On device, with the phone on the LAN:
1. Open the app against a reachable server — the fleet lists normally.
2. Put a configured peer server to sleep, then pull to refresh.
   **Expect:** the reachable server renders within the deadline and the sleeping one reports a
   timeout naming the origin.
   **Regression:** an indefinite "Connecting to orchestrator". That is the Hermes no-timeout bug,
   and it means `deadline()` has been changed back to `AbortSignal.timeout`.
3. Background the app on a screen mid-request and reopen it. **Expect:** no leaked-timer warning.

**After M2.** Exercise one screen per domain — cartridges, goals, workflows, queue, tasks,
approvals — and confirm each still renders and still shows its error state when the server is
stopped. The migration is bisectable only if error semantics were left alone.

**After M4.** Confirm all six original destinations are still reachable in ≤2 taps.

**After M5.** Compare the phone's burn-rate figure against the dashboard header for the same
window; they read the same endpoint and must agree.

---

## Risks carried from the Architecture step

- **(a) Error semantics.** The shared client throws typed `ApiError` with `kind`/`origin`; mobile
  screens catch loosely. M2 must keep existing catch blocks rather than "improving" them in the
  same pass — otherwise the migration cannot be bisected.
- **(b) A fourth copy.** `fanOut`/`usageSeries` duplication in M5. Decide before starting M5.

## Do not

- Start M2 before M1 is green — it ships the hang to iOS.
- Ship M5 before M3. Without the guard, the next five capabilities go missing the same way these
  105 did.
- Treat 105 as a number to drive to zero. Most of it is desk work; the goal is that every absence
  is a **decision**, recorded in `DESK_ONLY`.
