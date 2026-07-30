# Local vs frontier: how to split work between Gridlight and Claude/Codex

Research for part 1 of the Gridlight integration. Written against the machine we actually
have: Gridlight running **Qwen2.5-Coder-14B** locally, alongside Claude Code and Codex.

The question is not "which model is better". It is: given both, which *turns* should go
where, and what signal decides.

---

## 1. Two families, and they are not the same trade

Everything credible in this space reduces to one of two shapes. They have very different
cost profiles, and the literature is clear that the choice depends on how good your
escalation signal is.

### A. Escalate-on-trouble (SLM-first / cascade)

Run the local model on every turn. A lightweight router watches for trouble and escalates
only those turns to frontier. Practitioner reports put **80–90% of agentic turns staying
local**; cascades "escalate queries through increasingly expensive models until confidence
thresholds are met" ([Dynamic Model Routing and Cascading survey][survey], [TianPan][tp]).

**Cost**: frontier is paid only on the escalated minority.
**Risk**: entirely dependent on signal quality. A bad signal either escalates everything
(paying more than frontier-only, since you also paid local) or nothing (shipping 14B work
as if it were frontier work).

### B. Draft-then-verify (both models on the same item)

Local drafts, frontier reviews or repairs. RLM-Cascade "applies both models to the same
request in a draft-then-verify structure" ([RLM-Cascade][rlm]).

**Cost**: frontier is paid on *every* item, though on cheaper input (reviewing a diff
rather than authoring it).
**Risk**: low. Quality floor is roughly frontier-review quality regardless of how bad the
draft was.

**This is the honest trade**: (A) is much cheaper but only if the signal works; (B) is
predictable but doubles the per-item touch. My peer flagged exactly this, and they are
right that (B) should not be dismissed for being unfashionable.

---

## 2. What actually drives escalation

The signals that appear repeatedly, in rough order of how obtainable they are for us:

| Signal | What it is | Available to us? |
|---|---|---|
| **Repeated tool failure** | N consecutive failing tool calls | **Yes, today** — `stuck-detector.ts` already does this |
| **Schema / contract violation** | Model emitted malformed tool JSON, or broke a stated output contract | **Yes** — first-party engine knows it exactly |
| **Self-reported confidence** | Model emits a confidence token; Self-REF trains for this | Partially — prompt-level, unreliable untrained |
| **Token log-probs / negentropy** | "mean token negentropy used as a primary signal" ([survey][survey]) | **NO** — verified: Gridlight talks to the gateway over a chat-completions API and never sees per-token probabilities |
| **Multi-judge agreement** | Escalate when judges disagree ([TMLS][tmls]) | Yes, but costs a second inference |
| **Conformal prediction** | CP-Router routes on calibrated output uncertainty ([survey][survey]) | Later; needs calibration data we do not have yet |

### The correction that reshapes this

My peer audited `packages/core` and established two things I had assumed wrongly.

**1. Confidence routing is not implementable here.** There is no logprob or entropy surface
at all. Most of the cascade literature defines the router's trigger as a confidence
threshold; **we cannot reproduce that trigger**. The honest framing is therefore
*escalate on **observed** trouble*, not *route on confidence*.

The practical difference: confidence routing escalates **before** wasting a turn;
behavioural routing escalates **after** one failed turn. On a 14B running locally that
wasted turn costs no money and a few seconds, so the trade is acceptable — but it is a real
departure from the papers and should not be papered over.

**2. Nine behavioural signals already exist**, computed today in `packages/core`, not
proposed work. The most valuable is **prose-instead-of-tool-call**
(`agentExecutor.ts:465`): the model narrates an edit instead of emitting a tool call. That
is the canonical failure mode of a code-specialised model out of its depth on structured
output, it is already a boolean, and it is high precision — it fires close to exactly when
a 14B is doing work it should not be doing.

Others: empty response, API retry count, tool-returned-error, step threw, error patterns in
tool output, `pendingQuestion` (model stalled and wants a human), plan-progress stall, and
terminal success.

### The gap none of them close

**All nine are liveness and format signals. None is a correctness signal.** A model can emit
well-formed tool calls, hit no retries, complete its plan, report success — and be subtly
wrong. Nothing in the list detects that.

This is the strongest argument in the whole document, and it is my peer's, not mine.

---

## 3. Which turns suit a 14B coder model

Local models are "effective for high-volume, lower-complexity tasks like summarization,
extraction, classification, and reformatting" ([Ewerlöf][ew], [Fowler][mf]). The
agentic-programming survey describes hierarchical systems where a **localization agent
grounds steps in concrete code** and a composition agent assembles them, with a supervisor
routing failures ([survey of agentic programming][agentic], [Sakura][sakura]).

That maps cleanly onto a coding loop:

**Suits Qwen2.5-Coder-14B (bounded, verifiable, single-context):**
- Reading and summarising files; answering "where is X defined"
- Localization — turning a task into the concrete files/symbols it touches
- Structured extraction (parse this output into JSON)
- Single-file, well-specified edits; mechanical refactors
- Running tests/lint and reporting results
- Drafting a diff that something else will verify

**Needs frontier (unbounded, cross-cutting, judgement):**
- Multi-file architecture and design trade-offs
- Root-cause reasoning across subsystems
- Deciding *what* the complete set is — the enumeration step of our own work standard
- Reviewing whether a fix is actually complete
- Anything where being subtly wrong is expensive and unverifiable

The pattern underneath: **local does the bounded and checkable, frontier does the
open-ended and the judging.** A 14B is not weak — it is weak *at unbounded context and
subtle cross-file reasoning*, which is exactly what frontier buys.

