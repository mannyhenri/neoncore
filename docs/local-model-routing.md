# Capability-gated routing: deciding what a local model may do

**The problem this solves.** A developer runs a local model. They do not know how good it
is. It might be a 4B that cannot reliably emit a tool call, or a 30B agentic-coding model
that outperforms a frontier engine at mechanical edits. The system must **measure the model
and decide, per function, whether it participates** — without anyone hand-authoring a table
for a model they happen to know.

This supersedes the static local-vs-frontier table in
[research/local-vs-frontier.md](research/local-vs-frontier.md) §3. That table was keyed to
Qwen2.5-Coder-14B and, worse, keyed to the wrong variable — **size does not predict
capability** (§3.1). Swap the model and it is silently wrong with no mechanism to notice.

Three parts, matching the three things asked for: **what agents do** (§2), **the minimum
bar per function** (§3), **the algorithm** (§4).

---

## 1. The default is inverted, deliberately

Our previous design was frontier-by-default with local as the exception. That cannot
deliver "flexible and efficient with the local models we have while maximising tooling and
token costs", because it puts the burden of proof on the cheap engine — so the expensive one
wins every ambiguous case, and ambiguous cases are most of them.

The literature points the other way. NVIDIA's position is that SLMs are "sufficiently
powerful, inherently more suitable, and necessarily more economical for many invocations in
agentic systems", that agentic systems decompose into modular sub-tasks each handled by a
specialised small model, and that **heterogeneous systems invoking multiple different
models are the natural choice** — which is exactly the Gridlight + Claude + Codex setup.
Their operational rule is the best one-line statement of the goal here:

> **Reserve the generalist for the decide/plan moments; use small models for the repetitive
> errands.**

So the algorithm answers **"which functions must escalate to frontier"**, not "which
functions may be delegated to local". Same map, opposite default, and far more work stays
local. SLMs are cited at 10–30× cheaper with lower latency and energy.

**The guardrail that makes the inversion safe.** Inverting the default inverts the failure
mode: previously an unprofiled function quietly cost money; now it could quietly ship work
from a model nobody verified. So eligibility has **three states, not two**:

| State | Meaning | Routes to |
|---|---|---|
| `ELIGIBLE` | Measured, clears the bar | **local** |
| `INELIGIBLE` | Measured, fails the bar | **frontier** |
| `UNMEASURED` | No data yet | **frontier**, and queue a probe |

Two states would collapse "we checked and it is fine" into "we never checked" — the
confidently-wrong-answer class this codebase has hit repeatedly. Cold start therefore
behaves exactly like today's system and improves as the probe fills in, which also makes
this the safest possible rollout.

---

## 2. What agents actually do — the function registry

**44 functions.** Four registries are derived from source; the fifth category is
hand-listed because it has no enum to derive from — and its absence from the first draft is
the most instructive thing in this document (see "what the checker actually guarantees").

- `packages/core/src/agent/agentTools.ts` — 12 agent tools
- `server/src/types.ts` `StepExecutorType` — 7 workflow node types
- `server/src/lib/confer-conductor.ts` — 9 confer milestone roles
- `server/src/mcp-server.ts` — 10 coordination tools
- *engine lifecycle and developer-facing* — 6 functions, **not derivable from any enum**

`server/test/function-registry-coverage.test.ts` re-derives the first four from source and
fails if any function lacks a tier. Add a tool and the table is incomplete until updated —
the anti-drift property, because a routing table hand-maintained against a tool registry
rots exactly like `KNOWN_ENGINES` did against `AgentType`. What it cannot do is notice a
whole category is missing; that limitation is documented below rather than glossed.

### The tier scale

**The tier is a convenience label over the vector, not the thing the router computes on.**
Capability is a *vector* and it is **not monotonic**: an ordinal scale assumes that clearing
T3 implies clearing T1, and that is false exactly where it matters. A model with decent comprehension and poor
tool-call reliability would be labelled T2, assumed to clear T1, and handed `read_file`,
which it fails. So the router evaluates **the gate plus the vector** (§4), and the tier
exists so humans can read the table.

