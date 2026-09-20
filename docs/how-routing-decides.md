# How NeonCore decides: local model or cloud

Every claim here is either a `file:line` or a number computed from the live database through
the real router. Nothing is from design intent — this describes what runs, not what was
planned. Where we do not know something, it says so.

---

## The short answer

**The local model gets everything that READS. The cloud gets everything that WRITES or JUDGES.**

Nobody wrote that rule. It falls out of two measured zeros meeting the capability bars, and it
would change if the model were re-measured.

Right now, of 44 known functions: **15 local, 29 cloud.**

---

## The decision, in the order it actually executes

It runs in exactly one place: `server/src/routes/workflows.ts:849`, when a workflow step is
dispatched.

1. **What is this step?** `executor_type` on the step IS the function id — `read_file`,
   `review-gate`, `git_commit` (`workflows.ts:853`). No guessing.
2. **Which model would run it?** Read from the live cartridge in that repo
   (`workflows.ts:859`). A cartridge that is offline yields no model.
3. **What can that model do?** `loadProfile(modelId)` fetches the measured capability vector.
   Never measured → no profile.
4. **Decide.** `routeFunction()` compares the vector against the bar for that function's tier.
5. **Act.** If the answer is cloud, the step's engine is rewritten to `claude` and the reason is
   recorded in `routing_note` so you can see why (`workflows.ts:875-876`).

---

## What the local model was measured at

`qwen2.5-coder-14b`, measured 2026-07-31, 10 trials per dimension:

| dimension | score |
|---|---|
| toolCall | 1.00 |
| instructionAdherence | 1.00 |
| planning | 0.90 |
| safeEdit | 0.70 |
| synthesis | 0.60 |
| comprehension | **0.00** |
| judgement | **0.00** |

These are not opinions. Each is a pass-rate over real turns run through the Gridlight CLI,
scored on the filesystem end state — did the file actually end up correct.

**This is not a scoreboard, and only six of the seven route anything.** `instructionAdherence`
is measured but consulted by no bar and no latency check. It is a *confound control*: a failed
trial is ambiguous between "could not do it" and "did the work and stopped short of the final
action", so every other rate is really a lower bound — and `instructionAdherence` measures that
non-completion directly (`probe-local-model.mjs:285-287`). Its scoring 1.00 is what licenses
reading the two zeros below as genuine capability failures rather than as the model quietly
giving up. Its consumer is the person reading the profile, not the router.

One caveat on how they are counted: a trial that times out at the 180-second wall clock is
scored the same as a wrong answer (`probe-local-model.mjs:265-266`), so a pass rate blends
capability with latency. It did **not** distort the two zeros above — comprehension was 0/10
with only 1 timeout, meaning 9 outright failures, and judgement was 0/10 with none. Those
zeros are real. But the rule matters for any future dimension that lands near its bar, and
especially for comparing a local model against hosted ones on a shared clock.

---

## Why each group landed where it did

Functions are grouped into tiers, and each tier has a bar
(`server/src/lib/engine-capability.ts:133-139`). The gate every tier shares is
`toolCall ≥ 0.60` — can the model emit a tool call our harness can execute at all.

| tier | local | bar | the router's actual reason |
|---|---|---|---|
| T0 | **1 / 1** | *(none)* | `T0: no model call — heuristic, always local` |
| T1-READ | **14 / 14** | toolCall ≥ 0.60 | `T1-READ bar cleared` (measured 1.00) |
| T1-WRITE | 0 / 3 | safeEdit ≥ 0.80 | `safeEdit=0.7 < 0.8` |
| T2 | 0 / 6 | comprehension ≥ 0.60 | `comprehension=0 (N=10), 95% upper bound 0.28 < 0.6` |
| T5 | 0 / 10 | judgement ≥ 0.70 | `judgement=0 (N=10), 95% upper bound 0.28 < 0.7` |
| T3 | 0 / 2 | synthesis ≥ 0.60 | `synthesis=0.6 (N=10) but 95% lower bound 0.31 < 0.6` |
| T4 | 0 / 8 | synthesis ≥ 0.50, planning ≥ 0.60 | `synthesis 0.6 … lower bound 0.31 < 0.5, planning 0.9 … lower bound 0.6 < 0.6` |

