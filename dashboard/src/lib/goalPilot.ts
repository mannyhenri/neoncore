/**
 * Goal Pilot — the decisions the panel makes, as pure functions so they can be tested without
 * rendering. The server is the authority on every rule here (lib/goal-pilot.ts); these mirror it
 * so the UI can say "this is missing" BEFORE the request is refused, never to replace the check.
 */
import type {
  Agent, Goal, GoalPilot, PilotAnswer, PilotPhase, PilotQuestion, PilotProposedStage, PilotStage, PilotCandidateRepo,
  AcceptanceContract, CriterionOutcome, VerifyMethod,
} from '../types';

/** The five steps the person sees. The phases map onto them. */
export const PILOT_STEPS = ['Feature', 'Scope', 'Workflows', 'Repos', 'Run'] as const;

export function stepIndexFor(phase: PilotPhase): number {
  switch (phase) {
    case 'scoping':
    case 'clarifying':
      return 1;
    case 'planning':
    case 'proposed':
      return 2;
    case 'staffing':
      return 3;
    default:
      return 4;
  }
}

/** A pilot that is still steering its goal. Completed and cancelled ones are history. */
export function isLivePilot(p: Pick<GoalPilot, 'phase'>): boolean {
  return p.phase !== 'completed' && p.phase !== 'cancelled';
}

/** Is the panel waiting on the planner cartridge right now? */
export function waitingOnPlanner(p: Pick<GoalPilot, 'phase'>): boolean {
  return p.phase === 'scoping' || p.phase === 'planning';
}

/**
 * What "let the agents decide" resolves to — same rule as the server's suggestionValue: a
 * multi-select suggestion is split only when every piece is a real option.
 */
export function suggestionFor(q: PilotQuestion): string | string[] {
  if (q.kind !== 'multi') return q.suggested;
  if (!q.suggested) return [];
  if (q.options.includes(q.suggested)) return [q.suggested];
  const pieces = q.suggested.split(/\s*,\s*/).filter(Boolean);
  return pieces.every((p) => q.options.includes(p)) ? pieces : [q.suggested];
}

export function isEmptyAnswer(a: PilotAnswer | undefined): boolean {
  if (!a) return true;
  if (a.delegated) return false;
  return Array.isArray(a.value) ? a.value.length === 0 : !String(a.value ?? '').trim();
}

/** Required questions with neither an answer nor a delegation — the server refuses these. */
export function missingRequired(questions: PilotQuestion[], answers: Record<string, PilotAnswer>): PilotQuestion[] {
  return questions.filter((q) => q.required && isEmptyAnswer(answers[q.id]));
}

/** "Accept every suggestion" — answers untouched questions with the planner's recommendation. */
export function acceptSuggestions(questions: PilotQuestion[], answers: Record<string, PilotAnswer>): Record<string, PilotAnswer> {
  const next = { ...answers };
  for (const q of questions) {
    if (!isEmptyAnswer(next[q.id])) continue;
    const v = suggestionFor(q);
    if (Array.isArray(v) ? v.length : v) next[q.id] = { value: v };
  }
  return next;
}

export function answerLabel(_q: PilotQuestion, a: PilotAnswer | undefined): string {
  if (!a) return '—';
  const v = Array.isArray(a.value) ? a.value.join(', ') : a.value;
  if (a.delegated) return v ? `Agents decide → ${v}` : 'Agents decide';
  return v || '—';
}

export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** The stages the person is about to accept, as the server wants them. */
export interface DraftStage extends PilotProposedStage { include: boolean }

export function draftStagesFrom(stages: PilotProposedStage[]): DraftStage[] {
  return stages.map((s) => ({ ...s, include: true }));
}

export function includedStages(stages: DraftStage[]): PilotProposedStage[] {
  return stages.filter((s) => s.include).map(({ include: _include, ...s }) => s);
}

/**
 * Online cartridges that can plan (or read a codebase): those in the project's repos first (they can
 * read the code the work is about), then ones not in Manual mode (which would stop for approval on
 * every command), then Claude first (it has the MCP tool built in), then newest.
 */
export function plannerCandidates(agents: Agent[], preferRepos: string[] = []): Agent[] {
  const rank = (a: Agent) => (a.agentType === 'claude' ? 0 : a.agentType === 'codex' ? 1 : 2);
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const mine = new Set(preferRepos.map(norm));
  const inProject = (a: Agent) => (mine.has(norm(a.repoPath || '')) ? 0 : 1);
  // A cartridge in Manual mode stops for a person on every command — reading a repo included — so
  // one that can work unattended is offered first. It stays in the list: it is still a valid choice.
  const attended = (a: Agent) => (a.mode === 'manual' ? 1 : 0);
  return agents
    .filter((a) => a.status !== 'offline')
    .sort((x, y) => inProject(x) - inProject(y) || attended(x) - attended(y) || rank(x) - rank(y)
      || String(y.lastSeen ?? '').localeCompare(String(x.lastSeen ?? '')));
}

