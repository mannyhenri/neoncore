# @neoncore/parity-eval

Behavioral parity eval for a **headless agent CLI**. It runs a fixed suite of
coding tasks through that CLI pointed at a local model, scores each by **hard
outcome assertions** (file end-state, verify-command exit code, expected output),
and reports a per-capability score for that model.

This is **Step 0 (the spike)** of the dual-runtime effort — see
`docs/plans/dual-runtime-routing.md`. It answers one question: *does a local
model ever clear the bar on real code changes without a quality cliff?* The
score is the trust signal that later gates hardware-aware routing (Task 1).

No agent source is imported — the harness drives the agent binary as a black
box (`<agent-bin> -p "<prompt>" --cwd <fixture>`), configured by `PARITY_*` env
vars (`PARITY_MODEL`, `PARITY_GATEWAY_URL`, `PARITY_BACKEND_MODE`,
`PARITY_PERMISSION_MODE`, `PARITY_TUI`, `PARITY_NEONCORE_ENABLED`). The gateway probe sends
`PARITY_API_TOKEN` as a bearer token when it is set.

## Run it

Prerequisites:
1. A local OpenAI-compatible model server (Ollama / LM Studio / vLLM) serving a
   **code** model. `llama3.1` and general chat models are not code models — use
   `qwen2.5-coder`. e.g. with Ollama:
   ```
   ollama serve                      # starts the server on :11434
   ollama pull qwen2.5-coder:7b      # or :14b (16GB VRAM) / :32b (24GB VRAM)
   ```
2. An agent CLI that accepts `-p "<prompt>" --cwd <dir>`, reads the `PARITY_*`
   env vars above, continues across steps headlessly and exits non-zero on
   failure:
   ```
   export PARITY_AGENT_BIN=/path/to/your/agent-cli
   ```

Then:
```
node src/cli.mjs run --model qwen2.5-coder:7b --agent-bin "$PARITY_AGENT_BIN" --gateway http://localhost:11434 --backend openai-compatible --k 3
```

Options: `--model` (required), `--agent-bin` (required, or `PARITY_AGENT_BIN`),
`--gateway` (default `http://localhost:8080`), `--backend` (`gateway` = liveness
probe only, the default; or `openai-compatible`), `--k` runs per task for pass@k
(default 3), `--only a,b`, `--tasks-dir`, `--neoncore` (report
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
should), and the full runner path with a mock agent CLI (fixture copy → spawn →
assert → cleanup, plus fixture isolation).

## Status

Harness + suite + tests: **done and green** (11 tests). A real scored run is
**pending a local code model** (see prerequisites) — no synthetic scores are
produced. Step 1 (persist to NeonCore `model_parity_scores` + route) is deferred
until a spike run confirms local clears the bar.
