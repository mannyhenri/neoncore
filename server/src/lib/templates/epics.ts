/** Standard workflow templates: the epic templates (Task by Task, CE Develop and Optimize, Two Repos). An epic worked by conferring cartridges is the Confer template with a Jira epic (./confer.ts). Seeded on every boot by ./index.ts. */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

export function seedEpics({ now, stableId, insertWorkflow, step, cc, gate }: SeedKit): void {
  // ── 9. Epic: Task by Task ───────────────────────────────
  //
  // Was "Jira Tasks Completion", which required the Jira CLI and asked the user after every
  // task. Repurposed rather than copied: the epic is now a markdown file OR a tracker key, and
  // the loop runs to the end unattended. The old name is in `deprecatedNames` above so its row
  // is removed from existing databases instead of lingering beside this one.
  {
    const wfId = stableId('Epic: Task by Task');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID();
    insertWorkflow.run(wfId, 'Epic: Task by Task',
      'Loads an epic and works every task to the end: understand \u2192 failing tests \u2192 implement \u2192 verify \u2192 commit \u2192 next. One commit per task. Runs unattended \u2014 it never asks between tasks.', now);

    // Step 1: where the epic is, where task state lives, how to run the tests.
    step(wfId, s1, 'Load Epic',
      'Resolves the epic (markdown file or tracker key), finds where per-task status is recorded, and reports the project root and test command. Outputs paths only.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: "The epic above is a PATH to a markdown file or a tracker key (e.g. Jira). Output paths only — step 2 loads the tasks one at a time.\n\n1. A path or `.md` → read it. A key → a local epic doc first (`.claude/scoping/EPIC-*.md`, `docs/plans/*.md`), else a tracker CLI if configured.\n2. Find the project root and the exact test command.\n3. Write the progress doc `docs/progress/<EPIC-ID>.md` at the root: a table, one row per task — ID | Title | Status | Commit | Notes — Status TODO, DONE, BLOCKED or SKIPPED; then a `## Log`. If it exists, keep its statuses and add new tasks. Every later step reads and writes it.\n\n**OUTPUT — these lines and nothing else:**\n```\nEPIC: [path or key]\nSTATE: [the progress doc]\nPROGRESS: [its absolute path]\nROOT: [project root]\nTESTS: [the exact test command]\nTASKS: [count of tasks not DONE]\n```",
      }, []);

    // Step 2: ONE task per dispatch. The engine repeats it `TASKS: n` times — the count comes
    // from step 1's output, so coverage is guaranteed by the runner rather than by an agent
    // remembering to keep going. `loopUntil` ends it early if the work runs out first.
    step(wfId, s2, 'Work Every Task',
      'Handles ONE task per dispatch: understand \u2192 failing tests \u2192 implement \u2192 full suite \u2192 commit. The engine re-runs it once per outstanding task, using the count step 1 reported.',
      300, 310, 'claude-code',
      {
        ...cc('backend'), includeDepOutput: true,
        loopCount: 1,
        // Colon optional: a confer's participants summarise the block as "… | TASKS 14" (run 86).
        loopCountFrom: { step: 'Load Epic', pattern: 'TASKS:?\\s*(\\d+)' },
        loopUntil: 'ALL TASKS COMPLETE',
        prompt: "Step 1 gave the epic, the state doc (the progress doc), the project root and the test command.\n\n**Handle EXACTLY ONE task in this dispatch.** The engine re-runs this step once per outstanding task. Do not ask the user anything; nobody is watching.\n\n**End EVERY exit path below with `[k] remaining`**, counted by re-reading the state doc — never by decrementing step 1's estimate, since an epic can grow mid-run. The engine extends the loop from that number; omit it and the leftover tasks are silently dropped.\n\n### 1 — PICK — DEPENDENCIES FIRST\n- Take the first task in the state doc not marked DONE or SKIPPED — or, when this run came back with TASKS STILL OPEN, the first of those (BLOCKED and SKIPPED included: try again with what you know now) — then look for a prerequisite:\n  - a `Dependencies` column in the task table: bare task ids (`BC-004`), comma-separated lists (`BC-003, BC-009`), or `None` / `-` / empty for none. A bare id IS a prerequisite even without the word \"depends\".\n  - prose: depends on, blocked by, after, requires, unblocked by, a linked issue. Check the tracker issue too if one is configured.\n  Ids can point to tasks later in the table: table order is not execution order.\n- Prerequisite not done → work that prerequisite instead, following the chain down to something runnable. Do not skip past it and do not start the blocked task. Say `SWITCHED to [id] — [blocked-id] depends on it`.\n- Prerequisite not yours (another cartridge, repo or a person), or marked `BLOCKED` / `FAILED` → you cannot start it, nor anything that depends on it. Mark the dependent `WAITING ON [id]` in the state doc and take the next undone, unblocked task.\n- A dependency loop → take the first unblocked task and say `CYCLE: [a] and [b] depend on each other`.\n- Nothing left → output exactly `ALL TASKS COMPLETE` with a one-line tally and stop.\n\n### 2 — UNDERSTAND\nRead the task's section in full (description, acceptance criteria, notes; the tracker issue if a CLI is configured), then the code it touches and the patterns to follow.\n\n### 3 — TESTS FIRST\nWrite them from the requirements, not from your planned implementation: happy path, 2+ edge cases, 1+ error state per requirement. Run them and confirm they FAIL. If they pass first, they are wrong.\n\n### 4 — IMPLEMENT\nThe minimum code that meets the requirements, following existing patterns. Never edit the tests to make them pass.\n\n### 5 — VERIFY\nThe new tests pass (up to 3 fix attempts), then the FULL suite with step 1's command.\n\n### 6 — RECORD AND COMMIT\nMark its row DONE in the state doc (commit, one-line note) and append a line to its `## Log`. Commit implementation, tests and state doc as ONE commit: `[task-id] [title] — implement per epic`. Output `DONE [task-id] · commit [hash] · [k] remaining`.\n\n**If the task cannot be finished:**\n- Suite still red after 3 attempts → commit nothing, mark it `BLOCKED` in the state doc with the failure output, output `BLOCKED [task-id] · [k] remaining`.\n- Not understandable from the epic → mark it `SKIPPED` with the reason and commit only that, so the next dispatch moves past it. Output `SKIPPED [task-id] · [k] remaining`.\n\nNever work two tasks in one dispatch. Never skip step 3 or step 5.",
      }, [s1]);

    // Step 3: the sweep. The loop guarantees N dispatches; only this says what got DONE.
    step(wfId, s3, 'Verify Coverage',
      'Reports what the run actually covered: every task classified done/skipped/blocked/outstanding, the full suite re-run, and one commit confirmed per completed task. Implements nothing.',
      300, 540, 'claude-code',
      {
        ...cc('researcher'), includeDepOutput: true,
        // The engine reads this step's COVERAGE line (lib/coverage-loop.ts): tasks open → back to
        // the work; no progress → the run holds for you. The run does not end with work undone.
        coverage: { retryFrom: ['Work Every Task'] },
        prompt: "The work loop has finished. It guarantees attempts, not completions, so report what was actually covered. Implement nothing.\n\n1. Re-read the state doc (the progress doc) and classify EVERY task: done, skipped, blocked or outstanding.\n2. Run the full suite once with step 1's command. A red suite is the headline.\n3. Check `git log --oneline` for the run: one commit per done task. A done task with no commit exists only in the working tree.\n\n**OUTPUT — exactly this shape:**\n```\nCOVERAGE: [done]/[total] done · [skipped] skipped · [blocked] blocked · [outstanding] outstanding\nSUITE: [pass/fail] — [the command you ran]\nCOMMITS: [n] commits for [done] completed tasks\n\nOUTSTANDING (if any) — one line each, with why:\n- [task-id] [title] — [blocked by X / never attempted / skipped: reason]\n```\n\nIf everything is done and green, say so in one line. Never count a skipped or blocked task as done: the engine reads COVERAGE and sends the run back to the work while tasks are open.",
      }, [s2]);

    // Step 4: Notify
    step(wfId, s4, 'Notify',
      'System notification: the epic run finished, carrying the coverage report.',
      300, 770, 'connector',
      { connectorType: 'system-notify', title: 'Epic: Task by Task \u2014 Done', message: '{{workflowName}} finished.\n{{result}}' },
      [s3]);
  }

  // ── 9a. CE Develop and Optimize ─────────────────────────────────────────
  //
  // A task loop for work whose implementation is not yet complete AND whose final shape is
  // chosen by a measured target. Ordinary epic execution stops at "the tests pass"; an
  // optimization-only loop assumes there is already something correct to measure. This
  // template joins the two without letting performance experiments weaken correctness.
  {
    const wfId = stableId('CE Develop and Optimize');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CE Develop and Optimize',
      'Works a task list one item at a time: build a correct runnable slice with TDD, optimize it against a fixed metric when needed, preserve correctness for every experiment, append durable evidence, and stop for discussion on bugs or unmet goals.', now);

    step(wfId, s1, 'Load Work and Goals',
      'Resolves the task source, success metric, target, measurement command, state file and durable running document; counts unfinished tasks without changing code.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: "The launch context names a Jira epic/task list or a markdown plan and the metric goal for this run.\n\nResolve the work before changing code:\n1. Load every task and its dependency/status. A local plan is preferred; use a configured tracker when the launch context supplies a tracker key.\n2. Identify the repository root and exact correctness test command.\n3. Extract the named primary metric, target comparison, measurement command, fixed workload, and constraints. A metric is usable only when its direction, units, workload and target are unambiguous.\n4. Write the progress doc `docs/progress/<WORK-ID>.md` at the root: a table, one row per task — ID | Title | Status | Commit | Notes — Status TODO, DONE, BLOCKED or SKIPPED; then a `## Log`. If it exists, keep its statuses. It is STATE. Choose RUNLOG, the experiment journal, as a separate durable document under docs/ that appends across every task and experiment.\n5. Count tasks not done or explicitly skipped. Do not count parent headings or completed tasks.\n\nIf the metric contract cannot be made reproducible from the supplied work, ask one focused question and do not report the step complete.\n\nOUTPUT — exactly these lines:\n\nWORK: [plan path or tracker key]\nSTATE: [the progress doc]\nPROGRESS: [its absolute path]\nRUNLOG: [durable running markdown document]\nROOT: [repository root]\nTESTS: [exact correctness/full-suite command]\nTASKS: [count of unfinished tasks]\nMETRIC: [name, direction and units]\nOVERALL_TARGET: [numeric/ordinal final run target and comparison]\nMEASURE: [exact repeatable measurement command and fixed workload]",
      }, []);

    step(wfId, s2, 'Develop and Optimize Every Task',
      'Handles exactly one dependency-ready task per dispatch: TDD vertical slice, correctness verification, measured optimization if needed, evidence append, commit and next task.',
      300, 310, 'claude-code',
      {
        ...cc('backend'), includeDepOutput: true,
        loopCount: 1,
        loopCountFrom: { step: 'Load Work and Goals', pattern: 'TASKS:\\s*(\\d+)' },
        loopUntil: 'ALL TASKS COMPLETE',
        prompt: "The prior step supplied WORK, STATE, RUNLOG, ROOT, TESTS, METRIC, OVERALL_TARGET and MEASURE.\n\nYOU HANDLE EXACTLY ONE TASK IN THIS DISPATCH.\n\n### 0 — PICK — DEPENDENCIES FIRST\n- Read the complete task section and its tracker links. A markdown table commonly stores bare task ids or comma-separated ids in a Dependencies column; None, -, or an empty cell means no prerequisite. Prose such as depends on, blocked by, after, and requires also declares prerequisites.\n- Start with the first unfinished task — or, when this run came back with TASKS STILL OPEN, the first of those — then follow its dependency chain. If a prerequisite is unfinished, work that prerequisite first—switch to the prerequisite even when it appears later in the document. Say `SWITCHED to [id] — [blocked-id] depends on it`. Do not skip past it and do not start the blocked task.\n- If the prerequisite is not yours to work because it belongs to another repo, cartridge or person, mark this task WAITING ON [id] and choose the next task that is both unfinished and unblocked. Do not edit another owner's scope.\n- If a prerequisite is BLOCKED or FAILED, keep every dependent waiting. If the dependency graph cycles, stop for discussion rather than inventing an order.\n- If none remain, output ALL TASKS COMPLETE with the final tally.\n\nAt the end of every successful dispatch, re-count from STATE and report [k] remaining; the engine uses that claim to extend a stale initial task count.\n\n### 1 — BEGIN THE DURABLE RECORD\nAppend the task id, title, starting commit, requirements, task acceptance, metric relevance and timestamp to the running document. Classify it as a development task, an optimization task, or both. Extract TASK_TARGET only when this task explicitly declares one; OVERALL_TARGET belongs to the final run and must not be imposed on every intermediate task. The running document is the authoritative experiment journal; never keep a result only in chat. Record commands and actual output, not predictions.\n\n### 2 — BUILD THE CORRECT RUNNABLE VERTICAL SLICE\nDetermine whether the task's feature is missing, incomplete or already runnable.\n- For missing/incomplete behavior, enumerate the complete requirement set and write a failing test first. Confirm the expected red result.\n- Implement the smallest runnable vertical slice that covers that whole set, including integration boundaries needed for the real workload.\n- Run focused tests and then TESTS. Do not optimize code that is not correct and runnable.\n- Capture the correctness commands and actual results in RUNLOG.\n\n### 3 — MEASURE BEFORE CHANGING PERFORMANCE\nRun MEASURE on the correct slice using the fixed workload. Record raw samples, aggregation, environment/hardware identity and baseline in RUNLOG.\n- For a development task without TASK_TARGET, the measurement is a baseline/regression signal; it need not already meet OVERALL_TARGET. Continue when task acceptance passes and the metric has no forbidden regression.\n- For an optimization task or a task with an explicit TASK_TARGET, optimize only when its own target is missed.\n- If measurement is invalid, irreproducible or too noisy to distinguish changes, STOP FOR DISCUSSION as described below. Do not guess.\n\n### 4 — CE MEASURED OPTIMIZATION LOOP\nWhen an optimization task is correct and runnable but misses TASK_TARGET, use the CE Optimize protocol:\n1. Attribute the shortfall before editing; take the cheapest locating measurement that would change what gets implemented.\n2. Write a ranked hypothesis backlog with expected benefit, confidence, measurement cost and correctness risk.\n3. Test one attributable hypothesis at a time in an isolated experiment worktree. Never combine unrelated changes before their individual effect is known.\n4. Run the same MEASURE command. Keep a candidate only when it improves the current best by more than the declared noise/acceptance threshold; otherwise revert it completely.\n5. EVERY optimization experiment must run the correctness gates before it is eligible to become best. A faster incorrect result is a failed experiment.\n6. Append hypothesis, diff/commit identity, raw measurements, comparison, correctness result and keep/revert decision to RUNLOG immediately.\n7. Integrate the winning experiment into ROOT (cherry-pick or an equivalently traceable apply), then rerun TESTS and MEASURE in ROOT. Only this integrated and remeasured state may be committed as the task result. Remove or explicitly record abandoned experiment worktrees.\n8. Continue until TASK_TARGET is met, the evidence reaches a plateau/stopping limit supplied at launch, or no runnable hypothesis remains.\n\n### 5 — PER-TASK GOAL AND CORRECTNESS GATE\nThe task can finish only when all of these are true:\n- the complete task requirement set passes its tests;\n- TESTS is green;\n- the feature is runnable on the real measurement path;\n- TASK_TARGET is met when this task declares one; otherwise the task's acceptance criteria pass and the metric shows no forbidden regression;\n- RUNLOG contains the baseline, final value, retained changes and rejected experiments.\n\nIf all pass: update STATE, append the final task verdict to RUNLOG, stage only this task's implementation/tests/state/log, and commit `[task-id] [title] — develop and optimize`. Re-count STATE and output:\nDONE [task-id] · baseline [value] · final [value] · task target [MET/NOT APPLICABLE] · commit [hash] · [k] remaining\n\n### STOP FOR DISCUSSION — DO NOT SILENTLY CONTINUE\nIf you discover a bug outside the task, a red correctness gate after three focused attempts, an invalid metric, an unsafe change, a missing external dependency, a plateau below target, or no credible hypothesis remains:\n1. Revert unproven experiment changes; preserve the last correct measured state.\n2. Append the evidence, blocker and available choices to RUNLOG. Do not mark the task done and do not commit a failing state.\n3. Use AskUserQuestion with the concrete evidence and 2–3 actionable choices.\n4. Do not report this workflow step complete while the issue is unresolved. Continue in the same task after the answer.\n\nNever work two tasks in one dispatch. Never weaken or edit correctness tests merely to keep a faster result. Never move to the next task unless this task's target and correctness gates pass.",
      }, [s1]);

    step(wfId, s3, 'Verify Coverage and Evidence',
      'Audits every task, the durable running document, commits, correctness suite and comparable metric evidence without implementing anything.',
      300, 540, 'claude-code',
      {
        ...cc('reviewer'), includeDepOutput: true,
        coverage: { retryFrom: ['Develop and Optimize Every Task'] },
        prompt: "Do not implement or optimize anything. Audit the completed run from WORK, STATE and RUNLOG. RUNLOG is the authoritative running document.\n\n1. Classify every task: done, skipped, blocked or outstanding. Confirm one scoped commit per done task.\n2. Run TESTS and record the actual result.\n3. For every metric-bearing task, verify RUNLOG has a comparable baseline and final measurement using MEASURE, environment identity, raw samples, correctness result and keep/revert decisions.\n4. Confirm the final retained tree—not an abandoned experiment—produces the reported final values.\n5. Append this audit to RUNLOG.\n\nOUTPUT:\nCOVERAGE: [done]/[total] done · [skipped] skipped · [blocked] blocked · [outstanding] outstanding\nCORRECTNESS: [PASS/FAIL] — [command and counts]\nMETRICS: [verified]/[metric-bearing tasks] comparable results · overall [metric] [baseline] → [final] · target [MET/NOT MET]\nEVIDENCE: [COMPLETE/INCOMPLETE] — [RUNLOG path]\nCOMMITS: [count] task commits\nISSUES: [none, or exact unresolved bugs/blockers/evidence gaps]\n\nOUTSTANDING — one line per task not done, with why:\n- [task-id] [title] — [blocked by X / never attempted / skipped: reason]\n\nCount only DONE tasks as done: the engine reads COVERAGE and sends the run back to the work while tasks are open.",
      }, [s1, s2]);

    step(wfId, s4, 'Goal Achievement Gate',
      'Hard final gate: continue only when coverage, correctness, evidence and declared goals are all satisfied; otherwise stop the workflow for discussion.',
      300, 770, 'quality-gate',
      {
        ...gate('custom'), maxRetries: 0, terminalOnFail: true,
        customPrompt: `You are the final evidence gate. Do not implement, edit tests, optimize, repair the running document or reinterpret the target. Evaluate only the supplied coverage report, the running document and current repository evidence.

Respond on the FIRST LINE with exactly PASS or FAIL.

PASS only when:
- every required task is done, with no blocked/outstanding task or unresolved bug;
- the full correctness suite passes;
- every metric-bearing task has comparable baseline/final evidence from the declared workload;
- every retained experiment passed its correctness gate;
- the declared target and overall workflow goal are met;
- the running document contains enough evidence to reproduce the verdict.

FAIL when any item is missing, invalid, unresolved, skipped without explicit authorization, or below target. A FAIL is terminal and intentionally stops this workflow so the operator can discuss the evidence before deciding what to do next. List the exact failed conditions and cite their RUNLOG sections.`,
      }, [s3]);

    step(wfId, s5, 'Notify',
      'System notification emitted only after the goal gate passes.',
      300, 1000, 'connector',
      { connectorType: 'system-notify', title: 'CE Develop and Optimize — Goals Met', message: '{{workflowName}} passed its correctness and metric goals.\n{{result}}' },
      [s4]);
  }

  // ── 9b. Epic: Two Repos ──────────────────────────────────────────────────
  //
  // REQUESTED: "in workflows (like in confer) to involve more than one repo/cartridge
  // (example use the epic jira task template with two repos working together owning their
  // own piece)".
  //
  // The ENGINE already did all of this — per-step cartridges (agentOverrides), parallel
  // dispatch (readySteps), join steps, and a per-branch loop count read from one shared
  // upstream step. What was missing was a template that used them together: `Epic: Task by
  // Task` is a line, and assigning its steps to different cartridges only moves where the
  // single thread runs.
  //
  // The shape is a diamond. Scope once, fan out to two cartridges that each loop over THEIR
  // OWN tasks, then join on a step that refuses to call the epic done unless both sides are.
  //
  // WHY SCOPING IS SHARED AND WORK IS NOT. One epic means one list, or the two sides disagree
  // about what "done" is. But the WORK is partitioned by repo and each side is told, in its
  // own prompt, that it owns only its half — two agents editing the same task is the failure
  // this shape exists to prevent, and it is not preventable after the fact.
  {
    const wfId = stableId('Epic: Two Repos');
    const s1 = randomUUID(), sA = randomUUID(), sB = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'Epic: Two Repos',
      'One epic, two repos, working at the same time. Scope and partition once \u2192 each cartridge works only its own repo\u0027s tasks, committing as it goes \u2192 a join step that fails if either side is short. Assign a cartridge per side at launch ("assign per step").', now);

    // Step 1: scope BOTH repos and partition the epic. Runs on either cartridge — it reads.
    step(wfId, s1, 'Scope & Partition',
      'Reads the epic once, decides which repo owns each task, and reports a per-repo count. The only step that sees the whole epic.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: "An epic is specified above, spanning TWO repositories. It is either a PATH to a markdown file or a tracker key.\n\n**Goal: one list, split in two.** Both cartridges below read THIS output and nothing else, so a task you fail to assign is a task nobody does, and a task you assign twice is two agents editing one thing.\n\n1. Resolve the epic (a local doc first — `.claude/scoping/EPIC-*.md`, `docs/plans/*.md` — then a tracker CLI only if one is configured).\n2. Identify the TWO repositories involved and which is A and which is B. State the project root and the exact test command for EACH — they are different repos and will not share a test runner.\n3. Assign EVERY task to exactly one repo, by where its code must change. A task needing both is assigned to the repo that owns the INTERFACE, and its dependency on the other side is named.\n4. Write ONE progress doc for the whole epic, `docs/progress/<EPIC-ID>.md` in repo A: a table, one row per task — ID | Title | Repo | Status | Commit | Notes — Status TODO, DONE, BLOCKED, SKIPPED or WAITING; then a `## Log`. If it exists, keep its statuses. Both sides read and write it.\n5. Name the tasks in B that cannot start until a task in A lands, if any. Do not invent ordering that is not there — the whole point is that both sides run at once.\n\n**OUTPUT — these lines and nothing else:**\n```\nEPIC: [path or key]\nSTATE: [the progress doc]\nPROGRESS: [its absolute path]\nREPO_A: [name]\nROOT_A: [project root]\nTESTS_A: [exact test command]\nTASKS_A: [count of A tasks not yet done]\nREPO_B: [name]\nROOT_B: [project root]\nTESTS_B: [exact test command]\nTASKS_B: [count of B tasks not yet done]\nBLOCKED_BY_A: [task ids in B that wait on A, or \"none\"]\n```",
      }, []);

    // Steps A and B: the fan-out. Same shape, opposite halves, one dispatch per task.
    // Each reads its OWN count from step 1 — `loopCountFrom` names the step and the pattern,
    // so one upstream output drives two independent loops.
    const side = (letter: 'A' | 'B') => ({
      ...cc('backend'), includeDepOutput: true,
      loopCount: 1,
      loopCountFrom: { step: 'Scope & Partition', pattern: `TASKS_${letter}:\\s*(\\d+)` },
      loopUntil: `ALL ${letter} TASKS COMPLETE`,
      prompt: `Step 1 partitioned one epic across two repositories. **YOU OWN REPO ${letter} ONLY.**\n\n**YOU HANDLE EXACTLY ONE TASK IN THIS DISPATCH.** The engine re-runs this step once per task assigned to ${letter} \u2014 the count came from step 1, so coverage is guaranteed by the engine, not by you continuing. Another cartridge is working the OTHER repo at the same time, right now. Do not ask the user anything; nobody is watching.\n\n**THE BOUNDARY, which matters more than speed:**\n- Work ONLY in ROOT_${letter}. Never edit files in the other repo, even to fix something obviously broken there \u2014 that agent is editing them as you read this, and you will collide.\n- If your task needs a change on the other side, do NOT make it. Write what you need in the state doc under the other repo\u0027s task, finish your side against the interface as specified, and say so.\n- The state doc is SHARED. Append to your own task\u0027s line; never rewrite the whole file or reorder it \u2014 that is how the other side\u0027s progress disappears.\n\n### 1 \u2014 PICK \u2014 DEPENDENCIES FIRST\n- Read the state doc. Consider the FIRST task assigned to REPO_${letter} that is not done or skipped — or, when this run came back with TASKS STILL OPEN, the first of those for REPO_${letter} (BLOCKED and SKIPPED included: try again with what you know now).\n- **Does it declare a prerequisite?** Either a \u0060Dependencies\u0060 COLUMN in the task table \u2014 holding bare task ids with no verb, comma-separated lists, or the sentinel \u0060None\u0060 \u2014 or prose: \u0060depends on\u0060, \u0060blocked by\u0060, \u0060after\u0060, \u0060requires\u0060, or a BLOCKED_BY entry naming it. The ids need not appear earlier in the table than the task that names them.\n- **If that prerequisite is ALSO assigned to REPO_${letter} and is not done, work its prerequisite instead \u2014 do not skip past it.** It is your own work and it is what unblocks the rest; deferring it just reorders your queue into the shape the dependency forbade. Follow the chain down to something runnable, and say \u0060SWITCHED to [id] \u2014 [blocked-id] depends on it\u0060.\n- **If the prerequisite belongs to the OTHER repo, it is not yours to work** \u2014 that cartridge is editing those files right now. Mark your task \u0060WAITING ON [id]\u0060, take the next REPO_${letter} task that is undone and unblocked, and say which you skipped and why.\n- If a prerequisite is \u0060BLOCKED\u0060 or \u0060FAILED\u0060, do not start what depends on it \u2014 mark the dependent \u0060WAITING ON [id]\u0060 and move on.\n- If none remain, output exactly \u0060ALL ${letter} TASKS COMPLETE\u0060 with a one-line tally and STOP. That sentinel ends YOUR loop only \u2014 the other side keeps running.\n\n### 2 \u2014 UNDERSTAND\nRead the task in full. Use Read/Grep/Glob in ROOT_${letter}: what exists, what is missing, which patterns to follow.\n\n### 3 \u2014 TESTS FIRST\nWrite tests from the REQUIREMENTS. Happy path, two edge cases, one error state per requirement. Run them and CONFIRM THEY FAIL.\n\n### 4 \u2014 IMPLEMENT\nThe minimum code that satisfies the requirements. Do not edit tests to make them pass.\n\n### 5 \u2014 VERIFY\nRun the new tests, then the FULL suite with TESTS_${letter}. It must be green.\n\n### 6 \u2014 RECORD AND COMMIT\n- Mark its row DONE in the shared state doc (commit, one-line note naming REPO_${letter}) and append a line to its \u0060## Log\u0060.\n- Commit in ROOT_${letter} only: \u0060[task-id] [title] \u2014 implement per epic\u0060\n- Re-read the state doc and COUNT what is still outstanding for ${letter}. Do not decrement step 1\u0027s number \u2014 that is the one that can be stale.\n- Output \u0060DONE [task-id] \u00b7 commit [hash] \u00b7 [k] remaining\u0060. The engine reads that count and extends the run if ${letter}\u0027s work outlived its budget, so report it on EVERY exit path below.\n\n**IF THIS TASK CANNOT BE FINISHED:**\n- Suite red after 3 attempts \u2192 commit NOTHING, mark it \u0060BLOCKED\u0060 with the failure output, output \u0060BLOCKED [task-id] \u00b7 [k] remaining\u0060.\n- Needs the other repo first \u2192 mark it \u0060WAITING ON ${letter === 'A' ? 'B' : 'A'}\u0060 with what you need, and output \u0060WAITING [task-id] \u00b7 [k] remaining\u0060.\n- Cannot be understood \u2192 \u0060SKIPPED\u0060 with the reason, commit only that, output \u0060SKIPPED [task-id] \u00b7 [k] remaining\u0060.`,
    });

    step(wfId, sA, 'Work Repo A',
      'Handles ONE task per dispatch in repo A. Runs at the same time as repo B, and touches only its own repo.',
      140, 310, 'claude-code', side('A'), [s1]);

    step(wfId, sB, 'Work Repo B',
      'Handles ONE task per dispatch in repo B. Runs at the same time as repo A, and touches only its own repo.',
      460, 310, 'claude-code', side('B'), [s1]);

    // Step 4: the JOIN. Depends on BOTH, so the executor cannot reach it until both sides end.
    step(wfId, s4, 'Verify Both Repos',
      'Waits for BOTH sides, classifies every task in the shared doc, re-runs both suites, and reports per repo. A run where one side finished and the other stalled is the failure this catches.',
      300, 540, 'claude-code',
      {
        ...cc('researcher'), includeDepOutput: true,
        coverage: { retryFrom: ['Work Repo A', 'Work Repo B'] },
        prompt: "Both repos have finished their dispatches. **This step exists because a two-sided run fails asymmetrically:** one cartridge completes cleanly, the other stalls on task two, and every surface reports a finished workflow. The loop guarantees ATTEMPTS, not completions, and it guarantees them per side.\n\n**Do not implement anything. This step reports.**\n\n1. Re-read the shared state doc. Classify EVERY task: done, skipped, blocked, waiting-on-the-other-repo, or never attempted — and which repo owned it.\n2. Run the FULL suite in BOTH repos, with TESTS_A and TESTS_B. Both must be green. If one side committed on a red suite, that is the most important thing on this page.\n3. `git log --oneline` in BOTH roots: one commit per completed task, in the right repo. A commit for an A task inside repo B means the boundary was crossed.\n4. Name any task marked WAITING that the other side never delivered — that is work neither cartridge owns, and it is invisible from either side alone.\n\n**OUTPUT — exactly this shape:**\n```\nCOVERAGE: [done]/[total] across both repos\nREPO_A: [done]/[total] done · [skipped] skipped · [blocked] blocked · [outstanding] outstanding\nREPO_B: [done]/[total] done · [skipped] skipped · [blocked] blocked · [outstanding] outstanding\nSUITE_A: [pass/fail] — [command]\nSUITE_B: [pass/fail] — [command]\nCOMMITS: [n] in A for [k] tasks · [m] in B for [j] tasks\nCROSS-REPO EDITS: [none / the commits that touched the wrong repo]\n\nOUTSTANDING (if any) — one line each, with the owning repo and why:\n- [repo] [task-id] [title] — [blocked by X / waiting on other side / never attempted]\n```\n\nCount only DONE tasks as done — the engine reads COVERAGE and sends the run back to whichever side still has open tasks. If both sides are complete and both suites are green, say so in one line. If either is short, name it — an epic that is A-complete and B-half-done is a useful result, and one that CLAIMS to be done is not.",
      }, [sA, sB]);

    step(wfId, s5, 'Notify',
      'System notification: the two-repo epic run finished, carrying the per-repo coverage report.',
      300, 770, 'connector',
      { connectorType: 'system-notify', title: 'Epic: Two Repos \u2014 Done', message: '{{workflowName}} finished.\n{{result}}' },
      [s4]);
  }
}
