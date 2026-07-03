# AWAITING HUMAN — CE Phase 2 Gate

- **Phase:** 2 — Plan
- **Feature:** Dual-Runtime Routing (Gridlight + Claude/Codex) — wedge: per-model parity eval
- **Affected files:** ~9 — a new `neoncore/eval/` package (6 files: package.json, runner,
  score, cli, task dirs, results), one Gridlight-repo fix
  (`../vscode-extension/packages/cli/src/bin/gridlight.ts`), and (Step 1 only)
  `server/src/db.ts` + a new `server/src/routes/parity.ts`.
- **Implementation steps:** 9 (Step 0 spike: 1-6; Step 1 productize: 7-9, gated on the spike).
- **Risks (top 5):**
  1. Green-score-ships-bad-code (deterministic asserts miss the quality cliff).
  2. Local models never clear the bar on multi-file refactor (the high-value class).
  3. Payoff < effort (local wins cheap queries, loses expensive ones).
  4. Non-determinism misranks models near threshold (mitigate: pass@k + CIs).
  5. Maintenance rot — per-model suite goes stale, no owner named.
- **File to review:** `docs/plans/dual-runtime-routing.md`

## Open decisions requiring human input
1. **Headline — scope:** disposable spike-first (CEO) vs the reusable routing-shaped harness
   you chose in Phase 1. Recommended reconciliation: **Step 0 spike → Step 1 productize only
   if the spike proves local ever clears the bar.** Confirm or override.
2. First models to test — recommend qwen2.5-coder 7B/14B/32B (llama3.1 as negative control?).
3. Static golden assertions vs a live Claude reference per run — recommend static goldens.
4. NeonCore reporting during eval — off (clean scoring) vs on (dogfood transcript path).
5. Capability taxonomy — 6 classes vs coarser bash/quick-vs-code-gen.
6. Harness location — `neoncore/eval/` (recommended) vs the Gridlight monorepo.
7. Who owns re-running the eval as models/Gridlight change (maintenance-rot).

## To proceed
- "approved phase 2, continue to phase 3" — I'll implement **Step 0 (the spike)** per the
  plan: scaffold `eval/`, author the task suite, land the two `bin/gridlight.ts` fixes, and
  run qwen2.5-coder to get the go/no-go verdict.
- Add any overrides to the open decisions above (e.g. "approved, but skip the spike and build
  the reusable harness" or "test these models: …").

## To revise
- "rejected phase 2: [reason]" — e.g. change the phasing, the task classes, or the models.
