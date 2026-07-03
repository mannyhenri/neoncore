# Build Summary — Dual-Runtime Parity Eval (CE Phase 3, Step 0 spike)

Branch: `feature/dual-runtime-parity-eval`
Plan: `docs/plans/dual-runtime-routing.md` (Step 0)

## What was built

A standalone, dependency-free (Node ESM) parity-eval harness in `eval/` that
drives the Gridlight terminal headlessly and scores a local model by hard outcome
assertions, per capability class.

- `eval/src/probe.mjs` — gateway reachability probe (infra-fail vs model-fail).
- `eval/src/runner.mjs` — copy fixture → temp, spawn `gridlight -p --cwd`,
  evaluate assertions; `runTaskK` for pass@k.
- `eval/src/score.mjs` — per-class + aggregate scoring with Wilson lower bound;
  `buildReport` in the shape Task 1 routing will read.
- `eval/src/loadTasks.mjs` / `eval/src/cli.mjs` — suite loader + `parity-eval run`.
- `eval/tasks/` — 6 tasks: bash, read, edit, write, search, refactor (fixtures +
  end-state assertions; `_lib/assert.mjs` helpers).
- `eval/test/` — 11 tests + 2 mock Gridlight binaries.
- `eval/README.md` — how to run + current status.

Gridlight repo (`../vscode-extension`, separate git) — the only change there,
both headless-correctness fixes in `packages/cli/src/bin/gridlight.ts`:
1. `runPrompt` now loops on `hasMoreSteps` via `continueAfterAnswer` (mirrors the
   TUI) so multi-file / refactor tasks don't truncate after step 1.
2. `-p` mode sets `process.exitCode = success ? 0 : 1` (was always 0).

## Tests

- **Harness:** `npm test` in `eval/` → **11 passing, 0 failing.** Covers scorer
  (Wilson bounds, aggregation), each assertion on correct AND wrong end-state
  (the "must fail when it should" guard), full runner path with a mock Gridlight,
  and fixture isolation.
- **Gridlight fixes:** `tsc -p packages/cli/tsconfig.json --noEmit` → **clean (exit 0).**

## Coverage / lint / type

- Harness is plain Node ESM — no tsc; behavior covered by the test suite above.
- Gridlight change: typechecked clean; not separately unit-tested (2-branch
  control-flow change, behavior exercised by a real headless run — see below).

## Deviations from plan

1. **Isolated branch, not a separate worktree.** The workflow's literal step is
   `git worktree add`; used a feature branch instead (same isolation + PR outcome,
   less multi-repo friction). The Gridlight fix lives in a different repo either way.
2. **No real scored run yet — environment-gated, not skipped.** Prereqs for a run
   aren't present here: no model server running (Ollama installed but not serving;
   only `gemma4:31b` pulled, which is not a code model), and the built `gridlight`
   dist predates the src fixes. No synthetic scores were fabricated. To run:
   `ollama serve` + `ollama pull qwen2.5-coder:7b`, rebuild the CLI
   (`cd ../vscode-extension/packages/cli && npm run build`), then
   `node eval/src/cli.mjs run --model qwen2.5-coder:7b`.
3. **Step 1 not started** (NeonCore `model_parity_scores` table + route) — by
   design, gated on the spike verdict per the plan.

## Phase 4 review + fixes applied

Five specialist reviewers (correctness, security, reliability, simplicity,
adversarial) ran over the diff. The important finding: three stdout-substring
tasks were false-positive machines. Fixes landed:

- **Score validity:** converted read/bash/search tasks from stdout-substring to
  **file-based answers** (model writes to `answer.txt` / `lodash-users.txt`;
  asserted on file content, with the search task rejecting the distractor).
  Verdict now **gates on `error`/`exitCode`** — a timed-out or exit-1 run is a
  hard fail and its assertions don't run. Probe now verifies the **requested
  model is actually served** (not just that the gateway answers).
- **Reliability/security:** timeout now **kills the process group and awaits
  `close`** before asserting/cleanup; child env is **scrubbed** (no
  ANTHROPIC/AWS/etc. secrets to the auto-approve model); **SIGINT/SIGTERM**
  handler kills in-flight children and removes temp dirs.
- **Robustness:** `--k` validated; `loadTasks` validates `class`/`prompt`;
  gridlight continuation cap now **warns + returns false** instead of exiting 0;
  `edit-timeout` checks sibling fields survive; dead `fileExists` removed;
  misleading comment fixed.
- **Tests:** suite grew 11 → **16, all green** — added exit-code gating,
  timeout gating, probe-rejects-missing-model, file-answer over-broad rejection.

## Open items / next

- The go/no-go verdict itself needs the real run on qwen2.5-coder (7B/14B/32B).
- Cross-repo: the Gridlight `bin/gridlight.ts` fix needs its own commit + PR in
  `../vscode-extension` (not committed here).
- Task-suite breadth: git + combined bug-fix classes deferred; 6 core classes present.