/** The engine a repo should default to: a live one first, Claude among equals. */
export function defaultEngine(repo: PilotCandidateRepo): string {
  const live = repo.engines.filter((e) => e.status !== 'offline');
  const pool = live.length ? live : repo.engines;
  return (pool.find((e) => e.agentType === 'claude') ?? pool[0])?.agentType ?? 'claude';
}

export function engineStatus(repo: PilotCandidateRepo | undefined, agentType: string): 'live' | 'offline' | 'none' {
  const e = repo?.engines.find((x) => x.agentType === agentType);
  if (!e) return 'none';
  return e.status === 'offline' ? 'offline' : 'live';
}

/** Every stage assigned to a chosen repo — the first one unless the person picked another. */
/**
 * The repos that work each TEAM stage together (a Confer stage). Default: every chosen repo; a
 * person's picks are kept only while those repos are still chosen. A team stage needs two or more
 * — `short` names the ones that have fewer, so the form can say so before the server refuses.
 */
export function resolveTeams(teamKeys: string[], repos: string[], picked: Record<string, string[]>):
  { teams: Record<string, string[]>; short: string[] } {
  const teams: Record<string, string[]> = {};
  const short: string[] = [];
  for (const k of teamKeys) {
    const mine = (picked[k] ?? repos).filter((r) => repos.includes(r));
    teams[k] = mine;
    if (mine.length < 2) short.push(k);
  }
  return { teams, short };
}

export function resolveAssignments(stageKeys: string[], repos: string[], picked: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of stageKeys) out[k] = picked[k] && repos.includes(picked[k]) ? picked[k] : repos[0] ?? '';
  return out;
}

/** The intake, pre-filled from a feature (goal) that already exists — nothing typed twice. */
export function intakeFromGoal(goal: Goal): Record<string, string> {
  const autonomyToInvolvement: Record<string, string> = {
    guided: 'hands-on', supervised: 'hands-on', collaborative: 'balanced', assisted: 'hands-off',
  };
  return {
    goal: goal.name,
    context: goal.description || '',
    done: goal.successMetric || '',
    constraints: [goal.noGos, goal.invariants].filter(Boolean).join('\n'),
    deadline: goal.targetDate || '',
    budgetUsd: goal.budgetUsd != null ? String(goal.budgetUsd) : '',
    involvement: autonomyToInvolvement[goal.autonomy || ''] || 'balanced',
    // A feature on a project's list is, by default, a feature — change it if it is a fix or a study.
    workType: 'feature',
  };
}

export const STAGE_TONE: Record<PilotStage['status'], string> = {
  pending: 'text-gray-500',
  waiting: 'text-amber-300',
  running: 'text-violet-300',
  review: 'text-amber-300',
  verifying: 'text-sky-300',
  completed: 'text-emerald-400',
  failed: 'text-red-400',
  skipped: 'text-gray-600',
  cancelled: 'text-gray-600',
};

export const STAGE_ICON: Record<PilotStage['status'], string> = {
  pending: '○', waiting: '◔', running: '◉', review: '◆', verifying: '◎', completed: '✓', failed: '✕', skipped: '↷', cancelled: '–',
};