- **T0** — no model call at all. Free, always local, regardless of engine.
- **T1-READ** — emit a well-formed tool call for a **non-mutating** operation. Fails
  loudly: bad path, error, retry, no harm done.
- **T1-WRITE** — mechanical to invoke but **mutating**, and can fail *silently and
  destructively*. An exact-match replacement that hits the wrong occurrence — or matches
  nothing and reports success — corrupts a file while emitting a perfectly well-formed tool
  call.
- **T2** — comprehend and summarise content already in context.
- **T3** — synthesise correct code for a single, well-specified change.
- **T4** — multi-file reasoning and long-horizon planning.
- **T5** — judge someone else's work: is it correct, is it complete.

The T1 split is by **blast radius on failure**, not difficulty — and it matters more under
the inverted default than it would have before. SLM-first means T1 carries the most work
*by volume*, so if the most freely delegated tier also contains the tools that can corrupt
a file, we have optimised token cost into a data-loss risk. A model can clear a tool-call
benchmark and still botch exact-match replacement; those are different capabilities and
BFCL measures only the first.

**Latency tolerance** is tracked per function alongside the tier, because capability and
speed are independent (§3.4): `interactive` functions sit in a loop the developer is
waiting on; `batch` functions can be arbitrarily slow at no cost.

### Agent tools (`agentTools.ts`)

For a *tool*, the tier asks "can the model invoke this correctly" — not "is the content
good". Content quality is the surrounding step's tier, tracked separately below.

| Function | Tier | Latency | Why |
|---|---|---|---|
| `read_file` | T1-READ | interactive | Path in, bytes out. The archetypal local win. |
| `list_files` | T1-READ | interactive | Mechanical. |
| `search_code` | T1-READ | interactive | Mechanical; query formulation is trivial. |
| `git_status` | T1-READ | interactive | Mechanical. |
| `git_diff` | T1-READ | interactive | Mechanical. |
| `web_search` | T1-READ | batch | Issue a query. Network-bound anyway. |
| `web_fetch` | T1-READ | batch | Fetch a URL. Network-bound anyway. |
| `write_file` | T1-WRITE | interactive | Mutating. Call is mechanical; content quality = the step's tier. |
| `edit_file` | T1-WRITE | interactive | Mutating and **fails silently** — exact-match replacement on the wrong occurrence corrupts the file. First tool to break on a weak model. |
| `run_command` | T1-WRITE | interactive | Mutating in the general case (it can run anything). Invocation is mechanical; *deciding what to run* is the step's tier. |
| `git_commit` | T2 | batch | Mutating, and requires summarising a diff into a coherent message. |
| `spawn_agent` | T4 | batch | Delegation requires decomposing work and knowing what to hand off. |

### Workflow node types (`StepExecutorType`)

| Function | Tier | Why |
|---|---|---|
| `command` | T0 | Runs a shell command. No model involved. |
| `connector` | T1-READ | External call with structured arguments. |
| `decision` | T2 | Branch on a stated condition. |
| `claude-code` | T4 | The open-ended agent work step. Unbounded by construction. |
| `review-gate` | T5 | Judging whether work passes. Reserve for the generalist. |
| `quality-gate` | T5 | Same. |
| `deliberation` | T5 | Panel judgement across engines. |

### Confer milestone roles (`confer-conductor.ts`)

| Function | Tier | Why |
|---|---|---|
| `align` | T4 | Negotiate a shared plan and a work split. |
| `frame` | T4 | Agree one approach to one problem. |
| `build` | T4 | Implement a slice against an agreed design. |
| `draft` | T4 | Produce the first complete solution. |
| `revise` | T3 | Apply already-agreed changes — bounded by the critique list. |
| `finalize` | T5 | **Not summarisation — verification.** Finalize means confirming a peer's account of the work is *true*. In this confer series a summary twice overstated one side's contribution and was caught only by the person it flattered. A confirmation always looks like success, so a weak model confirming what it cannot evaluate fails invisibly. |
| `review` | T5 | Critique a peer's work. |
| `critique` | T5 | Same. |
| `converge` | T5 | Merge slices and prove no conflicts. |

