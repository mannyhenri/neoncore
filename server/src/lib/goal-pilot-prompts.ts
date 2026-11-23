/**
 * What the planner cartridge is asked. Two prompts: SCOPE (ask what is open, or write the brief)
 * and PIPELINE (propose the workflows that deliver it).
 *
 * Both end with a PILOT-DATA block: the same information as the prose, as JSON. A model reads
 * either; a script (the sandbox's simulated planner, or a future non-LLM planner) reads the JSON
 * without having to parse prose. The prose stays the authority for a model — it carries the
 * rules — and the JSON is built from the same values, so the two cannot disagree.
 *
 * The header line `[NeonCore goal pilot · <kind> request <id>]` is the stable marker a cartridge
 * (or the sandbox simulation) recognises the request by.
 */
import { featureStageProblem } from './feature-stages.js';
import { normalizeRepoPath } from './resolve-agent.js';
import db from '../db.js';
import { planScopeLines } from './plan-scope.js';
import { AUTH_CURL_HEADER, getServerBaseUrl } from './server-url.js';
import { availableTemplates } from './goal-decomposition.js';
import { skippableStepNames } from './stage-steps.js';
import {
  BRIEF_FIELDS, INTAKE_QUESTIONS, MAX_QUESTIONS_PER_ROUND, MAX_SCOPE_ROUNDS, MAX_STAGES,
  answerText, involvementOf, type GoalPilot, type PilotRequest,
} from './goal-pilot.js';
import {
  MAX_CRITERIA, MAX_FILES_PER_TEST, defaultVerify, criteriaToWrite, checklistCriteria,
  FEATURE_SIZES, CRITERION_RULES, featureSize,
  type AcceptanceContract, type Criterion,
} from './acceptance-contract.js';

export const PILOT_TOOL = 'neoncore_submit_goal_pilot';
export const PILOT_DATA_MARKER = 'PILOT-DATA';

export function requestHeader(kind: PilotRequest['kind'], requestId: string): string {
  return `[NeonCore goal pilot · ${kind} request ${requestId}]`;
}

function goalRow(goalId: string): Record<string, unknown> {
  return (db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown> | undefined) ?? {};
}

/**
 * The project the feature belongs to: what it is, which repos its work happens in, and the OTHER
 * features on its list. The siblings matter most — a project lists many features and each is scoped
 * on its own, so without them a planner happily folds the next three features into this one.
 */
/** How much of the project's architecture notes reaches a planner prompt. */
export const ARCHITECTURE_IN_PROMPT_MAX = 3000;

export function projectContext(goalId: string, featureRepos: string[] = []): { lines: string[]; data: Record<string, unknown> | null } {
  const g = goalRow(goalId);
  const pid = String(g.project_id || '');
  if (!pid) return { lines: [], data: null };
  const p = db.prepare('SELECT id, name, description, primary_repo, architecture FROM projects WHERE id = ?').get(pid) as
    { id: string; name: string; description: string; primary_repo: string; architecture: string } | undefined;
  if (!p) return { lines: [], data: null };
  const repos = [...new Set([p.primary_repo, ...((db.prepare('SELECT repo_path FROM project_cartridges WHERE project_id = ? ORDER BY repo_path').all(pid) as { repo_path: string }[]).map((r) => r.repo_path))].filter(Boolean))];
  const siblings = (db.prepare('SELECT id, name, status FROM goals WHERE project_id = ? AND id != ? ORDER BY position, created_at').all(pid, goalId) as { id: string; name: string; status: string }[]);
  const picked = new Set(featureRepos.map(normalizeRepoPath));
  const chosen = repos.filter((r) => picked.has(normalizeRepoPath(r)));
  const others = repos.filter((r) => !picked.has(normalizeRepoPath(r)));
  const archFull = (p.architecture || '').trim();
  const arch = archFull.length > ARCHITECTURE_IN_PROMPT_MAX ? `${archFull.slice(0, ARCHITECTURE_IN_PROMPT_MAX)}\n…(clipped)` : archFull;
  const lines = [
    `PROJECT: ${p.name}${p.description ? ` — ${p.description.replace(/\s+/g, ' ')}` : ''}`,
    // The repos this feature involves, when the person chose some (the rest of the project is out of scope).
    ...(repos.length && chosen.length
      ? [`Repos for THIS feature: ${chosen.join(', ')}`,
        ...(others.length ? [`Other repos in the project — not part of this feature, leave them alone: ${others.join(', ')}`] : [])]
      : repos.length ? [`Repos in this project: ${repos.join(', ')}`] : []),
    ...(siblings.length
      ? ['Other features on this project\'s list — each is scoped and built SEPARATELY, so they are OUT OF SCOPE here',
        '(do not plan them into this feature; note a dependency on one as an assumption):',
        ...siblings.slice(0, 20).map((f) => `  · ${f.name}${f.status === 'achieved' ? ' (done)' : ''}`)]
      : []),
    // How the product is built — written when the project was taken on (lib/project-import.ts) or by a
    // person. Clipped: it grounds the questions; the repo itself is still the authority.
    ...(arch ? ['HOW THE PRODUCT IS BUILT (the project\'s architecture notes — check the code where it matters):', arch] : []),
  ];
  return { lines, data: { id: p.id, name: p.name, description: p.description, repos, featureRepos: chosen, otherFeatures: siblings.map((f) => f.name), architecture: arch } };
}

