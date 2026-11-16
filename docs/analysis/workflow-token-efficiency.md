# Workflow efficiency: what a query costs, step by step

First-pass analysis of how NeonCore turns a query into prompts, what it does with each answer, and
where the tokens and the time go, across all 30 seeded templates.

Every number below was **measured on the real engine** with the workflow test harness
(`sandbox/workflow-test`): the real seeder, launch route, executor, webhook and confer conductor,
with simulated cartridges. Each prompt is the exact text the engine typed into a cartridge. To
re-measure after any change:

```bash
npm run workflow:test -- --all "Add self-serve refunds for orders under \$200" --profile     # catalogue table
npm run workflow:test -- "Bug Investigation" "…" --profile                                # one workflow, per dispatch
npm run workflow:test -- "Epic: Task by Task" "…" --profile --tasks 20                    # loops at a realistic size
```

Profile conditions, chosen so the numbers do not understate a real install:
- **Typical context:** a goal filled in the way the Goals page asks for one, which produces a 1,689-char
  brief including memory, and five agent-memory entries. `--context bare` removes both.
- **Realistic replies:** about 1,500 chars per step. The code's own notes record that 45% of real stored results
  ran longer. `--reply-chars 5000` was used as a check.
- **Tokens:** approximated as chars ÷ 4.

One structural fact shapes everything else: **all steps of a run are typed into the same live
agent session.** The relay pastes each step into the cartridge's terminal, and nothing clears the
session between steps. Every prompt and every answer stays in that conversation and is re-read on
every later model call.

## Status — third pass: all eight recommendations implemented

Same method and baseline as the second pass (`npm run workflow:test`, baseline stored before any change):

| | Baseline | Second pass | Now | Change vs baseline |
|---|--:|--:|--:|--:|
| Prompt characters, all 30 templates | 1,673,796 | 914,474 | 886,264 (≈222k tokens) | **−47.1%** |
| Dispatches | 281 | 272 | 260 | 12 fewer Work Standard Checks (content templates) |
| Waiting on the executor poll | 1,452s | 0s | 0s | **−100%** |
| Earlier prompts and reports in context at step starts (lower bound) | 2.61M tokens | 1.58M tokens | 0.93M tokens | **−64.4%** |
| Templates passing | 30/30 | 30/30 | 30/30 | — |

Loops at 20 tasks, against the first-pass table below:

| Template | Prompt tokens | Re-read ≥ | Fresh sessions |
|---|--:|--:|--:|
| Epic: Task by Task | 43k → 16k (−63%) | 596k → 105k (**−82%**) | 2 |
| CE Develop and Optimize | 60k → 19k (−69%) | 801k → 124k (**−85%**) | 2 |
| Epic: Two Repos | 89k → 31k (−66%) | 2.2M → 220k (**−90%**) | 4 |

CE: Full Delivery: re-read 663k → 98k tokens (−85%) against the second pass, for +6% prompt text
(105,884 → 112,428 chars). Its six phase boundaries each re-send the full context once.

What changed in this pass (details in WORKFLOWS.md):

4. **A fresh session per phase** (`workflow-executor-v2.ts`, "A fresh session per phase"). A step
   marked `freshSession: true`, which CE: Full Delivery sets on the first step of phases 2–7, or any
   step once the run has typed 10 prompts into one session, is sent into a new session. NeonCore types
   `/clear`, waits for Claude's `SessionEnd` with reason `clear`, then sends the step in full. The
   threshold equals the ledger's refresh backstop. At that point the full context would have been
   re-sent into the old session anyway, so clearing costs no extra prompt text (measured: the 20-task
   epics send the same characters as without clears). At 15 the re-read cut was smaller, and
   Two Repos paid +5% characters.
   - **Found while testing it live:** a step's completion arrives *inside* the agent's turn
     (`report_step_done` is a tool call), so the first version typed `/clear` into a busy cartridge.
     The simulated CLI, like Claude Code, queued it and sent it to the model as a plain message.
     `/clear` now waits for the turn to end: the Stop hook's completion check allowing the stop.
     If the turn does not end within 60s, there is no fresh session. It is also not typed when the
     turn ended on a question to the user.
   - Skipped for Codex and Gridlight, for a gate retry or routed redo, before the run has put
     anything in the session, and for a step with `freshSession: false`.
   - `SessionEnd` with reason `clear` no longer marks the cartridge offline or offers to resume it.
     That was already wrong when a user typed `/clear`.
