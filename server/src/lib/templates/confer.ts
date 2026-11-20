/** Standard workflow templates: Confer — one task, or every task of a Jira epic. Seeded on every boot by ./index.ts. */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

/** The launch-context line the dashboard writes when a Jira epic is given. Scope reads it. */
export const CONFER_EPIC_LINE = 'JIRA EPIC:';


export function seedConfer({ now, stableId, insertWorkflow, step, cc }: SeedKit): void {
  // ── 0c. Confer ────────────────────────────────────────────────────────────
  //
  // Confer as a TEMPLATE rather than a button in the header. It was a global action in the top
  // menu, which made it the one way of starting work that had no run history, no project, no
  // report and no place on the canvas. It is a workflow like everything else.
  //
  // ONE TEMPLATE FOR A TASK AND FOR AN EPIC. "Epic: Confer Across Repos" was this template with a
  // step in front that read an epic and a step behind that checked every task was covered; the
  // confer step between them was the same. They are merged: give the launch a Jira epic
  // (`JIRA EPIC: KEY` in the context — the dashboard's epic field writes it) and Scope looks the
  // epic up first and lists every task in it; give it only a task and Scope states that task.
  //
  // EVERY TASK, NOT "AS MANY AS FIT IN THE ROUNDS". A confer can end tidily with an epic half
  // done: the participants agree a split, one side finishes, the other runs out of rounds. Verify
  // Coverage's COVERAGE line is READ BY THE ENGINE (lib/coverage-loop.ts): tasks still open →
  // a fresh confer session on what is left (handed the OUTSTANDING list, its build rounds sized
  // to it), then Verify again — for as long as each pass gets further. A pass that finishes
  // nothing more HOLDS the run for you: keep working, or accept it as it is. No autonomy level
  // may make that choice, so an epic never quietly reads as done.
  //
  // SIZED TO THE EPIC. The confer's build rounds come from Scope's TASK_COUNT — two tasks per
  // participant per round, up to 20 rounds (lib/confer-sizing.ts) — instead of a fixed 3.
  //
  // No quality gate of its own ON PURPOSE: a template with one is launched without the Work
  // Standard Check (withStandardGate: "don't stack two critics"), and Confer changes code in
  // every participant's repo — it keeps the check.
  //
  // WHEN TO USE THIS AND WHEN "Epic: Two Repos". If you already know who owns what, Two Repos is
  // faster and the boundary is explicit. If the split is the hard part — usually true when an epic
  // spans a client and a server — confer it: the agents can read their own repos, the template
  // author could not.
  //
  // The confer step ships with an EMPTY conferAgentIds: the launch modal fills it from the
  // cartridges picked under "Run on" (CONFER_FILL, lib/workflow-launch.ts). Scope and Verify are
  // one cartridge's job even in a confer run (`conferFill: 'single'`).
  {
    const wfId = stableId('Confer');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID();
    insertWorkflow.run(wfId, 'Confer',
      'Two or more cartridges work together — they agree an approach, split it between themselves, and build in rounds. Put the task in the context, or add a Jira epic: the epic is looked up first and the run keeps going until every task in it is done. Pick the cartridges under "Run on" at launch.', now);

    step(wfId, s1, 'Scope the Work',
      'Reads the task, or looks up the Jira epic and lists every task in it. States the objective and how done is measured; decides nothing about who does what — the confer does that.',
      300, 50, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true, conferFill: 'single',
        prompt: `The launch context above says what the cartridges will work on: a task in plain words, a Jira epic, or both.

**Is there a Jira epic?** Look for a \`${CONFER_EPIC_LINE}\` line in the context, or an epic key (e.g. GRD-1712) or epic URL in the text.

### WITH A JIRA EPIC — look it up first, every task in it
1. Read the epic in Jira: the Atlassian MCP if it is connected (getJiraIssue for the epic, then searchJiraIssuesUsingJql with \`parent = KEY\`, or \`"Epic Link" = KEY\` on older projects); otherwise the project's Jira CLI (\`jira --version\`, \`jira-cli --version\`). If neither works, STOP and say so — never invent tasks.
2. Collect EVERY child issue, recursing into sub-epics until only leaf tasks remain. Tasks already Done are listed as done, not dropped.
3. Write the progress doc \`docs/progress/<EPIC-KEY>.md\` at this repository's root (\`git rev-parse --show-toplevel\`): a table, one row per task — Key | Title | Owner | Status | Commit | Notes — Status TODO, DONE, BLOCKED or SKIPPED; then one section per task with its description and acceptance criteria, and a \`## Log\`. If it exists, keep its statuses. Participants mark their tasks in it.
4. Text typed alongside the epic is direction for the whole epic: carry it into OBJECTIVE.

### WITHOUT AN EPIC — the task in the context
If it breaks into distinct parts, list them as T1, T2…; otherwise it is one task, T1. Write them to \`docs/progress/<slug>.md\` in the same shape.

### BOTH
State the OBJECTIVE, not the split: the next step is a confer, and the participants decide who owns what from their own repos. Name every repository involved and what each is FOR. Say how the whole is verified (the test command per repo, and what done means across them) and any ordering the work itself imposes — inventing sequence turns a confer into a queue.

**OUTPUT — under 1,400 characters; the next step is handed at most 1,500. For a long epic list keys and titles only — the details are in the state doc and in Jira.**
\`\`\`
MODE: EPIC <KEY> | TASK
STATE: <the progress doc>
PROGRESS: <its absolute path>
TASK_COUNT: <number of tasks not DONE>
OBJECTIVE: <one paragraph a reader with no context could act on>
REPOS: <name — what it is for, one per line>
TASKS: <id — title, one per line, unassigned; done ones marked (done)>
VERIFY: <test command per repo; the cross-repo definition of done>
ORDERING: <what genuinely must come first, or "none">
\`\`\``,
      }, []);

    step(wfId, s2, 'Confer & Build',
      'The cartridges agree one plan, divide the tasks between themselves, and build in rounds — each in its own repo.',
      300, 225, 'confer',
      {
        // `divide` = each participant owns a slice, which is the cross-repo case. Shared checkout:
        // participants are in different repos already, so worktree isolation would split a repo
        // that is not the thing being shared.
        conferAgentIds: [], conferMode: 'divide', conferIsolation: 'shared', includeDepOutput: true,
        // Sized from the work: Scope's TASK_COUNT, two tasks per participant per round, capped at
        // 2 rounds (lib/confer-sizing.ts SIZED_ROUNDS_CAP). 2 when the count cannot be read.
        buildRounds: 2,
        buildRoundsFrom: { step: 'Scope the Work', pattern: 'TASK_COUNT:\\s*(\\d+)', tasksPerRound: 2 },
        prompt: `The previous step gives the objective, repos, task list and how it is verified. Every task in it is in scope — the run is not done until each one is. Details: the STATE doc (and Jira).

**Confer, do not queue.** Agree ONE plan and say who owns which task before anyone writes code. Every task gets exactly one owner; an unclaimed task is never done.
- Work only in your own repo; ask its owner for changes elsewhere.
- Agree the interface between repos first, in writing. Tell peers the moment you change something they depend on.
- Disagree out loud, and name who you are blocked on.
- Tests first; your repo's full suite green before you call anything done.
- One commit per task, id in the message; mark it DONE in the STATE doc.

Report the tasks you took, finished and are waiting on.`,
      }, [s1]);

    step(wfId, s3, 'Verify Coverage',
      'Checks the combined result: every task owned and done, every suite green, the shared interface the same on both sides. While tasks are open the engine sends the run back to the confer; when a pass gets no further, it asks you.',
      300, 400, 'claude-code',
      {
        ...cc('reviewer'), conferFill: 'single', includeDepOutput: true,
        // The engine reads COVERAGE (lib/coverage-loop.ts) — see the note at the top of this file.
        coverage: { retryFrom: ['Confer & Build'] },
        prompt: `The confer has finished. **Do not implement anything — this step reports.** A confer can end tidily with the work half done (one side finishes, the other runs out of rounds), and pieces that each work alone can still not fit. This step is what notices.

1. Take the task list from "Scope the Work" — re-read the STATE doc (in EPIC mode, each task's Jira status too). For EVERY task: owned by whom, and done, skipped, blocked or never claimed.
2. Run the full suite in EVERY repo involved and paste the real result. All must be green.
3. \`git log --oneline\` in each repo: one commit per completed task, in the repo that owns it. A commit for repo A's task inside repo B means the boundary broke.
4. For each shared contract the participants touched (types, API shapes, schemas, env vars), check both sides agree. Name the file on each side.

**OUTPUT:**
\`\`\`
COVERAGE: [done]/[total] · [unclaimed] never claimed · [blocked] blocked
BY REPO: [repo — done/total, suite pass/fail, commits]
INTERFACE: [agreed and implemented on both sides / MISMATCH — what differs]

OUTSTANDING — one line each: id, title, the repo that should own it, and why it is open:
- [task-id] [title] — [repo] — [never claimed / blocked by X / ran out of rounds]
\`\`\`

Count a task as done only if it is DONE, its repo's suite is green and the interface it touches matches on both sides. The engine reads COVERAGE: while tasks are open the run goes back to the confer with your OUTSTANDING list, so make each line something a participant can pick up.`,
      }, [s1, s2]);

    step(wfId, s4, 'Notify', 'Confer complete.', 300, 575, 'connector',
      { connectorType: 'system-notify', title: 'Confer — Done', message: 'The cartridges have finished conferring. Check NeonCore for the coverage report.' }, [s3]);
  }
}
