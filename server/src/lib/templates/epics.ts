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
        prompt: "The prior step supplied WORK, STATE, RUNLOG, ROOT, TESTS, METRIC, OVERALL_TARGET and MEASURE. RUNLOG is the running document: append every command and its actual output there as you go, never only in chat.\n\nYOU HANDLE EXACTLY ONE TASK IN THIS DISPATCH.\n\n### 0 — PICK — DEPENDENCIES FIRST\n- Take the first unfinished task — or, when this run came back with TASKS STILL OPEN, the first of those. Prerequisites are declared in a Dependencies column of the task table (bare task ids, comma-separated, or None) or in prose: depends on, blocked by, after, requires.\n- If a prerequisite is unfinished, work that prerequisite first, even when it appears later; do not skip past it. Say `SWITCHED to [id] — [blocked-id] depends on it`.\n- If the prerequisite is not yours (another repo, cartridge or person), mark this task WAITING ON [id] and take the next unfinished, unblocked task.\n- Keep dependents of a BLOCKED or FAILED task waiting. If dependencies form a cycle, stop for discussion.\n- If none remain, output ALL TASKS COMPLETE with the final tally.\n\n### 1 — RECORD THE START\nAppend to RUNLOG: task id, title, starting commit, acceptance criteria, and whether it is development, optimization or both. Set TASK_TARGET only if the task declares one; OVERALL_TARGET is for the final run, not every task.\n\n### 2 — BUILD A CORRECT, RUNNABLE VERTICAL SLICE\nIf the behaviour is missing or incomplete: enumerate its requirements, write a failing test first and confirm it fails, then implement the smallest runnable vertical slice that covers them, including the integration the real workload needs. Run the focused tests, then TESTS. Never optimize code that is not yet correct.\n\n### 3 — MEASURE\nRun MEASURE on the fixed workload; record raw samples, environment and the baseline. Without a TASK_TARGET the number is a regression check only. If the measurement is invalid or too noisy to compare, stop for discussion.\n\n### 4 — OPTIMIZE (only when TASK_TARGET is missed)\n1. Locate the shortfall with the cheapest measurement that would change what you build.\n2. Rank hypotheses by expected gain, confidence, cost and correctness risk.\n3. Try one hypothesis at a time in an isolated experiment worktree, measured with the same MEASURE.\n4. Every experiment must pass the correctness gates before it can count; a faster wrong result is a failure. Keep it only if it beats the current best by more than the noise threshold, otherwise revert it completely. Log hypothesis, commit, measurements, correctness and the keep/revert decision.\n5. Integrate the winning experiment into ROOT traceably, then rerun TESTS and MEASURE in ROOT. Only that state may be committed. Remove or record abandoned worktrees.\n6. Stop at TASK_TARGET, a plateau or the launch's limit, or when no hypothesis remains.\n\n### 5 — PER-TASK GATE\nFinish only when the requirements' tests and TESTS pass, the feature runs on the real measurement path, TASK_TARGET is met (or, without one, acceptance passes with no forbidden regression), and RUNLOG holds the baseline, final value, kept and rejected experiments.\nThen update STATE, append the verdict to RUNLOG, commit only this task's files as `[task-id] [title] — develop and optimize`, re-count STATE, and output:\nDONE [task-id] · baseline [value] · final [value] · task target [MET/NOT APPLICABLE] · commit [hash] · [k] remaining\nThe engine reads [k] remaining to extend a stale task count.\n\n### STOP FOR DISCUSSION\nOn a bug outside the task, a correctness gate still red after three focused attempts, an invalid metric, an unsafe change, a missing dependency, or a plateau below target with no credible hypothesis left:\n1. Revert unproven experiments and keep the last correct measured state.\n2. Append the evidence, blocker and options to RUNLOG. Do not mark the task done or commit a failing state.\n3. Use AskUserQuestion with the evidence and 2–3 concrete choices.\n4. Do not report this step complete until it is resolved; then continue the same task.\n\nNever work two tasks in one dispatch, and never weaken correctness tests to keep a faster result.",
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
        prompt: "An epic spanning TWO repositories is specified above, as a markdown file path or a tracker key. Both cartridges read only THIS output: a task you leave unassigned nobody does, and a task assigned twice is two agents editing one thing.\n\n1. Resolve the epic: a local doc first (`.claude/scoping/EPIC-*.md`, `docs/plans/*.md`), a tracker CLI only if one is configured.\n2. Name repo A and repo B, with the project root and exact test command for EACH.\n3. Assign EVERY task to exactly one repo, by where its code must change. A task needing both goes to the repo that owns the INTERFACE, with its dependency on the other side named.\n4. Write ONE progress doc, `docs/progress/<EPIC-ID>.md` in repo A: a table, one row per task — ID | Title | Repo | Status | Commit | Notes — Status TODO, DONE, BLOCKED, SKIPPED or WAITING; then a `## Log`. If it exists, keep its statuses.\n5. Name the B tasks that cannot start until an A task lands. Do not invent ordering: both sides run at once.\n\n**OUTPUT — these lines and nothing else:**\n```\nEPIC: [path or key]\nSTATE: [the progress doc]\nPROGRESS: [its absolute path]\nREPO_A: [name]\nROOT_A: [project root]\nTESTS_A: [exact test command]\nTASKS_A: [count of A tasks not yet done]\nREPO_B: [name]\nROOT_B: [project root]\nTESTS_B: [exact test command]\nTASKS_B: [count of B tasks not yet done]\nBLOCKED_BY_A: [task ids in B that wait on A, or \"none\"]\n```",
      }, []);

    // Steps A and B: the fan-out. Same shape, opposite halves, one dispatch per task.
    // Each reads its OWN count from step 1 — `loopCountFrom` names the step and the pattern,
    // so one upstream output drives two independent loops.
    const side = (letter: 'A' | 'B') => ({
      ...cc('backend'), includeDepOutput: true,
      loopCount: 1,
      loopCountFrom: { step: 'Scope & Partition', pattern: `TASKS_${letter}:\\s*(\\d+)` },
      loopUntil: `ALL ${letter} TASKS COMPLETE`,
      prompt: `Step 1 split one epic across two repos. **YOU OWN REPO ${letter} ONLY.** Another cartridge is working the other repo right now. Handle **EXACTLY ONE TASK** in this dispatch; the engine re-runs this step once per ${letter} task. Do not ask the user anything.

**BOUNDARY:**
- Work only in ROOT_${letter}. Never edit files in the other repo, even to fix something broken there.
- If your task needs a change on the other side, do not make it: note what you need under that repo's task in the state doc and build against the interface as specified.
- The state doc is shared: update your own task's row and append to its ## Log; never rewrite or reorder it.

### 1 — PICK — DEPENDENCIES FIRST
- Take the first REPO_${letter} task not done or skipped — or, when this run came back with TASKS STILL OPEN, the first of those for REPO_${letter} (BLOCKED and SKIPPED included).
- Prerequisites are declared in a Dependencies column of the task table (bare task ids, comma-separated, or None) or in prose: depends on, blocked by, after, requires, or a BLOCKED_BY entry.
- If the prerequisite is also REPO_${letter}'s and not done, work that prerequisite first — do not skip past it. Say "SWITCHED to [id] — [blocked-id] depends on it".
- If it belongs to the other repo, it is not yours: mark your task WAITING ON [id] and take the next unblocked REPO_${letter} task.
- If a prerequisite is BLOCKED or FAILED, mark the dependent WAITING ON [id] and move on.
- If none remain, output exactly "ALL ${letter} TASKS COMPLETE" with a one-line tally and stop. That ends your loop only.

### 2 — BUILD
Read the task and the code it touches in ROOT_${letter}. Write tests from the requirements (happy path, edge cases, an error state) and confirm they fail. Implement the minimum that passes; never edit tests to pass. Run the new tests, then the full suite with TESTS_${letter}: it must be green.

### 3 — RECORD AND COMMIT
- Mark the row DONE in the state doc (commit, a note naming REPO_${letter}) and append to ## Log.
- Commit in ROOT_${letter} only: "[task-id] [title] — implement per epic".
- Re-count what is outstanding for ${letter} from the state doc (step 1's number can be stale) and output "DONE [task-id] · commit [hash] · [k] remaining". The engine reads [k] to extend the run, so report it on every exit below.

**IF IT CANNOT BE FINISHED:**
- Suite red after 3 attempts → commit nothing, mark it BLOCKED with the failure output: "BLOCKED [task-id] · [k] remaining".
- Needs the other repo first → mark it WAITING ON ${letter === 'A' ? 'B' : 'A'} with what you need: "WAITING [task-id] · [k] remaining".
- Cannot be understood → SKIPPED with the reason, commit only that: "SKIPPED [task-id] · [k] remaining".`,
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
        prompt: "Both repos have finished. Do not implement anything; this step reports, because a two-sided run fails asymmetrically: one side finishes while the other stalls, and the run still looks done.\n\n1. Re-read the shared state doc. Classify EVERY task — done, skipped, blocked, waiting on the other repo, or never attempted — with its owning repo.\n2. Run the full suite in BOTH repos with TESTS_A and TESTS_B. A side that committed on a red suite is the top finding.\n3. `git log --oneline` in both roots: one commit per completed task, in the right repo. An A task committed in repo B crossed the boundary.\n4. Name any WAITING task the other side never delivered: neither cartridge owns it.\n\n**OUTPUT — exactly this shape:**\n```\nCOVERAGE: [done]/[total] across both repos\nREPO_A: [done]/[total] done · [skipped] skipped · [blocked] blocked · [outstanding] outstanding\nREPO_B: [done]/[total] done · [skipped] skipped · [blocked] blocked · [outstanding] outstanding\nSUITE_A: [pass/fail] — [command]\nSUITE_B: [pass/fail] — [command]\nCOMMITS: [n] in A for [k] tasks · [m] in B for [j] tasks\nCROSS-REPO EDITS: [none / the commits that touched the wrong repo]\n\nOUTSTANDING (if any) — one line each, with the owning repo and why:\n- [repo] [task-id] [title] — [blocked by X / waiting on other side / never attempted]\n```\n\nCount only DONE tasks as done: the engine reads COVERAGE and sends the run back to whichever side still has open tasks. If either side is short, say so plainly.",
      }, [sA, sB]);

    step(wfId, s5, 'Notify',
      'System notification: the two-repo epic run finished, carrying the per-repo coverage report.',
      300, 770, 'connector',
      { connectorType: 'system-notify', title: 'Epic: Two Repos \u2014 Done', message: '{{workflowName}} finished.\n{{result}}' },
      [s4]);
  }
}
