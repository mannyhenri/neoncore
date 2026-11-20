/**
 * GOAL PILOT — a goal run as a managed pipeline of workflows. See docs/GOAL-PILOT.md.
 *
 *   1. INTAKE      the person answers a few general questions (INTAKE_QUESTIONS)
 *   2. SCOPING     a planner cartridge reads them and asks whatever is still needed for the scope
 *                  to be specific enough that no agent has to ask anything once work starts —
 *                  for as many rounds as it takes (capped at MAX_SCOPE_ROUNDS)
 *   3. BRIEF       when nothing is left open, the planner writes the scope brief
 *   4. PIPELINE    the planner proposes which workflows, in which order, will deliver it
 *   5. ACCEPT      the person edits/accepts the brief and the pipeline
 *   6. STAFFING    the person names the repos (and engine per repo) that will execute it
 *   7. RUN         each workflow runs in turn (lib/goal-pilot-runner.ts)
 *
 * ── WHO DOES THE THINKING ──────────────────────────────────────────────────────────────
 * The same answer as goal-draft.ts and goal-decomposition.ts: a CARTRIDGE. NeonCore has no LLM
 * client, so steps 2-4 are prompts dispatched to the planner cartridge the person picked, which
 * submits its answer through the MCP tool `neoncore_submit_goal_pilot` (or the curl fallback).
 * The spend lands in session_usage, where the goal's cost rollup can see it. In the offline
 * sandbox the simulated agent CLI answers these prompts with scripted logic
 * (sandbox/sim/planner.mjs); everything between the prompt and the stored proposal is real.
 *
 * ── VALIDATION IS THE BOUNDARY ─────────────────────────────────────────────────────────
 * Everything a planner sends goes through `normalizeScopeResult` / `normalizePipelineResult`,
 * which keep what is usable and RECORD what they dropped. The notes are shown to the person:
 * a silently trimmed proposal presented as the planner's own output would make review a lie.
 *
 * ── NOTHING GENERATED BECOMES REAL WITHOUT A PERSON ────────────────────────────────────
 * Questions are only asked; the brief is only shown; the pipeline is only proposed. The goal's
 * fields change in `acceptPlan` (with whatever the person edited), and projects/runs come into
 * existence in `startPilot` — both explicit actions.
 */
import db from '../db.js';
import { randomUUID } from 'crypto';
import { availableTemplates, templateIdForName } from './goal-decomposition.js';
import { type Criterion, normalizeCriteria, acceptedCriteria, criteriaText, deleteContract } from './acceptance-contract.js';
import { skippableStepNames } from './stage-steps.js';

// ── registries ────────────────────────────────────────────────────────────────

export interface ChoiceOption { value: string; label: string; hint: string }

export const WORK_TYPES: ChoiceOption[] = [
  { value: 'feature', label: 'New feature', hint: 'Something users can do that they cannot today' },
  { value: 'bug', label: 'Bug fix', hint: 'Something behaves wrongly and should not' },
  { value: 'improvement', label: 'Improvement / refactor', hint: 'Make existing code better without changing what it does' },
  { value: 'performance', label: 'Performance', hint: 'Faster, cheaper, lighter — against a number' },
  { value: 'research', label: 'Research / strategy', hint: 'Answer a question or decide a direction' },
  { value: 'quality', label: 'QA / testing', hint: 'Find out what is broken and how well it is covered' },
  { value: 'docs', label: 'Docs / release', hint: 'Documents you ship or keep' },
];

/**
 * How much the person wants to be asked while the pipeline runs. ONE choice, two effects:
 * the goal's autonomy line (an instruction in every dispatched prompt, lib/goal-pm.ts) and the
 * posture each run starts in (what the run may settle without a person, lib/autonomy.ts).
 * Two separate knobs for one intent is how they end up contradicting each other.
 */
export const INVOLVEMENT_LEVELS = [
  {
    value: 'hands-on', label: 'Hands-on', goalAutonomy: 'supervised', runAutonomy: 'manual',
    hint: 'Every gate, decision and held step waits for you.',
  },
  {
    value: 'balanced', label: 'Balanced', goalAutonomy: 'collaborative', runAutonomy: 'advance',
    hint: 'Held steps advance on their own; decisions and agent questions wait for you.',
  },
  {
    value: 'hands-off', label: 'Hands-off', goalAutonomy: 'assisted', runAutonomy: 'full',
    hint: 'Decisions are settled for you too (reversible for 5 minutes). Only breakage stops it.',
  },
] as const;
export type Involvement = (typeof INVOLVEMENT_LEVELS)[number]['value'];

export function involvementOf(v: unknown): (typeof INVOLVEMENT_LEVELS)[number] {
  return INVOLVEMENT_LEVELS.find((l) => l.value === v) ?? INVOLVEMENT_LEVELS[1];
}

export interface IntakeQuestion {
  key: string;
  label: string;
  help: string;
  kind: 'text' | 'textarea' | 'choice' | 'date' | 'number';
  required: boolean;
  placeholder?: string;
  options?: ChoiceOption[];
}

/**
 * THE GENERAL QUESTIONS. One registry drives the form, the validation and the planner prompt,
 * so a question added here is asked, checked and read by the planner without touching anything
 * else.
 */
