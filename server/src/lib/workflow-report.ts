/**
 * THE WORKFLOW COMPLETION REPORT — the step every workflow ends with.
 *
 * A workflow run leaves its account of itself scattered across step results, a journal
 * table and a websocket log. Nobody reads those. The question a project owner actually
 * has — did it work, what changed, is anything broken, is someone waiting on me — was
 * answerable only by a person willing to reconstruct it from twenty step outputs. So the
 * last thing every run does is write that answer down: one self-contained HTML page plus
 * the JSON it was rendered from, and then opens it. One file, one window.
 *
 * THREE DECISIONS THIS FILE ENCODES.
 *
 * 1. IT IS A PLAIN `claude-code` STEP, not a new executor type. A new type would need a
 *    branch in the executor, the normalizer, the canvas, the routing table and the engine
 *    router, and would still end up doing what a prompt does. The report is prose work; a
 *    prompt is the right shape for it.
 *
 * 2. THE PROMPT IS ENGINE-NEUTRAL, AND OPENS EXACTLY ONE WINDOW. The contract is "write the
 *    two files, then open the local HTML" — nothing else. Codex has no artifact tool, so an
 *    instruction to publish one would strand every Codex cartridge; and an engine that DOES
 *    have one must not use it here, because publishing alongside the local open lands the
 *    reader with two copies of the same report in two windows. One deliverable, one window.
 *
 * 3. IT IS DETECTED BY A MARKER, NEVER BY NAME. `executorConfig.stepKind` is what makes the
 *    idempotent pass idempotent. Matching on the step's title instead would re-append a
 *    second report the first time someone renames the step on the canvas, and the run would
 *    write its report twice with nothing to say which one was current.
 *
 * NO IMPORT OF `../db.js` HERE, DELIBERATELY. `db.ts` imports THIS module to run the
 * backfill at the bottom of its own module body. If this file imported db back, that cycle
 * would be evaluated with `db`'s default export still in TDZ and the server would die at
 * import — the exact shape of the boot crash documented against the goals migration in
 * db.ts. So the handle is passed in, the same way `armOnWork(db, ...)` takes it in
 * lib/work-standard.ts.
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { RUN_REPORT_RESULT_MAX_CHARS, RUN_REPORT_TOTAL_MAX_CHARS } from './context-budget.js';
import { STEP_X, STEP_SPACING_Y } from './workflow-layout.js';

export const REPORT_STEP_NAME = 'Workflow Completion Report';

/** The marker. Detection is by this, never by step name — see the header. */
export const REPORT_STEP_KIND = 'workflow-report';

export const REPORT_STEP_DESCRIPTION =
  'Renders the run as a self-contained HTML report (plus its JSON source) and opens it.';

/** A step that can carry the report, and whose executor the report inherits. */
const WORK_TYPES = new Set(['claude-code', 'command', '']);

/**
 * The canned prompt.
 *
 * It is long because the alternative is an agent inventing its own report format every run,
 * and a report whose shape changes every run is one nobody learns to read. The section order is
 * fixed so the same question is always answered in the same place.
 */