7. **Template hygiene.**
   - The **Work Standard Check now runs after the work and before the trailing connectors**
     (work → check → Capture Learnings / Save / Notify → report). Before, it audited Notify's 87-char
     output, after "Done" had been announced. Each affected run pays a few hundred characters more,
     because the check now sees the actual work.
   - **Opt-out:** templates that change no code (`NO_STANDARD_GATE_TEMPLATES`: the digests, Deep
     Research, Product Strategy, Architecture Review, Release Documentation, Jira Tasks Validation,
     the two Gridlight QA runs, and CE Phases 1, 2 and 7) launch without it: 12 fewer dispatches per
     catalogue pass. `skipStandardGate` on `/v2/create` is now stored (`workflows.standard_gate`).
     Before, the launch added the check back on every run.
   - **Consistent launch paths:** scheduled and decomposed runs (`cloneTemplateAsRun`) get exactly
     the steps a Run-button launch gets. A test compares the two for every template.
   - **Report spec scaled to run size:** a run with at most 3 agent steps gets the compact spec
     (949 chars instead of 1,676). It asks for the same fields and the same single delivery, and both
     are held to every field the dashboard reads.
   - *Not done:* collapsing connector chains. With immediate advance a chain costs 0s and no
     dispatch, so collapsing it would save nothing measurable, and each connector stays visible and
     individually configurable on the canvas.

Also in this pass, from the follow-up questions:

- **Confer participants talking to each other.** A `neoncore_message_agent` message used to arrive as
  if the user had typed it: no sender, wrapped in the goal brief and work standard, replacing the
  recipient's objective. It now arrives marked as a message from a peer agent, with no wrappers, and
  a late comment re-opens a milestone the recipient had already signalled done. Chatty scenario: Confer
  116,798 → 107,897 chars, Epic: Confer Across Repos 133,048 → 125,880. Peer messages 24,220 →
  15,090 chars.
- **Crash recovery** (live power cut in the sandbox, server and runner killed mid-step). Fixed:
  native relaunch failed with "no runner is registered"; a resumed cartridge sat idle without
  continuing its step; a transcript replay sent bare session references into a session that had
  never seen them. After the fixes, the run completed about 3.5 minutes after the crash.

## Status — second pass: recommendations 1, 2, 3, 5, 6 and 8 implemented

Measured with `npm run workflow:test` against the baseline stored **before** any change
(`sandbox/workflow-test/baseline.json`: the same query, reply size, goal and memory for every run):

| | Baseline | Now | Change |
|---|--:|--:|--:|
| Prompt characters, all 30 templates | 1,673,796 (≈418k tokens) | 915,248 (≈229k tokens) | **−45.3%** |
| Waiting on the executor poll | 1,452s (242 polls) | 0s | **−100%** |
| Earlier prompts and reports in context at step starts (lower bound) | 2.61M tokens | 1.58M tokens | **−39.5%** |
| Templates passing | 30/30 | 30/30 | — |

Loops at a realistic 20 tasks: Epic: Task by Task −63% prompt characters (re-read −54%),
CE Develop and Optimize −68% (−61%), Epic: Two Repos −65% (−57%).

What changed (details in WORKFLOWS.md, *How a step is sent*):

1. **One step per cartridge.** A step waits while its cartridge has another step running, in
   any run, or has an open question or permission prompt. "Parallel" stages on one cartridge
   no longer merge into one message. Verified live: CE: Phase 2 now completes all 8 steps,
   where before it left 2 hanging.
2. **Session-aware prompts** (`server/src/lib/session-ledger.ts`). The goal brief, memory, completion
   contract, persona and work-standard block go into a session in full once. Later prompts
   carry a one-line reference. A result the session reported itself, or was already sent, is
   referred to by its hand-off and first line. Every reference names a fetch path that returns
   the full text. Full prompts come back on a new session, a reported compaction (the reporter
   now forwards it), every 10 prompts as a backstop, and always for Codex and Gridlight. A
   reference is only used when it is shorter than what it replaces.