export const INTAKE_QUESTIONS: IntakeQuestion[] = [
  {
    key: 'goal', label: 'What is the feature?', kind: 'text', required: true,
    help: 'One sentence. It becomes the feature\'s name.',
    placeholder: 'Add an expenses tracking section to the app',
  },
  {
    key: 'context', label: 'What exists today, and what should change?', kind: 'textarea', required: true,
    help: 'A few sentences of background: the product, where things stand, what prompted this.',
    placeholder: 'Our bookkeeping app tracks income per invoice but expenses live in a spreadsheet…',
  },
  {
    key: 'workType', label: 'What kind of work is it?', kind: 'choice', required: true,
    help: 'Decides which questions get asked and which workflows fit.', options: WORK_TYPES,
  },
  {
    key: 'audience', label: 'Who is it for?', kind: 'text', required: false,
    help: 'The people who will use or notice the result.', placeholder: 'Small-business owners using the web app',
  },
  {
    key: 'done', label: 'How will you know it is done?', kind: 'textarea', required: true,
    help: 'What you would check before calling it finished.',
    placeholder: 'I can add an expense, see it listed by month, and the totals are right',
  },
  {
    key: 'constraints', label: 'What must not change, or is off-limits?', kind: 'textarea', required: false,
    help: 'Behaviour that must keep working, areas nobody should touch, technology to avoid.',
  },
  { key: 'deadline', label: 'Target date', kind: 'date', required: false, help: 'Optional. Agents scope to fit it.' },
  { key: 'budgetUsd', label: 'Budget (USD)', kind: 'number', required: false, help: 'Optional spend ceiling for this feature — the pipeline pauses when it is reached.' },
  {
    key: 'involvement', label: 'How involved do you want to be while it runs?', kind: 'choice', required: true,
    help: 'You can change a single run\'s posture later from its card.',
    options: INVOLVEMENT_LEVELS.map(({ value, label, hint }) => ({ value, label, hint })),
  },
];

/**
 * The scope brief — what the planner writes once nothing is left open. `goalColumn` is where an
 * accepted field lands on the goal, which is what puts it in front of EVERY agent at dispatch
 * (lib/goal-brief.ts). Fields with no column travel in each stage's launch context instead.
 */
export interface BriefField {
  key: keyof PilotBrief;
  label: string;
  guidance: string;
  goalColumn: string | null;
}

export const BRIEF_FIELDS: BriefField[] = [
  { key: 'summary', label: 'Summary', goalColumn: 'description',
    guidance: 'Two or three sentences: the outcome, who it is for, and why now. No implementation detail.' },
  { key: 'successMetric', label: 'Done when', goalColumn: 'success_metric',
    guidance: 'One sentence naming the observable condition that means this goal is finished.' },
  { key: 'inScope', label: 'In scope', goalColumn: null,
    guidance: 'One line per deliverable, concrete enough that an agent knows exactly what to build.' },
  { key: 'acceptanceCriteria', label: 'Acceptance criteria', goalColumn: 'acceptance_criteria',
    guidance: 'EARS form, one per line: "When <trigger>, the system shall <response>." Each must be checkable.' },
  { key: 'invariants', label: 'Invariants', goalColumn: 'invariants',
    guidance: 'What must stay true throughout — behaviour that may not regress. One per line.' },
  { key: 'outOfScope', label: 'Out of scope (no-gos)', goalColumn: 'no_gos',
    guidance: 'Explicitly excluded work, one per line. Include what the person deferred to a later version.' },
  { key: 'rabbitHoles', label: 'Rabbit holes', goalColumn: 'rabbit_holes',
    guidance: 'Known traps for this work and how to avoid each. One per line.' },
  { key: 'assumptions', label: 'Assumptions', goalColumn: null,
    guidance: 'Anything decided on the person\'s behalf (questions they delegated). One per line.' },
];

export const MAX_SCOPE_ROUNDS = 4;
export const MAX_QUESTIONS_PER_ROUND = 10;
export const MAX_OPTIONS = 8;
export const MAX_STAGES = 8;
const QUESTION_KINDS = new Set(['choice', 'multi', 'text', 'boolean']);

// ── types ─────────────────────────────────────────────────────────────────────

export interface ScopeQuestion {
  id: string;
  text: string;
  why: string;
  kind: 'choice' | 'multi' | 'text' | 'boolean';
  options: string[];
  /** The planner's recommended answer — what "let the agents decide" resolves to. */
  suggested: string;
  required: boolean;
}

export interface Answer {
  value: string | string[];
  /** "Let the agents decide": the suggested answer is used and recorded as an assumption. */
  delegated?: boolean;
}

export interface ScopeRound {
  round: number;
  requestId: string;
  message: string;
  questions: ScopeQuestion[];
  answers: Record<string, Answer>;
  askedAt: string;
  answeredAt: string | null;
}

export interface PilotBrief {
  slug: string;
  summary: string;
  successMetric: string;
  inScope: string;
  acceptanceCriteria: string;
  invariants: string;
  outOfScope: string;
  rabbitHoles: string;
  assumptions: string;
}

export interface ProposedStage {
  key: string;
  template: string;
  title: string;
  why: string;
  focus: string;
  optional: boolean;
  /** Steps of the workflow this stage leaves out — not its job (lib/stage-steps.ts). */
  skipSteps: string[];
}

export interface PipelineProposal {
  message: string;
  stages: ProposedStage[];
  alternatives: { template: string; why: string }[];
}

export interface AcceptedPlan {
  brief: PilotBrief;
  stages: ProposedStage[];
  /** The numbered acceptance criteria, frozen here (lib/acceptance-contract.ts). */
  criteria: Criterion[];
}

export interface Staffing {
  repos: { repoPath: string; agentType: string }[];
}

/** A feature that runs on its own branch: a worktree + cartridge per repo (lib/feature-workspace.ts). */
export interface FeatureWorkspace {
  branch: string;
  repos: {
    /** The real repo (the project's). */
    repoPath: string;
    /** Where this feature's work happens: a git worktree of repoPath on `branch`. */
    worktreePath: string;
    agentType: string;
    /** The branch the feature started from, and its PR goes into (e.g. 'main'). */
    base: string;
    pr: { url: string; number: number; state: string } | null;
    /** Why the last PR attempt or cleanup did not complete for this repo ('' = it did). */
    error: string;
    /** The worktree was removed (after its PR merged). */
    removed: boolean;
  }[];
  prsAt: string | null;
}