### Coordination tools (`mcp-server.ts`)

| Function | Tier | Why |
|---|---|---|
| `neoncore_register` | T1-READ | Structured call. |
| `neoncore_report` | T1-READ | Structured call. |
| `neoncore_list_agents` | T1-READ | Structured call. |
| `neoncore_claim_task` | T1-READ | Structured call. |
| `neoncore_my_queue` | T1-READ | Structured call. |
| `neoncore_request_permission` | T1-READ | Structured call. |
| `neoncore_message_agent` | T2 | Composing a message a peer can act on. |
| `neoncore_read_agent` | T2 | Reading and comprehending a peer's transcript. |
| `neoncore_report_step_done` | T2 | Summarise what a step produced. |
| `neoncore_report_task_done` | T5 | **Reserve for the generalist regardless of probe.** The work standard requires enumerating the COMPLETE set from a codebase and judging whether a fix covers it. That is the highest-judgement step in the pipeline and it decides whether everything downstream is correct. |

### Engine lifecycle and developer-facing functions

**These are the functions the first draft missed**, and how they were found matters more
than the rows themselves — see "what the checker actually guarantees" below. The first two
are code-derived; the last three are development-cycle functions with no enum of their own,
and are labelled as such rather than dressed up as code-derived.

| Function | Tier | Latency | Source | Why |
|---|---|---|---|---|
| `task_planning` | T4 | interactive | `agentExecutor.createTaskPlan()` | Decomposing a goal into steps. A real model call, and the first thing a weak model gets wrong. |
| `developer_question` | T5 | interactive | `PendingQuestion` (`taskTypes.ts:16`), `Presenter.question()` (`presenter.ts:25`), `Confirmer` (`confirmer.ts:22`) | **Knowing you are stuck is judgement.** A weak model that asks constantly destroys the entire value of running locally — the developer pays in attention what they saved in tokens, which is a worse trade than just using frontier. This failure mode is invisible to every capability benchmark. |
| `test_case_authoring` | T3 | batch | *development cycle — no enum* | Writing one test case against a **stated** assertion. Well-specified and verifiable — a genuine small-model case. |
| `test_authoring` | T5 | batch | *development cycle — no enum* | Writing the **set-based** test this project's standard demands. The standard forbids example-based tests because they pass on a half-done fix — so the test must iterate the registry, which means **enumerating the complete set from the code first**. That enumeration is the same capability held at T5 for `neoncore_report_task_done`, and it is the hard part; the test is worthless without it. **This confer demonstrated the failure directly:** the registry checker was a test that read `38/38` green while the set it iterated was incomplete. A model that can write a passing test but cannot enumerate the true set produces exactly that artefact — green, confident, and blind to a missing category. Routing this locally would industrialise it. |
| `test_failure_interpretation` | T4 | interactive | *development cycle — no enum* | Reading a failure and deciding what to do. Decides whether a local fix loop converges or thrashes. |
| `result_summarization` | T2 | batch | *development cycle — no enum* | Summarising the end result for the developer. Comprehension over work already done. |

### What the checker actually guarantees

`server/test/function-registry-coverage.test.ts` re-derives the expected set from source and
reports `44/44`. **That number proves internal consistency, not completeness.**

The checker derives its expected set from the same registries the table was built from, so
it can only find omissions *within categories it already knows*. It is structurally blind to
a missing **category** — and that is exactly what went wrong: the first draft reported `38/38` green while omitting developer interaction, test authoring and test-failure
interpretation entirely.

