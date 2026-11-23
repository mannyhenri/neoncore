# @neoncore/qa-runner

Plays a QA test's cached actions in Chromium with no AI, and gives a cartridge what it needs to
work out new ones. The contract is `docs/plans/qa-section.md` (action format, CLI, guardrails).

```bash
node packages/qa-runner/cli.mjs run      --spec test.json --out out/ [--state state.json]
node packages/qa-runner/cli.mjs act      --spec act.json  --out out/ [--state state.json]
node packages/qa-runner/cli.mjs snapshot --url http://127.0.0.1:4061/login --allow 127.0.0.1 --out out/
```

One JSON object on stdout; exit 0 when it ran (passed or failed), 2 when refused (`blocked`).
`--state` keeps cookies between calls, so a cartridge logs in once and then acts.

Guardrails, enforced in the browser: requests off `allowHosts` are aborted; clicks matching
`denyActions` (default delete, remove, pay, purchase, send email, unsubscribe) are refused unless
`allowDestructive`; `valueEnv` credentials are masked as ••• in the result, console lines, errors
and the trace zip; waits are capped at 5 s; `budget.minutes` stops the run.

Playwright is pinned to 1.58.2, whose Chromium build (1208) is the one cached on this Mac.

```bash
npm test -w packages/qa-runner      # starts the demo app (eval/qa-demo) on a free port
```
