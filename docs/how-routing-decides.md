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

It runs in exactly one place: `server/src/routes/workflows.ts:836`, when a workflow step is
dispatched.

1. **What is this step?** `executor_type` on the step IS the function id — `read_file`,
   `review-gate`, `git_commit` (`workflows.ts:829`). No guessing.
2. **Which model would run it?** Read from the live cartridge in that repo
   (`workflows.ts:832`). A cartridge that is offline yields no model.
3. **What can that model do?** `loadProfile(modelId)` fetches the measured capability vector.
   Never measured → no profile.
4. **Decide.** `routeFunction()` compares the vector against the bar for that function's tier.
5. **Act.** If the answer is cloud, the step's engine is rewritten to `claude` and the reason is
   recorded in `routing_note` so you can see why (`workflows.ts:838-841`).

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

| tier | local | bar it had to clear | what happened |
|---|---|---|---|
| T0 | **1 / 1** | *(none)* | No bar, so no evidence needed |
| T1-READ | **14 / 14** | toolCall ≥ 0.60 | Measured 1.00 — clears easily |
| T1-WRITE | 0 / 3 | safeEdit ≥ 0.80 | Measured 0.70 — **fails the bar** |
| T2 | 0 / 6 | comprehension ≥ 0.60 | Measured 0.00 — fails |
| T5 | 0 / 10 | judgement ≥ 0.70 | Measured 0.00 — fails |
| T3 | 0 / 2 | synthesis ≥ 0.60 | **Not enough evidence** |
| T4 | 0 / 8 | synthesis ≥ 0.50, planning ≥ 0.60 | **Not enough evidence** |

The 15 that run locally: `read_file`, `list_files`, `search_code`, `git_status`, `git_diff`,
`web_search`, `web_fetch`, `connector`, `command`, and the six `neoncore_*` coordination tools.

**Fourteen of those fifteen are T1-READ. The fifteenth is `command`, at T0.** That is the
one-sentence answer, visible in the data.

---

## The distinction that matters most: "no" versus "we don't know"

Ten of the 44 are **INCONCLUSIVE**, not INELIGIBLE. That means the trials were too few to
certify either way (`MIN_TRIALS = 8`, `engine-capability.ts:115`), and the router sends anything
undecided to the cloud.

So roughly a quarter of the map is on the cloud **for want of measurement, not for want of
capability.** More probe trials would move some of them. `synthesis` measured 0.60 — exactly the
T3 bar — but with too much statistical uncertainty around it to call, so it stays undecided
rather than being rounded in either direction.

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
- **The comparison is asymmetric.** We measured the local model against **absolute** bars. Claude
  and Codex have never been measured on the same probes. So every "cloud" decision means *"local
  did not clear the bar"* — **not** *"cloud is better at this."* For something like `read_file`
  they may be identical, which would make some cloud routing pure cost. Measuring both is in
  progress; until it finishes, that asymmetry is an open gap, not a settled result.
- **Demotion has never fired on real traffic.** The system can record that a function keeps
  failing and stop routing it locally. That machinery is wired and proven reachable, but no live
  demotion has ever been recorded — the threshold has not been crossed.
- **One model has ever been measured.** Everything above describes `qwen2.5-coder-14b`. A
  different local model would need its own probe run.
- **The probe never reports to NeonCore, by design.** `probe-local-model.mjs:184` disables
  reporting. So capability scores and live demotions are two separate evidence streams that
  never touch: the profile comes from probes, demotions from real traffic, and neither
  validates the other.
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
- **Adjust a tier bar** (`engine-capability.ts:133-139`) — this is a policy decision about
  acceptable risk, not a measurement. Lowering `safeEdit` to 0.70 would move all three T1-WRITE
  functions local, on a model measured to get one edit in three wrong.
