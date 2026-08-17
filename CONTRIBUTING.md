# Contributing to NeonCore

Thanks for being here. This document is short on ceremony and specific about the two things that
actually matter in this codebase: **how work is verified**, and **where the contracts live**.

## Getting set up

```bash
git clone https://github.com/GRIDLIGHT-INC/neoncore.git
cd neoncore
npm install
npm run build
npm start                       # http://localhost:4040
```

**If you already run NeonCore on this machine, start your dev server like this instead:**

```bash
NEONCORE_NO_FIRST_LAUNCH=1 NEONCORE_DB_PATH=/tmp/dev.db PORT=4141 npm start --workspace=server
```

Without `NEONCORE_NO_FIRST_LAUNCH=1`, a second instance rewrites this machine's
`~/.claude/settings.json` to *its* port. Every existing cartridge then stops appearing with no
error on either side, and you will spend an afternoon on it. `NEONCORE_DB_PATH` keeps your
experiments out of your real database.

## The work standard

Every change follows [docs/WORK-STANDARD.md](docs/WORK-STANDARD.md). In short:

1. **Scope** — enumerate the complete set from the code (the registry, the schema, the call sites),
   not from the issue description. State the count.
2. **Reproduce** — write a test that fails *on a partial fix*. A test that passes when you've fixed
   three of five cases is not a test of the thing you claimed to fix.
3. **Fix** — the whole set. If you deliberately leave part out, say so explicitly; silent
   deferrals are the failure this standard exists to prevent.
4. **Verify** — run it and paste the real output.
5. **Report** — what you did, what you skipped, and why.

This is enforced by hooks rather than by good intentions, so you will notice if you skip it.

## Tests

```bash
npm test --workspace=server        # node:test, isolated DB per file
npm test --workspace=dashboard     # vitest + testing-library
npm test --workspace=mobile        # vitest
npx tsc --noEmit --project mobile  # mobile has no renderer in test; types carry weight
```

Two categories of test in this repo are load-bearing, and both exist because of bugs that shipped:

- **Contract tests** (`server/test/route-contract.test.ts`) drive the *real* router and compare it
  against what `packages/client` declares it returns. "Has a caller" and "has a *correct* caller"
  are different claims.
- **Drift guards** (`mobile/src/__tests__/contract-drift.test.ts`) fail if a client type is
  *stricter* than the server's. A field the server marks optional and a client marks required does
  not fail the typecheck — it removes it, and the crash lands at runtime in a screen.

## Architecture rules worth knowing before you send a PR

- **`packages/client` is the contract.** The dashboard and the iOS app both read its types. Do not
  hand-copy a server type into a client — import it. Copies drift toward being stricter than
  reality, which is the direction that breaks at runtime.
- **The server is the source of computed truth.** Progress, cost, reach, health and schedule are
  derived server-side and sent to clients. Recomputing them in a UI is how two surfaces come to
  disagree about the same goal.
- **Nullable means something.** `progress.fraction: null` means *nothing to measure*, not zero.
  `health: null` means nothing is blocked. Flattening these into a default is a silent lie on a
  screen.
- **The phone is not a second dashboard.** Mobile covers checking and unblocking. Authoring flows
  stay on the desktop. If you're adding a multi-field form to the iOS app, discuss it in an issue
  first.

## Commits and PRs

Commit subjects describe the change in plain language, in the imperative:

```
feat(mobile): goals and tasks on the phone, and screens that finish loading
fix(queue): work that keeps moving when a cartridge stalls
```

The body is where the reasoning goes — especially *why*, and what you deliberately left out. Long
bodies are welcome; this repo's history is used as documentation.

In a PR, please include: what you changed, the actual test output, and anything you scoped out.

## Reporting bugs

Include the NeonCore version, your OS, how the agent is connected (relay or extension), and the
relevant server log lines. If a cartridge isn't appearing, include:

```bash
grep -o 'http://[^"]*' ~/.claude/settings.json | sort -u
curl http://<SERVER>:4040/api/health
```

That one is the baked-in-URL problem often enough to be worth checking first.

## Security

Do not open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