export type PilotPhase =
  | 'scoping' | 'clarifying' | 'planning' | 'proposed' | 'staffing'
  | 'running' | 'paused' | 'completed' | 'cancelled';

/**
 * `review` — waiting for the PERSON (approve the acceptance tests, confirm checklist verdicts).
 * `verifying` — the stage's run is done; NeonCore is checking the locked tests against it.
 */
export type StageStatus = 'pending' | 'waiting' | 'running' | 'review' | 'verifying' | 'completed' | 'failed' | 'skipped' | 'cancelled';

/**
 *   workflow    a workflow run (the planner's pipeline)
 *   acceptance  stage 0: an agent writes one failing test per test-criterion; the person approves
 *   review      last: an independent cartridge judges the checklist criteria; the person confirms
 */
export type StageKind = 'workflow' | 'acceptance' | 'review';

/** After a workflow stage: '' (no contract to check) | pending | tampered | error | done. */
export type VerifyState = '' | 'pending' | 'tampered' | 'error' | 'done';

export interface PilotStage {
  id: string;
  position: number;
  kind: StageKind;
  key: string;
  templateId: string;
  template: string;
  title: string;
  why: string;
  focus: string;
  repoPath: string;
  agentType: string;
  /**
   * A stage worked by several cartridges together (a Confer stage): every participant's repo and
   * engine. Empty for a one-cartridge stage. The first participant is also repoPath/agentType.
   */
  participants: { repoPath: string; agentType: string }[];
  /** Steps of the workflow this stage leaves out, as planned (lib/stage-steps.ts). */
  skipSteps: string[];
  projectId: string;
  runId: string;
  agentId: string;
  status: StageStatus;
  waitReason: string;
  resultSummary: string;
  attempts: number;
  verifyState: VerifyState;
  requestId: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** The planner's narrative on top of the compiled goal report (lib/goal-pilot-report.ts). */
export interface ReportSummary {
  text: string;
  highlights: string[];
  followUps: string[];
  /** `planner` once the planner cartridge wrote it; `compiled` from the run reports until then. */
  source: 'planner' | 'compiled';
}

/** Every kind of request a pipeline sends a cartridge — the registry tests iterate. */
export const PILOT_REQUEST_KINDS = ['scope', 'pipeline', 'report', 'tests', 'review'] as const;
export type PilotRequestKind = (typeof PILOT_REQUEST_KINDS)[number];

export interface PilotRequest {
  id: string;
  pilotId: string;
  /** scope/pipeline/report go to the planner; tests to the test writer; review to the checklist reviewer. */
  kind: PilotRequestKind;
  round: number;
  status: 'pending' | 'ready' | 'failed' | 'superseded';
  agentId: string;
  notes: string[];
  error: string;
  queued: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface GoalPilot {
  id: string;
  goalId: string;
  phase: PilotPhase;
  plannerAgentId: string;
  intake: Record<string, string>;
  rounds: ScopeRound[];
  brief: PilotBrief | null;
  /** The planner's numbered acceptance criteria, proposed with the brief. */
  criteria: Criterion[] | null;
  proposal: PipelineProposal | null;
  plan: AcceptedPlan | null;
  staffing: Staffing | null;
  /** The project's repos this feature involves, chosen when it started ([] = all of them). */
  featureRepos: string[];
  /** Its own branch, a worktree + cartridge per repo, and the PRs (lib/feature-workspace.ts); null = runs in place. */
  workspace: FeatureWorkspace | null;
  involvement: Involvement;
  currentRequestId: string;
  attention: string;
  createdAt: string;
  updatedAt: string;
  planAcceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The goal report, once built (lib/goal-pilot-report.ts GoalReport). */
  report: Record<string, unknown> | null;
  reportAt: string | null;
}

export class PilotError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

// ── helpers ───────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/**
 * Multi-line text from whatever the planner sent. Models send lists as arrays as often as as
 * newline-joined strings; both are accepted, and arrays become one item per line.
 */
function lines(v: unknown): string {
  if (Array.isArray(v)) {
    return v.map((x) => str(x)).filter(Boolean).map((x) => x.replace(/^[-*•]\s*/, '')).map((x) => `- ${x}`).join('\n');
  }
  return str(v);
}

export function slugify(text: string, max = 40): string {
  const s = text.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, ' ').replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut;
}

const parse = <T>(s: unknown, fallback: T): T => {
  try { return s ? JSON.parse(s as string) as T : fallback; } catch { return fallback; }
};

// ── intake ────────────────────────────────────────────────────────────────────

/** Keep the registry's keys, trimmed; report what a required question is missing. */
export function normalizeIntake(raw: unknown): { intake: Record<string, string>; missing: string[] } {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const intake: Record<string, string> = {};
  const missing: string[] = [];
  for (const q of INTAKE_QUESTIONS) {
    let v = str(src[q.key]);
    if (q.kind === 'choice' && v && !q.options!.some((o) => o.value === v)) v = '';
    if (q.kind === 'number' && v && !Number.isFinite(Number(v))) v = '';
    if (q.kind === 'date') v = v.slice(0, 10);
    if (v) intake[q.key] = v;
    else if (q.required) missing.push(q.label);
  }
  return { intake, missing };
}

// ── planner output: scope ─────────────────────────────────────────────────────

export type ScopeResult =
  | { status: 'questions'; message: string; questions: ScopeQuestion[] }
  | { status: 'complete'; message: string; brief: PilotBrief; criteria: Criterion[] };

export interface Normalized<T> { value: T | null; notes: string[]; error: string }

/**
 * Coerce a scoping submission into questions or a brief, and say what was lost.
 *
 * `alreadyAsked` are question ids from earlier rounds: a planner re-asking something the person
 * already answered is the exact failure this feature exists to prevent, so those are dropped.
 */
export function normalizeScopeResult(raw: unknown, alreadyAsked: ReadonlySet<string> = new Set(), workType = ''): Normalized<ScopeResult> {
  const notes: string[] = [];
  const fail = (error: string): Normalized<ScopeResult> => ({ value: null, notes, error });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('the submission was not an object');
  const r = raw as Record<string, unknown>;
  const message = str(r.message);
  const status = str(r.status).toLowerCase();

  if (status === 'complete') {
    // Criteria may come on the result or inside the brief; the free-text acceptance criteria are the
    // fallback, one criterion per line.
    const b = r.brief && typeof r.brief === 'object' ? r.brief as Record<string, unknown> : null;
    const rawCriteria = Array.isArray(r.criteria) ? r.criteria : Array.isArray(b?.criteria) ? b!.criteria : undefined;
    const brief = normalizeBrief(r.brief, notes, Array.isArray(rawCriteria) && rawCriteria.length > 0);
    if (!brief) return fail('status "complete" needs a brief with at least a summary, and acceptance criteria');
    const criteria = normalizeCriteria(rawCriteria, { fallback: brief.acceptanceCriteria, workType }, notes);
    if (criteria.length === 0) return fail('status "complete" needs at least one acceptance criterion (`criteria`: [{ "text", "expect", "verify" }])');
    // One source of truth: the brief's text is written FROM the numbered criteria.
    brief.acceptanceCriteria = criteriaText(criteria);
    return { value: { status: 'complete', message, brief, criteria }, notes, error: '' };
  }
  if (status !== 'questions') return fail('status must be "questions" or "complete"');

  const rawQs = Array.isArray(r.questions) ? r.questions : [];
  if (rawQs.length > MAX_QUESTIONS_PER_ROUND) notes.push(`${rawQs.length} questions asked; kept the first ${MAX_QUESTIONS_PER_ROUND}`);
  const seen = new Set<string>();
  const questions: ScopeQuestion[] = [];
  rawQs.slice(0, MAX_QUESTIONS_PER_ROUND).forEach((rq, i) => {
    if (!rq || typeof rq !== 'object' || Array.isArray(rq)) { notes.push(`question ${i + 1} was not an object — dropped`); return; }
    const q = rq as Record<string, unknown>;
    const text = str(q.text);
    if (!text) { notes.push(`question ${i + 1} had no text — dropped`); return; }
    let id = slugify(str(q.id) || text, 48) || `q${i + 1}`;
    if (alreadyAsked.has(id)) { notes.push(`"${text}" was already answered in an earlier round — dropped`); return; }
    if (seen.has(id)) { const fresh = `${id}-${i + 1}`; notes.push(`question id "${id}" was reused — renamed to "${fresh}"`); id = fresh; }
    seen.add(id);

    let options = Array.isArray(q.options) ? [...new Set(q.options.map(str).filter(Boolean))] : [];
    if (options.length > MAX_OPTIONS) { notes.push(`"${text}" offered ${options.length} options; kept ${MAX_OPTIONS}`); options = options.slice(0, MAX_OPTIONS); }
    let kind = str(q.kind).toLowerCase() as ScopeQuestion['kind'];
    if (!QUESTION_KINDS.has(kind)) kind = options.length >= 2 ? 'choice' : 'text';
    if ((kind === 'choice' || kind === 'multi') && options.length < 2) {
      notes.push(`"${text}" was a ${kind} question with fewer than two options — asked as free text`);
      kind = 'text';
    }
    if (kind === 'boolean') options = ['Yes', 'No'];
    if (kind === 'text') options = [];

    let suggested = str(q.suggested);
    if (suggested && (kind === 'choice' || kind === 'boolean') && !options.includes(suggested)) {
      notes.push(`"${text}" suggested "${suggested}", which is not one of its options — suggestion dropped`);
      suggested = '';
    }
    questions.push({
      id, text, kind, options, suggested,
      why: str(q.why),
      required: q.required !== false,
    });
  });
  if (questions.length === 0) return fail('status "questions" with no usable questions — submit status "complete" with a brief instead');
  return { value: { status: 'questions', message, questions }, notes, error: '' };
}

export function normalizeBrief(raw: unknown, notes: string[] = [], hasCriteria = false): PilotBrief | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const brief = {} as PilotBrief;
  for (const f of BRIEF_FIELDS) brief[f.key] = lines(b[f.key]);
  if (!brief.summary || (!brief.acceptanceCriteria && !hasCriteria)) return null;
  const slug = slugify(str(b.slug) || brief.summary);
  if (str(b.slug) && slug !== str(b.slug)) notes.push(`slug "${str(b.slug)}" normalized to "${slug}"`);
  brief.slug = slug || 'goal';
  return brief;
}

