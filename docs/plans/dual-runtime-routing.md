# Plan: Dual-Runtime Routing — Wedge (Per-Model Parity Eval)

CE Phase 2 output (multi-agent plan review) · 2026-07-03
Branch: feat/transcript-pipeline · Repo: GRIDLIGHT-INC/neoncore
Source brainstorm: `docs/brainstorms/dual-runtime-routing.md`
Status: DRAFT — awaiting human approval at the Phase 2 gate

Reviewed from three angles: CEO/scope, eng/architecture, research (best practices).
The single most important unresolved decision is **scope: disposable spike vs
reusable routing-shaped harness** — see Open Decisions #1.

---

## Overview

Build the wedge: a **behavioral** parity eval that runs a fixed suite of coding tasks
through the Gridlight terminal (`@gridlight/cli`) pointed at a local model, scores each by
**hard outcome assertions** (file end-state, verify-command exit code, expected output),
and produces per-capability + aggregate scores per model id. The score is the trust signal
that later gates hardware-aware routing between Gridlight (local) and Claude/Codex (hosted).

The three reviews converged on the technique (exec-based assertions, Approach A) and split
on one thing — how much to build now:

- **CEO/scope: REDUCTION.** Don't build routing-shaped, per-model/per-class storage before
  proving the payoff exists. First answer one yes/no with a disposable ~10-task bakeoff
  against the strongest local coder model: *does a local model ever clear the bar on real
  code changes without a quality cliff?* If no, the whole dual-runtime bet is dead and the
  reusable harness was wasted. Its top risk: **green-score-ships-bad-code** (deterministic
  assertions pass end-state but miss the subjective-quality cliff that breaks routing trust).
