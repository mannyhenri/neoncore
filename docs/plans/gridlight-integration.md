# Gridlight integration: where the router lives in NeonCore

Part 2 of the Gridlight work. Companion to [../research/local-vs-frontier.md](../research/local-vs-frontier.md),
which decides *what* the policy should be. This decides *where it goes in this codebase*.

Scope boundary: this covers the **NeonCore side only**. The Gridlight CLI side (parity gaps
and CLI requirements) is owned by the peer cartridge in `gridlight-monorepo` and lands in
`docs/neoncore-parity-gaps.md` / `docs/neoncore-cli-requirements.md` there.

---

## 1. What already exists

More than expected. NeonCore is most of an escalation substrate already — it just has no
router.

| Capability | Where | Good enough? |
|---|---|---|
| Dispatch to a specific engine on a repo | `server/src/lib/resolve-agent.ts:120` `agentIdForRepoAndType()` | **Yes** — this is the routing primitive |
| Multi-engine coordination on one task | `server/src/lib/confer-conductor.ts` | Yes — milestones, per-participant prompts |
| A "judge" step that returns PASS/FAIL with feedback and retries | `workflow-executor-v2.ts` `review-gate`, `quality-gate` (`currentRetry` / `maxRetries` / `lastFeedback`) | **Yes** — this IS draft-then-verify, already built |
| Repeated-failure detection | `server/src/stuck-detector.ts` `ERROR_PATTERNS`, `analyzeAgent()` | Partly — see §2 |
| Panel of engines answering the same question | `workflow-executor-v2.ts` `deliberation` | Yes — multi-judge agreement is available |
| Per-agent token/cost accounting | `server/src/lib/pricing.ts`, `server/src/lib/goal-cost.ts` | Yes — needed to prove routing saves money |
| Completion contract with mandatory verification | `server/src/lib/work-standard.ts` | Yes — the free verification harness |
| Gridlight as a known engine | `server/src/types.ts:2` `AgentType` includes `'gridlight'` | Yes — no schema work needed |

**The important one**: `review-gate` with retry and feedback is draft-then-verify already
implemented. Routing a `gridlight` step into a review gate executed by `claude` is a
config-level change, not a feature.

---

## 2. What is missing

Four things, and only the first is genuinely new machinery.

### Gap A — the router itself

Nothing decides *which engine* gets a turn. `agentIdForRepoAndType()` is called with a type
the caller already chose. There is no policy object, no escalation ladder, no place to say
"try local, escalate on trouble".

**Where it belongs**: a new `server/src/lib/engine-router.ts`, pure and testable in the
style of `work-standard.ts` — take a task descriptor plus the current trouble signals,
return which engine should get this turn and why. Pure so the policy can be tested against
a table of cases without a live model.

### Gap B — typed trouble signals

`stuck-detector.ts` infers trouble by regex-matching tool output against `ERROR_PATTERNS`.
That is the right idea and the wrong resolution: it is scraping, because for Claude and
Codex scraping is the only option.

Gridlight is first-party. Per the peer's correction — which I accept and which improves
this design — the router should consume **typed events from `packages/core`**, with the
regex path kept as the degraded fallback for third-party engines.

**Resolved by the peer's audit** — the signals exist today in `packages/core`, and one
assumed signal does not exist at all:

| Available | Not available |
|---|---|
| prose-instead-of-tool-call, empty response, API retry count, tool-returned-error, step threw, error patterns in output, `pendingQuestion`, plan-progress stall, terminal success | **token log-probs / entropy** — no surface exists; confidence routing is not implementable |

So `low_confidence` is struck from the design. The ingest accepts the nine behavioural
signals and a normaliser folds the scraped `stuck-detector` output into the same shape, so
the router never learns which engine it is judging.

**Policy ownership**: core also offers a rolled-up `escalationHint`. The router will consume
the **raw signals as truth** and treat the hint as a diagnostic only. Policy must live in
exactly one place — a rollup the router depends on becomes a second policy that can drift
from the first, and then thresholds are tuned in two repos.

**Where it belongs**: `server/src/lib/engine-signals.ts` (normaliser, pure) plus an ingest
route alongside the existing agent endpoints.

### Gap C — engine capability declaration

Nothing records what an engine *can* do. The router needs to know that `gridlight` is a
14B local model — cheap, bounded, no permission gate yet — versus `claude` being frontier
and expensive. Today `AgentType` is a bare string union.

**Where it belongs**: a capability registry keyed by `AgentType`, colocated with the router.
Deliberately data, not code, so adding an engine is a table entry.

### Gap D — routing policy is not configurable

The escalation thresholds (how many failures before escalating, whether to draft-then-verify
a class of work) must be settings, not constants, or we cannot tune them against real
behaviour. `settings` already exists and is the natural home.

---

## 3. Sequencing

Ordered so each step is verifiable before the next depends on it.

1. **Capability registry + router skeleton** (Gap C, A). Pure functions, set-based tests
   over the engine registry. No dispatch changes yet — the router returns a decision that
   nothing acts on. Verifiable in isolation.
2. **Signal normaliser** (Gap B). Wrap the existing `stuck-detector` output into the shared
   shape; add the ingest path for first-party typed events. Both feed one interface.
   *Blocked on the peer's answer about what `packages/core` can truthfully emit.*
3. **Wire the router into dispatch.** The narrowest useful integration: when a workflow step
   or confer participant is `gridlight` and the signals trip, escalate that turn to a
   frontier engine on the same repo — `agentIdForRepoAndType(repoPath, 'claude')` already
   resolves the target.
4. **Draft-then-verify as a preset.** No new machinery: a workflow template that runs the
   work step on `gridlight` and a `review-gate` on `claude`. This is available *today* and
   should ship first as the safe baseline while the router is proven.
5. **Policy settings** (Gap D) once we have real numbers from 1–4.

**Step 4 is the quick win** and I would ship it before the router. It needs no new code,
gives the user local-first work immediately, and its quality floor is frontier-review
quality.

---

## 4. Hard dependency on the Gridlight side

The peer's verified gap list gates parts of this:

- **Their gap #6 (neoncore MCP server not registered for the CLI)** means Gridlight cannot
  participate in a confer at all today. Until that closes, step 3 can only route *workflow
  steps*, not confer participants. This is the blocker for the user's "all three together"
  question.
- **Their gap #5 (no registration/telemetry)** means the router would be blind to Gridlight
  turns — no activity, no token usage, so no cost accounting and no scraped fallback signal.
- **Their gap #4 (permission bridge never wired in the CLI host)** is a safety precondition,
  not a nicety: routing work to a local model *by default* means it acts more often, and
  the approval path is the containment boundary. **Local-by-default with no approval path
  is the risk case** — I agree with the peer's framing and would not enable
  escalate-on-trouble routing until #4 is closed.

Their suggested order (#6 → #5 → #4) is right for unblocking; my only amendment is that #4
must land before the router *defaults* to local, even though it can land after the router
exists behind a flag.

---

## 5. What this plan deliberately does not do

- **No gridlight hook shim.** My first instinct was to add `agent/hooks/gridlight-*` for
  symmetry with the other five engines. The peer corrected this and they are right: hooks
  exist because Claude and Codex are third-party binaries instrumentable only from outside.
  Building a shim for a first-party engine would discard the typed signals `packages/core`
  already has.
- **No routing by static task labels.** The research is consistent that difficulty is not
  reliably predictable from the request; cascades observe an attempt before deciding.
- **No confidence calibration yet.** Conformal routing needs calibration data we do not
  have. Revisit once step 1–4 have produced real traces.