export const WORKFLOW_REPORT_PROMPT = `Produce the WORKFLOW COMPLETION REPORT for this run. This is the final step of the workflow.

This is a REPORTING step, not a work step. Do not start new feature work and do not fix problems you find — record them. "The workflow finished" and "the workflow succeeded" are different claims, and only the evidence decides which one this report makes.

The full run record is supplied above: every step, its status, its timings and its result. Treat it as the record of what happened. Anything it does not cover, check against the repository itself — \`git status\`, \`git log\`, the files on disk, and the real output of the build/test commands. Never invent a result you did not see.

═══════════ 1. WRITE THE DATA FIRST ═══════════

Build the report as STRUCTURED DATA first, then render the HTML from that same data. Two hand-written documents drift; one rendered from the other cannot contradict it.

Write both files to \`.neoncore/reports/<workflowRunId>/\` in the repo, using the run id from the run record above:

  .neoncore/reports/<workflowRunId>/workflow-report.json
  .neoncore/reports/<workflowRunId>/workflow-report.html

Do NOT commit them. Confirm \`.neoncore/\` is in \`.gitignore\` and add it if it is not.

The JSON is the source of truth and must carry every section below as data (\`schema\`, \`header\`, \`jira\`, \`executiveSummary\`, \`outcome\`, \`whatChanged\`, \`validation\`, \`issues\`, \`nextSteps\`, \`humanActionRequired\`, \`technical\`). Sections that legitimately do not apply are \`null\`, not omitted silently.

═══════════ 2. THE HTML ═══════════

One self-contained file: no external CSS, JS, fonts or images. It must render correctly opened from \`file://\`, and be legible in both light and dark (use \`prefers-color-scheme\` and set an explicit background on \`body\`).

It is written for an executive or project owner to scan in UNDER A MINUTE, with a developer able to expand the detail. Keep the default visible page to roughly one or two screens; everything deep goes into collapsed \`<details>\` sections. No walls of text. Never reproduce raw chain-of-thought — summarize decisions and their reasoning instead.

Status indicators, used consistently throughout:
  ✓ passed / completed     ⚠ warning / partial / blocked     ✕ failed     ○ not run / not started

REQUIRED SECTIONS, IN THIS ORDER:

1. HEADER — project, workflow/run name, the agent used (Claude Code / Codex / …), run id, overall status, start and end (or duration), environment if relevant, git branch, final commit if any.
   Overall status is exactly one of SUCCESS / PARTIAL / FAILED / BLOCKED and must reflect the real final state of the work, not merely that the agent finished executing.

2. JIRA CONTEXT — ONLY if Jira tickets or an Epic are associated with this run; omit the section entirely otherwise. Epic key, title, status, link. Then per ticket: key, title, type, Jira status, and its relationship to this workflow — one of Completed / Partial / Touched / Blocked / Not Started — plus a coverage line such as "2 Completed · 1 Partial · 1 Blocked". Never mark a ticket Completed unless its acceptance criteria were actually satisfied.

3. EXECUTIVE SUMMARY — 3–6 sentences of plain language, no implementation detail: what was asked, what was actually accomplished, whether the objective was met, the most important issue or risk, and what should happen next. Someone who reads only this section must understand the outcome.

4. OUTCOME / STATUS SUMMARY — a compact scorecard: tasks completed/total, tests passed/total, issues, warnings, human actions required. A "task" is a meaningful unit of work; do not inflate the count with internal steps.

5. WHAT CHANGED — grouped by functional area (Backend, Frontend, Database, API, Infrastructure, Configuration, Security, Tests, Documentation), listing only the areas actually touched. Short descriptions of what was done and why it matters. File-level detail belongs in Technical Details, not here.

6. VALIDATION & ISSUES — answers "how confident should we be that this is correct?". Show build, type check, unit tests, integration tests and lint each with an explicit status, then every meaningful issue with severity (INFO / LOW / MEDIUM / HIGH / CRITICAL), description, impact and current status. Distinguish Failed, Blocked, Not Run and Passed — something that was NOT RUN is never shown as passed.

7. NEXT STEPS — 3–5 prioritized, specific, actionable items, each labelled [HUMAN], [AGENT] or [EITHER]. "Run the authentication E2E suite against staging", not "continue testing". If nothing remains, say "No further action required."

8. HUMAN ACTION REQUIRED — ONLY when human intervention is genuinely needed, and then visually unmissable: credentials, deployment approval, a product decision, missing requirements, a migration review, infrastructure permissions, conflicting Jira requirements. Omit the section entirely otherwise.

9. TECHNICAL DETAILS — collapsed by default, with expandable subsections:
   · Files Changed — path, change type (Modified / Added / Deleted), short purpose.
   · Git — starting branch, starting commit, ending commit, commits created, PR if any, whether uncommitted changes remain.
   · Commands Executed — the meaningful ones with result, exit code and duration where known. Skip trivial exploratory commands.
   · Test Details — per suite: passed, failed, skipped, blocked.
   · Agent Decisions — only decisions that materially affected implementation or architecture: decision, reason, alternatives considered, impact.
   · Assumptions — assumptions that influenced the work. Any assumption that creates risk must ALSO appear in Validation & Issues.
   · Execution Log / Timeline — chronological, collapsed.

A reader must be able to answer, immediately: What were we trying to do? Did it work? What actually changed? How was it validated? Is anything broken or risky? Is someone waiting on me? What happens next? Which Jira work does this relate to?

═══════════ 3. OPEN IT — ONE WINDOW ═══════════

Open the local file with the platform opener, and report the command you used:
  macOS   open .neoncore/reports/<workflowRunId>/workflow-report.html
  Linux   xdg-open .neoncore/reports/<workflowRunId>/workflow-report.html
  Windows start .neoncore/reports/<workflowRunId>/workflow-report.html

The local HTML file IS the deliverable. Open exactly ONE window: do not also publish the page as a hosted artifact, upload it, or open a second copy anywhere. If the reader asks for a shareable link afterwards, that is a separate request.

═══════════ 4. SEND THE JSON BACK ═══════════

The two files you just wrote are on THIS cartridge's disk. NeonCore cannot see them, so a report that stops there is one nobody will ever find. POST the JSON to the journal, where it is kept per repo and can be read back later:

DO BOTH OF THESE. They are idempotent — the second one replaces the first rather than storing a duplicate — and between them the report reaches the journal on any engine.

1. RUN THE CURL. The exact command, with this run's real ids already filled in, is at the end of the Run Record above under "SENDING THE REPORT BACK". It prints an HTTP status: **201 means the report landed**. Put that status code in your \`verify\`. This is the path that works everywhere, so do not skip it.

2. ALSO pass it on the completion call. When you complete this step with \`neoncore_report_step_done\` (section 5), include the parsed JSON as the \`report\` argument:

    neoncore_report_step_done(stepId: "…", result: "…", scope: "…", verify: "…", report: <the parsed contents of workflow-report.json>)

If your copy of the tool does not accept a \`report\` argument it will be ignored silently — which is exactly why step 1 is not optional and why its status code goes in your verify.

Send the JSON you actually wrote, unmodified — the file is the source of truth and the stored copy has to match the HTML the reader is looking at. A 201 means it landed. Report the status code in your verify.

═══════════ 5. COMPLETING THIS STEP ═══════════

This is a work step, so NeonCore requires a real \`scope\` and \`verify\` from you. For a reporting step they mean:

  scope:  which of the 9 required sections you rendered, and which you legitimately omitted
          (Jira Context / Human Action Required) with the reason. e.g.
          "8/9 sections — Jira omitted, no tickets associated with this run"
  verify: the commands you actually ran and their real output — that the JSON parses, that
          both files exist, the POST's status code, and the command you used to open the HTML.
          e.g. "python3 -m json.tool .neoncore/reports/<id>/workflow-report.json > /dev/null → ok;
           ls -l .neoncore/reports/<id>/ → 2 files; POST …/report → 201;
           open …/workflow-report.html → exit 0"

Do not report verification you did not run.`;