/** "12s", "4m", "2h" — how long the planner has been thinking, for a person deciding whether to retry. */
export function since(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** One line for the pipeline header: "2 of 5 done · running: Build expenses". */
export function pipelineSummary(stages: PilotStage[]): string {
  const done = stages.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
  const current = stages.find((s) => s.status !== 'completed' && s.status !== 'skipped');
  const head = `${done} of ${stages.length} done`;
  if (!current) return head;
  const verb = current.status === 'running' ? (current.attention ? 'needs you' : 'running')
    : current.status === 'review' ? 'needs you'
    : current.status === 'verifying' ? (current.verifyState === 'tampered' || current.verifyState === 'error' ? 'needs you' : 'checking')
    : current.status === 'waiting' ? 'waiting' : current.status === 'pending' ? 'next' : current.status;
  return `${head} · ${verb}: ${current.title}`;
}

// ── the acceptance contract ─────────────────────────────────────────────────────

/** A criterion as the person edits it before accepting the plan. Ids follow position (AC-1…). */
export interface DraftCriterion { text: string; expect: string; verify: VerifyMethod }

/**
 * The criteria the plan step starts from: what was accepted, else what the planner proposed, else
 * one per line of the free-text acceptance criteria (a pilot from before criteria existed).
 */
export function draftCriteriaFrom(p: Pick<GoalPilot, 'plan' | 'criteria' | 'brief' | 'intake'>, defaultVerify: VerifyMethod = 'test'): DraftCriterion[] {
  const src = p.plan?.criteria?.length ? p.plan.criteria : p.criteria?.length ? p.criteria : null;
  if (src) return src.map(({ text, expect, verify }) => ({ text, expect, verify }));
  return String(p.brief?.acceptanceCriteria ?? '').split('\n').map((l) => l.replace(/^[-*•]\s*/, '').replace(/^AC-\d+:\s*/i, '').trim())
    .filter(Boolean).map((text) => ({ text, expect: '', verify: defaultVerify }));
}

export const criterionId = (index: number) => `AC-${index + 1}`;

/** What the server would refuse at accept — shown before the person clicks. */
export function criteriaProblems(list: DraftCriterion[]): string[] {
  const out: string[] = [];
  if (list.length === 0) out.push('Add at least one acceptance criterion — it is what "done" is judged against.');
  list.forEach((c, i) => {
    if (!c.text.trim()) out.push(`${criterionId(i)} has no text.`);
    else if (c.verify === 'test' && !c.expect.trim()) out.push(`${criterionId(i)} is checked by a test but does not say exactly what it expects.`);
  });
  return out;
}

export const OUTCOME_LABEL: Record<CriterionOutcome, string> = {
  pass: 'passing', fail: 'failing', 'not-run': 'not run yet', met: 'met', 'not-met': 'not met',
  unconfirmed: 'to confirm', 'not-checked': 'not checked yet', waived: 'not checked (tests skipped)',
};

export const OUTCOME_TONE: Record<CriterionOutcome, string> = {
  pass: 'text-emerald-300 border-emerald-600/50 bg-emerald-900/20', met: 'text-emerald-300 border-emerald-600/50 bg-emerald-900/20',
  fail: 'text-red-300 border-red-600/50 bg-red-900/20', 'not-met': 'text-red-300 border-red-600/50 bg-red-900/20',
  unconfirmed: 'text-amber-300 border-amber-600/50 bg-amber-900/20',
  'not-run': 'text-gray-400 border-white/15', 'not-checked': 'text-gray-400 border-white/15', waived: 'text-gray-500 border-white/10',
};

/** What the person must do about the contract right now, if anything. */
export type ContractAction = 'review-tests' | 'approval-blocked' | 'tampered' | 'confirm-checklist' | 'ask-again' | null;

export function contractAction(c: AcceptanceContract | null, stages: PilotStage[]): ContractAction {
  if (!c) return null;
  if (c.tamper) return 'tampered';
  if (c.status === 'review') return c.approval?.blocked ? 'approval-blocked' : c.approval ? null : 'review-tests';
  if (c.status === 'drafting' && c.request?.status === 'failed' && c.amending) return 'ask-again';
  if (stages.some((s) => s.kind === 'review' && s.status === 'review')) return 'confirm-checklist';
  return null;
}

/** One line for the contract's header. */
export function contractHeadline(c: AcceptanceContract): string {
  const tests = c.criteria.filter((x) => x.verify === 'test').length;
  const checks = c.criteria.length - tests;
  const what = [tests ? `${tests} test${tests === 1 ? '' : 's'}` : '', checks ? `${checks} checklist item${checks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ');
  switch (c.status) {
    case 'drafting': return c.amending ? `Amending ${c.amending.criterionIds.join(', ')} — the test is being rewritten` : `The acceptance tests are being written (${what})`;
    case 'review': return c.amending ? `Amended test for ${c.amending.criterionIds.join(', ')} — waiting for your approval` : `${what} written — waiting for your approval`;
    case 'waived': return 'Acceptance tests skipped — the test criteria will not be checked';
    default: return `Locked v${c.version} · ${what}`;
  }
}

/** How far a check in flight has got, for a progress line. */
export function activityLine(c: AcceptanceContract): string {
  const a = c.activity;
  if (!a) return '';
  const label = a.kind === 'baseline' ? 'Running the tests before any work' : a.kind === 'verify' ? 'Checking the stage\'s work against the locked tests' : 'Restoring the approved tests';
  return `${label}… ${a.done}/${a.total}`;
}