**The registry was found incomplete by a human sentence, not by the test.** The user's own
words — "creating tests", "testing", "interacting with the developer" — were the external
oracle. The general lesson, which applies to any verification mechanism in this repo:

> A checker derived from the artefact it checks can only find omissions within categories it
> already knows. Completeness against the world is not testable this way; it needs an
> external oracle.

This is the second time a verification mechanism here has checked the part that was already
right — `docs-citations.test.ts` was scoped to exclude the repo whose citations were most
likely to rot, and a citation drifted inside a single milestone while the suite stayed
green. Treat a green coverage number as evidence about drift, never as evidence about scope.

### What is already free — and why it is not in the table

`contextCompactor`, `relevanceScorer`, `projectMemory` and `workspaceScanner` in
`packages/core` make **no model call at all** — they are heuristic. So *codebase indexing,
file scanning, relevance ranking and context compaction cost zero tokens today* and are
already optimal. They are T0 and need no routing decision. This corrects a premise worth
stating plainly: "should the local model do the indexing?" does not arise, because in this
architecture indexing is not a model task.

---

## 3. The minimum bars, from research

### 3.1 Size is not the predictor — this is the finding that reshapes everything

Reliable tool calling emerges around a **7–9B cutoff for general-purpose models**, but
models trained for agentic coding **beat larger general-purpose models** at tool calling.
Training direction dominates parameter count; for structured output, methodology and
architecture matter more than raw size. Architecture also splits by task: encoder-style
models suit comprehension (retrieval, clone detection), decoder-style suit generation.

**Consequence:** any algorithm that routes on model name or parameter count is wrong on
arrival. We must route on **measured** capability. This is precisely why the previous
static table failed — it keyed on the wrong variable.

### 3.2 The hard gate is tool-call reliability, and it is measurable

A model that cannot emit a well-formed tool call cannot read a file, so **every other
dimension is downstream of this one — gate first, profile second.** BFCL V4 gives a
published scale that cliffs sharply:

| Model class | BFCL V4 | Implication |
|---|---|---|
| ~27B | 68.5% | Clears T1 comfortably |
| ~9B | 66.1% | Clears T1 — the single-GPU sweet spot |
| ~4B | 50.3% | Marginal at T1 |
| ~2B | 43.6% | **Fails the gate.** Cannot participate agentically at all. |

### 3.3 Bars per tier

| Tier | Requires | Evidence |
|---|---|---|
| T0 | nothing | no model call |
| T1-READ | tool-call reliability above the gate | BFCL ≳ 60% for dependable use; below ~50% it fails often enough to cost more than it saves |
| T1-WRITE | the gate **plus a demonstrated exact-match edit in the probe** | BFCL measures "can invoke tools", not "can safely mutate my codebase". A well-formed call that replaces the wrong occurrence is a corrupted file, not a failed call — so this tier needs its own cheap probe task rather than inheriting T1-READ's score |
| T2 | comprehension + summarisation over supplied context | 3B–8B models approach GPT-3.5-class on HumanEval/MMLU for summarisation and RAG |
| T3 | single-file code synthesis | the 7–9B agentic-coding class; general models of the same size underperform here |
| T4 | multi-file reasoning, long-horizon planning | the capability cliff — bounded vs unbounded reasoning; this is what frontier buys |
| T5 | judging correctness and completeness | reserve for the generalist; see §2 `neoncore_report_task_done` |

**The honest shape of this:** T1 and T2 are where nearly all the volume is — reads,
searches, status calls, summaries — and they are cheaply within reach of a small model.
T4 and T5 are where correctness is decided. That is why SLM-first pays: the registry is
mostly T1/T2 by count, and mostly T4/T5 by consequence.

**Count is a proxy, not the economic claim.** Functions are not equally frequent —
`read_file` and `search_code` fire constantly, `neoncore_report_task_done` fires once per
task. The real number is the **frequency-weighted token share**, and we have not measured
it. It is probably *higher* than the headline count, which strengthens the case, but the
count must not be read as spend.