/** The executorConfig every report step carries. The marker lives here. */
export function reportStepConfig(): Record<string, unknown> {
  return {
    stepKind: REPORT_STEP_KIND,
    // The whole run, not just this step's direct dependencies — see buildRunReportContext.
    reportContext: true,
    // Redundant with reportContext, and doubling the last steps' results into the prompt
    // only crowds out the run record.
    includeDepOutput: false,
    role: 'general',
    systemPromptMode: 'free',
    systemPrompt: '',
    loopCount: 1,
    prompt: WORKFLOW_REPORT_PROMPT,
  };
}

/** Is this step the completion report? By marker, never by name. */
export function isReportStep(executorConfig: Record<string, unknown> | undefined | null): boolean {
  return !!executorConfig && executorConfig.stepKind === REPORT_STEP_KIND;
}

/**
 * Append the completion report to a step list, unless one is already there.
 *
 * Same terminal-dependency logic as `withStandardGate` in routes/workflows.ts, and for the
 * same reason: the report depends on every TERMINAL step, so a parallel branch cannot still
 * be running while the run reports itself finished. Appending it to the last element of the
 * array would do exactly that.
 *
 * Skipped when the caller opts out, when the marker is already present, or when there is no
 * work step — a workflow of pure connectors has nothing to report on and no cartridge to
 * inherit, and a claude-code step with no executor fails at dispatch.
 */