// ── planner output: pipeline ──────────────────────────────────────────────────

/** Templates by validated name. Only live template rows can be proposed — see availableTemplates. */
export function normalizePipelineResult(raw: unknown): Normalized<PipelineProposal> {
  const notes: string[] = [];
  const fail = (error: string): Normalized<PipelineProposal> => ({ value: null, notes, error });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('the submission was not an object');
  const r = raw as Record<string, unknown>;
  const rawStages = Array.isArray(r.stages) ? r.stages : [];
  if (rawStages.length > MAX_STAGES) notes.push(`${rawStages.length} workflows proposed; kept the first ${MAX_STAGES}`);

  const byLower = new Map(availableTemplates().map((t) => [t.name.toLowerCase(), t.name]));
  const stages: ProposedStage[] = [];
  rawStages.slice(0, MAX_STAGES).forEach((rs, i) => {
    if (!rs || typeof rs !== 'object' || Array.isArray(rs)) { notes.push(`stage ${i + 1} was not an object — dropped`); return; }
    const s = rs as Record<string, unknown>;
    const asked = str(s.template);
    const template = byLower.get(asked.toLowerCase());
    if (!template) {
      notes.push(asked ? `stage ${i + 1} asked for the "${asked}" workflow, which does not exist — dropped` : `stage ${i + 1} named no workflow — dropped`);
      return;
    }
    stages.push({
      key: `s${stages.length + 1}`,
      template,
      title: str(s.title) || template,
      why: str(s.why),
      focus: str(s.focus),
      optional: s.optional === true,
      skipSteps: plannedSkips(template, s.skipSteps),
    });
  });
  if (stages.length === 0) return fail('no usable workflows were proposed');

  const alternatives = (Array.isArray(r.alternatives) ? r.alternatives : [])
    .map((a) => (a && typeof a === 'object' ? a as Record<string, unknown> : {}))
    .map((a) => ({ template: byLower.get(str(a.template).toLowerCase()) ?? '', why: str(a.why) }))
    .filter((a) => a.template && !stages.some((s) => s.template === a.template))
    .slice(0, 6);

  return { value: { message: str(r.message), stages, alternatives }, notes, error: '' };
}

