# Gridlight + Claude + Codex: what we decided, and what we didn't

An account of the local-vs-frontier work, written to answer three questions directly:
what scenarios did we cover, how did we strategise it, and **did we actually explore when
to use one engine over another**.

Drafted by the gridlight-monorepo cartridge; sections 2 and 3 were contributed directly by
the neoncore cartridge, which owns the strategy analysis. Companion to
[research/local-vs-frontier.md](research/local-vs-frontier.md),
[plans/gridlight-integration.md](plans/gridlight-integration.md),
[plans/dual-runtime-routing.md](plans/dual-runtime-routing.md), and — in the peer repo —
`docs/neoncore-parity-gaps.md` and `docs/neoncore-cli-requirements.md`.

---

## 1. Short verdict

**Did we explore when to use one over the other? Yes — twice. And we missed one.**

We answered it at two levels:

- **Which kind of work suits a local 14B vs a frontier model** — a capability mapping
  (§2). This is a genuine capability *cliff*, not a preference.
- **Which engine should get a given turn, in the moment** — the escalation ladder:
  attempt locally, observe what happens, escalate that turn on trouble (§3).

**What we did not explore: Claude versus Codex.** We collapsed both into a single bucket
called "frontier" and never asked when one beats the other. This is worth stating bluntly
because the miss is not merely an omission in prose — `plans/gridlight-integration.md`
step 3 hardcodes `agentIdForRepoAndType(repoPath, 'claude')` as the escalation target. The
document does not fail to ask which frontier engine should get the escalated turn; it
**silently answers, in Claude's favour, with no stated reason**.

There is a real argument for having started with local-vs-frontier: that comparison is a
capability cliff (bounded versus unbounded reasoning), whereas Claude-vs-Codex is a much
flatter comparison between two frontier engines. That is a good reason to *start* there.
It is not a reason to *stop* there, and we never made stopping a decision — so it is a
gap, not a scoping choice.

Three further limits, stated up front rather than buried:

1. **We cannot yet measure any of this on your machine.** See R1 in §5.
2. **Nine of the ten signals measure liveness and format, not correctness.** Confidently
   wrong work scores clean.
3. **80–90% is imported from other people's practice, not observed on this machine.**

---

## 2. The decision rule: when to use which