3. **Loops and gate retries** refer to the instructions the session already has, instead of
   re-sending them.
5. **Immediate advance.** An accepted completion, decision, advance, launch, confer milestone or
   finished connector triggers an executor pass at once. The 12s poll is now only the backstop.
6. **Confer.** The work-standard block goes once per session, and the overall task goes on
   milestone 1 only. "Read the Epic" runs on one cartridge (`conferFill: 'single'`).
   *Deviation:* the verify steps stay confers. They must run every repo's suite and check both
   sides of each interface, and a single judge is not given the other repo's path.
8. **Response path.** A long result keeps its head and its conclusion, with a note saying what
   was dropped and where the whole text is. A work step is not forwarded the previous step's
   scope/verify block, and a gate still is, since it audits it (*deviation*: the proposal was to
   drop it everywhere). Learnings are one line per step, cut at line boundaries.

Not done in the second pass: 4 (a fresh session per phase) and 7 (template hygiene); both are in the third pass above.

---

## 1. Headline numbers — first pass, before any change (all 30 templates, happy path)

| | Typical install | Bare (no goal, no memory) |
|---|--:|--:|
| Prompt tokens sent | **418k** over 281 dispatches | 316k |
| …of which the user's query | **0.1%** | 0.1% |
| …already sent to the same session (redundant) | **53%** (221k) | 42% (131k) |
| Earlier prompts and reports in context at step starts (lower bound) | **≥ 2.6M tokens** | — |
| Results truncated before the next step saw them | 192 | 192 |
| 12s executor polls on the critical path | 234 (about 23 min of average idle) | 234 |

Where the prompt text goes (typical install):

| Component | Share | What it is |
|---|--:|---|
| Upstream results | 35% | Dependency outputs, the report step's full run record, and gate feedback |
| Goal brief + memory | 25% | Up to 2,000 + 800 chars, attached to **every** dispatch |
| Step instructions | 22% | The template's own prompt, role persona and gate preset |
| Completion contract | 14% | The `[Completion]` block (597 chars per work step), retry hints, and the work-standard block on confer milestones |
| Workflow framing | 4% | Description, loop header, dispatch marker |
| The query | 0.1% | |

Why text is redundant, meaning the same session had already received it:

| Reason | Tokens | Share of everything sent |
|---|--:|--:|
| Goal brief + memory re-sent on every step | 90k | 21.6% |
| The agent's **own** earlier result pasted back to it as "output of previous step" | 63k | 15.2% |
| Completion contract repeated | 45k | 10.8% |
| Step instructions repeated (loop iterations, gate retries) | 14k | 3.4% |
| Workflow framing repeated | 8k | 1.9% |

Two single items are large enough to call out on their own:
- **The Workflow Completion Report step is 22% of all prompt tokens.** Its run record re-sends every
  step's result, up to 1,200 chars each and 24,000 in total, to the session that wrote them.
- **The auto-added Work Standard Check is 5%.** It is added at launch to every gate-less template.

### Loops at a realistic size (20 tasks)

Three tasks hide the loop cost. At 20 tasks:

| Template | Prompt tokens | Redundant | Re-read ≥ | Biggest redundant item |
|---|--:|--:|--:|---|
| Epic: Task by Task | 43k | **84%** | 596k | Full 3,018-char instructions re-sent each task (61k chars) |
| CE Develop and Optimize | 60k | **87%** | 801k | Full 6,200-char instructions re-sent each task (122k chars) |
| Epic: Two Repos | 89k | **88%** | 2.2M | 3,708-char instructions × 2 loops, each task (149k chars) |

---

## 2. How a step travels, and what happens to the answer

**Out (per dispatch)**, assembled in `executeStandardStep` and `sendCommandToAgent`:

```
[NeonCore goal — …]                    goal brief, ≤2,000 chars      ← every dispatch, if the repo has a goal
[Memory: …]                            ≤800 chars                    ← every dispatch, if the agent has memory
[neoncore step <id> #<nonce>]          dispatch marker
## Context / ## About this workflow    query + description            ← first steps only
[Workflow loop — dispatch k of N]      loop header, ~410 chars        ← loop iterations 2…N
[Output from previous step: "X"]       each dep ≤1,500, all ≤4,000    ← every step with dependencies
## Run Record — …                      ≤24,000                        ← report step
<role persona>                         180–250 chars
<step instructions>                    0.2k–6.2k chars (template)
[Completion] …                         597 chars incl. curl fallback   ← every work step
```

Gates add their preset (929–1,582 chars) and a retry hint that lists upstream step names. Confer
milestones re-send the whole task and append the 1.1k-char work-standard block on every milestone.

**Back**, via `neoncore_report_step_done`, then the webhook, then `completeStepFromSignal`:
1. The MCP tool posts `result/next/scope/verify/deferred` to the webhook.
2. The webhook validates: length ≤200k, scope + verify present (work steps), and the loop count if a later
   step reads one.
3. The result is stored **decorated**: `NEXT: <hand-off>` on line 1 (below the verdict for gates), the
   agent's text, then a `---\nscope/verify/deferred` block, plus a `[Plan]` wrapper if plan mode captured one.
4. The executor acts immediately on gates (verdict, retry) and loops (re-dispatch). Everything else is
   marked completed, and **successors start on the next 12-second poll**. No tick runs on completion.
5. The next step receives each dependency result cut at 1,500 chars **from the start**. Because
   the decoration adds about 150 chars, even a 1,500-char reply is cut, and what is lost is the tail:
   the agent's closing lines and the scope/verify block.
6. `tokens_in/out` per step are stored as chars ÷ 4 estimates. Real usage comes from transcripts.

The caps work: longer replies (5,000 chars) did not raise prompt totals at all (418,501 vs 418,449
chars). The cost of a verbose agent shows up as information lost to truncation (222 cuts vs 192),
not as bigger prompts.

---

## 3. Findings, ranked by impact

### F1. Everything accumulates in one session, and NeonCore re-sends it anyway
Every run uses one session, and each step re-sends what that session already holds: the goal brief,
memory, contract, persona, and the agent's own previous results. That is the worst of both designs.
A continuous session should only need deltas, and a fresh session per step would not accumulate.
The re-read lower bound (one model call per step; agents make many) is 6× the prompt total. It
grows **quadratically** with steps per session: CE: Full Delivery sends 50k prompt tokens but
carries ≥1.1M. A 38-dispatch session with real tool output will also hit context compaction, after
which earlier steps survive only as a summary.

### F2. "Parallel" steps on one cartridge are merged into a single message (verified)
The executor dispatches every ready step of a stage at once. With the default one cartridge per
run, they all go to the same relay, which writes each as a bracketed paste followed by a delayed
Enter, with no serialisation. **Verified in the sandbox** (real relay and PTY, CE: Phase 2): the three
plan-review steps were injected within 3 ms and reached the agent as one 6,984-char user message
containing all three step prompts. The simulated agent answered the first one. The other two
stayed `running` with nothing left to answer them. A real model may answer all three in one turn,
but nothing guarantees it. The step-session guard will not re-send, because the prompt was received.
The personas also conflict within one turn, for example security expert against performance expert.

This affects six templates: CE: Phase 2 (3-way), CE: Phase 4 (6-way), CE: Full Delivery (3- and 6-way),
Release Documentation (4-way), and Epic: Two Repos (its two loops start together).

Related: the executor never checks whether a cartridge is busy before dispatching. Only the launch
and confers do. In the same sandbox run, a step sent to a cartridge that was `waiting` on a
question was treated as **the answer to that question**, and went without the goal brief.

### F3. Per-dispatch constants: 25–36% of every prompt
The goal brief (≤2,000), memory (≤800) and the completion contract (597, of which about 250 is a curl
fallback that repeats the server URL and auth header) ride on every dispatch. The contract is the
step's only completion protocol and must stay. The rest is identical text the session already has.

### F4. The agent's own results, pasted back
"Output from previous step" is 15% of everything sent, and all of it was written by the same
session, which still has it in context as its own report call. The report step's run record is
another large share of the same thing. This context is only necessary when steps run on **different**
cartridges, or after compaction.