// ── rows ──────────────────────────────────────────────────────────────────────

function rowToPilot(row: Record<string, unknown>): GoalPilot {
  return {
    id: row.id as string,
    goalId: row.goal_id as string,
    phase: row.phase as PilotPhase,
    plannerAgentId: (row.planner_agent_id as string) || '',
    intake: parse<Record<string, string>>(row.intake, {}),
    rounds: parse<ScopeRound[]>(row.rounds, []),
    brief: parse<PilotBrief | null>(row.brief, null),
    criteria: parse<Criterion[] | null>(row.criteria, null),
    proposal: parse<PipelineProposal | null>(row.proposal, null),
    plan: parse<AcceptedPlan | null>(row.plan, null),
    staffing: parse<Staffing | null>(row.staffing, null),
    featureRepos: parse<string[]>(row.feature_repos, []).filter((r) => typeof r === 'string' && r),
    workspace: parse<FeatureWorkspace | null>(row.workspace, null),
    involvement: involvementOf(row.involvement).value,
    currentRequestId: (row.current_request_id as string) || '',
    attention: (row.attention as string) || '',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    planAcceptedAt: (row.plan_accepted_at as string) ?? null,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
    report: parse<Record<string, unknown> | null>(row.report, null),
    reportAt: (row.report_at as string) ?? null,
  };
}

function rowToStage(row: Record<string, unknown>): PilotStage {
  return {
    id: row.id as string,
    position: row.position as number,
    kind: ((row.kind as string) || 'workflow') as StageKind,
    key: (row.stage_key as string) || '',
    templateId: (row.template_id as string) || '',
    template: (row.template_name as string) || '',
    title: (row.title as string) || '',
    why: (row.why as string) || '',
    focus: (row.focus as string) || '',
    repoPath: (row.repo_path as string) || '',
    agentType: (row.agent_type as string) || 'claude',
    participants: parse<{ repoPath: string; agentType: string }[]>(row.participants, [])
      .filter((p) => p && typeof p.repoPath === 'string' && p.repoPath.trim()),
    skipSteps: parse<string[]>(row.skip_steps, []).filter((n) => typeof n === 'string'),
    projectId: (row.project_id as string) || '',
    runId: (row.run_id as string) || '',
    agentId: (row.agent_id as string) || '',
    status: row.status as StageStatus,
    waitReason: (row.wait_reason as string) || '',
    resultSummary: (row.result_summary as string) || '',
    attempts: (row.attempts as number) || 0,
    verifyState: ((row.verify_state as string) || '') as VerifyState,
    requestId: (row.request_id as string) || '',
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
  };
}

function rowToRequest(row: Record<string, unknown>): PilotRequest {
  return {
    id: row.id as string,
    pilotId: row.pilot_id as string,
    kind: row.kind as PilotRequest['kind'],
    round: (row.round as number) || 0,
    status: row.status as PilotRequest['status'],
    agentId: (row.agent_id as string) || '',
    notes: parse<string[]>(row.notes, []),
    error: (row.error as string) || '',
    queued: !!row.queued,
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string) ?? null,
  };
}

