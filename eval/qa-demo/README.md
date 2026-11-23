# QA demo app

A small daily-report app with eight bugs planted on purpose, for proving the QA section
(`docs/plans/qa-section.md`). Dependency-free, in-memory, reset on every start.

```bash
node eval/qa-demo/server.mjs --port 4061      # http://127.0.0.1:4061
```

## Accounts

| User | Password (env, local default) | Role |
|---|---|---|
| `supervisor` | `QA_DEMO_SUPERVISOR_PASS` (default `supervisor-demo`) | approves reports |
| `worker` | `QA_DEMO_WORKER_PASS` (default `worker-demo`) | writes reports |

The defaults exist only so the demo runs locally with no setup. A QA target stores the env NAMES
(`credentialsEnv`), never the values.

## Pages

Log in → Reports (list, filter, export, quick approve) → New report (project, date, hours, notes)
→ Report detail (status, Approve for a supervisor). New reports start "Awaiting approval".

## Variants (for self-repair)

| Variant | Change |
|---|---|
| A | normal |
| B | the "Submit" button is renamed **Send report**, and the Hours field moves below Notes |
| C | the approval feature is removed (no Approve button, approve routes 404) |

Pick one with `QA_DEMO_VARIANT=B`, or at run time from this machine only:

```bash
curl -X POST localhost:4061/__variant -H 'content-type: application/json' -d '{"variant":"B"}'
curl -X POST localhost:4061/__reset      # seed data back, everyone logged out
```

## Recorder

Set `QA_DEMO_RECORDER` to the recorder script's URL (e.g.
`http://localhost:4040/qa/recorder.js?target=<id>`) and every page includes it.

`BUGS.md` lists the planted bugs. It is for checking a run, never for the explorer.
