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
import { REPORT_EXEMPT_TEMPLATES } from './digest-template.js';
import { randomUUID } from 'crypto';
import { RUN_REPORT_RESULT_MAX_CHARS, RUN_REPORT_TOTAL_MAX_CHARS } from './context-budget.js';
import { STEP_X, STEP_SPACING_Y } from './workflow-layout.js';

export const REPORT_STEP_NAME = 'Workflow Completion Report';

/** The marker. Detection is by this, never by step name — see the header. */
export const REPORT_STEP_KIND = 'workflow-report';

/**
 * A work step whose output belongs INSIDE the report, as its last section, instead of in a
 * window of its own: `executorConfig.reportAppendix = { title, path }`, with `path` relative
 * to the repo. The Daily AI Research Digest's render step is the case that forced it — one
 * run was landing as the digest window, a notification and the report window.
 *
 * Read at RUN time by buildRunReportContext, never baked into the report step's prompt: that
 * prompt is rewritten on every boot by ensureReportStepOnTemplates, which would erase it.
 */
export const REPORT_APPENDIX_KEY = 'reportAppendix';

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
/**
 * The stand-in for the run id inside the report prompt. A TEMPLATE has no run, so its stored
 * prompt necessarily carries a placeholder; `resolveRunPlaceholders` replaces it the moment a
 * run exists, which is at clone time.
 */
export const RUN_ID_PLACEHOLDER = '<workflowRunId>';

/**
 * Bake the run id into a step's prompt.
 *
 * WHY THIS IS NOT LEFT TO THE AGENT. The prompt below says "using the run id from the run
 * record above", and for a `claude-code` report step that record is genuinely above it —
 * `buildRunReportContext` puts it there. Every OTHER dispatch path builds its own prompt and
 * supplies no run record, and then the agent receives the literal string `<workflowRunId>` six
 * times and nothing to resolve it with.
 *
 * That is not hypothetical. Two agents in a conferred report step each wrote a real, complete
 * report and had to invent an id for the directory:
 *
 *   "runIdIsSubstituted": true
 *   "Aucun workflowRunId n'existe. L'API renvoie la tache avec la chaine LITTERALE
 *    « <workflowRunId> » non substituee, et /api/workflow/runs, /api/runs et
 *    /api/confer/<id>/state repondent 404."
 *
 * Both fell back to the confer's id, so both wrote the SAME invented directory — one report,
 * two repos, matching no run in the database. Nothing could ingest it and nothing could show
 * it in the journal, and from the outside that reads as "I got the same report several times
 * and it is not in the journal".
 *
 * Substituting at the source removes the question from every dispatch path at once, instead of
 * teaching each of them separately about a placeholder.
 */
export function resolveRunPlaceholders(config: string, runId: string): string {
  if (!runId || !config.includes(RUN_ID_PLACEHOLDER)) return config;
  return config.split(RUN_ID_PLACEHOLDER).join(runId);
}