export function withReportStep(
  steps: Record<string, unknown>[],
  opts: { skip?: boolean } = {},
): Record<string, unknown>[] {
  if (opts.skip) return steps;
  if (steps.some((s) => isReportStep(s.executorConfig as Record<string, unknown> | undefined))) return steps;

  const workSteps = steps.filter((s) => WORK_TYPES.has((s.executorType as string) || ''));
  if (workSteps.length === 0) return steps;

  const dependedOn = new Set<string>();
  for (const s of steps) {
    for (const dep of (s.dependsOn as string[] | undefined) || []) dependedOn.add(dep);
  }
  const terminal = steps.filter((s) => !dependedOn.has(s.id as string)).map((s) => s.id as string);

  // Inherit the executor from the last work step, so the report lands on a cartridge that
  // actually has the repo — it needs `git log` and the files on disk, not just the results.
  const executorId = (workSteps[workSteps.length - 1].executorId as string) || '';
  const lastY = Math.max(0, ...steps.map((s) => Number(s.positionY) || 0));

  return [
    ...steps,
    {
      id: `workflow-report-${randomUUID().slice(0, 8)}`,
      name: REPORT_STEP_NAME,
      description: REPORT_STEP_DESCRIPTION,
      executorType: 'claude-code',
      executorId,
      executorConfig: reportStepConfig(),
      dependsOn: terminal.length > 0 ? terminal : [steps[steps.length - 1].id],
      autoAdvance: true,
      positionX: STEP_X,
      // Provisional: layoutSteps recomputes the whole column once the graph is complete.
      positionY: lastY + STEP_SPACING_Y,
    },
  ];
}

/**
 * Give every template in the database a report step. Idempotent, runs on every boot.
 *
 * `seedDefaultTemplates()` deletes and re-inserts the standard templates on each boot, so
 * this has to run AFTER it or the report steps it just wrote are gone. It keys off the same
 * predicate the rest of the system uses for "this is a template" — `template_id IS NULL` —
 * which is what makes it cover the user-created templates already in an existing database
 * as well as the seeded ones. A hand-maintained list of names would cover the 23 seeded ones
 * and silently miss every template a user built on the canvas.
 *
 * Wrapped in ONE transaction. 63 of the server's test files — and every server in a
 * federation sharing a machine — import db.ts concurrently, so a reader can otherwise catch
 * this pass mid-flight and see a template whose report step is half written into the graph.
 * All-or-nothing is both cheaper and the only state worth exposing.
 *
 * A template that already carries the marker is REFRESHED in place rather than skipped, so a
 * change to the prompt or to the graph reaches every template and not just the seeded ones.
 *
 * Returns the number of templates that gained a NEW step (0 on a second run; refreshes are
 * logged separately, since a refresh is the steady state and would make the count meaningless).
 */
export function ensureReportStepOnTemplates(db: DatabaseType): number {
  // IMMEDIATE for the same reason db.ts's seed is — see the note there. A deferred
  // transaction cannot wait on the reader→writer upgrade, so busy_timeout never applies.
  return db.transaction(() => addReportSteps(db)).immediate();
}