export function getPilot(id: string): GoalPilot | null {
  const row = db.prepare('SELECT * FROM goal_pilots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToPilot(row) : null;
}

export function pilotsForGoal(goalId: string): GoalPilot[] {
  return (db.prepare('SELECT * FROM goal_pilots WHERE goal_id = ? ORDER BY created_at DESC').all(goalId) as Record<string, unknown>[])
    .map(rowToPilot);
}

export function pilotsInPhase(...phases: PilotPhase[]): GoalPilot[] {
  const marks = phases.map(() => '?').join(',');
  return (db.prepare(`SELECT * FROM goal_pilots WHERE phase IN (${marks}) ORDER BY created_at`).all(...phases) as Record<string, unknown>[])
    .map(rowToPilot);
}

export function stagesOf(pilotId: string): PilotStage[] {
  return (db.prepare('SELECT * FROM goal_pilot_stages WHERE pilot_id = ? ORDER BY position').all(pilotId) as Record<string, unknown>[])
    .map(rowToStage);
}

export function getStage(stageId: string): PilotStage | null {
  const row = db.prepare('SELECT * FROM goal_pilot_stages WHERE id = ?').get(stageId) as Record<string, unknown> | undefined;
  return row ? rowToStage(row) : null;
}

export function getRequest(id: string): PilotRequest | null {
  const row = db.prepare('SELECT * FROM goal_pilot_requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToRequest(row) : null;
}

export function requestPrompt(id: string): string {
  return ((db.prepare('SELECT prompt FROM goal_pilot_requests WHERE id = ?').get(id) as { prompt?: string } | undefined)?.prompt) || '';
}

export function requestsOf(pilotId: string): PilotRequest[] {
  return (db.prepare('SELECT * FROM goal_pilot_requests WHERE pilot_id = ? ORDER BY created_at DESC').all(pilotId) as Record<string, unknown>[])
    .map(rowToRequest);
}

const now = () => new Date().toISOString();

export function setPhase(pilotId: string, phase: PilotPhase, extra: { attention?: string } = {}): void {
  db.prepare('UPDATE goal_pilots SET phase = ?, attention = ?, updated_at = ? WHERE id = ?')
    .run(phase, extra.attention ?? '', now(), pilotId);
}

export function setAttention(pilotId: string, attention: string): void {
  db.prepare('UPDATE goal_pilots SET attention = ?, updated_at = ? WHERE id = ?').run(attention, now(), pilotId);
}

export function updateStage(stageId: string, fields: Partial<Record<
  'status' | 'wait_reason' | 'run_id' | 'agent_id' | 'project_id' | 'result_summary' | 'started_at' | 'completed_at' | 'attempts'
  | 'verify_state' | 'request_id',
  string | number | null>>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  db.prepare(`UPDATE goal_pilot_stages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), stageId);
}

/** Is a pilot still steering this goal? Only one may, or two pipelines would fight over it. */
export function activePilotForGoal(goalId: string): GoalPilot | null {
  return pilotsForGoal(goalId).find((p) => p.phase !== 'completed' && p.phase !== 'cancelled') ?? null;
}

// ── creation ──────────────────────────────────────────────────────────────────

export function createPilotRow(input: { goalId: string; plannerAgentId: string; intake: Record<string, string>; featureRepos?: string[] }): GoalPilot {
  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO goal_pilots (id, goal_id, phase, planner_agent_id, intake, involvement, feature_repos, created_at, updated_at)
     VALUES (?, ?, 'scoping', ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.goalId, input.plannerAgentId, JSON.stringify(input.intake), involvementOf(input.intake.involvement).value,
    JSON.stringify(input.featureRepos ?? []), t, t);
  return getPilot(id)!;
}

/** The requests answered by the pilot's PLANNER (the rest go to a stage's cartridge). */
export const PLANNER_KINDS: ReadonlySet<PilotRequest['kind']> = new Set(['scope', 'pipeline', 'report']);

export function createRequestRow(pilot: GoalPilot, kind: PilotRequest['kind'], agentId: string): PilotRequest {
  const id = randomUUID();
  const round = kind === 'scope' ? pilot.rounds.length + 1 : 0;
  const tx = db.transaction(() => {
    // A retry supersedes whatever was still outstanding, so a late answer to the old prompt
    // cannot overwrite the conversation the person has since moved on with.
    // Lanes: a planner request supersedes planner requests; a tests request, tests requests; a
    // review request, review requests — an amendment's test request must not cancel the reviewer.
    const lane = PLANNER_KINDS.has(kind) ? [...PLANNER_KINDS] : [kind];
    db.prepare(`UPDATE goal_pilot_requests SET status = 'superseded', completed_at = ?
                 WHERE pilot_id = ? AND status = 'pending' AND kind IN (${lane.map(() => '?').join(',')})`)
      .run(now(), pilot.id, ...lane);
    db.prepare(
      `INSERT INTO goal_pilot_requests (id, pilot_id, kind, round, status, agent_id, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(id, pilot.id, kind, round, agentId, now());
    // The test writer and the checklist reviewer are not the planner: their requests are tracked by
    // the contract and the review stage, and the pilot keeps its planner and its planner request.
    if (PLANNER_KINDS.has(kind)) {
      db.prepare('UPDATE goal_pilots SET current_request_id = ?, planner_agent_id = ?, updated_at = ? WHERE id = ?')
        .run(id, agentId, now(), pilot.id);
    }
  });
  tx();
  return getRequest(id)!;
}

export function setRequestPrompt(id: string, prompt: string, queued: boolean): void {
  db.prepare('UPDATE goal_pilot_requests SET prompt = ?, queued = ? WHERE id = ?').run(prompt, queued ? 1 : 0, id);
}

export function failRequest(id: string, error: string): void {
  db.prepare(`UPDATE goal_pilot_requests SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'pending'`)
    .run(error, now(), id);
  const req = getRequest(id);
  if (!req) return;
  const who = req.kind === 'tests' ? 'The acceptance-test request' : req.kind === 'review' ? 'The checklist review request' : 'The planner request';
  setAttention(req.pilotId, `${who} failed: ${error}`);
}

// ── transitions driven by the planner ─────────────────────────────────────────

export interface SubmitOutcome {
  request: PilotRequest;
  pilot: GoalPilot;
  /** True when the transition needs the pipeline request dispatched next (scope just completed). */
  needsPipeline: boolean;
  /** For a `report` request: the planner's summary, to be applied to the stored goal report. */
  summary?: ReportSummary;
}

const strList = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, max);

/**
 * The steps a stage asked to leave out that its workflow has AND may leave out (lib/stage-steps.ts),
 * spelled as the workflow spells them. Anything else is dropped: a skip list never breaks a run.
 */
export function plannedSkips(template: string, raw: unknown): string[] {
  const asked = new Set(strList(raw, 20).map((n) => n.toLowerCase()));
  if (asked.size === 0) return [];
  const templateId = templateIdForName(template);
  if (!templateId) return [];
  const steps = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(templateId) as Record<string, unknown>[];
  return skippableStepNames(steps).filter((n) => asked.has(n.toLowerCase()));
}

/** The planner's summary of a finished goal. `summary` is required; highlights and follow-ups are lists. */
export function normalizeReportSummary(raw: unknown): { value: ReportSummary | null; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: null, error: 'the submission was not an object' };
  const r = raw as Record<string, unknown>;
  const text = typeof r.summary === 'string' ? r.summary.trim() : '';
  if (!text) return { value: null, error: '`summary` is required: 3-6 sentences on what was done, how it went and what is left' };
  return { value: { text: text.slice(0, 3000), highlights: strList(r.highlights, 6), followUps: strList(r.followUps, 6), source: 'planner' }, error: '' };
}