function intakeLines(pilot: GoalPilot): string[] {
  return INTAKE_QUESTIONS
    .filter((q) => pilot.intake[q.key])
    .map((q) => {
      const v = pilot.intake[q.key];
      const label = q.options?.find((o) => o.value === v)?.label;
      return `- ${q.label} ${label ? `${label}` : v.replace(/\s+/g, ' ')}`;
    });
}

/** Every answered question so far, in order — what the planner must never ask again. */
export function decisions(pilot: GoalPilot): { id: string; question: string; answer: string; delegated: boolean }[] {
  return pilot.rounds.flatMap((r) => r.questions
    .filter(() => r.answeredAt)
    .map((q) => ({ id: q.id, question: q.text, answer: answerText(q, r.answers[q.id]), delegated: !!r.answers[q.id]?.delegated })));
}

function completion(requestId: string, shape: string): string[] {
  const url = `"\${NEONCORE_URL:-${getServerBaseUrl()}}/api/goal-pilots/requests/${requestId}/submit"`;
  return [
    `SUBMIT with the MCP tool \`${PILOT_TOOL}\`, requestId "${requestId}", result = ${shape}`,
    `Fallback ONLY if that tool is unavailable: curl -s -X POST ${url} ${AUTH_CURL_HEADER} -H 'Content-Type: application/json' -d '{"result": <the result object>}'`,
    'If the submission is rejected, the reply says why — fix it and submit again.',
  ];
}

function dataBlock(data: unknown): string[] {
  return [
    '',
    `${PILOT_DATA_MARKER} (the same information as above, machine-readable):`,
    '```json',
    JSON.stringify(data),
    '```',
  ];
}