function addReportSteps(db: DatabaseType): number {
  const templates = db.prepare(
    'SELECT id, name FROM workflows WHERE template_id IS NULL',
  ).all() as { id: string; name: string }[];

  const insert = db.prepare(`
    INSERT INTO workflow_steps
      (id, workflow_id, name, description, position_x, position_y,
       executor_type, executor_id, executor_config, auto_advance, depends_on, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'claude-code', ?, ?, 1, ?, ?)
  `);

  const update = db.prepare(`
    UPDATE workflow_steps
       SET executor_config = ?, depends_on = ?, position_y = ?, name = ?, description = ?
     WHERE id = ?
  `);

  const now = new Date().toISOString();
  let added = 0;
  let refreshed = 0;

  for (const tpl of templates) {
    const rows = db.prepare(
      'SELECT id, executor_type, executor_id, executor_config, depends_on, position_y FROM workflow_steps WHERE workflow_id = ?',
    ).all(tpl.id) as Record<string, unknown>[];
    if (rows.length === 0) continue;

    const parsed = rows.map((r) => {
      let cfg: Record<string, unknown> = {};
      try { cfg = JSON.parse((r.executor_config as string) || '{}') || {}; } catch { cfg = {}; }
      let deps: string[] = [];
      try { deps = JSON.parse((r.depends_on as string) || '[]') || []; } catch { deps = []; }
      return { id: r.id as string, type: (r.executor_type as string) || '', executorId: (r.executor_id as string) || '', cfg, deps, y: Number(r.position_y) || 0 };
    });

    const existing = parsed.find((p) => isReportStep(p.cfg));

    const workSteps = parsed.filter((p) => WORK_TYPES.has(p.type) && p.id !== existing?.id);
    if (workSteps.length === 0) continue;

    // Terminal EXCLUDING the report's own edges. Its dependencies are precisely what makes
    // those steps non-terminal, so counting them would recompute the set as empty.
    const dependedOn = new Set<string>();
    for (const p of parsed) {
      if (p.id === existing?.id) continue;
      for (const d of p.deps) dependedOn.add(d);
    }
    const terminal = parsed
      .filter((p) => p.id !== existing?.id && !dependedOn.has(p.id))
      .map((p) => p.id);

    const deps = JSON.stringify(
      terminal.length > 0 ? terminal : [parsed[parsed.length - 1].id],
    );
    const lastY = Math.max(0, ...parsed.filter((p) => p.id !== existing?.id).map((p) => p.y));

    // REFRESH, don't skip. The pass used to bail the moment it saw the marker, which meant an
    // improvement to the prompt reached the standard templates — seedDefaultTemplates deletes
    // and re-inserts their steps on every boot, so the pass writes them fresh — and never
    // reached a USER-created template, which kept whatever prompt it was built with. Found in
    // the live database: 23 of 24 report steps had the current prompt and the hand-built one
    // was a month behind. The step is machinery, not user content, so its config is ours to
    // keep current; its ID and its pinned cartridge are not, and survive.
    if (existing) {
      update.run(JSON.stringify(reportStepConfig()), deps, lastY + 175, REPORT_STEP_NAME,
        REPORT_STEP_DESCRIPTION, existing.id);
      refreshed++;
      continue;
    }

    // Templates defer their cartridge to launch time; inherit whatever the work steps use so
    // a template stays deferred and a concrete workflow keeps its agent.
    const executorId = workSteps[workSteps.length - 1].executorId || '__deferred__';

    insert.run(
      randomUUID(), tpl.id, REPORT_STEP_NAME, REPORT_STEP_DESCRIPTION,
      STEP_X, lastY + STEP_SPACING_Y,
      executorId, JSON.stringify(reportStepConfig()), deps, now,
    );
    added++;
  }

  if (refreshed > 0) {
    console.log(`[workflow-report] Refreshed ${refreshed} existing report step(s) to the current prompt`);
  }
  return added;
}

/**
 * The whole run, as prompt context.
 *
 * WITHOUT THIS THE REPORT IS CONFIDENTLY WRONG. `gatherDependencyContext` reads only a
 * step's DIRECT dependencies, and the report step is terminal — so it would see the last
 * step or two and nothing else, then write an authoritative-looking account of a twenty-step
 * run it never saw. A missing report is a gap; a fabricated one is a lie the reader has no
 * way to detect.
 *
 * Budgeted in the spirit of DEP_RESULT_MAX_CHARS / DEP_TOTAL_MAX_CHARS: a per-step cap so
 * one enormous result cannot crowd out the other nineteen, and a total cap so a long run
 * does not blow the prompt. Truncation is marked, never silent.
 */