### 3.4 Latency is an independent axis, and the user named it first

"Could be great, or could be **super slow**, or not good enough" names three failure modes.
Capability covers two. A model that clears T4 at 3 tokens/sec is **worse than frontier for
anything in an interactive loop** and perfectly fine for an overnight index refresh.

So latency gates participation independently of capability:

- `interactive` functions sit in a loop the developer is waiting on. A slow model here makes
  the whole session feel broken even when it is perfectly capable.
- `batch` functions can be arbitrarily slow at no cost.

The probe therefore measures **tokens/sec alongside capability**, and the router checks
both. This also gives cost its home: the probe becomes the single place we measure
capability, speed and cost per `model_id` — which is the argument for building it at all.
*Intelligence per Watt* is the closest published framing for the energy side.

---

## 4. The algorithm

```
PROBE(model_id)                once per model, cached, seeded from published benchmarks
  ├─> GATE:  toolCall reliability  ── binary. Fails => NOTHING routes local. Checked first.
  ├─> VECTOR { safeEdit, comprehension, synthesis, planning, judgement }
  └─> SPEED  { tokensPerSec }
        └─> MAP: for each of the 44 functions, (gate, vector, speed) vs (tier bar, latency)
              └─> { ELIGIBLE | INELIGIBLE | UNMEASURED }
                    └─> ROUTE(function_id) at dispatch
                          └─> DEMOTE on observed failure, persisted per (model_id, function)
                                └─> feeds back into the profile  ← the only closed loop
```

**The gate is evaluated separately and first.** It is not the bottom of an ordinal scale: a
model that fails tool-calling routes *nothing* locally regardless of how well it summarises.
Collapsing the gate into a tier is how a flat profile reintroduces the failure that
structured profiles exist to prevent.

**Speed is checked alongside capability, not after it.** The probe measures **tokens/sec**,
and each function carries a **latency tolerance** (`interactive` / `batch`). A model that
clears a function's tier but misses its latency tolerance is routed to frontier for that
function and may still be routed local for `batch` ones — capability and speed gate
independently, so a slow-but-capable model is not wasted, it is used where waiting is free.

**a. Probe.** Measure the model once per `model_id`, cached. This is not new work:
[plans/dual-runtime-routing.md](plans/dual-runtime-routing.md) already scoped a parity eval
producing per-capability scores per model id plus a `model_parity_scores` table. That *is*
the probe. Published BFCL numbers seed the profile so a cold start is not useless, and the
eval refines it. Profiles should be **structured per capability, not a single scalar** —
structured profiles outperform flat ones, and query-level signals beat domain-level.

**b. Map.** Compare the vector against each function's tier bar to produce the
three-state eligibility map. The map is **data**; it is the single source of truth.

**c. Route.** The router is a **pure function** over `(function_id, map, live_signals)`
returning an engine. It holds **no policy of its own beyond thresholds**. This is not
stylistic: every time policy has lived in two places in this codebase it has drifted —
`KNOWN_ENGINES` against `AgentType`, `escalationHint` against the escalation ladder. If the
map says a function is eligible and the router carries a separate opinion, we have rebuilt
that defect on purpose.

**d. Demote — and this is the only closed loop in the design.** The behavioural signals
already shipped (`packages/core/src/neoncore/signals.ts` — prose-instead-of-tool-call, tool
errors, `testSuite`, etc.) demote a function that keeps failing in practice. Demotion is
**persistent and scoped to `(model_id, function_id)`**, written back to the same store as
the probe — not held in memory. Otherwise every restart re-learns that this model cannot do
review-gates, at the cost of a failed turn each time.

This is more than a safety net. **The probe is a single point of failure**: the whole
architecture is profile → map → router, so a mis-measured profile silently mis-routes every
function keyed to it — and unlike a *missing* measurement, which the three-state guardrail
catches, a *wrong* measurement looks exactly like a right one. Demotion is the only
mechanism that corrects a bad profile, which makes it the error-correction path, not a
fallback.

