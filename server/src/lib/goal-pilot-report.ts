/**
 * THE GOAL REPORT — one artifact that says what a piloted goal actually did.
 *
 * Each workflow run already ends with its own completion report (lib/workflow-report.ts), filed in
 * the journal of the repo it ran in. A goal runs several workflows, possibly in several repos, so
 * the answer to "what was done for this goal?" was spread across N run reports, the scoping
 * conversation, the learnings table and the cost rollup — and nothing put it together. This does,
 * when the last stage finishes:
 *
 *   1. COMPILE the report from what was RECORDED — brief, decisions, every stage and its run's
 *      completion report, learnings, spend, open items. Deterministic, no model needed, so a goal
 *      always gets its report even if no planner is available.
 *   2. Ask the planner cartridge for the NARRATIVE summary on top (kind `report` request). Until it
 *      answers — or if it never does — a summary compiled from the run reports stands in, labelled
 *      as such.
 *
 * The report is stored on the pilot (JSON), rendered on demand as HTML and Markdown, and written
 * as files next to the database (`reports/goals/<goalId>/<pilotId>/`) so it survives as a
 * document. Nothing is written into the repos: those belong to the agents.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { goalCostUsd } from './goal-cost.js';
import { BRIEF_FIELDS, answerText, getPilot, stagesOf, type PilotBrief, type ReportSummary } from './goal-pilot.js';
import {
  getContract, criterionStates, contractVerdict, PASSING, type AcceptanceContract, type Amendment, type CriterionOutcome,
} from './acceptance-contract.js';

export interface StageRunReport {
  status: string;
  executiveSummary: string;
  whatChanged: string[];
  issues: { severity: string; description: string; status: string }[];
  nextSteps: string[];
  testsPassed: number | null;
  testsTotal: number | null;
}

export interface GoalReportStage {
  position: number;
  kind: string;
  title: string;
  template: string;
  repo: string;
  engine: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  minutes: number | null;
  steps: { completed: number; total: number };
  produced: string;
  runId: string;
  runReport: StageRunReport | null;
}

export type GoalReportSummary = ReportSummary;

/** One acceptance criterion and the evidence NeonCore holds for it. */
export interface GoalReportCriterion {
  id: string;
  text: string;
  expect: string;
  verify: 'test' | 'checklist';
  outcome: CriterionOutcome;
  /** Test criteria: the locked command and files, and NeonCore's latest run of it. */
  command: string;
  files: string[];
  exitCode: number | null;
  output: string;
  checkedAt: string | null;
  checkedAfter: string;
  /** The run before any work — a sound test was red here. */
  baseline: { exitCode: number | null; passed: boolean } | null;
  /** Checklist criteria: the independent reviewer's verdict and the person's confirmation. */
  verdict: string;
  evidence: string;
  reviewer: string;
  confirmed: boolean | null;
  note: string;
}

export interface GoalReportAcceptance {
  version: number;
  lockedAt: string | null;
  contractStatus: string;
  total: number;
  passing: number;
  criteria: GoalReportCriterion[];
  /** How many times NeonCore checked the work against the locked tests (after each stage). */
  checks: number;
  /** True when no check ever found a locked test changed. */
  testsUnchanged: boolean;
  tamperEvents: { at: string; stage: string; paths: string[]; resolution: 'restored' | 'accepted' | 'open' }[];
  amendments: Amendment[];
  reviewIndependent: boolean | null;
  note: string;
}

export interface GoalReport {
  version: 1;
  generatedAt: string;
  goal: { id: string; name: string; successMetric: string };
  pilotId: string;
  /**
   * With an acceptance contract: SUCCESS only when EVERY criterion passes on NeonCore's own evidence
   * (its test run, or the reviewer's verdict confirmed by the person). Without one (a pilot from
   * before contracts): by the stages that completed.
   */
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'INCOMPLETE';
  involvement: string;
  startedAt: string | null;
  finishedAt: string | null;
  minutes: number | null;
  costUsd: number;
  outcome: {
    stagesCompleted: number; stagesTotal: number; stagesSkipped: number;
    stepsCompleted: number; stepsTotal: number;
    testsPassed: number; testsTotal: number; issues: number;
  };
  summary: GoalReportSummary;
  acceptance: GoalReportAcceptance | null;
  brief: PilotBrief | null;
  decisions: { question: string; answer: string; delegated: boolean }[];
  stages: GoalReportStage[];
  learnings: { workflow: string; content: string }[];
  openItems: string[];
  files: { html: string; markdown: string; json: string } | null;
}