export function buildRunReportContext(
  db: DatabaseType,
  workflowId: string,
  stepId: string,
  /**
   * The URL a cartridge can reach this server on. PASSED IN, not imported.
   *
   * lib/server-url.ts imports ../db.js, and db.ts imports THIS file to run its backfill — so
   * importing getServerBaseUrl here closed the cycle this file's header warns about, and db.ts
   * called ensureReportStepOnTemplates while this module's own consts were still in TDZ:
   * "Cannot access 'REPORT_STEP_KIND' before initialization", at import, on a fresh database.
   * The executor already holds this value.
   */
  baseUrl = '',
): string {
  const wf = db.prepare(
    `SELECT w.id, w.name, w.description, w.status, w.run_number, w.initial_context,
            w.started_at, w.created_at, w.target_repos, p.name AS project_name
       FROM workflows w LEFT JOIN projects p ON p.id = w.project_id
      WHERE w.id = ?`,
  ).get(workflowId) as Record<string, unknown> | undefined;
  if (!wf) return '';

  const steps = db.prepare(
    `SELECT id, name, executor_type, status, result, error, started_at, completed_at, depends_on
       FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y ASC, created_at ASC`,
  ).all(workflowId) as Record<string, unknown>[];

  const head: string[] = [
    '## Run Record — the authoritative account of this run',
    '',
    'This is what actually happened, step by step. Base the report on it, and check anything',
    'it does not cover against the repository itself.',
    '',
    `Workflow: ${wf.name || '(unnamed)'}`,
    `Run id: ${wf.id}`,
  ];
  if (Number(wf.run_number) > 0) head.push(`Run number: #${wf.run_number}`);
  if (wf.project_name) head.push(`Project: ${wf.project_name}`);
  head.push(`Run status at report time: ${wf.status || 'unknown'}`);
  if (wf.started_at) head.push(`Started: ${wf.started_at}`);
  head.push(`Report written: ${new Date().toISOString()}`);
  const repos = String(wf.target_repos || '[]');
  if (repos && repos !== '[]') head.push(`Target repos: ${repos}`);
  if (wf.description) head.push('', `Description:\n${wf.description}`);
  const ic = String(wf.initial_context || '').trim();
  if (ic) head.push('', `Initial context given at launch:\n${ic}`);

  // The report step itself is excluded: it is the step currently running, and listing it
  // invites the report to describe writing the report.
  const others = steps.filter((s) => s.id !== stepId);
  head.push('', `### Steps (${others.length})`, '');

  const body: string[] = [];
  for (let i = 0; i < others.length; i++) {
    const s = others[i];
    const started = (s.started_at as string) || '';
    const done = (s.completed_at as string) || '';
    const duration = started && done
      ? `${Math.max(0, Math.round((Date.parse(done) - Date.parse(started)) / 1000))}s`
      : '—';
    const lines = [
      `#### ${i + 1}. ${s.name}`,
      `type: ${s.executor_type || 'claude-code'} · status: ${s.status || 'pending'} · started: ${started || '—'} · completed: ${done || '—'} · duration: ${duration}`,
    ];
    if (s.error) lines.push(`error: ${String(s.error).slice(0, 400)}`);
    const raw = String(s.result || '');
    if (raw) {
      const shown = raw.length > RUN_REPORT_RESULT_MAX_CHARS
        ? raw.slice(0, RUN_REPORT_RESULT_MAX_CHARS) + `\n…[truncated ${raw.length - RUN_REPORT_RESULT_MAX_CHARS} chars]`
        : raw;
      lines.push('result:', shown);
    } else {
      lines.push('result: (none recorded)');
    }
    body.push(lines.join('\n'));
  }

  let joined = body.join('\n\n');
  if (joined.length > RUN_REPORT_TOTAL_MAX_CHARS) {
    joined = joined.slice(0, RUN_REPORT_TOTAL_MAX_CHARS)
      + '\n\n…[run record truncated — some step results above are incomplete. Say so in the report rather than guessing at what they contained.]';
  }

  // The POST command, with the real step id and the URL that actually reaches this server from
  // wherever the cartridge is. The canned prompt cannot carry these — it is one static string
  // shared by every run — and an agent asked to guess its own callback URL will guess
  // localhost, which on an off-box cartridge is itself. Same reasoning as buildCompletionSuffix.
  const base = baseUrl || '${NEONCORE_URL}';
  const send = [
    '### SENDING THE REPORT BACK',
    '',
    'Run this once both files are written. A 201 means the report reached the journal:',
    '',
    `    curl -s -o /dev/null -w '%{http_code}\\n' -X POST "\${NEONCORE_URL:-${base}}/api/workflows/webhook/${stepId}/report" \\`,
    "      -H 'Content-Type: application/json' \\",
    `      -d "$(python3 -c 'import json,sys; print(json.dumps({\"report\": json.load(open(sys.argv[1]))}))' .neoncore/reports/${wf.id}/workflow-report.json)"`,
    '',
  ].join('\n');

  return `${head.join('\n')}\n${joined}\n\n${send}\n---\n\n`;
}