export function buildScopePrompt(pilot: GoalPilot, requestId: string): string {
  const goal = goalRow(pilot.goalId);
  const project = projectContext(pilot.goalId, pilot.featureRepos);
  // A project planned from a document (lib/plan-scope.ts): what it settled is decided, not asked.
  const documented = planScopeLines(pilot.goalId);
  const round = pilot.rounds.length + 1;
  const last = round >= MAX_SCOPE_ROUNDS;
  const asked = decisions(pilot);
  const involvement = involvementOf(pilot.involvement);

  return [
    requestHeader('scope', requestId),
    'You are the PLANNER for one FEATURE of a NeonCore project (NeonCore calls it a goal). You are not building anything: do not write code, do not',
    'edit files, do not create tasks or workflows.',
    '',
    'YOUR JOB: make the scope of this goal specific enough that the agents who execute it will NOT NEED TO',
    'ASK ANYTHING once work starts. Either ask the questions that are still open, or — when nothing that',
    'would change what gets built is still open — write the scope brief.',
    '',
    `FEATURE: ${goal.name ?? pilot.intake.goal ?? ''}`,
    ...(project.lines.length ? ['', ...project.lines] : []),
    ...(documented.lines.length ? ['', ...documented.lines] : []),
    '',
    'WHAT THE PERSON TOLD US:',
    ...intakeLines(pilot),
    `- While it runs they want to be: ${involvement.label} — ${involvement.hint}`,
    ...(asked.length
      ? ['', `DECIDED SO FAR (${pilot.rounds.length} round${pilot.rounds.length === 1 ? '' : 's'} of questions):`,
        ...asked.map((d) => `- ${d.question} → ${d.answer}`)]
      : []),
    '',
    `THIS IS ROUND ${round} OF AT MOST ${MAX_SCOPE_ROUNDS}.${last ? ' It is the LAST round: you MUST submit status "complete", and list anything still open under assumptions.' : ''}`,
    '',
    'HOW TO DECIDE',
    '- If you are in a repository that this goal concerns, read enough of it to ground your questions in',
    '  what actually exists (name the files or modules a question is about).',
    '- Ask only what changes what gets built, how it is verified, or what must not be touched: data,',
    '  placement, behaviour at the edges, permissions, what is deliberately left for later, how "done"',
    '  is checked. Do not ask about anything already answered above.',
    `- At most ${MAX_QUESTIONS_PER_ROUND} questions, fewest first-order questions that matter. Prefer "choice" with 2-5`,
    '  options and put your recommendation in `suggested` — the person can delegate a question to you,',
    '  and the suggestion is what then gets used.',
    '- An answer "left to the agents" is DECIDED: use the stated value and record it under assumptions.',
    '- A vague answer ("not sure", "tbd") to something that matters deserves one sharper follow-up.',
    ...(documented.settled
      ? ['- The planning document already settles this feature (above). Ask ONLY what it and the answers above leave open',
        '  AND would change what gets built. If nothing is left open, submit status "complete" NOW, in this round, with no',
        '  questions — the brief carries the document\'s decisions as written.']
      : []),
    '',
    'THE BRIEF (when you submit status "complete") has these fields. Multi-line fields: one item per line.',
    '- slug: short kebab-case name for the work (used for docs/<slug>/ paths)',
    ...BRIEF_FIELDS.filter((f) => f.key !== 'acceptanceCriteria').map((f) => `- ${f.key} (${f.label}): ${f.guidance}`),
    'Everything in the brief reaches every agent that works on this goal, so it must be grounded in what',
    'the person said — an invented requirement becomes an instruction somebody acts on.',
    '',
    'THE SIZE (`size`) sets how many acceptance criteria the work may have — a submission over it is rejected:',
    ...FEATURE_SIZES.map((x) => `- ${x.value}: at most ${x.maxCriteria} — ${x.hint}`),
    ...(featureSize(pilot.intake.size)
      ? [`The person sized this feature ${featureSize(pilot.intake.size)}: at most ${FEATURE_SIZES.find((x) => x.value === featureSize(pilot.intake.size))!.maxCriteria} criteria. Send "size": "${featureSize(pilot.intake.size)}".`]
      : ['Pick the smallest size that honestly fits and send it as "size".']),
    '',
    `THE ACCEPTANCE CRITERIA (\`criteria\`, never more than ${MAX_CRITERIA}) are what "done" is judged against — they become`,
    'a CONTRACT: tests are written for them BEFORE any work and locked, and NeonCore runs those checks itself.',
    ...CRITERION_RULES,
    'Each criterion:',
    '- text: one observable behaviour — "When <situation>, the system shall <result>."',
    '- expect: EXACTLY what is expected, concrete enough to assert: inputs → result, with real values',
    '  ("amount 12.50, category Travel, 2024-03-05 → listed under March 2024; March total shows 12.50").',
    '- verify: "test" when an automated test written for it can check it; "command" when one existing command',
    '  can (send it as `command`, run from the repo root — it passes when it exits 0); "checklist" when only judgement',
    `  can (research conclusions, wording, docs quality). Default for this work type: ${defaultVerify(pilot.intake.workType)}.`,
    'Cover what the person said "done" means — nothing more.',
    '',
    ...completion(requestId, 'EITHER'),
    '  { "status": "questions", "message": "<one line to the person>", "questions": [ { "id": "<slug>", "text": "...",',
    '    "why": "<what it changes>", "kind": "choice|multi|text|boolean", "options": ["..."], "suggested": "...", "required": true } ] }',
    '  OR',
    '  { "status": "complete", "message": "<one line>", "size": "small|medium|large", "brief": { "slug": "...", ' +
      BRIEF_FIELDS.filter((f) => f.key !== 'acceptanceCriteria').map((f) => `"${f.key}": "..."`).join(', ') + ' },',
    '    "criteria": [ { "text": "When …, the system shall …", "expect": "<inputs → exact result>", "verify": "test|command|checklist", "command": "<only for command>" } ] }',
    ...dataBlock({
      requestId, kind: 'scope', round, maxRounds: MAX_SCOPE_ROUNDS, maxQuestions: MAX_QUESTIONS_PER_ROUND,
      goal: { id: pilot.goalId, name: goal.name ?? '' },
      project: project.data,
      intake: pilot.intake,
      involvement: involvement.value,
      rounds: pilot.rounds.map((r) => ({
        round: r.round,
        questions: r.questions.map((q) => ({ ...q, answer: r.answers[q.id] ?? null })),
      })),
      briefFields: BRIEF_FIELDS.map((f) => f.key),
      defaultVerify: defaultVerify(pilot.intake.workType),
      maxCriteria: MAX_CRITERIA,
      sizes: Object.fromEntries(FEATURE_SIZES.map((x) => [x.value, x.maxCriteria])),
      size: featureSize(pilot.intake.size) || null,
    }),
  ].join('\n');
}