### F5. Loop iterations re-send the full instructions
Iteration k ≥ 2 re-sends the step's entire prompt (up to 6,200 chars) plus the loop header, to the
session that just executed iteration k−1. At 20 tasks, 84–88% of a loop template's prompt text is
redundant.

### F6. Confer milestones repeat the whole brief
Each milestone prompt re-sends the overall task (query, description, step prompt and any dependency
output), the git commit and push instructions, the curl done-signal, and the 1.1k work-standard
block. That block is already flagged in `lib/prompt-budget.ts` as a "double contract". Confer:
83.6k chars over 12 milestone prompts, with the contract alone 33% of the run. The Confer and
Epic: Confer Across Repos launches also convert the **verify** step into a second confer (5 more
milestones × 2 cartridges), which roughly doubles the cost of a step that only reads.

### F7. The response path loses the end of each answer
Results are truncated from the start at 1,500 chars after the webhook has added about 150 chars. The
`NEXT:` hand-off survives, because it is deliberately placed first. The agent's conclusion and the
scope/verify block are what get cut, and 192 of the catalogue's results were cut. "Learnings"
injected into later runs of a template are the first 600 chars of an auto-summary: a header, then
the start of the first step's output, cut mid-sentence. Up to three of these land in the first
step of every later run in that project.

### F8. Speed: the poll dominates the fast path
A finished step's successors wait for the next 12-second tick (6s average). Each connector costs a
tick of its own, so the three-connector endings (Capture Learnings, Save to Project, Notify) idle about
18–36s for millisecond operations. A gate retry costs two ticks. Across the catalogue that is 234
polls, about 23 minutes of average idle. CE: Full Delivery alone has 38, about 3.8 minutes average
and 7.6 worst. Loop iterations and gate verdicts are immediate. Stage transitions are not.

### F9. Template-level overhead
- **Workflow Completion Report:** 22% of all tokens. It is a full 1,676-char spec plus the run record, in
  every template, on runs as small as the two-step Gridlight QA, where it is about half the run.
- **Auto-added Work Standard Check:** 5%. It is inserted after Notify, so its only input is Notify's
  87-char output, and "Done" is notified before the audit runs. It is also added to content
  workflows it does not fit (digests, strategy sessions, QA guides), and to manual launches only:
  scheduled runs (`cloneTemplateAsRun`) never get it.
- **Connector chains** of 2–3 steps: a tick each, for one combined effect.

---

## 4. Per-template notes

Prompt-token measurements, typical context, happy path, 3 tasks for loops:

| Workflow | Prompts (typical) | Prompts (bare) | Re-read at step starts ≥ | Largest prompt | Redundant | Results cut | 12s polls |
|---|--:|--:|--:|--:|--:|--:|--:|
| Bug Hunter | 10,733 (7 disp.) | 7,777 | 33,124 | 3,289 | 50% | 6 | 8 |
| Bug Investigation | 11,188 (7 disp.) | 8,232 | 35,435 | 3,303 | 48% | 6 | 8 |
| CE Develop and Optimize | 14,627 (7 disp.) | 11,671 | 50,613 | 2,680 | 60% | 4 | 6 |
| CE: Full Delivery | 50,085 (38 disp.) | 34,039 | 1,101,338 | 7,204 | 72% | 37 | 38 |
| CE: Phase 1 — Interrogate | 8,527 (6 disp.) | 5,994 | 21,759 | 3,037 | 42% | 5 | 7 |
| CE: Phase 2 — Plan | 10,758 (7 disp.) | 7,802 | 32,331 | 3,301 | 52% | 6 | 6 |
| CE: Phase 3 — Implement | 9,006 (6 disp.) | 6,473 | 23,332 | 2,953 | 47% | 5 | 7 |
| CE: Phase 4 — Review | 18,451 (12 disp.) | 13,384 | 103,285 | 5,120 | 55% | 11 | 8 |
| CE: Phase 5 — QA | 8,624 (6 disp.) | 6,090 | 22,394 | 2,956 | 46% | 5 | 7 |
| CE: Phase 6 — Ship | 9,755 (7 disp.) | 6,800 | 30,234 | 3,372 | 47% | 6 | 8 |
| CE: Phase 7 — Compound | 8,641 (6 disp.) | 6,108 | 22,509 | 2,945 | 46% | 5 | 7 |
| Code Review & Audit | 9,367 (6 disp.) | 6,833 | 24,424 | 2,962 | 46% | 5 | 7 |
| Confer | 30,149 (26 disp.) | 25,924 | 172,994 | 2,267 | 54% | 3 | 3 |
| Daily AI Filmmaking Digest | 7,975 (5 disp.) | 5,864 | 21,599 | 2,086 | 46% | 4 | 5 |
| Daily AI Research Digest | 6,786 (5 disp.) | 4,675 | 17,466 | 1,552 | 54% | 4 | 5 |
| Deep Research | 11,800 (8 disp.) | 8,422 | 42,018 | 3,655 | 49% | 7 | 9 |
| Engineering Architecture Review | 10,900 (7 disp.) | 7,945 | 34,023 | 3,432 | 46% | 6 | 10 |
| Epic: Confer Across Repos | 47,191 (34 disp.) | 41,838 | 359,619 | 2,622 | 49% | 4 | 3 |
| Epic: Task by Task | 11,374 (7 disp.) | 8,418 | 39,014 | 2,611 | 57% | 4 | 6 |
| Epic: Two Repos | 19,110 (10 disp.) | 14,888 | 97,807 | 2,975 | 63% | 5 | 6 |
| Feature Validation | 11,693 (7 disp.) | 8,737 | 37,283 | 3,315 | 45% | 6 | 8 |
| Full QA Review | 12,848 (8 disp.) | 9,470 | 46,263 | 3,650 | 50% | 7 | 9 |
| Gridlight Full Release QA | 4,446 (3 disp.) | 3,179 | 4,447 | 2,078 | 31% | 2 | 3 |
| Gridlight Local QA | 4,419 (3 disp.) | 3,152 | 4,423 | 2,065 | 31% | 2 | 3 |
| Gridlight Performance Improvement | 17,053 (9 disp.) | 13,253 | 67,331 | 4,098 | 57% | 8 | 9 |
| Jira Tasks Validation | 7,848 (5 disp.) | 5,737 | 17,303 | 2,611 | 37% | 4 | 6 |
| Product Strategy Session | 12,780 (8 disp.) | 9,402 | 46,243 | 3,768 | 46% | 7 | 11 |
| QA Testing Guide | 9,107 (6 disp.) | 6,574 | 22,973 | 2,980 | 48% | 5 | 7 |
| Release Documentation | 12,494 (8 disp.) | 9,116 | 44,248 | 3,673 | 52% | 7 | 6 |
| Spec Intake → Dev Spec | 10,716 (7 disp.) | 7,761 | 32,876 | 3,403 | 46% | 6 | 8 |
| **All 30** | **418,449** | **315,554** | **2,608,706** | | **53%** | **192** | **234** |