---

## 4. Recommendation for NeonCore

**Three layers, cheap to expensive, each blind where the next one sees.**

| Layer | Catches | Cost |
|---|---|---|
| 1. Escalate-on-trouble | Floundering — prose instead of tool calls, retries, stalls | One wasted local turn |
| 2. `testSuite` signal | Regressions the suite covers | Free — observed passively |
| 3. Scoped draft-then-verify | Quiet wrongness on high-stakes work | Frontier review, narrow class only |

Layer 2 is live: Gridlight now emits `signals.testSuite = 'green' | 'red' | 'unknown'`,
observed by correlating tool-call ids to results across npm/pnpm/yarn/bun, pytest, jest,
vitest, mocha, go, cargo, rspec, phpunit and `node --test`. No extra model call.

Three properties the router must respect:

- **`'unknown'` is not `'green'`.** A turn that edited code and never ran tests is a
  different risk from one that ran them and passed.
- **It is weighted separately from `escalationHint`**, deliberately. A red suite with no
  floundering persists as `escalation:none` + `testSuite: red`. Correctness and liveness
  must not share a threshold.
- **It is partial cover only.** It fires only when tests actually run, and sees only what
  the suite covers — thin-test repos stay invisible. It does **not** displace layer 3.

Reasoning, honestly stated:

1. We already have the strongest trouble signal in production — `stuck-detector.ts`
   detects consecutive tool failures today. We are not starting from zero.
2. Gridlight is first-party, so schema violations and confidence are directly observable
   rather than scraped. My peer's correction matters here: a router on *typed* signals is
   a different quality of thing from one on inferred ones.
3. Escalate-on-trouble covers *format and liveness* failure — the model visibly floundering.
   It cannot cover **silent correctness** failure, because no available signal sees it.
4. So draft-then-verify earns its double spend precisely where a wrong answer would look
   successful to all nine signals: **multi-file refactors, auth, migrations, anything where
   being subtly wrong is expensive and unverifiable**. There, frontier review is not
   redundancy, it is the only check that exists.
5. Cheaply, we already own part of the verification harness: the work standard requires a
   set-based test and pasted real output before anything is called done.

**The escalation ladder** — deliberately ordered so the cheap checks run first:

```
is this turn in the high-stakes class?   (multi-file / auth / migrations)
  ├─ YES → local drafts, frontier REVIEWS       (draft-then-verify; correctness cover)
  └─ NO  → local attempt
             └─ prose-instead-of-tool-call, OR empty response, OR 2+ tool errors on the
                same step, OR plan progress stalled, OR pendingQuestion
                  └─ escalate THIS TURN to frontier (not the whole task)
                       └─ frontier result re-enters the same loop
```

Note the ladder escalates a **turn**, not a task. Handing the whole job to frontier on the
first stumble discards the 80–90% of turns the local model handles fine.

**What I am NOT recommending**: routing by static task-type labels alone. Both the
taxonomy-routing paper and the cascade work point the same way — difficulty is not reliably
predictable from the request, which is why cascades observe an attempt before deciding.
Guessing up front is how you get a 14B silently doing architecture.

---

## 5. Resolved: the signals exist, the confidence trigger does not

This section previously asked whether `packages/core` could emit usable signals. **Answered
by the peer with file-level citations**: nine behavioural signals already exist, no
confidence surface exists. That resolves the question in favour of escalate-on-trouble
being implementable, while removing the trigger the literature assumes.

The one thing still to settle is who owns policy. Core offers a rolled-up
`escalationHint: 'none' | 'suspect' | 'failing'` alongside the raw signals. **My position:
emit both, but the router treats the raw signals as truth and the hint as a diagnostic
only.** Policy must live in exactly one place; a cached rollup that the router depends on
becomes a second policy that can silently drift from the first.

---

## Sources

- [Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey][survey]
- [Is Escalation Worth It? A Decision-Theoretic Characterization of LLM Cascades][esc]
- [RLM-Cascade: Response-Level Speculative Decoding][rlm]
- [Cluster, Route, Escalate: Cascaded Framework for Cost-Aware LLM Serving][cre]
- [SELECT-THEN-ROUTE: Taxonomy guided Routing for LLMs][str]
- [Model Routing and Cascades for LLM Cost — TMLS][tmls]
- [LLM Routing and Model Cascades — TianPan][tp]
- [AI Agentic Programming: A Survey of Techniques, Challenges, and Opportunities][agentic]
- [Using local LLMs for agentic coding — Alex Ewerlöf][ew]
- [Experiences with local models for coding — Martin Fowler][mf]
- [Sakura: Generating Complex Tests from Natural Language Descriptions][sakura]

[survey]: https://arxiv.org/html/2603.04445v2
[esc]: https://arxiv.org/html/2605.06350
[rlm]: https://arxiv.org/pdf/2606.22840
[cre]: https://arxiv.org/html/2606.27457
[str]: https://aclanthology.org/2025.emnlp-industry.28.pdf
[tmls]: https://www.tmls.nyc/research/model-routing-cascades
[tp]: https://tianpan.co/blog/2025-11-03-llm-routing-model-cascades
[agentic]: https://arxiv.org/html/2508.11126v1
[ew]: https://blog.alexewerlof.com/p/local-llms-for-agentic-coding
[mf]: https://martinfowler.com/articles/exploring-gen-ai/local-models-for-coding-experiences.html
[sakura]: https://arxiv.org/pdf/2606.00530