/**
 * Template name + the first sentence or two of its description — enough to choose by — and the
 * steps a stage may leave out (lib/stage-steps.ts), so the planner can drop what is not its job.
 */
export function templateCatalogue(): { name: string; description: string; skippable: string[] }[] {
  const rows = availableTemplates();
  return rows.map((t) => {
    const d = (db.prepare('SELECT description FROM workflows WHERE id = ?').get(t.id) as { description?: string } | undefined)?.description || '';
    const short = d.replace(/\s+/g, ' ').trim();
    const steps = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y, created_at').all(t.id) as Record<string, unknown>[];
    return {
      name: t.name,
      description: short.length > 220 ? `${short.slice(0, 219)}…` : short,
      skippable: [...new Set(skippableStepNames(steps))].filter((n) => !/^(notify|capture learnings)$/i.test(n)),
    };
  });
}

export function buildPipelinePrompt(pilot: GoalPilot, requestId: string): string {
  const goal = goalRow(pilot.goalId);
  const brief = pilot.brief!;
  const involvement = involvementOf(pilot.involvement);
  const size = brief.size;
  // Only what may be a stage of this feature is offered (lib/feature-stages.ts); a submission using
  // anything else is refused with the reason anyway.
  const catalogue = templateCatalogue().filter((t) => !featureStageProblem(t.name, size));
  const asked = decisions(pilot);

  return [
    requestHeader('pipeline', requestId),
    'You are the PLANNER for a NeonCore feature (goal) whose scope is now settled. Propose the WORKFLOWS that will',
    'deliver it, in the order they should run. You are not building anything: do not write code, do not',
    'edit files, do not start workflows.',
    '',
    `FEATURE: ${goal.name ?? ''}`,
    ...projectContext(pilot.goalId, pilot.featureRepos).lines,
    `WORK TYPE: ${pilot.intake.workType ?? 'unspecified'}`,
    `INVOLVEMENT: ${involvement.label} — ${involvement.hint}`,
    '',
    'SCOPE BRIEF:',
    `- slug: ${brief.slug}`,
    ...BRIEF_FIELDS.filter((f) => brief[f.key]).map((f) => `- ${f.label}:\n${brief[f.key].split('\n').map((l) => `    ${l}`).join('\n')}`),
    ...(asked.length ? ['', 'DECISIONS FROM SCOPING:', ...asked.map((d) => `- ${d.question} → ${d.answer}`)] : []),
    '',
    'AVAILABLE WORKFLOWS — use these EXACT names:',
    ...catalogue.map((t) => `  · ${t.name}${t.description ? ` — ${t.description}` : ''}${t.skippable.length ? `\n      steps you may leave out: ${t.skippable.join(' · ')}` : ''}`),
    '',
    'HOW THE PIPELINE RUNS — a feature is: write the tests → build → deliver.',
    '- Before your first stage, NeonCore has an agent write one FAILING test per "test" criterion and LOCKS',
    '  them once they fail before any work. After every stage NeonCore runs them itself. So do NOT propose a',
    '  workflow whose job is to write the acceptance tests — propose the ones that make them pass.',
    '- Then YOUR stages: the workflows that BUILD the feature. Nothing else. NeonCore does the rest itself:',
    '  · QA runs on the EPIC once most of its features are built — never a QA stage per feature;',
    '  · NeonCore opens the PR, merges it and removes the branch when the person marks the feature done —',
    '    never a stage (or a step) that opens a PR or ships;',
    '  · it reviews the checklist criteria with an independent reviewer and writes the report — no review',
    `    stage unless the feature is large (this one is ${size || 'medium'}), no write-up / Compound stage.`,
    '- Stages run one after another. Each runs to completion on a cartridge in a repo the person picks',
    '  next; the next stage starts when it finishes and is handed the earlier stages\' results.',
    '- Every stage receives the scope brief and the decisions above as its launch context, plus the',
    '  `focus` you write for it. Write `focus` as the instruction for THAT stage on THIS goal: what to',
    '  concentrate on, which paths to use (docs/<slug>/…), what it must hand to the next stage.',
    '- Workflow decision gates take their recommendation unless the person chose hands-on: give every stage',
    '  a clear `focus` so no gate needs them.',
    '- Confer is worked by TWO OR MORE cartridges in different repos together; the person assigns the',
    '  repos when staffing. Choose it when the work spans repos and the split is the hard part. To work',
    '  a whole Jira epic, put `JIRA EPIC: <KEY>` on the first line of its `focus`: it looks the epic up',
    '  and the run does not finish until every task in it is done (or the person accepts what is left).',
    '- Task-list workflows (Confer, Epic: Task by Task, Epic: Two Repos, CE Develop and Optimize) keep',
    '  a progress document at docs/progress/<ID>.md and do not end until every task is done.',
    '',
    'RULES',
    `- At most ${MAX_STAGES} stages. Prefer the fewest that deliver the whole scope — a short, honest`,
    '  pipeline beats a padded one. Mark stages that are useful but not essential `optional: true`.',
    '- Skip workflows whose job scoping already did (e.g. an interrogation/brainstorm phase) and say so.',
    '- ONE JOB PER STAGE, each job once. Do not plan two stages that do the same job, and do not split one',
    '  body of work into several build stages unless they are genuinely separate deliverables. A small feature',
    '  is usually ONE build stage.',
    '- A workflow runs ALL its steps unless you leave some out. Put in `skipSteps` the steps (exact names from',
    '  "steps you may leave out") that are not this stage\'s job on THIS goal — e.g. Security Review and',
    '  Performance & Accessibility in a stage that is a live run of engines. Leave out only what clearly does',
    '  not apply; when in doubt keep it. (Notify, and Capture Learnings when a Compound stage follows, are',
    '  left out by NeonCore already — do not list them.)',
    '- Name up to 4 alternatives you considered, with why they were not chosen.',
    '',
    ...completion(requestId, '{ "message": "<one line to the person>", "stages": [ { "template": "<exact name>", "title": "<short, for this goal>", "why": "...", "focus": "...", "optional": false, "skipSteps": [] } ], "alternatives": [ { "template": "<exact name>", "why": "..." } ] }'),
    ...dataBlock({
      requestId, kind: 'pipeline', maxStages: MAX_STAGES,
      goal: { id: pilot.goalId, name: goal.name ?? '' },
      intake: pilot.intake,
      involvement: involvement.value,
      brief,
      criteria: pilot.criteria ?? [],
      decisions: asked,
      templates: catalogue,
    }),
  ].join('\n');
}