Those are the router's own strings, not a paraphrase — and they show something the raw scores
hide: **the decision is made on statistical bounds, not on the measured average.**

- To rule a function OUT, the *optimistic* end of the range must still miss the bar. Comprehension
  measured 0.00, and even its 95% upper bound is 0.28 — far under 0.60. That is a strong "no".
- To rule one IN, the *pessimistic* end must still clear the bar. Synthesis measured exactly
  0.60, but with 10 trials the true value could plausibly be as low as 0.31, so it is not
  certified.
- T1-WRITE is the exception: 0.70 against a 0.80 bar fails on the plain number, no bound needed.

**And that exception is a real asymmetry worth knowing.** A score *below* the bar is treated as
conclusive on the point estimate alone; a score *above* the bar is not — it still has to clear on
the pessimistic bound. Two real rows show it side by side:

    safeEdit 0.70 vs bar 0.80  -> INELIGIBLE     (yet the interval [0.397, 0.892] contains 0.80)
    planning 0.90 vs bar 0.60  -> INCONCLUSIVE   (a 0.90 score, still not certified)

The model might genuinely be at 0.85 on safeEdit; ten trials cannot tell. The router reports that
as a definitive no while reporting 0.90 as undecided. That is a deliberate bias toward the cloud —
the safe direction for something that must not ship unverified writes — but it means **INELIGIBLE
sometimes means "below the line on ten samples", not "provably cannot"**.

Two gates sit *before* the bars and can override any of this, so capability is necessary rather
than sufficient:

- **A runtime demotion** (`engine-router.ts:96`) returns INELIGIBLE before a bar is ever read — if
  a function keeps failing in real use, it stops going local regardless of its measured score.
- **Latency** (`engine-router.ts:122`): an interactive function whose measured turn time exceeds
  30s is INELIGIBLE however capable it is. Qwen's medians are 8.7–14.2s so this does not fire
  today — but on slower hardware or a larger local model, a function that clears every capability
  bar can still go to the cloud, and the tier table alone would not explain why.

The 15 that run locally: `read_file`, `list_files`, `search_code`, `git_status`, `git_diff`,
`web_search`, `web_fetch`, `connector`, `command`, and the six `neoncore_*` coordination tools.

**Fourteen of those fifteen are T1-READ. The fifteenth is `command`, at T0.** That is the
one-sentence answer, visible in the data.

---

## The distinction that matters most: "no" versus "we don't know"

Ten of the 44 are **INCONCLUSIVE**, not INELIGIBLE — and the router sends anything undecided to
the cloud.

It is worth being precise about why, because the obvious explanation is wrong. It is **not**
that there were too few trials to bother: 10 trials were run, above the `MIN_TRIALS = 8` floor
(`engine-capability.ts:115`). It is that the confidence interval around the result **straddles
the bar**. `synthesis` measured 0.60 against a 0.60 bar — dead level — and with 10 trials the
true rate could plausibly be anywhere from about 0.31 upward. Landing exactly on a bar is the
least decidable place to land.

So roughly a quarter of the map is on the cloud **for want of certainty, not for want of
capability** — a different fact from "the local model cannot do it", and an actionable one:
more trials narrow the interval, and some of these would resolve to yes.

---

## What this does NOT decide

This is the part most likely to differ from your mental model.

- **It only applies to workflow steps.** `routeFunction` has one dispatch call site. A plain
  prompt sent to a cartridge never consults it. If you type at Gridlight directly, Gridlight
  answers — no routing happens.
- **With the cartridge offline, the map is not the map.** Step 2 requires a cartridge whose
  status is not `offline`. With none, there is no model id, no profile, and **43 of 44 go to the
  cloud as UNMEASURED** — only `command` stays local, because a T0 function has no bar to fail.
  The system fails safe, but the 15/29 split describes the *configured* state, not necessarily
  this second's behaviour.