*(neoncore cartridge's analysis, contributed directly)*

Two mechanisms, both load-bearing, neither sufficient alone.

**STATIC — decided before the turn starts.** Sets the prior *and* gates verification.

**DYNAMIC — decided during the turn.** Everything not in the high-stakes class starts
local and escalates only on *observed* trouble.

### Static: suits the local model (Qwen2.5-Coder-14B)

Bounded, verifiable, single-context work:

- Reading and summarising files; "where is X defined"
- **Localization** — turning a task into the concrete files and symbols it touches
- Structured extraction (parse this output into JSON)
- Single-file, well-specified edits; mechanical refactors
- Running tests and lint, reporting results
- Drafting a diff that something else will verify

### Static: needs frontier (Claude or Codex)

Unbounded, cross-cutting, judgement work:

- Multi-file architecture and design trade-offs
- Root-cause reasoning across subsystems
- **Deciding what the complete set is** — the enumeration step
- Reviewing whether a fix is actually complete
- Anything where being subtly wrong is expensive and unverifiable

### Static: the high-stakes class

Multi-file, auth, migrations: **local drafts, frontier reviews — regardless of how cleanly
the local turn went.** No trouble signal is required to trigger this, and that is the
point: the failure it covers is the one that produces no signals at all.

The pattern underneath, if you read one line: **local does the bounded and checkable,
frontier does the open-ended and the judging.** A 14B is not weak — it is weak at unbounded
context and subtle cross-file reasoning, which is exactly what frontier buys.

### What we rejected, and the nuance that matters

We rejected routing by static task labels **alone**. The literature is consistent that
difficulty is not reliably predictable from the request, which is why cascades observe an
attempt before deciding. Guessing up front is how a 14B ends up silently doing
architecture.

But "alone" is load-bearing, and it would be wrong to read the list above as decorative.
Static labels do two real jobs:

1. **They set the prior** — where a turn starts by default.
2. **They gate layer 3.** The escalation ladder's *first* branch is a static task-type
   judgement: *is this turn in the high-stakes class (multi-file / auth / migrations)?*
   Without that label, "scoped draft-then-verify" has no scope and collapses into blanket
   draft-then-verify, which doubles spend on everything.

So both mechanisms are used: labels choose the starting point and the verification class,
observation decides escalation within it. Neither is sufficient alone.

---

## 3. The strategy: three layers

*(neoncore cartridge's analysis, contributed directly)*

Each layer is blind where the next one sees.

| Layer | Catches | Cost |
|---|---|---|
| 1. Escalate-on-trouble | Floundering — prose instead of tool calls, retries, stalls | One wasted local turn |
| 2. `testSuite` signal | Regressions the suite covers | Free — observed passively |
| 3. Scoped draft-then-verify | Quiet wrongness on high-stakes work | Frontier review, narrow class only |

**Why three and not one.** Layer 1 sees a model visibly failing. It cannot see a model
succeeding at the wrong thing. Layer 2 catches that cheaply *when tests exist and get
run*, which is why it does not replace layer 3. Layer 3 is the only check that sees
confidently-wrong work, and it costs a frontier call on every item — so it is scoped to
the class where being subtly wrong is expensive and unverifiable.

**Three properties of layer 2 the router must respect:**

- **`'unknown'` is not `'green'`.** A turn that edited code and never ran tests is its own
  risk, distinct from one that ran them and passed.
- **It is weighted separately from `escalationHint`**, so correctness and liveness never
  share a threshold. A model can flounder its way to a green suite, and glide confidently
  to a red one.
- **It is partial cover by construction.** Thin-test repos stay invisible. It does not
  displace layer 3.

**The escalation ladder:**

```
is this turn in the high-stakes class?   (multi-file / auth / migrations)
  ├─ YES → local drafts, frontier REVIEWS       (draft-then-verify; correctness cover)
  └─ NO  → local attempt
             └─ prose-instead-of-tool-call, OR empty response, OR 2+ tool errors on the
                same step, OR pendingQuestion
                OR plan progress stalled  ← requires the router to track turn history;
                                            NOT emitted as a signal (see below)
                  └─ escalate THIS TURN to frontier (not the whole task)
                       └─ frontier result re-enters the same loop
```

> **Read this before implementing the ladder.** It is the design, and it does not exist
> end to end today:
>
> - **The escalation action is unbuilt.** "Escalate THIS TURN, not the whole task" is the
>   design's central efficiency claim, and today only **session-level handoff** exists —
>   stop the gridlight cartridge, dispatch the task elsewhere. Keeping the local session
>   alive and splicing a frontier result back into its plan needs a re-entrant path in
>   `TaskPlanner` that has not been written (§6).
> - **One trigger has no producer.** `progress {completed, total, percent}` is emitted once
>   per turn, but a *stall* means "percent not advancing across N turns" — cross-turn state
>   nothing holds. Four of the five triggers are single-turn booleans an implementer can
>   wire directly; this one silently requires building turn-history tracking first. It is
>   still the right signal — it is just not free, and the difference matters when scoping.
> - **The ladder is ROUTER policy; `rollup()` is the ENGINE's cheap local opinion.** They
>   deliberately disagree. `rollup()` grades in two tiers — `failing` for
>   prose-instead-of-tool-call, empty response, step threw, terminal failure; `suspect` for
>   pendingQuestion, repeated API retries, 2+ tool errors, error patterns in output — while
>   the ladder treats its triggers as one escalate-now set. That is not a contradiction:
>   the agreed contract is that **the router consumes the raw signals as truth and treats
>   the hint as a diagnostic**, so the router is free to disagree with the rollup. Policy
>   must live in exactly one place, and that place is the router.

The ladder escalates a **turn**, not a task. Handing the whole job to frontier on the
first stumble discards the majority of turns the local model handles fine — which is
precisely why the unbuilt escalation action above matters rather than being a detail.

**One trigger deserves singling out.** *Prose-instead-of-tool-call* — the model narrating
an edit rather than emitting a tool call — is the canonical failure of a code-specialised
model out of its depth on structured output. It is already a boolean in the engine, and it
fires close to exactly when a 14B is attempting work it should not be.

**The trigger we cannot use.** Most cascade literature routes on a *confidence threshold*
(log-probs, entropy). Gridlight talks to the gateway over a chat-completions-shaped API and
never sees per-token probabilities. So our escalation is **behavioural, not predictive**:
we escalate *after* one failed turn rather than *before* wasting it. On a local 14B that
wasted turn costs no money and a few seconds, which is why the trade is acceptable — but it
is a real departure from the papers and should not be papered over.

---

## 4. The scenarios, concretely

### A. Gridlight alone

Local-only. Good for the bounded list in §2 — exploration, localization, summarising,
mechanical edits, running tests. Watch for: it will attempt architecture if you ask it to,
and nothing stops it. The permission gate is what bounds blast radius when it runs
unattended.

### B. Gridlight + Claude — **the recommended starting configuration**

Local drafts, frontier reviews. This is **available today with no new code**:
`workflow-executor-v2.ts` already implements `review-gate` / `quality-gate` with
`maxRetries` and `lastFeedback`. Setting `executorConfig.agentType` on a step pins it to a
cartridge via `agentIdForRepoAndType()` (`server/src/routes/workflows.ts`), so running the
work step on `gridlight` and the review gate on `claude` is a workflow-template change, not
a feature.

Its quality floor is roughly frontier-review quality regardless of how poor the draft was,
which makes it the safe baseline to run *while* the router is still unbuilt.

> **Precondition, and a silent failure mode — read before relying on this.**
>
> Pinning resolves against **live cartridges, not config**. It requires a **live gridlight
> cartridge running in that repo** at launch.
>
> When it cannot resolve, **it fails silently**. In `server/src/routes/workflows.ts`, a
> missing repo hits a bare `continue`, and no matching cartridge only emits a
> `console.warn` — *"no live gridlight cartridge in {repo} — start one"*. Neither path
> fails the launch, and `executor_id` is left exactly as it was, so the step runs on
> whatever agent was already assigned.
>
> The consequence is the reason this is a warning and not a footnote: **you can follow this
> recommendation, have no gridlight cartridge running, watch the workflow complete
> successfully, and conclude local-first is working — while every step ran on frontier.**
> That is worse than the feature not existing, because it manufactures false evidence for
> the strategy.
>
> This is an instance of a defect class that recurred throughout this work rather than an
> isolated caveat: **the operation reports success while doing something other than what
> was asked.** The transcript endpoint filing Gridlight messages under Claude, and
> `/api/activity` accepting and discarding unknown keys, are the same shape. All three
> return success. Check that a gridlight cartridge is live before trusting the result.

### C. Gridlight + Codex

Mechanically identical to B — same review-gate, different reviewer. And this is exactly
where the §1 gap bites: **we never established when Codex is the better reviewer than
Claude.** Until someone does, treat the choice as unsettled rather than inheriting the
hardcoded `'claude'` default as if it were a finding.

### D. All three at once

The user's actual question, and the answer has two halves.

**Attribution is solved.** All three register as distinct cartridges on the same repo,
report transcripts under their own engine identity, and can message each other. Gridlight
reached parity in commit `e8917ad` (see §5). One sharp edge worth knowing: attribution is
*not* uniformly keyed — `/api/agents/transcript` keys on `engine`, not `agentType`, and
NeonCore's MCP server defaults `NEONCORE_AGENT_TYPE` to `'codex'`. Both are silent
wrong-answer failures rather than errors, and both are pinned by tests now.

**File collisions are the real constraint.** Three engines editing one working tree will
clobber each other. This is not theoretical — it is the failure mode you should expect.
NeonCore already has the answer: workflow steps support per-step git worktrees
(`workflow-executor-v2.ts:99` `executorConfig?._worktreePath`, `:1254`
`ensureStepWorktree()`). Route the three engines into separate worktrees, or give them
disjoint file ownership — which is how the two cartridges that produced this document
avoided colliding.

---

## 5. Shipped vs planned vs blocked

Every claim here cites a file or a commit.

### Shipped — Gridlight CLI is a first-class cartridge (`e8917ad`)

Parity went **1/11 → 11/11** against a contract transcribed from NeonCore's own
claude/codex implementation. Before: NeonCore could launch `gridlight` and type into it,
but the session was invisible — no agent row, no transcript, no approval path, no way to
reach a peer.

| Now working | Where |
|---|---|
| Registration, activity, transcript, session-end, plan-executed, completion-check | `packages/core/src/neoncore/reporter.ts` |
| Ten routing signals incl. `testSuite` correctness signal | `packages/core/src/neoncore/signals.ts` |
| Confer participation — 10 MCP tools reachable | `packages/cli/src/host/mcpConfig.ts` |
| Permission gate — the containment boundary for unattended local work | `packages/cli/src/host/neoncoreGate.ts` |

Verified: 6 tests passing, contract 11/11, and a live `gridlight -p` run that registered a
cartridge, emitted signals, and went offline cleanly.

### Planned, not built

- **The router itself** — nothing yet decides which engine gets a turn.
  `agentIdForRepoAndType()` is the routing *primitive*, called with a type the caller
  already chose. Proposed home: `server/src/lib/engine-router.ts`.
- **Engine capability registry** — `AgentType` is a bare string union; nothing records that
  `gridlight` is a cheap local 14B and `claude` is expensive frontier.
- **Policy settings** — thresholds are constants, so they cannot be tuned against real
  behaviour.

### Blocked — R1, and it matters more than it sounds

**The gateway does not echo which model actually served a turn.** The client sends a model
preference and never reads back what answered. Per project convention the model defaults to
`""` so the gateway decides routing — which means in the default configuration, telemetry
cannot distinguish a local 14B turn from a frontier one.

Consequence: **"80–90% of turns stayed local" is unverifiable here.** Any claim about how
much the strategy saves is, today, borrowed rather than measured.

There is a second route to that number that does **not** need the gateway fix:
`plans/dual-runtime-routing.md` (2026-07-03) scopes a parity eval that measures local
capability *offline*, per capability class. Anyone starting implementation should read that
document first — it reached "verify-and-fallback first" independently four months earlier,
and already named `green-score-ships-bad-code` as its top risk, which is the same
correctness gap restated in §3.

---

## 6. What we did not cover

Deliberately generous, because §1's question deserves the absences as much as the answers.

- **Claude vs Codex.** The headline gap. Not asked, and silently answered in code.
- **Cost and latency per turn — and it is worse for the engine that matters most.** The
  entire premise is that local is cheap and frontier is expensive, and we measured neither.
  Token usage has a home (`session_usage`), so for **Claude and Codex** this is plumbing.
  For **Gridlight it is genuinely absent**: a local model's real cost is wall-clock and
  watts on your own machine, and there is no per-turn latency column anywhere. So "local is
  cheap" — the load-bearing premise of the whole strategy — is unmeasured for the one
  engine it is a claim about.
- **Thin-test repos.** Layer 2 fires only when tests run and sees only what the suite
  covers. In a repo with weak tests, the correctness layer is close to blind and we did not
  quantify how blind.
- **Step-level escalation.** The ladder escalates a turn; today only *session-level*
  handoff exists (stop the gridlight cartridge, dispatch to another). Keeping the local
  session alive and splicing a frontier result back into its plan needs a re-entrant path
  in `TaskPlanner` that does not exist.
- **Whether the local model is worth it at all.** We assumed a 14B earns its place. The
  parity eval in `plans/dual-runtime-routing.md` was designed to test exactly that
  assumption, and we did not run it.
  **The boundary on this one matters**: the three-layer design is deliberately robust to
  the answer. If the eval finds the 14B does not earn its place on some class of work, the
  response is to **narrow the static prior in §2** — not to redesign the strategy. Layers 2
  and 3 are unaffected either way. So "we did not validate an input" is true; "the
  conclusion may be wrong" is not.
- **The three neoncore-side defects** found along the way — transcript attribution keyed on
  `engine`, `/api/activity` silently discarding unknown top-level keys, and the removal of
  gemini/amazonq/cursor — are scoped and queued, not done.

---

## 7. If you only do one thing

Run **scenario B** — Gridlight drafting, Claude reviewing through the existing
`review-gate`. It needs no new code, it gives you local-first work immediately, and its
quality floor is frontier-review quality. It is the safe baseline to run while the router
is still a plan.

**Two conditions, because this step can lie to you.** Start a **live gridlight cartridge in
the repo first** — pinning resolves against running cartridges, not config. And **check the
server log afterwards**: if no gridlight cartridge was live, the pin is skipped with only a
`console.warn` and the step runs on whatever agent was already assigned, while the workflow
still reports success. A green run is not by itself evidence that anything ran locally
(§4D, §4B).

Then read `plans/dual-runtime-routing.md` before anyone writes routing code, because its
offline parity eval answers the measurement question that R1 currently blocks.