| Template | Notes |
|---|---|
| Bug Hunter, Bug Investigation | Linear: 5 work steps → test gate → connector → report. The report is about 30% of tokens. The gate's routing rule is now live (last turn). |
| CE Develop and Optimize | 6,200-char loop instructions re-sent every task (F5). Zero-retry terminal gate is well designed. |
| CE: Full Delivery | 48 steps, 38 dispatches, one session: the extreme case of F1 (≥1.1M re-read). Two fan-outs merge (F2). 7 phase connectors, 38 polls, 7 manual gates. The strongest candidate for a fresh session per phase. |
| CE: Phase 1–7 | Small and linear. Phase 2 and Phase 4 fan-outs merge (F2). Every phase except 3 (the only one with its own gate) gets the blind Work Standard Check (F9). |
| Code Review & Audit | Security gate mid-chain re-runs Logic Review on FAIL. Fine. |
| Confer, Epic: Confer Across Repos | Milestone prompts dominate (F6). Verify becomes a second confer. |
| Daily AI Research / Filmmaking Digest | Large single-use instructions (5.2k "Scan the Web") are fine. A Work Standard Check on a news digest is a poor fit, and is only added on manual launches. |
| Deep Research | Linear. "Create in Jira?" (2k chars) runs on every launch. |
| Engineering Architecture Review, Product Strategy Session | Three-connector endings (F8), blind Work Standard Check (F9). |
| Epic: Task by Task | The model loop: data-driven count, LOOP-001/003. F5 dominates at scale. |
| Epic: Two Repos | Two loops in one stage: on one cartridge their first iterations are dispatched in the same tick and merged (F2), and later iterations interleave in one session. Needs two cartridges to work as designed. |
| Feature Validation, Full QA Review | Long linear reviewer chains. Full QA's independent reviews could run in parallel given separate cartridges. |
| Gridlight Local / Full Release QA | Two steps. The report (2.5k custom spec) is about half the run. |
| Gridlight Performance Improvement | Steps depend on 3–4 upstream steps each, so upstream results are 50% of prompts, at the 4,000-char cap. |
| Jira Tasks Validation | **The pattern to copy:** steps write to files and return only a path and a count, so hand-offs stay tiny and nothing is truncated. |
| QA Testing Guide, Release Documentation, Spec Intake | Release Documentation's 4-way fan-out merges (F2). The others are linear and reasonable. |

---

## 5. Recommendations, in order

Each can be measured before and after with `--profile`. Savings are estimated from the numbers above.

1. **Serialise dispatch per cartridge** (F2). Do not dispatch a step to a cartridge that already has a
   running step or a pending question. Hold it until that cartridge reports. This fixes the merged
   fan-out and the "prompt consumed as an answer" case. It costs no tokens, and it is a correctness fix.
2. **Make prompts session-aware** (F1, F3, F4). The first dispatch into a session carries the goal
   brief, memory, full contract and persona. Later dispatches into the same session reference them
   in one line. A dependency result the same session produced is referenced (keep the `NEXT:` line)
   rather than pasted. The report's run record does the same for same-session steps. This removes
   most of the **53%** redundant text (about 221k of 418k catalogue tokens) and shrinks re-reading by a
   similar fraction. Keep full context whenever the session changed or was compacted. The
   step-session guard already records the session per dispatch.
3. **Loop iterations: send the header plus a short reminder** (F5), not the full instructions again.
   That is 61k–149k chars saved per 20-task epic.
4. **A fresh session per phase for long workflows** (F1). For CE: Full Delivery and anything over about
   10 dispatches, `/clear` or use a fresh session at phase boundaries, with the phase hand-off as the
   carrier. This bounds the quadratic re-read.
5. **Advance immediately** (F8). Run the executor pass right after a completion is accepted, and run
   chained connectors in the same pass. That saves about 6s average per stage, about 23 minutes of idle
   across one pass of the catalogue, and 3.8 minutes on CE: Full Delivery.
6. **Confer milestones** (F6). Drop the duplicated work-standard block (already flagged), send the task
   brief on milestone 1 only, and do not convert read-only verify steps into confers.
7. **Template hygiene** (F9). Place the Work Standard Check before the connectors, so it sees the work
   and precedes "Done". Make it opt-out for content workflows, and consistent between manual and
   scheduled launches. Collapse connector chains. Scale the report spec to run size.
8. **Response path** (F7). Keep the head and tail when truncating, or forward a bounded summary field.
   Do not forward the scope/verify block downstream. Store distilled learnings rather than 600-char
   fragments, or stop injecting them.

Keep what works: the dependency and run-record caps, `NEXT:` first, the LOOP-001/002/003 guards, the
per-dispatch overhead budgets (`lib/prompt-budget.ts`), and file-based hand-offs like Jira Tasks
Validation.

## Limits of this analysis

- Replies are simulated at a fixed size. The agent's tool work (file reads, test output), which
  dominates a real session, is not modelled, so the re-read figures are lower bounds.
- Tokens are chars ÷ 4. Prompt caching makes re-reads cheaper per token but does not reduce context
  size or compaction.
- Fan-out merging was verified with the sandbox's simulated CLI behind the real relay and PTY. How
  the real Claude Code TUI handles several pastes before one Enter is inferred from the byte stream,
  not observed.