/**
 * The goal is done: write the narrative for its report. The compiled report — every stage, its run
 * report, the decisions, the learnings, the open items — is the evidence, and the only evidence.
 */
export function buildReportPrompt(pilot: GoalPilot, requestId: string, report: Record<string, unknown>): string {
  const goal = goalRow(pilot.goalId);
  const stages = (report.stages as { position: number; title: string; template: string; status: string; runReport?: { executiveSummary?: string } | null; produced?: string }[]) ?? [];
  const { files: _files, ...data } = report;
  const acceptance = report.acceptance as { total: number; passing: number; testsUnchanged: boolean; criteria: { id: string; outcome: string; text: string }[] } | null | undefined;
  return [
    requestHeader('report', requestId),
    'The goal below has finished its pipeline. Write the SUMMARY for its goal report — the one document',
    'the person reads to learn what was done. You are not building anything: do not edit files, do not',
    'start work.',
    '',
    `GOAL: ${goal.name ?? ''}`,
    `DONE WHEN: ${goal.success_metric || '(not stated)'}`,
    '',
    'WHAT EACH STAGE RECORDED:',
    ...stages.map((s) => `- ${s.position}. ${s.title} (${s.template}) — ${s.status}: ${String(s.runReport?.executiveSummary || s.produced || 'no report').replace(/\s+/g, ' ').slice(0, 400)}`),
    ...(acceptance && acceptance.total ? [
      '',
      `ACCEPTANCE CRITERIA — NeonCore's OWN evidence (it ran the locked tests itself): ${acceptance.passing} of ${acceptance.total} pass.`,
      ...acceptance.criteria.map((c) => `- ${c.id} ${c.outcome.toUpperCase()}: ${c.text}`),
      `Locked tests ${acceptance.testsUnchanged ? 'unchanged since approval' : 'were changed during the work (see the report)'}.`,
      'This evidence outranks anything a stage said about itself: "done when" is met only if every criterion passes.',
    ] : []),
    '',
    'WRITE',
    '- summary: 3-6 plain sentences — what was asked, what was delivered, whether "done when" is met',
    '  according to the evidence, the biggest risk, and what is left. Judge from the records only: a',
    '  stage that did not complete did not deliver, and a test that was not run did not pass.',
    '- highlights: up to 6 one-line deliverables a person could go and check.',
    '- followUps: up to 6 concrete things still to do (confirmations, reviews, unfinished stages).',
    '',
    ...completion(requestId, '{ "summary": "...", "highlights": ["..."], "followUps": ["..."] }'),
    ...dataBlock({ requestId, kind: 'report', goal: { id: pilot.goalId, name: goal.name ?? '' }, report: data }),
  ].join('\n');
}