const minutesBetween = (a: string | null, b: string | null): number | null =>
  a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : null;

const strs = (v: unknown, max = 8): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, max);

/** The run's own completion report, as stored in the journal — or null when it wrote none. */
function runReportOf(runId: string): StageRunReport | null {
  if (!runId) return null;
  const row = db.prepare('SELECT report FROM workflow_reports WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(runId) as { report?: string } | undefined;
  if (!row?.report) return null;
  let r: Record<string, unknown>;
  try { r = JSON.parse(row.report) as Record<string, unknown>; } catch { return null; }
  const header = (r.header ?? {}) as Record<string, unknown>;
  const outcome = (r.outcome ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    status: typeof header.overallStatus === 'string' ? header.overallStatus : '',
    executiveSummary: typeof r.executiveSummary === 'string' ? r.executiveSummary.trim() : '',
    whatChanged: strs(r.whatChanged, 10),
    issues: (Array.isArray(r.issues) ? r.issues : []).filter((i) => i && typeof i === 'object').slice(0, 10).map((i) => {
      const o = i as Record<string, unknown>;
      return { severity: String(o.severity ?? ''), description: String(o.description ?? ''), status: String(o.status ?? '') };
    }),
    nextSteps: strs(r.nextSteps, 5),
    testsPassed: num(outcome.testsPassed),
    testsTotal: num(outcome.testsTotal),
  };
}

const excerpt = (s: string, max = 1200) => (s.length > max ? `…${s.slice(-(max - 1))}` : s);

/** The contract, as evidence: per criterion what NeonCore ran or what was judged, and every change to it. */
export function acceptanceSection(c: AcceptanceContract): GoalReportAcceptance {
  const states = criterionStates(c);
  const criteria: GoalReportCriterion[] = states.map((st) => ({
    id: st.id, text: st.text, expect: st.expect, verify: st.verify, outcome: st.outcome,
    command: st.test?.command ?? '', files: st.test?.files ?? [],
    exitCode: st.last?.exitCode ?? null, output: st.last ? excerpt(st.last.output) : '', checkedAt: st.last?.at ?? null, checkedAfter: st.lastStage,
    baseline: st.baseline ? { exitCode: st.baseline.exitCode, passed: st.baseline.passed } : null,
    verdict: st.verdict?.verdict ?? '', evidence: st.verdict?.evidence ?? '', reviewer: st.reviewer,
    confirmed: st.confirmation ? st.confirmation.accepted : null, note: st.confirmation?.note ?? '',
  }));
  const tamperEvents = c.verifications.filter((v) => v.status === 'tampered').map((v) => {
    const paths = v.tampered.map((f) => f.path);
    const later = c.amendments.find((a) => Date.parse(a.at) >= Date.parse(v.at) && (a.kind === 'restore' || a.kind === 'accept-change') && (a.paths ?? []).some((p) => paths.includes(p)));
    return { at: v.at, stage: `${v.stagePosition}. ${v.stageTitle}`, paths, resolution: later ? (later.kind === 'restore' ? 'restored' as const : 'accepted' as const) : 'open' as const };
  });
  return {
    version: c.version, lockedAt: c.lockedAt, contractStatus: c.status,
    total: criteria.length, passing: criteria.filter((x) => PASSING.has(x.outcome)).length, criteria,
    checks: c.verifications.filter((v) => v.status !== 'error').length,
    testsUnchanged: tamperEvents.length === 0,
    tamperEvents, amendments: c.amendments,
    reviewIndependent: c.checklist ? c.checklist.independent : null,
    note: c.status === 'waived' ? 'The person skipped writing the acceptance tests: the test criteria were never checked.' : '',
  };
}

/** The stand-in summary, until (or unless) the planner writes one. Built only from records. */
export function compiledSummary(r: Pick<GoalReport, 'goal' | 'stages' | 'outcome' | 'openItems'> & { acceptance?: GoalReportAcceptance | null }): GoalReportSummary {
  const done = r.stages.filter((s) => s.status === 'completed');
  const notDone = r.stages.filter((s) => s.status !== 'completed');
  const lead = `${r.outcome.stagesCompleted} of ${r.outcome.stagesTotal} stage${r.outcome.stagesTotal === 1 ? '' : 's'} completed for "${r.goal.name}"`
    + (notDone.length ? ` (${notDone.map((s) => `${s.title}: ${s.status}`).join('; ')})` : '') + '.';
  const tests = r.outcome.testsTotal ? ` Tests reported by the runs: ${r.outcome.testsPassed}/${r.outcome.testsTotal} passing.` : '';
  const a = r.acceptance;
  const contract = a && a.total
    ? ` Acceptance: ${a.passing} of ${a.total} criteria pass on NeonCore's own check${a.passing < a.total ? ` (not yet: ${a.criteria.filter((c) => !PASSING.has(c.outcome)).map((c) => `${c.id} ${c.outcome}`).join(', ')})` : ''}; locked tests ${a.testsUnchanged ? 'unchanged since approval' : `changed ${a.tamperEvents.length} time(s) during the work`}.`
    : '';
  return {
    text: `${lead}${contract}${tests}`,
    highlights: done.map((s) => `${s.title}: ${s.runReport?.executiveSummary || s.produced || 'completed'}`.replace(/\s+/g, ' ').slice(0, 240)),
    followUps: r.openItems.slice(0, 6),
    source: 'compiled',
  };
}

/** Compile the report for a pilot from everything NeonCore recorded. */
export function buildGoalReport(pilotId: string, keepSummary?: GoalReportSummary): GoalReport | null {
  const pilot = getPilot(pilotId);
  if (!pilot) return null;
  const goal = db.prepare('SELECT id, name, success_metric FROM goals WHERE id = ?').get(pilot.goalId) as
    { id: string; name: string; success_metric: string } | undefined;
  if (!goal) return null;

  const stages: GoalReportStage[] = stagesOf(pilot.id).map((s) => {
    const counts = s.runId
      ? db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('completed','skipped') THEN 1 ELSE 0 END) AS done
                      FROM workflow_steps WHERE workflow_id = ?`).get(s.runId) as { total: number; done: number | null }
      : { total: 0, done: 0 };
    return {
      position: s.position + 1, kind: s.kind, title: s.title,
      template: s.kind === 'acceptance' ? 'Acceptance tests' : s.kind === 'review' ? 'Independent review' : s.template,
      repo: path.basename(s.repoPath), engine: s.agentType, status: s.status,
      startedAt: s.startedAt, completedAt: s.completedAt, minutes: minutesBetween(s.startedAt, s.completedAt),
      steps: { completed: counts.done ?? 0, total: counts.total },
      produced: s.resultSummary, runId: s.runId, runReport: runReportOf(s.runId),
    };
  });

  const runIds = stages.map((s) => s.runId).filter(Boolean);
  const learnings = runIds.length
    ? (db.prepare(`SELECT workflow_name, content FROM project_learnings WHERE workflow_id IN (${runIds.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(...runIds) as { workflow_name: string; content: string }[]).map((l) => ({ workflow: l.workflow_name, content: l.content }))
    : [];

  const decisions = pilot.rounds.flatMap((round) => round.questions
    .filter(() => round.answeredAt)
    .map((q) => ({ question: q.text, answer: answerText(q, round.answers[q.id]), delegated: !!round.answers[q.id]?.delegated })));

  const brief = pilot.plan?.brief ?? pilot.brief;
  const openItems: string[] = [];
  for (const a of (brief?.assumptions || '').split('\n').map((x) => x.replace(/^[-*•]\s*/, '').trim()).filter(Boolean)) {
    openItems.push(`Assumption made for you — confirm: ${a}`);
  }
  for (const s of stages) {
    if (s.status !== 'completed') openItems.push(`Stage ${s.position} "${s.title}" ${s.status} — its work was not done.`);
    for (const n of s.runReport?.nextSteps ?? []) if (/^\[HUMAN\]/i.test(n)) openItems.push(`${s.title}: ${n.replace(/^\[HUMAN\]\s*/i, '')}`);
    for (const i of s.runReport?.issues ?? []) if (!/^(closed|resolved|fixed)$/i.test(i.status)) openItems.push(`${s.title}: ${i.severity ? `[${i.severity}] ` : ''}${i.description}`);
  }

  const contract = getContract(pilot.id);
  const acceptance = contract && contract.criteria.length ? acceptanceSection(contract) : null;
  for (const c of acceptance?.criteria ?? []) {
    if (PASSING.has(c.outcome)) continue;
    const why = c.outcome === 'fail' ? `its test still fails (\`${c.command}\` → exit ${c.exitCode ?? 'none'})`
      : c.outcome === 'not-run' ? 'its test was never run against the work'
      : c.outcome === 'not-met' ? 'judged not met'
      : c.outcome === 'unconfirmed' ? 'the reviewer\'s verdict is waiting for your confirmation'
      : c.outcome === 'waived' ? 'its test was skipped' : 'it was never checked';
    openItems.unshift(`${c.id} is not met — ${why}: ${c.text}`);
  }
  for (const t of acceptance?.tamperEvents ?? []) if (t.resolution === 'open') openItems.unshift(`Locked acceptance tests were changed in stage ${t.stage} and not resolved: ${t.paths.join(', ')}`);

  const completed = stages.filter((s) => s.status === 'completed').length;
  const skipped = stages.filter((s) => s.status === 'skipped').length;
  const testsPassed = stages.reduce((n, s) => n + (s.runReport?.testsPassed ?? 0), 0);
  const testsTotal = stages.reduce((n, s) => n + (s.runReport?.testsTotal ?? 0), 0);
  const issues = stages.reduce((n, s) => n + (s.runReport?.issues.length ?? 0), 0);
  const finishedAt = pilot.completedAt ?? stages.map((s) => s.completedAt).filter(Boolean).sort().pop() ?? null;

  const report: GoalReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    goal: { id: goal.id, name: goal.name, successMetric: goal.success_metric || '' },
    pilotId: pilot.id,
    status: acceptance
      ? contractVerdict(criterionStates(contract!))
      : completed === stages.length && stages.length > 0 ? 'SUCCESS' : completed > 0 ? 'PARTIAL' : 'INCOMPLETE',
    involvement: pilot.involvement,
    startedAt: pilot.startedAt,
    finishedAt,
    minutes: minutesBetween(pilot.startedAt, finishedAt),
    costUsd: Math.round(goalCostUsd(goal.id) * 100) / 100,
    outcome: {
      stagesCompleted: completed, stagesTotal: stages.length, stagesSkipped: skipped,
      stepsCompleted: stages.reduce((n, s) => n + s.steps.completed, 0), stepsTotal: stages.reduce((n, s) => n + s.steps.total, 0),
      testsPassed, testsTotal, issues,
    },
    summary: { text: '', highlights: [], followUps: [], source: 'compiled' },
    acceptance,
    brief, decisions, stages, learnings, openItems, files: null,
  };
  report.summary = keepSummary ?? compiledSummary(report);
  return report;
}

// ── rendering ───────────────────────────────────────────────────────────────

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lines = (s: string) => s.split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
const fmtDate = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const fmtMin = (m: number | null) => (m === null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

export function renderGoalReportMarkdown(r: GoalReport): string {
  const out: string[] = [];
  out.push(`# Goal report — ${r.goal.name}`, '');
  out.push(`**Status:** ${r.status}${r.acceptance ? ` · **Criteria:** ${r.acceptance.passing}/${r.acceptance.total}` : ''} · **Stages:** ${r.outcome.stagesCompleted}/${r.outcome.stagesTotal} · **Steps:** ${r.outcome.stepsCompleted}/${r.outcome.stepsTotal}`
    + `${r.outcome.testsTotal ? ` · **Tests:** ${r.outcome.testsPassed}/${r.outcome.testsTotal}` : ''} · **Spend:** $${r.costUsd.toFixed(2)} · **Duration:** ${fmtMin(r.minutes)}`, '');
  if (r.goal.successMetric) out.push(`**Done when:** ${r.goal.successMetric}`, '');
  out.push('## Summary', '', r.summary.text, '');
  if (r.summary.source === 'compiled') out.push('_Compiled from the run reports — the planner has not written a summary._', '');
  if (r.summary.highlights.length) out.push('### What was done', '', ...r.summary.highlights.map((h) => `- ${h}`), '');
  if (r.summary.followUps.length) out.push('### Follow-ups', '', ...r.summary.followUps.map((h) => `- ${h}`), '');
  if (r.acceptance) out.push(...acceptanceMarkdown(r.acceptance));
  out.push('## Stages', '');
  for (const s of r.stages) {
    out.push(`### ${s.position}. ${s.title} — ${s.status}`, '', `${s.template} · ${s.engine} in ${s.repo}${s.kind !== 'acceptance' && s.kind !== 'review' ? ` · ${s.steps.completed}/${s.steps.total} steps` : ''} · ${fmtMin(s.minutes)}`, '');
    if (s.runReport?.executiveSummary) out.push(s.runReport.executiveSummary, '');
    else if (s.produced) out.push(s.produced, '');
    if (s.runReport?.whatChanged.length) out.push('Changed:', ...s.runReport.whatChanged.map((w) => `- ${w}`), '');
    if (s.runReport?.issues.length) out.push('Issues:', ...s.runReport.issues.map((i) => `- [${i.severity}] ${i.description} (${i.status})`), '');
  }
  if (r.brief) {
    out.push('## Scope', '', r.brief.summary, '');
    for (const f of BRIEF_FIELDS.filter((x) => x.key !== 'summary' && r.brief![x.key])) {
      out.push(`### ${f.label}`, '', ...lines(r.brief[f.key]).map((l) => `- ${l}`), '');
    }
  }
  if (r.decisions.length) {
    out.push('## Decisions made while scoping', '', ...r.decisions.map((d) => `- ${d.question} → ${d.answer}`), '');
  }
  if (r.learnings.length) out.push('## Learnings captured', '', ...r.learnings.map((l) => `### ${l.workflow}\n\n${l.content}\n`), '');
  if (r.openItems.length) out.push('## Open items', '', ...r.openItems.map((o) => `- [ ] ${o}`), '');
  out.push('---', `Generated ${fmtDate(r.generatedAt)} by NeonCore Goal Pilot · pilot ${r.pilotId}`);
  return out.join('\n');
}

const OUTCOME_LABEL: Record<string, string> = {
  pass: 'PASS', fail: 'FAIL', 'not-run': 'NOT RUN', met: 'MET', 'not-met': 'NOT MET', unconfirmed: 'UNCONFIRMED', 'not-checked': 'NOT CHECKED', waived: 'WAIVED',
};

function evidenceLine(c: GoalReportCriterion): string {
  if (c.verify === 'test') {
    if (!c.command) return 'No test was locked for it.';
    const base = c.baseline ? ` Before any work: exit ${c.baseline.exitCode ?? 'none'}${c.baseline.passed ? ' (already passing)' : ' (failing, as it should)'}.` : '';
    return c.checkedAt
      ? `NeonCore ran \`${c.command}\` after ${c.checkedAfter}: exit ${c.exitCode ?? 'none'}.${base}`
      : `\`${c.command}\` was not run against the work.${base}`;
  }
  if (!c.verdict) return 'Not reviewed.';
  const who = c.confirmed === null ? 'not yet confirmed by you' : c.confirmed ? 'confirmed by you' : 'overruled by you';
  return `${c.reviewer || 'Reviewer'}: ${c.verdict} — ${c.evidence} (${who}${c.note ? `: ${c.note}` : ''})`;
}

function amendmentLine(a: Amendment): string {
  const what = { 'changes-requested': 'changes requested to the tests', unlock: 'unlocked', restore: 'changed tests restored', 'accept-change': 'changed tests accepted', waive: 'tests skipped' }[a.kind];
  const wording = a.before && a.after ? ` (wording: "${a.before.text}" → "${a.after.text}"${a.before.expect !== a.after.expect ? `; expected: "${a.before.expect}" → "${a.after.expect}"` : ''})` : '';
  return `${fmtDate(a.at)} · ${a.criterionIds.join(', ') || 'contract'} ${what} → v${a.version}: ${a.reason}${a.paths?.length ? ` [${a.paths.join(', ')}]` : ''}${wording}`;
}

function acceptanceMarkdown(a: GoalReportAcceptance): string[] {
  const out = ['## Acceptance criteria', '', `**${a.passing} of ${a.total} pass** on NeonCore's own check · contract v${a.version}${a.lockedAt ? ` locked ${fmtDate(a.lockedAt)}` : ''} · checked ${a.checks} time(s) · locked tests ${a.testsUnchanged ? 'unchanged since approval' : `changed ${a.tamperEvents.length} time(s)`}`, ''];
  if (a.note) out.push(`_${a.note}_`, '');
  if (a.reviewIndependent === false) out.push('_The checklist was reviewed by a cartridge that also did the work — not an independent review._', '');
  for (const c of a.criteria) {
    out.push(`### ${c.id} — ${OUTCOME_LABEL[c.outcome] ?? c.outcome} (${c.verify})`, '', c.text, '');
    if (c.expect) out.push(`Expected: ${c.expect}`, '');
    out.push(evidenceLine(c), '');
    if (c.verify === 'test' && c.files.length) out.push(`Test files: ${c.files.map((f) => `\`${f}\``).join(', ')}`, '');
    if (c.verify === 'test' && c.output && c.outcome === 'fail') out.push('```', c.output, '```', '');
  }
  if (a.tamperEvents.length) out.push('### Changes to locked tests', '', ...a.tamperEvents.map((t) => `- ${fmtDate(t.at)} · stage ${t.stage}: ${t.paths.join(', ')} — ${t.resolution}`), '');
  if (a.amendments.length) out.push('### Amendments', '', ...a.amendments.map((x) => `- ${amendmentLine(x)}`), '');
  return out;
}

const STATUS_TONE: Record<string, string> = {
  SUCCESS: '#34d399', PARTIAL: '#fbbf24', INCOMPLETE: '#f87171', FAILED: '#f87171', BLOCKED: '#f87171',
  PASS: '#34d399', MET: '#34d399', FAIL: '#f87171', 'NOT MET': '#f87171', 'NOT RUN': '#9ca3af', 'NOT CHECKED': '#9ca3af', UNCONFIRMED: '#fbbf24', WAIVED: '#9ca3af',
  completed: '#34d399', skipped: '#9ca3af', failed: '#f87171', cancelled: '#9ca3af', running: '#a78bfa', waiting: '#fbbf24', pending: '#9ca3af',
};

export function renderGoalReportHtml(r: GoalReport): string {
  const pill = (label: string) => `<span class="pill" style="color:${STATUS_TONE[label] ?? '#c4b5fd'};border-color:${STATUS_TONE[label] ?? '#7c3aed'}">${esc(label)}</span>`;
  const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
  const tile = (label: string, value: string) => `<div class="tile"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

  const stages = r.stages.map((s) => `
    <section class="stage">
      <div class="row"><h3>${s.position}. ${esc(s.title)}</h3>${pill(s.status)}</div>
      <div class="meta">${esc(s.template)} · ${esc(s.engine)} in ${esc(s.repo)}${s.kind !== 'acceptance' && s.kind !== 'review' ? ` · ${s.steps.completed}/${s.steps.total} steps` : ''} · ${esc(fmtMin(s.minutes))}${s.runReport?.status ? ` · run report: ${esc(s.runReport.status)}` : ''}</div>
      ${s.runReport?.executiveSummary ? `<p>${esc(s.runReport.executiveSummary)}</p>` : s.produced ? `<pre>${esc(s.produced)}</pre>` : '<p class="muted">No report was recorded for this stage.</p>'}
      ${s.runReport?.whatChanged.length ? `<h4>Changed</h4>${list(s.runReport.whatChanged)}` : ''}
      ${s.runReport?.issues.length ? `<h4>Issues</h4>${list(s.runReport.issues.map((i) => `[${i.severity}] ${i.description} — ${i.status}`))}` : ''}
    </section>`).join('');

  const acceptance = r.acceptance ? (() => {
    const a = r.acceptance!;
    const rows = a.criteria.map((c) => `
      <section class="stage crit">
        <div class="row"><h3>${esc(c.id)} · ${esc(c.text)}</h3>${pill(OUTCOME_LABEL[c.outcome] ?? c.outcome)}</div>
        ${c.expect ? `<div class="meta">Expected: ${esc(c.expect)}</div>` : ''}
        <div class="meta">${c.verify === 'test' ? 'Automated test' : 'Checklist'}${c.files.length ? ` · ${c.files.map((f) => `<code>${esc(f)}</code>`).join(', ')}` : ''}</div>
        <p>${esc(evidenceLine(c))}</p>
        ${c.verify === 'test' && c.output && c.outcome === 'fail' ? `<pre>${esc(c.output)}</pre>` : ''}
      </section>`).join('');
    return `
  <h2>Acceptance criteria</h2>
  <div class="meta"><b>${a.passing} of ${a.total} pass</b> on NeonCore's own check · contract v${a.version}${a.lockedAt ? ` locked ${esc(fmtDate(a.lockedAt))}` : ''} · checked ${a.checks} time(s) · locked tests ${a.testsUnchanged ? 'unchanged since approval' : `changed ${a.tamperEvents.length} time(s)`}</div>
  ${a.note ? `<p class="muted">${esc(a.note)}</p>` : ''}
  ${a.reviewIndependent === false ? '<p class="muted">The checklist was reviewed by a cartridge that also did the work — not an independent review.</p>' : ''}
  ${rows}
  ${a.tamperEvents.length ? `<h4>Changes to locked tests</h4>${list(a.tamperEvents.map((t) => `${fmtDate(t.at)} · stage ${t.stage}: ${t.paths.join(', ')} — ${t.resolution}`))}` : ''}
  ${a.amendments.length ? `<h4>Amendments</h4>${list(a.amendments.map(amendmentLine))}` : ''}`;
  })() : '';

  const scope = r.brief ? `
    <h2>Scope</h2><p>${esc(r.brief.summary)}</p>
    ${BRIEF_FIELDS.filter((f) => f.key !== 'summary' && r.brief![f.key]).map((f) => `<h4>${esc(f.label)}</h4>${list(lines(r.brief![f.key]))}`).join('')}` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Goal report — ${esc(r.goal.name)}</title>
<style>
  body{margin:0;background:#0b0a12;color:#e5e7eb;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  main{max-width:920px;margin:0 auto;padding:32px 24px 64px}
  h1{font-size:24px;margin:0 0 4px} h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:#c4b5fd;margin:32px 0 10px;border-bottom:1px solid #2a2540;padding-bottom:6px}
  h3{font-size:15px;margin:0} h4{font-size:12px;color:#9ca3af;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.06em}
  .kicker{color:#a78bfa;font-size:12px;text-transform:uppercase;letter-spacing:.12em} .muted{color:#6b7280} .meta{color:#9ca3af;font-size:12px;margin:4px 0 8px}
  .pill{display:inline-block;border:1px solid;border-radius:999px;padding:1px 10px;font-size:11px;font-weight:600;margin-left:8px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:18px 0}
  .tile{background:#15131f;border:1px solid #2a2540;border-radius:10px;padding:12px} .tile .v{font-size:20px;font-weight:600} .tile .l{color:#9ca3af;font-size:11px}
  .summary{background:linear-gradient(180deg,#1e1638,#15131f);border:1px solid #4c1d95;border-radius:12px;padding:16px 18px}
  .stage{background:#15131f;border:1px solid #2a2540;border-radius:10px;padding:14px 16px;margin:10px 0}
  pre{white-space:pre-wrap;background:#0f0d18;border-radius:8px;padding:10px;color:#cbd5e1;font-size:12px}
  ul{margin:4px 0;padding-left:20px} li{margin:2px 0} footer{margin-top:40px;color:#6b7280;font-size:11px}
  .todo li{list-style:none;margin-left:-18px} .todo li:before{content:"☐ ";color:#fbbf24}
</style></head>
<body><main>
  <div class="kicker">NeonCore · Goal report</div>
  <div class="row"><h1>${esc(r.goal.name)}</h1>${pill(r.status)}</div>
  ${r.goal.successMetric ? `<div class="meta">Done when: ${esc(r.goal.successMetric)}</div>` : ''}
  <div class="meta">${esc(fmtDate(r.startedAt))} → ${esc(fmtDate(r.finishedAt))} · ${esc(fmtMin(r.minutes))} · involvement: ${esc(r.involvement)}</div>
  <div class="tiles">
    ${r.acceptance ? tile('criteria passing', `${r.acceptance.passing}/${r.acceptance.total}`) : ''}
    ${tile('stages completed', `${r.outcome.stagesCompleted}/${r.outcome.stagesTotal}`)}
    ${tile('steps completed', `${r.outcome.stepsCompleted}/${r.outcome.stepsTotal}`)}
    ${tile('tests passing', r.outcome.testsTotal ? `${r.outcome.testsPassed}/${r.outcome.testsTotal}` : '—')}
    ${tile('issues reported', String(r.outcome.issues))}
    ${tile('spend on this goal', `$${r.costUsd.toFixed(2)}`)}
  </div>
  <h2>Summary</h2>
  <div class="summary"><p>${esc(r.summary.text)}</p>
    ${r.summary.highlights.length ? `<h4>What was done</h4>${list(r.summary.highlights)}` : ''}
    ${r.summary.followUps.length ? `<h4>Follow-ups</h4>${list(r.summary.followUps)}` : ''}
    <div class="meta">${r.summary.source === 'planner' ? 'Written by the planner cartridge from the records below.' : 'Compiled from the run reports — the planner has not written a summary.'}</div>
  </div>
  ${acceptance}
  <h2>Stages</h2>${stages}
  ${scope}
  ${r.decisions.length ? `<h2>Decisions made while scoping</h2>${list(r.decisions.map((d) => `${d.question} → ${d.answer}`))}` : ''}
  ${r.learnings.length ? `<h2>Learnings captured</h2>${r.learnings.map((l) => `<h4>${esc(l.workflow)}</h4><pre>${esc(l.content)}</pre>`).join('')}` : ''}
  ${r.openItems.length ? `<h2>Open items</h2><ul class="todo">${r.openItems.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
  <footer>Generated ${esc(fmtDate(r.generatedAt))} by NeonCore Goal Pilot · pilot ${esc(r.pilotId)}</footer>
</main></body></html>`;
}

// ── storage ─────────────────────────────────────────────────────────────────

/** Next to the database, so the sandbox's reports live in its run folder and tests in their tmp dir. */
export function reportsRoot(): string {
  return process.env.NEONCORE_REPORTS_DIR?.trim() || path.join(path.dirname(db.name), 'reports');
}

/** Write the three files and store the report on the pilot. Returns it with its file paths. */
export function saveGoalReport(report: GoalReport): GoalReport {
  const dir = path.join(reportsRoot(), 'goals', report.goal.id, report.pilotId);
  let files: GoalReport['files'] = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    files = { html: path.join(dir, 'goal-report.html'), markdown: path.join(dir, 'goal-report.md'), json: path.join(dir, 'goal-report.json') };
    const withFiles = { ...report, files };
    fs.writeFileSync(files.html, renderGoalReportHtml(withFiles));
    fs.writeFileSync(files.markdown, renderGoalReportMarkdown(withFiles));
    fs.writeFileSync(files.json, JSON.stringify(withFiles, null, 2));
  } catch (err) {
    // The stored copy still serves the dashboard; a read-only disk must not lose the report.
    console.warn(`[goal-report] could not write files to ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    files = null;
  }
  const saved = { ...report, files };
  db.prepare('UPDATE goal_pilots SET report = ?, report_at = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(saved), saved.generatedAt, saved.generatedAt, report.pilotId);
  return saved;
}

export function storedGoalReport(pilotId: string): GoalReport | null {
  const row = db.prepare('SELECT report FROM goal_pilots WHERE id = ?').get(pilotId) as { report?: string } | undefined;
  if (!row?.report) return null;
  try { return JSON.parse(row.report) as GoalReport; } catch { return null; }
}

/**
 * Put the planner's narrative on the stored report — re-compiling the facts at the same time, so a
 * run report that was filed late is in there too — and rewrite the files.
 */
export function applyPlannerSummary(pilotId: string, summary: ReportSummary): GoalReport | null {
  const report = buildGoalReport(pilotId, summary);
  return report ? saveGoalReport(report) : null;
}

/** Compile and store the report now. Keeps a planner summary already written. */
export function generateGoalReport(pilotId: string): GoalReport | null {
  const previous = storedGoalReport(pilotId);
  const report = buildGoalReport(pilotId, previous?.summary.source === 'planner' ? previous.summary : undefined);
  return report ? saveGoalReport(report) : null;
}
