# @neoncore/parity-eval

Behavioral parity eval for the **Gridlight terminal**. It runs a fixed suite of
coding tasks through Gridlight pointed at a local model, scores each by **hard
outcome assertions** (file end-state, verify-command exit code, expected output),
and reports a per-capability score for that model.

This is **Step 0 (the spike)** of the dual-runtime effort — see
`docs/plans/dual-runtime-routing.md`. It answers one question: *does a local
model ever clear the bar on real code changes without a quality cliff?* The
score is the trust signal that later gates hardware-aware routing (Task 1).

Zero Gridlight source is imported — the harness drives the `gridlight` binary as
a black box (`gridlight -p "<prompt>" --cwd <fixture>`), configured by env.

## Run it

Prerequisites:
1. A local OpenAI-compatible model server (Ollama / LM Studio / vLLM) serving a
   **code** model. `llama3.1` and general chat models are not code models — use
   `qwen2.5-coder`. e.g. with Ollama:
   ```
   ollama serve                      # starts the server on :11434
   ollama pull qwen2.5-coder:7b      # or :14b (16GB VRAM) / :32b (24GB VRAM)
   ```
2. The `gridlight` binary on PATH, built from the CLI package **with the headless
   fixes** (multi-step continuation + honest exit code):
   ```
   cd ../vscode-extension/packages/cli && npm run build
   export GRIDLIGHT_BIN=$(pwd)/dist/bin/gridlight.js
   ```

Then:
```
node src/cli.mjs run --model qwen2.5-coder:7b --gateway http://localhost:11434 --k 3
```

Options: `--model` (required), `--gateway` (default `http://localhost:11434`),
`--backend` (default `openai-compatible`), `--k` runs per task for pass@k
(default 3), `--only a,b`, `--tasks-dir`, `--gridlight-bin`, `--neoncore` (report
to NeonCore during runs; default off/hermetic), `--no-probe`.

The gateway is probed first: a down server would score every task as a false
failure, so the run refuses to start unless the server answers (override with
`--no-probe`).

## What it reports

Per-class and aggregate pass rate, each with a 95% **Wilson lower bound** — even
at temperature 0 local models wobble, so routing should gate on the conservative
bound, not a noisy point score. Full JSON per run lands in `results/<model>/`.

## Task suite

`tasks/<id>/` = `task.json` (id, class, prompt, timeoutMs) + `fixture/` (seed
tree, copied fresh per run) + `assert.mjs` (`export async function assert({cwd,
stdout, exitCode}) -> {pass, checks[]}`). Assertions read END-STATE, not the
model's prose — the agent can't talk its way to a pass.

Current classes: `bash`, `read`, `edit`, `write`, `search`, `refactor`. The
`refactor` task is the decisive one (multi-file rename, verified by re-running
the module) — it's the high-value class routing most needs to get right.

## Test the harness itself

```
npm test
```
Validates the scorer (Wilson bounds, aggregation), every assertion against both a
correct and a deliberately-wrong end-state (assertions must fail when they
should), and the full runner path with a mock Gridlight (fixture copy → spawn →
assert → cleanup, plus fixture isolation).

## Status

Harness + suite + tests: **done and green** (11 tests). A real scored run is
**pending a local code model** (see prerequisites) — no synthetic scores are
produced. Step 1 (persist to NeonCore `model_parity_scores` + route) is deferred
until a spike run confirms local clears the bar.