// ── the acceptance contract ───────────────────────────────────────────────────

const criterionLines = (list: Criterion[]) => list.flatMap((c) => [`- ${c.id}: ${c.text}`, `    expected: ${c.expect || '(not stated — infer the most literal reading of the text)'}`]);

/**
 * Stage 0 (and every change request / amendment): write one failing test per test-criterion.
 * Sent to a cartridge in the repo the tests will live in. The agent writes files; NeonCore reads
 * and hashes them when it submits, and nothing is locked until the person approves.
 */
export function buildTestsPrompt(pilot: GoalPilot, contract: AcceptanceContract, requestId: string): string {
  const goal = goalRow(pilot.goalId);
  const brief = pilot.plan?.brief ?? pilot.brief;
  const slug = brief?.slug || 'goal';
  const toWrite = criteriaToWrite(contract);
  // Command criteria have no file: they are not the writer's to touch, and not "locked files" either.
  const others = contract.tests.filter((t) => t.files.length && !toWrite.some((c) => c.id === t.criterionId));
  const previous = contract.draftTests.length ? contract.draftTests : contract.tests;
  return [
    requestHeader('tests', requestId),
    'You are writing the ACCEPTANCE TESTS for a NeonCore goal — BEFORE any of it is built. These tests are',
    'the contract the work will be judged by: the person reviews and locks them, and NeonCore runs them',
    'itself after every stage of the pipeline.',
    '',
    `GOAL: ${goal.name ?? ''}`,
    ...(brief ? [`SCOPE: ${brief.summary}`, ...(brief.inScope ? ['IN SCOPE:', brief.inScope] : [])] : []),
    `REPO: you are in it. Follow its own test conventions (framework, folders); if it has none, use acceptance/${slug}/.`,
    '',
    `WRITE ONE TEST FOR EACH OF THESE ${toWrite.length} CRITERIA:`,
    ...criterionLines(toWrite),
    ...(contract.amending
      ? ['', `THE PERSON UNLOCKED ${contract.amending.criterionIds.join(', ')} — reason: ${contract.amending.reason}`,
        'Rewrite ONLY the test(s) for these criteria. Do not touch any other test file.']
      : []),
    ...(others.length
      ? ['', 'THESE TESTS ARE LOCKED — do not modify them:', ...others.map((t) => `- ${t.criterionId}: ${t.files.map((f) => f.path).join(', ')}`)]
      : []),
    ...(contract.feedback
      ? ['', `THE PERSON REVIEWED YOUR PREVIOUS TESTS AND ASKED FOR CHANGES: ${contract.feedback}`,
        ...(previous.length ? ['Previous tests:', ...previous.filter((t) => toWrite.some((c) => c.id === t.criterionId)).map((t) => `- ${t.criterionId}: \`${t.command}\` [${t.files.map((f) => f.path).join(', ')}]`)] : [])]
      : []),
    '',
    'RULES',
    '- Encode the EXPECTED result exactly: assert the concrete values it states, not "it works".',
    '- Each test must FAIL right now — the behaviour does not exist yet. A test that already passes',
    '  proves nothing about this work: tighten it.',
    '- Do NOT implement anything and do NOT change product code: test files only (plus the smallest',
    '  fixtures they need). Name each after its criterion (e.g. ac-1-…).',
    '- For each criterion, ONE command that runs only its test from the repo root and exits 0 only when',
    `  it passes (e.g. \`node --test acceptance/${slug}/ac-1.test.mjs\`, \`pytest tests/acceptance/test_ac_1.py\`).`,
    '- Independent of each other, of the network and of real external services; no sleeps.',
    `- At most ${MAX_FILES_PER_TEST} files per criterion. Once approved, these files are LOCKED: NeonCore hashes them`,
    '  and stops the pipeline if anyone changes them. Write them as if they can never be edited.',
    '- If a criterion cannot be tested automatically, still submit your best test and say so in `notes`;',
    '  the person may switch it to a checklist item.',
    '',
    ...completion(requestId, '{ "tests": [ { "criterionId": "AC-1", "files": ["<repo-relative path>"], "command": "<one line>" } ], "notes": "..." }'),
    ...dataBlock({
      requestId, kind: 'tests', goal: { id: pilot.goalId, name: goal.name ?? '' }, slug,
      workType: pilot.intake.workType ?? '', repoPath: contract.repoPath,
      criteria: toWrite,
      locked: others.map((t) => ({ criterionId: t.criterionId, files: t.files.map((f) => f.path), command: t.command })),
      amending: contract.amending, feedback: contract.feedback,
      previous: previous.map((t) => ({ criterionId: t.criterionId, files: t.files.map((f) => f.path), command: t.command })),
    }),
  ].join('\n');
}