- **Research: technique validated, harden two things.** Exec-based scoring is the industry
  standard (Terminal-Bench is near-identical to Approach A). (a) Treat determinism
  **statistically** — pass@k + confidence intervals, gate on the lower CI bound, because
  even at temp 0 local models wobble. (b) First router should be a **verify-and-fallback
  cascade** (run local, run tests, escalate on fail), not a difficulty predictor.
  `llama3.1` (Gridlight's default) is confirmed **not** a code model — test
  **qwen2.5-coder 7B/14B/32B**.
- **Eng/architecture: buildable now, two tiny Gridlight fixes.** Drive `gridlight -p` as a
  black box via env vars; the only Gridlight-repo change is a ~15-line `hasMoreSteps` loop
  and an exit-code fix.

**Reconciliation (recommended):** the spike and the reusable harness are not opposites. The
eng design's harness + task suite *is* the spike; the only "routing-shaped" parts are the
DB table + route + pass@k/CIs. So phase it:
- **Step 0 (spike):** harness + 6-8 tasks + qwen2.5-coder runs → results to JSON only.
  Answer the yes/no. No NeonCore DB, no route.
- **Step 1 (productize):** add `model_parity_scores` table, POST/GET route, and pass@k/CIs
  — **only if** Step 0 says local clears the bar.

This preserves the Phase 1 "reusable per-model eval" intent while honoring the CEO's "don't
build the instrument to productize a finding you haven't confirmed."

## Affected / Created Files

New harness (Step 0):
- `eval/package.json` — standalone Node package; spawns `gridlight`, no gridlight dep.
- `eval/src/runner.ts` — copy fixture → temp, spawn `gridlight -p --cwd`, capture
  stdout/exit/end-state.
- `eval/src/score.ts` — aggregate byClass + overall, write JSON (Step 1: POST to NeonCore).
- `eval/src/cli.ts` — `eval run --model <id>` entry point.
- `eval/tasks/<id>/{task.json, fixture/, assert.mjs}` — 6-8 task dirs (one per class).
- `eval/results/` — output JSON (gitignored).

Gridlight repo — the only change there (belongs upstream):
- `../vscode-extension/packages/cli/src/bin/gridlight.ts` — (1) loop `runPrompt` on
  `result.hasMoreSteps` (mirror `TuiController.handleResult`, controller.ts:195-206) so
  multi-file refactors don't truncate after step 1 (bin/gridlight.ts:97-115); (2) set
  `process.exitCode = result.success ? 0 : 1` (currently always 0, bin/gridlight.ts:112-114).

NeonCore productization (Step 1, only if spike passes):
- `server/src/db.ts` — add `model_parity_scores` table near existing table defs (~:308).
- `server/src/routes/parity.ts` — new POST/GET; register in `server/src/index.ts`.

## Implementation Steps

**Step 0 — Spike (answers the yes/no):**
1. Scaffold `eval/` package; add `GRIDLIGHT_BIN` resolution + gateway health probe (distinguish
   infra-fail from model-fail before running the suite).
2. Author 6-8 deterministic tasks across classes: bash, read, edit, write/create,
   multi-file refactor, search, git, and one combined bug-fix (failing test → make it pass).
   Assertions prefer filesystem end-state / verify-command exit 0 over stdout matching.
3. Land the two `bin/gridlight.ts` fixes (hasMoreSteps loop + exit code) so multi-step tasks
   actually complete.
4. Run the suite against **qwen2.5-coder 7B / 14B / 32B** (via Ollama/LM Studio/vLLM),
   `GRIDLIGHT_PERMISSION_MODE=auto`, NeonCore reporting **off** (hermetic).
5. **pass@k with confidence intervals** (k≈3-5), not single runs. Emit per-class score bands.
6. Read the verdict: does any local model clear a usable bar on edit/refactor without a
   quality cliff? Manual spot-check the "green" refactors for the quality-cliff risk.

**Step 1 — Productize (only if Step 0 passes):**
7. Add `model_parity_scores` table + `routes/parity.ts`; `score.ts` POSTs results.
8. Store per-class `pass_rate` with sample count + CI; routing later reads
   `WHERE model_id=? AND capability_class=?` and gates on the **lower CI bound**.
9. Hand off to Task 1 (hardware probe + verify-and-fallback cascade) as a separate phase.

## Test Plan (for the harness itself)

- **Scorer correctness:** run each `assert.mjs` against both a correct and a deliberately
  wrong end-state — assertions must fail when they should (guards the weak-oracle problem).
- **Mock model:** a stub `gridlight` returning canned edits → assert the scorer yields the
  expected pass/fail, independent of any real model.
- **Idempotency:** fixture copy leaves `tasks/` pristine; runs use an isolated temp dir,
  never the repo (fixture-bleed guard).
- **Timeout path:** a hanging task yields `pass:false`, not a hung harness.
- **Determinism check:** same model + task run k times reports variance, not a single flakey
  verdict.

## Rollback Plan

- Step 0 is **additive and isolated** — a new `eval/` dir + `results/` (gitignored). Delete
  the dir to fully roll back; nothing in `neoncore/` server or dashboard changes.
- The two `bin/gridlight.ts` fixes are behavior-correct on their own (multi-step completion
  + honest exit code) and low-risk, but land as a separate reviewable PR in the gridlight
  repo; revert independently.
- Step 1's DB table is created with `CREATE TABLE IF NOT EXISTS` and an index only; no
  migration of existing data, so rollback is `DROP TABLE model_parity_scores` + remove the
  route registration.

## Open Decisions (for the human gate)

1. **Scope: disposable spike vs reusable harness (headline).** CEO says spike-first; Phase 1
   chose reusable. Recommended reconciliation: Step 0 spike → Step 1 productize only if it
   passes. **Confirm or override.**
2. **First models to test.** Recommend qwen2.5-coder 7B/14B/32B (research-backed). Include
   `llama3.1` only as a negative control? 
3. **Golden static assertions vs live Claude reference per run.** Recommend static goldens
   (cheaper, deterministic, no per-run hosted cost) — CEO and eng agree.
4. **NeonCore reporting during eval:** off for clean scoring (recommended), or on to dogfood
   the transcript/token path?
5. **Capability taxonomy granularity.** Start with 6 classes (bash, read, edit, write,
   multi-file refactor, search, git); routing can coarsen to bash/quick vs code-gen by
   grouping. OK?
6. **Where the harness lives.** Recommend `neoncore/eval/` (score is consumed here, DB lives
   here) over the gridlight monorepo. Confirm?
7. **Pass threshold + owner.** Deferred to Task 1 (routing-side), but who owns re-running the
   eval when models/Gridlight change? (CEO flagged maintenance-rot with no named owner.)

## Risks (consolidated, most severe first)

1. **Green-score-ships-bad-code** — deterministic assertions miss the quality cliff. Mitigate:
   include regression/`PASS_TO_PASS`-style negative assertions, and manual spot-check green
   refactors during the spike before trusting any score for routing.
2. **Local never clears the bar** — especially on multi-file refactor, the high-value class.
   The spike exists precisely to find this cheaply.
3. **Payoff < effort** — local wins the cheap queries (bash/quick), loses the expensive ones
   (refactor). Routing may only shave pennies. The spike's verdict decides go/no-go.
4. **Non-determinism misranks models near the threshold** — mitigated by pass@k + CIs.
5. **Maintenance rot** — per-model suite goes stale; no owner named. Open Decision #7.

## Sources (research angle)

SWE-bench Verified; Terminal-Bench (closest prior art); Aider polyglot leaderboard
(edit-format vs solve axes); UTBoost (weak-oracle problem); Anthropic "Demystifying evals";
numerical nondeterminism at temp 0 (arXiv 2506.09501); RouteLLM (per-query routing);
FrugalGPT (verify-and-fallback cascade); local code-model VRAM tiers (qwen2.5-coder /
deepseek-coder / codestral).