Two mitigations follow:

- **Re-probe when the `model_id` changes** — including a silent swap behind the same gateway
  endpoint. That is R1 (the gateway not echoing the served model) resurfacing in a new and
  more damaging place: here it does not merely block measurement, it lets a stale profile
  authorise work for a model that never earned it.
- **Never treat a profile as final.** Sharing the store with demotion means the map *improves
  with use* instead of going stale the moment the probe finishes.

### Where this can actually be consulted today

Three dispatch paths, and they are not equal:

| Path | Can consult the map? | Notes |
|---|---|---|
| **Workflow steps** | **Yes, today** | `routes/workflows.ts` already reads `config.agentType` per step and resolves via `agentIdForRepoAndType()`. The map replaces a hardcoded string with a lookup. **Cheapest integration point — land it here first.** |
| **Confer** | **Yes, at participant selection** | Granularity mismatch: a confer assigns engines to participants **once at start**, then dispatches milestone prompts to fixed participants. So per-*milestone* routing is not possible today. **This design assumes participant-selection-time routing**, using the highest tier among the milestones that participant will face. Per-milestone re-targeting is new conductor work and is out of scope here. |
| **A plain prompt** | **No** | `sendCommandToAgent` takes an `agentId` the caller already chose. There is no function id to look the map up *with*. Routing a bare prompt requires **classifying it first** — which is tractable, since 1–4B models are already adequate for sub-second task classification, meaning the router's classifier can itself run locally at zero marginal cost. But it is **real new work and is scoped as such, not assumed.** |

---

## 5. What this does not settle

- **The probe is not built.** It is scoped in `dual-runtime-routing.md` and seeded by
  published benchmarks, but nothing runs it yet. Until it does, every function is
  `UNMEASURED` and routes frontier — correct, and identical to today's behaviour.
- **Latency and energy are unmeasured for local.** Token cost is priced via `session_usage`
  for Claude and Codex; a local model's real cost is wall-clock and watts, and there is no
  per-turn latency anywhere. "Local is cheap" remains an assumption about the one engine it
  is a claim about. *Intelligence per Watt* is the closest published framing.
- **Tier assignments are judgements, not measurements.** The bars in §3.3 come from the
  literature; the per-function tiers in §2 come from reasoning about each function. They are
  falsifiable and should be revised once the probe produces real per-function scores.
- **Claude vs Codex is still unexplored.** This design routes local-vs-frontier. Which
  frontier engine gets an escalated function remains unasked, and
  `plans/gridlight-integration.md` still silently answers it in Claude's favour.

---

## Sources

- [Small Language Models are the Future of Agentic AI](https://arxiv.org/abs/2506.02153) — Belcak et al., NVIDIA
- [RouteProfile: Elucidating the Design Space of LLM Profiles for Routing](https://arxiv.org/html/2605.00180v1)
- [Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey](https://arxiv.org/pdf/2603.04445)
- [Large Language Model Routing with Benchmark Datasets](https://arxiv.org/pdf/2309.15789)
- [Intelligence per Watt: Measuring Intelligence Efficiency of Local AI](https://arxiv.org/pdf/2511.07885)
- [AgentFlux: Decoupled Fine-Tuning & Inference for On-Device Agentic Systems](https://arxiv.org/pdf/2510.00229)
- [I Tested 13 Local LLMs on Tool Calling — 2026 eval results](https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/)
- [Best Local Models for Tool Calling in 2026: Benchmarks](https://www.promptquorum.com/power-local-llm/best-local-models-tool-calling-2026)
- [Agentic Coding With Local LLMs — Feasibility, Cost, Hardware in 2026](https://braindetox.kr/en/posts/local_llm_agentic_coding_2026.html)
- [A Survey on Large Language Models for Software Engineering](https://arxiv.org/pdf/2312.15223)