/**
 * The end of the pipeline: an INDEPENDENT cartridge judges the checklist criteria from the repo as it
 * is. It did not do the work, so it has no stake in the verdict; the person confirms each one.
 */
export function buildReviewPrompt(pilot: GoalPilot, contract: AcceptanceContract, requestId: string, stagesDone: { title: string; summary: string }[]): string {
  const goal = goalRow(pilot.goalId);
  const brief = pilot.plan?.brief ?? pilot.brief;
  const items = checklistCriteria(contract);
  return [
    requestHeader('review', requestId),
    'You are an INDEPENDENT REVIEWER for a NeonCore feature. Other agents did the work; you did not. Judge',
    'each criterion below against what ACTUALLY exists — read the files, run what you need to — and say',
    'whether it is met. Do NOT fix, edit or create anything: a reviewer who repairs the work is no longer',
    'independent.',
    '',
    `FEATURE: ${goal.name ?? ''}`,
    ...(brief ? [`SCOPE: ${brief.summary}`] : []),
    '',
    // The reviewer may be a cartridge in ANOTHER repo of the pipeline (it must not have done the
    // work). The criteria's paths and the locked tests are relative to the contract's repo.
    ...(contract.repoPath ? [`WHERE TO LOOK: ${contract.repoPath} — the paths in the criteria and the locked tests are relative to`,
      'that repository. If it is not the one you are in, read and run from there.', ''] : []),
    `CRITERIA TO JUDGE (${items.length}):`,
    ...criterionLines(items),
    ...(contract.tests.length ? ['', 'THE LOCKED ACCEPTANCE TESTS (you may run them as evidence; do not edit them):',
      ...contract.tests.map((t) => `- ${t.criterionId}: \`${t.command}\``)] : []),
    ...(stagesDone.length ? ['', 'WHAT THE STAGES SAY THEY DID (claims — check them, do not trust them):',
      ...stagesDone.map((s) => `- ${s.title}: ${s.summary.replace(/\s+/g, ' ').slice(0, 300)}`)] : []),
    '',
    'FOR EACH CRITERION',
    '- verdict: "met" only if you found it met, as expected; otherwise "not-met".',
    '- evidence: what you checked and what you found — file paths, the command you ran and its result,',
    '  the exact passage. "Looks good" is not evidence.',
    '',
    ...completion(requestId, '{ "verdicts": [ { "criterionId": "AC-3", "verdict": "met|not-met", "evidence": "..." } ] }'),
    ...dataBlock({
      requestId, kind: 'review', goal: { id: pilot.goalId, name: goal.name ?? '' }, slug: brief?.slug ?? '', repoPath: contract.repoPath ?? '',
      criteria: items, stages: stagesDone,
      tests: contract.tests.map((t) => ({ criterionId: t.criterionId, command: t.command })),
    }),
  ].join('\n');
}