// Compact on purpose. This was ~8.8k chars asking for a JSON file, a 9-section HTML page
// rendered from it, a browser window, a curl POST and the same JSON again on the completion
// call. The dashboard's Reports tab renders the JSON; the HTML was a second copy nobody read.
// It also never named the fields the app reads, so the status and counters were guesses.
// test/report-prompt-compact.test.ts derives the required fields from their consumers.
export const WORKFLOW_REPORT_PROMPT = `Produce the WORKFLOW COMPLETION REPORT for this run (the final step). Record what happened; do not start new work or fix what you find.

Evidence: the run record above, plus the repo itself (\`git status\`, \`git log\`, real build/test output). Never invent a result. "Finished" is not "succeeded" — the evidence decides.

Build ONE JSON object, concise and scannable in under a minute:
{
  "header": { "overallStatus": "SUCCESS" | "PARTIAL" | "FAILED" | "BLOCKED", "branch": "…", "commit": "…" },
  "executiveSummary": "2-4 plain sentences: what was asked, what was done, the biggest risk, what's next",
  "outcome": { "tasksCompleted": n, "tasksTotal": n, "testsPassed": n, "testsTotal": n, "issues": n, "humanActionsRequired": n },
  "whatChanged": ["<area>: <one line>", …],
  "issues": [{ "severity": "LOW|MEDIUM|HIGH|CRITICAL", "description": "…", "status": "…" }],
  "nextSteps": ["[HUMAN|AGENT] <specific action>", … at most 3],
  "humanActionRequired": "<what is needed from a person>" or null,
  "jira": null, or { "epic": "…", "tickets": [{ "key": "…", "relation": "Completed|Partial|Touched|Blocked" }] } only if tickets are linked
}
overallStatus reflects the real state of the work. Something NOT RUN is never counted as passed. Never mark a ticket Completed unless its acceptance criteria were met.

Deliver it ONCE: pass the object as the \`report\` argument of \`neoncore_report_step_done\`. Unless instructions above ask for a document, write no files and POST nothing else — the dashboard renders the JSON.
For this step, scope = "<n>/8 fields filled — <which are null and why>"; verify = the commands you ran to establish build/test status, with their real output.`;

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
  const updateCustom = db.prepare(`
    UPDATE workflow_steps SET depends_on = ?, position_y = ? WHERE id = ?
  `);

  const now = new Date().toISOString();
  let added = 0;
  let refreshed = 0;

  for (const tpl of templates) {
    const rows = db.prepare(
      'SELECT id, executor_type, executor_id, executor_config, depends_on, position_y FROM workflow_steps WHERE workflow_id = ?',
    ).all(tpl.id) as Record<string, unknown>[];
    if (rows.length === 0) continue;

    /**
     * Some workflows ARE their document. A completion report on top of one is a second
     * document about having produced the first — reported as "we only want to see the digest
     * at the end, not the report that we do for all the other workflows on top of it".
     *
     * REMOVES an existing step, not merely skips adding one: this function runs on every boot,
     * so a template that was given the step before the exemption existed would otherwise keep
     * it forever, and deleting the row by hand would be undone by the next restart.
     */
    if (REPORT_EXEMPT_TEMPLATES.includes(tpl.name)) {
      for (const r of rows) {
        let cfg: Record<string, unknown> = {};
        try { cfg = JSON.parse((r.executor_config as string) || '{}') || {}; } catch { cfg = {}; }
        if (!isReportStep(cfg)) continue;
        // Anything that depended on the report step must not be left pointing at a hole.
        const gone = r.id as string;
        for (const other of rows) {
          if (other.id === gone) continue;
          let deps: string[] = [];
          try { deps = JSON.parse((other.depends_on as string) || '[]') || []; } catch { deps = []; }
          if (!deps.includes(gone)) continue;
          db.prepare('UPDATE workflow_steps SET depends_on = ? WHERE id = ?')
            .run(JSON.stringify(deps.filter((x) => x !== gone)), other.id);
        }
        db.prepare('DELETE FROM workflow_steps WHERE id = ?').run(gone);
      }
      continue;
    }

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
      // A few templates use the report transport and journal contract but intentionally own
      // their report's content. Refreshing those with the generic prompt destroys the very
      // specialization their workflow exists to provide.
      if (existing.cfg.reportPromptManaged === false) {
        updateCustom.run(deps, lastY + STEP_SPACING_Y, existing.id);
        continue;
      }
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
   *
   * Unused since the report is delivered only through report_step_done (no curl block); kept so
   * callers and the import-cycle note above stay valid if a URL is ever needed here again.
   */
  _baseUrl = '',
): string {
  const wf = db.prepare(
    `SELECT w.id, w.name, w.description, w.status, w.run_number, w.initial_context,
            w.started_at, w.created_at, w.target_repos, p.name AS project_name
       FROM workflows w LEFT JOIN projects p ON p.id = w.project_id
      WHERE w.id = ?`,
  ).get(workflowId) as Record<string, unknown> | undefined;
  if (!wf) return '';

  const steps = db.prepare(
    `SELECT id, name, executor_type, executor_config, status, result, error, started_at, completed_at, depends_on
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

  const appendix = buildAppendixInstruction(others);

  return `${head.join('\n')}\n${joined}\n\n${appendix}---\n\n`;
}

/**
 * The "put this at the end" instruction for every step that declared a reportAppendix, or ''
 * when none did. The file is read by the report agent, on the cartridge that wrote it — the
 * server cannot see that disk.
 */
function buildAppendixInstruction(steps: Record<string, unknown>[]): string {
  const items: { step: string; title: string; path: string }[] = [];
  for (const s of steps) {
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(String(s.executor_config || '{}')) || {}; } catch { cfg = {}; }
    const a = cfg[REPORT_APPENDIX_KEY] as { title?: unknown; path?: unknown } | undefined;
    if (!a || typeof a.path !== 'string' || !a.path.trim()) continue;
    const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim() : String(s.name);
    items.push({ step: String(s.name), title, path: a.path.trim() });
  }
  if (items.length === 0) return '';

  const list = items.map((a) =>
    `- "${a.title}" — the file step "${a.step}" wrote at \`${a.path}\`. If the path has a date `
    + 'placeholder (YYYY-MM-DD), use the exact path that step reports in its result above.').join('\n');

  return [
    '### APPENDIX — THIS RUN PRODUCED A DOCUMENT',
    '',
    list,
    '',
    'Confirm each file exists and is non-empty, and list it in the report JSON as',
    '`appendix: [{ title, path, exists }]`. A missing or empty file is also an issue.',
    'Do not rewrite or embed its content.',
    '',
  ].join('\n');
}