/**
 * Record what the planner submitted and move the pilot on. Stores PROPOSALS only.
 *
 * Throws PilotError for a submission that cannot be used — with a message the planner can act
 * on, because it is passed back to it verbatim by the MCP tool.
 */
export function submitPlannerResult(requestId: string, raw: unknown): SubmitOutcome {
  const req = getRequest(requestId);
  if (!req) throw new PilotError('request not found', 404);
  if (req.status === 'superseded') throw new PilotError('this request was superseded by a newer one — nothing was recorded');
  if (req.status === 'ready') throw new PilotError('this request was already answered');
  const pilot = getPilot(req.pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  if (pilot.currentRequestId !== req.id) throw new PilotError('this request is no longer the one the pilot is waiting on');

  const finish = (status: 'ready' | 'failed', result: unknown, notes: string[], error: string) => {
    db.prepare('UPDATE goal_pilot_requests SET status = ?, result = ?, notes = ?, error = ?, completed_at = ? WHERE id = ?')
      .run(status, JSON.stringify(result ?? null), JSON.stringify(notes), error, now(), req.id);
  };

  if (req.kind === 'tests' || req.kind === 'review') {
    throw new PilotError('acceptance submissions are handled by lib/acceptance-runner.ts', 500);
  }

  if (req.kind === 'report') {
    const out = normalizeReportSummary(raw);
    if (!out.value) throw new PilotError(`submission rejected: ${out.error}`, 422);
    finish('ready', out.value, [], '');
    return { request: getRequest(req.id)!, pilot: getPilot(pilot.id)!, needsPipeline: false, summary: out.value };
  }

  if (req.kind === 'scope') {
    const asked = new Set(pilot.rounds.flatMap((r) => r.questions.map((q) => q.id)));
    const out = normalizeScopeResult(raw, asked, pilot.intake.workType ?? '');
    if (!out.value) {
      // Not recorded as a failure: the planner is told why and may submit again.
      throw new PilotError(`submission rejected: ${out.error}${out.notes.length ? ` (${out.notes.join('; ')})` : ''}`, 422);
    }
    if (out.value.status === 'questions' && pilot.rounds.length >= MAX_SCOPE_ROUNDS) {
      throw new PilotError(`submission rejected: ${MAX_SCOPE_ROUNDS} rounds of questions have been asked — submit status "complete" with a brief, and list anything still open under assumptions`, 422);
    }
    const v = out.value;
    const tx = db.transaction(() => {
      finish('ready', v, out.notes, '');
      if (v.status === 'questions') {
        const rounds: ScopeRound[] = [...pilot.rounds, {
          round: pilot.rounds.length + 1, requestId: req.id, message: v.message,
          questions: v.questions, answers: {}, askedAt: now(), answeredAt: null,
        }];
        db.prepare(`UPDATE goal_pilots SET rounds = ?, phase = 'clarifying', attention = '', updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(rounds), now(), pilot.id);
      } else {
        db.prepare(`UPDATE goal_pilots SET brief = ?, criteria = ?, phase = 'planning', attention = '', updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(v.brief), JSON.stringify(v.criteria), now(), pilot.id);
      }
    });
    tx();
    return { request: getRequest(req.id)!, pilot: getPilot(pilot.id)!, needsPipeline: v.status === 'complete' };
  }

  const out = normalizePipelineResult(raw);
  if (!out.value) throw new PilotError(`submission rejected: ${out.error}${out.notes.length ? ` (${out.notes.join('; ')})` : ''}`, 422);
  const tx = db.transaction(() => {
    finish('ready', out.value, out.notes, '');
    db.prepare(`UPDATE goal_pilots SET proposal = ?, phase = 'proposed', attention = '', updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(out.value), now(), pilot.id);
  });
  tx();
  return { request: getRequest(req.id)!, pilot: getPilot(pilot.id)!, needsPipeline: false };
}

// ── transitions driven by the person ──────────────────────────────────────────

/**
 * Validate and store the answers to the current round. Returns the pilot, now back in
 * `scoping` — the caller dispatches the next scope request.
 *
 * Every REQUIRED question needs an answer or an explicit delegation. An empty required answer is
 * refused here rather than sent on, because the next thing that would happen is the planner
 * asking it again.
 */
export function recordAnswers(pilotId: string, raw: unknown): GoalPilot {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  if (pilot.phase !== 'clarifying') throw new PilotError(`the pilot is ${pilot.phase}, not waiting for answers`);
  const round = pilot.rounds[pilot.rounds.length - 1];
  if (!round) throw new PilotError('there are no questions to answer');

  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const answers: Record<string, Answer> = {};
  const missing: string[] = [];
  for (const q of round.questions) {
    const a = src[q.id];
    const obj = a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : { value: a };
    const delegated = obj.delegated === true;
    let value: string | string[];
    if (q.kind === 'multi') {
      value = Array.isArray(obj.value) ? obj.value.map(str).filter(Boolean) : str(obj.value) ? [str(obj.value)] : [];
    } else {
      value = Array.isArray(obj.value) ? obj.value.map(str).filter(Boolean).join(', ') : str(obj.value);
    }
    const empty = Array.isArray(value) ? value.length === 0 : !value;
    if (delegated) {
      answers[q.id] = { value: empty ? suggestionValue(q) : value, delegated: true };
      continue;
    }
    if (empty) {
      if (q.required) missing.push(q.text);
      continue;
    }
    answers[q.id] = { value };
  }
  if (missing.length) {
    throw new PilotError(`answer these, or let the agents decide: ${missing.map((m) => `"${m}"`).join(', ')}`, 400);
  }

  const rounds = pilot.rounds.slice(0, -1).concat([{ ...round, answers, answeredAt: now() }]);
  db.prepare(`UPDATE goal_pilots SET rounds = ?, phase = 'scoping', attention = '', updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(rounds), now(), pilot.id);
  return getPilot(pilot.id)!;
}

/**
 * What "let the agents decide" resolves to. A multi-select suggestion often names several options
 * ("Unit tests, An end-to-end test"): it is split only when every piece is a real option, so an
 * option that itself contains a comma is never torn in half.
 */
export function suggestionValue(q: ScopeQuestion): string | string[] {
  if (q.kind !== 'multi') return q.suggested;
  if (!q.suggested) return [];
  if (q.options.includes(q.suggested)) return [q.suggested];
  const pieces = q.suggested.split(/\s*,\s*/).filter(Boolean);
  return pieces.every((p) => q.options.includes(p)) ? pieces : [q.suggested];
}

/** The answer as a sentence, for prompts and context. */
export function answerText(_q: ScopeQuestion, a: Answer | undefined): string {
  if (!a) return '(not answered)';
  const v = Array.isArray(a.value) ? a.value.join(', ') : a.value;
  if (a.delegated) return v ? `left to the agents — use: ${v}` : 'left to the agents';
  return v;
}

export interface PlanInput {
  brief?: Partial<Record<keyof PilotBrief, unknown>>;
  stages?: unknown;
  /** The acceptance criteria as the person edited them: [{ text, expect, verify }], renumbered AC-1…n. */
  criteria?: unknown;
}

/**
 * THE ONLY PATH from the planner's proposal to the goal. The person sends the brief as they
 * edited it and the stages in the order they want them; both are re-validated, the brief's goal
 * fields are written (an empty field leaves the goal's own value alone), and the pilot moves on
 * to staffing. Nothing runs yet.
 */
export function acceptPlan(pilotId: string, input: PlanInput): GoalPilot {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  if (pilot.phase !== 'proposed' && pilot.phase !== 'staffing') throw new PilotError(`the pilot is ${pilot.phase}; there is no proposal to accept`);
  if (!pilot.brief || !pilot.proposal) throw new PilotError('the planner has not proposed a plan yet');

  // The brief, as edited. Every field falls back to the planner's text only when the person did
  // not send it at all — sending '' is a decision to leave it empty.
  const sent = input.brief && typeof input.brief === 'object' ? input.brief : {};
  const brief = { ...pilot.brief };
  for (const f of BRIEF_FIELDS) {
    if (f.key in sent) brief[f.key] = lines((sent as Record<string, unknown>)[f.key]);
  }
  if ('slug' in sent) brief.slug = slugify(str(sent.slug)) || pilot.brief.slug;

  const rawStages = Array.isArray(input.stages) ? input.stages : pilot.proposal.stages;
  const live = new Map(availableTemplates().map((t) => [t.name.toLowerCase(), t.name]));
  const stages: ProposedStage[] = [];
  for (const rs of rawStages.slice(0, MAX_STAGES)) {
    if (!rs || typeof rs !== 'object') continue;
    const s = rs as Record<string, unknown>;
    const template = live.get(str(s.template).toLowerCase());
    if (!template) throw new PilotError(`the "${str(s.template)}" workflow does not exist (was it renamed or deleted?)`, 400);
    stages.push({
      key: `s${stages.length + 1}`, template,
      title: str(s.title) || template, why: str(s.why), focus: str(s.focus), optional: s.optional === true,
      skipSteps: plannedSkips(template, s.skipSteps),
    });
  }
  if (stages.length === 0) throw new PilotError('pick at least one workflow to run', 400);

  // The criteria are FROZEN here: numbered, each with its exact expected result and how it is
  // checked. A planner that sent none (or a pilot from before criteria existed) falls back to the
  // acceptance-criteria lines, which the person must then complete.
  const rawCriteria = Array.isArray(input.criteria) ? input.criteria
    : pilot.criteria?.length ? pilot.criteria
    : normalizeCriteria(undefined, { fallback: brief.acceptanceCriteria, workType: pilot.intake.workType });
  const { criteria, error } = acceptedCriteria(rawCriteria, pilot.intake.workType);
  if (error) throw new PilotError(error, 400);
  if (criteria.length === 0) throw new PilotError('write at least one acceptance criterion — it is what "done" is judged against', 400);
  brief.acceptanceCriteria = criteriaText(criteria);

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const f of BRIEF_FIELDS) {
    if (!f.goalColumn || !brief[f.key]) continue;
    sets.push(`${f.goalColumn} = ?`);
    values.push(brief[f.key]);
  }
  const tx = db.transaction(() => {
    if (sets.length) {
      db.prepare(`UPDATE goals SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now(), pilot.goalId);
    }
    db.prepare(`UPDATE goal_pilots SET plan = ?, phase = 'staffing', plan_accepted_at = ?, attention = '', updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ brief, stages, criteria } satisfies AcceptedPlan), now(), now(), pilot.id);
  });
  tx();
  return getPilot(pilot.id)!;
}

/** Back from staffing to the proposal — e.g. to change the order after seeing the repos. */
export function revisePlan(pilotId: string): GoalPilot {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  if (pilot.phase !== 'staffing') throw new PilotError(`the pilot is ${pilot.phase}; only an unstarted plan can be revised`);
  setPhase(pilot.id, 'proposed');
  return getPilot(pilot.id)!;
}

export { templateIdForName };

/** Remove a goal's pilots and everything under them — explicitly, rather than leaning on the cascade. */
export function deletePilotsForGoal(goalId: string): void {
  const ids = (db.prepare('SELECT id FROM goal_pilots WHERE goal_id = ?').all(goalId) as { id: string }[]).map((r) => r.id);
  for (const id of ids) deletePilotRows(id);
}

export function deletePilotRows(pilotId: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM goal_pilot_stages WHERE pilot_id = ?').run(pilotId);
    db.prepare('DELETE FROM goal_pilot_requests WHERE pilot_id = ?').run(pilotId);
    deleteContract(pilotId);
    db.prepare('DELETE FROM goal_pilots WHERE id = ?').run(pilotId);
  });
  tx();
}