- **The comparison is asymmetric, and this is the biggest open gap.** We measured the local model
  against **absolute** bars. Claude and Codex have never been measured on the same probes. So
  every "cloud" decision means *"local did not clear the bar"* — **not** *"cloud is better at
  this."* For something like `read_file` they may be identical, which would make some cloud
  routing pure cost.

  We tried to close it and could not. The probe was generalised to run any engine on the same
  seeds and the same pass predicate, but driving `claude -p` and `codex exec` headlessly from
  this environment did not work: a single foreground trial that had earlier passed in 74s later
  timed out at 200s with an execution error, and a background run produced no completed trial in
  six minutes. Since a timeout scores identically to a wrong answer, continuing would have
  produced a confident and false "cloud fails everything". **No frontier numbers are reported
  here because none were honestly obtained.** The harness is in place
  (`probe-local-model.mjs --engine`); it needs an environment where those CLIs run reliably
  unattended.
- **Demotion has never fired on real traffic.** The system can record that a function keeps
  failing and stop routing it locally. That machinery is wired and proven reachable, but no live
  demotion has ever been recorded — the threshold has not been crossed.
- **One model has ever been measured.** Everything above describes `qwen2.5-coder-14b`. A
  different local model would need its own probe run.
- **Capability scores and live demotions never touch.** The local engine is launched with
  NeonCore reporting explicitly disabled (`probe-local-model.mjs:56`); the cloud engines never
  had it, because they do not carry our reporter at all. Different mechanisms, same consequence:
  the profile comes from probes, demotions come from real traffic, and neither validates the
  other.
- **The probe only sees the end result.** It scores the filesystem after the turn. It cannot
  see how many attempts it took, whether the model floundered and recovered, what it cost, or
  whether a correct answer was reasoned or lucky. A model that thrashes for eight turns and
  lands correct scores the same as one that gets it first try.
- **There is no confidence signal anywhere.** Gridlight talks to the gateway over a
  chat-completions-style API and never sees token probabilities. So NeonCore cannot predict a
  bad turn — it can only observe one that already happened. Escalation therefore always costs
  one wasted local turn. On a 14B running locally that is seconds and no money, which is why
  the design accepts it.
- **The router never sees prompt shape.** Live turns showed the same model using a tool
  correctly on a directly-worded prompt and producing prose instead of a tool call on a vaguer
  one. The capability vector has no axis for that, so two requests for the same function can
  behave differently with nothing in the profile able to explain why.

---

## How to change what runs locally

- **Re-probe with more trials** — moves INCONCLUSIVE functions to a real yes or no.
- **Re-probe after changing the model** — a profile is replaced wholesale, and saving one clears
  that model's accumulated demotions, so the map is never a ratchet.

  **Know the cost before you do it.** Saving a profile runs
  `DELETE FROM engine_demotions WHERE model_id = ?` (`engine-store.ts:35,69`) — *all* functions,
  not only the ones you re-measured. So re-probing to resolve the ten undecided functions also
  erases every demotion earned from real use on the other 34, including the only one this system
  has ever recorded from live traffic. Record anything you care about first.
- **Adjust a tier bar** (`engine-capability.ts:133-139`) — a policy decision about acceptable
  risk, not a measurement. **But on its own it will not move anything**, and this is the least
  obvious thing in this document.

  `safeEdit` measured 7/10 = 0.70, giving a 95% interval of **[0.397, 0.892]**. Drop the bar
  from 0.80 to 0.70 and the verdict changes from INELIGIBLE to *INCONCLUSIVE* — which still
  routes to the cloud. The same is true at 0.60, 0.50 and 0.40. The knob moves the reason text
  and nothing else, with no error to tell you.

  What actually moves it is **more trials**. At a true rate of 0.70 against a 0.60 bar:

  | trials | 95% lower bound | verdict |
  |---|---|---|
  | 10 | 0.397 | inconclusive |
  | 25 | 0.524 | inconclusive |
  | 50 | 0.562 | inconclusive |
  | **100** | **0.604** | **clears** |

  So the real recipe for local writes is *roughly 100 trials **and** a bar at or below 0.60* —
  not a bar change alone.
