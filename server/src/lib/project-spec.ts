/**
 * THE PROJECT SPEC — every feature of a project in one living document, built from the records.
 *
 * A project holds its list of features (goals filed under it). Each feature carries its INTENT (what
 * the person and the planner agreed: summary, done-when, scope, no-gos, invariants, assumptions) and,
 * once it has run, its EVIDENCE (each acceptance criterion and what NeonCore found when it checked:
 * the locked test's run, or the independent reviewer's verdict confirmed by the person). Put side by
 * side, those two answer the question a roadmap discussion actually asks: not "is it done?" but "does
 * what was delivered meet what we said we wanted?"
 *
 * Nothing here is written by an agent or stored twice. The spec is DERIVED on every read from the
 * feature rows, their latest pipeline (lib/goal-pilot.ts), its acceptance contract
 * (lib/acceptance-contract.ts) and its report (lib/goal-pilot-report.ts) — so it cannot drift from
 * what the dashboard shows. The same object renders three documents:
 *
 *   spec       docs/product/README.md + features/<slug>.md — the full record, for the team
 *   roadmap    docs/product/ROADMAP.md (+ a self-contained HTML page) — Now / Next / Later / Done,
 *              for executives: outcomes and dates, no implementation detail
 *   (the changelog and architecture live in lib/project-changelog.ts and on the project row)
 */
import db from '../db.js';
import { getProjectCartridges } from './resolve-agent.js';
import { pilotsForGoal, slugify, type GoalPilot, type PilotBrief } from './goal-pilot.js';
import { getContract, criterionStates, PASSING, type CriterionOutcome } from './acceptance-contract.js';
import { goalCostUsd } from './goal-cost.js';
import { groupOf, sectionOf, projectAreas, OTHER_GROUP } from './project-import.js';

// ── the model ─────────────────────────────────────────────────────────────────

/**
 *   existing     was already in the product when the project was taken on (imported)
 *   planned      on the list, not started
 *   in-progress  being scoped, planned or built
 *   delivered    its pipeline finished — waiting for a person to read the report and mark it done
 *   done         marked done
 *   paused       its pipeline is stopped and needs a person
 */
export type SpecStatus = 'existing' | 'planned' | 'in-progress' | 'delivered' | 'done' | 'paused';

/**
 * How what was delivered compares to what was intended — the point of keeping a spec at all.
 *   verified      every acceptance criterion passes on NeonCore's own evidence
 *   partial       some criteria pass, some do not (or are not judged yet)
 *   unverified    built, but no criterion has passed NeonCore's check
 *   intent-only   no acceptance criteria: there is nothing to check it against
 *   pending       not built yet — the criteria are the target
 *   documented    already in the product (imported): its current behaviour is written down as criteria,
 *                 not yet checked by NeonCore
 */
export type Alignment = 'verified' | 'partial' | 'unverified' | 'intent-only' | 'pending' | 'documented';

/** One criterion, with the evidence NeonCore holds for it — reduced to what a reader needs. */
export interface SpecCriterion {
  id: string;
  text: string;
  expect: string;
  verify: 'test' | 'checklist';
  /** met | not-met | not-checked — the three things a reader acts on. */
  result: 'met' | 'not-met' | 'not-checked';
  outcome: CriterionOutcome | 'planned';
  evidence: string;
}

export interface SpecFeature {
  id: string;
  name: string;
  slug: string;
  position: number;
  status: SpecStatus;
  origin: 'imported' | 'planned';
  /** The capability it belongs to: '<group> · <sub-area>', '<group>', or '' (unsorted). */
  area: string;
  alignment: Alignment;
  /** The intent: what was agreed before any work. */
  intent: {
    summary: string;
    doneWhen: string;
    inScope: string;
    outOfScope: string;
    invariants: string;
    assumptions: string;
  };
  criteria: SpecCriterion[];
  criteriaMet: number;
  /** What the pipeline delivered — empty until it ran. */
  delivery: {
    reportStatus: string;
    startedAt: string | null;
    finishedAt: string | null;
    summary: string;
    whatChanged: string[];
    followUps: string[];
    openItems: string[];
    workflows: string[];
    costUsd: number;
  } | null;
  targetDate: string;
  /** Where the person placed it on the roadmap ('' = automatic). */
  lane: '' | 'now' | 'next' | 'later';
  /** The roadmap column it is in (placeColumns) — null for an existing feature, which is not on the roadmap. */
  column: RoadmapColumn | null;
  /** When it was marked done (done), or when its pipeline finished (delivered). */
  completedAt: string | null;
  updatedAt: string;
}

/**
 * A capability group — how an executive reads the feature list: a handful of these, each with a line
 * on what it does, instead of every feature in one run. Sub-areas split a large group further.
 */
export interface SpecGroup {
  name: string;
  summary: string;
  sections: { name: string; featureIds: string[] }[];
  counts: { features: number; existing: number; planned: number; building: number; done: number; verified: number; gaps: number };
}

export const UNSORTED_GROUP = 'Unsorted';

export interface ProjectSpec {
  generatedAt: string;
  project: { id: string; name: string; description: string; repos: string[]; mainRepo: string; color: string };
  architecture: string;
  features: SpecFeature[];
  /** Every feature in exactly one group, largest first ("Other" and "Unsorted" last). Empty when no feature has an area. */
  groups: SpecGroup[];
  totals: {
    features: number; existing: number; planned: number; inProgress: number; delivered: number; done: number; paused: number;
    verified: number; gaps: number; intentOnly: number;
  };
}

// ── building it ───────────────────────────────────────────────────────────────

const nonEmpty = (s: unknown) => (typeof s === 'string' ? s.trim() : '');

function statusOf(goal: Record<string, unknown>, pilot: GoalPilot | null): SpecStatus {
  if (goal.status === 'achieved') return goal.origin === 'imported' ? 'existing' : 'done';
  if (!pilot || pilot.phase === 'cancelled') return 'planned';
  if (pilot.phase === 'completed') return 'delivered';
  if (pilot.phase === 'paused') return 'paused';
  return 'in-progress';
}

/** The three results a reader acts on, from the contract's finer-grained outcomes. */
function resultOf(outcome: CriterionOutcome): SpecCriterion['result'] {
  if (PASSING.has(outcome)) return 'met';
  if (outcome === 'fail' || outcome === 'not-met') return 'not-met';
  return 'not-checked';
}

/** Criteria lines from free text ("AC-1 …", "- …", EARS sentences), for a feature with no contract. */
function criteriaFromText(text: string): SpecCriterion[] {
  return text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 20)
    .map((l, i) => {
      const m = l.match(/^(AC-\d+)[:.\s—-]+(.*)$/i);
      const body = m ? m[2].trim() : l;
      // "… Expected: <result>" — how documented behaviour (an import) and the brief's text both write it.
      const [text, expect = ''] = body.split(/\s+Expected:\s+/);
      return {
        id: m ? m[1].toUpperCase() : `AC-${i + 1}`, text: text.trim(), expect: expect.trim(), verify: 'checklist' as const,
        result: 'not-checked' as const, outcome: 'planned' as const, evidence: '',
      };
    });
}

function evidenceOf(s: ReturnType<typeof criterionStates>[number]): string {
  if (s.verify === 'test') {
    if (!s.last) return s.test ? `\`${s.test.command}\` — not run yet` : 'no locked test';
    return `\`${s.test?.command ?? s.last.command}\` → exit ${s.last.exitCode ?? '?'}${s.lastStage ? ` after ${s.lastStage}` : ''}`;
  }
  const parts: string[] = [];
  if (s.verdict) parts.push(`reviewer (${s.reviewer || 'independent cartridge'}): ${s.verdict.verdict} — ${s.verdict.evidence}`);
  if (s.confirmation) parts.push(`confirmed by you: ${s.confirmation.accepted ? 'met' : 'not met'}${s.confirmation.note ? ` (${s.confirmation.note})` : ''}`);
  return parts.join('; ') || 'not reviewed yet';
}

function alignmentOf(status: SpecStatus, criteria: SpecCriterion[]): Alignment {
  if (criteria.length === 0) return 'intent-only';
  const met = criteria.filter((c) => c.result === 'met').length;
  if (met === criteria.length) return 'verified';
  if (status === 'planned' || status === 'in-progress') return 'pending';
  if (status === 'existing') return 'documented';
  return met === 0 ? 'unverified' : 'partial';
}

function specFeature(goal: Record<string, unknown>): SpecFeature {
  const goalId = goal.id as string;
  const pilots = pilotsForGoal(goalId);
  // The pipeline that speaks for the feature: a live one, else the latest that got as far as a plan.
  const pilot = pilots.find((p) => p.phase !== 'completed' && p.phase !== 'cancelled')
    ?? pilots.find((p) => p.plan) ?? pilots[0] ?? null;
  const status = statusOf(goal, pilot);
  const brief: PilotBrief | null = pilot?.plan?.brief ?? pilot?.brief ?? null;

  let criteria: SpecCriterion[];
  const contract = pilot ? getContract(pilot.id) : null;
  if (contract) {
    criteria = criterionStates(contract).map((s) => ({
      id: s.id, text: s.text, expect: s.expect, verify: s.verify, outcome: s.outcome, result: resultOf(s.outcome), evidence: evidenceOf(s),
    }));
  } else if (pilot?.plan?.criteria?.length || pilot?.criteria?.length) {
    criteria = (pilot.plan?.criteria ?? pilot.criteria ?? []).map((c) => ({
      id: c.id, text: c.text, expect: c.expect, verify: c.verify, outcome: 'planned' as const, result: 'not-checked' as const, evidence: '',
    }));
  } else {
    criteria = criteriaFromText(nonEmpty(goal.acceptance_criteria));
  }

  const report = (pilot?.report ?? null) as Record<string, unknown> | null;
  const stagesR = Array.isArray(report?.stages) ? report!.stages as Record<string, unknown>[] : [];
  const summaryR = (report?.summary ?? {}) as { text?: string; highlights?: string[]; followUps?: string[] };
  const delivery = pilot && (pilot.startedAt || report) ? {
    reportStatus: nonEmpty(report?.status),
    startedAt: pilot.startedAt,
    finishedAt: pilot.completedAt,
    summary: nonEmpty(summaryR.text),
    whatChanged: [...new Set(stagesR.flatMap((s) => {
      const rr = s.runReport as { whatChanged?: string[] } | null;
      return Array.isArray(rr?.whatChanged) ? rr!.whatChanged : [];
    }).map((x) => String(x).trim()).filter(Boolean))].slice(0, 12),
    followUps: (Array.isArray(summaryR.followUps) ? summaryR.followUps : []).slice(0, 8),
    openItems: (Array.isArray(report?.openItems) ? report!.openItems as string[] : []).slice(0, 10),
    workflows: (pilot.plan?.stages ?? []).map((s) => s.template),
    costUsd: Math.round(goalCostUsd(goalId) * 100) / 100,
  } : null;

  const name = (goal.name as string) || '';
  return {
    id: goalId,
    name,
    slug: brief?.slug || slugify(name) || goalId.slice(0, 8),
    position: (goal.position as number) ?? 0,
    status,
    origin: goal.origin === 'imported' ? 'imported' : 'planned',
    area: nonEmpty(goal.area),
    alignment: alignmentOf(status, criteria),
    intent: {
      summary: nonEmpty(brief?.summary) || nonEmpty(goal.description),
      doneWhen: nonEmpty(brief?.successMetric) || nonEmpty(goal.success_metric),
      inScope: nonEmpty(brief?.inScope),
      outOfScope: nonEmpty(brief?.outOfScope) || nonEmpty(goal.no_gos),
      invariants: nonEmpty(brief?.invariants) || nonEmpty(goal.invariants),
      assumptions: nonEmpty(brief?.assumptions),
    },
    criteria,
    criteriaMet: criteria.filter((c) => c.result === 'met').length,
    delivery,
    targetDate: nonEmpty(goal.target_date),
    lane: (['now', 'next', 'later'].includes(goal.roadmap_lane as string) ? goal.roadmap_lane : '') as SpecFeature['lane'],
    column: null,
    completedAt: status === 'done' || status === 'existing' ? (nonEmpty(goal.done_at) || (goal.updated_at as string))
      : status === 'delivered' ? (pilot?.completedAt ?? null) : null,
    updatedAt: goal.updated_at as string,
  };
}

/** Two features with the same name would share docs/product/features/<slug>.md — the later ones get -2, -3… */
function uniqueSlugs(features: SpecFeature[]): SpecFeature[] {
  const seen = new Set<string>();
  for (const f of features) {
    let slug = f.slug;
    for (let n = 2; seen.has(slug); n++) slug = `${f.slug}-${n}`;
    seen.add(slug);
    f.slug = slug;
  }
  return features;
}

/** Group the features by their area's top-level group, in list order within each. */
export function groupFeatures(features: SpecFeature[], summaries: { name: string; summary: string }[]): SpecGroup[] {
  if (!features.some((f) => f.area)) return [];
  const byName = new Map<string, SpecFeature[]>();
  for (const f of features) {
    const g = groupOf(f.area) || UNSORTED_GROUP;
    if (!byName.has(g)) byName.set(g, []);
    byName.get(g)!.push(f);
  }
  const last = (g: string) => (g === UNSORTED_GROUP ? 2 : g === OTHER_GROUP ? 1 : 0);
  const summary = new Map(summaries.map((a) => [a.name, a.summary]));
  return [...byName.entries()]
    .sort((a, b) => last(a[0]) - last(b[0]) || b[1].length - a[1].length)
    .map(([name, list]) => {
      const sections = new Map<string, string[]>();
      for (const f of list) {
        const s = sectionOf(f.area);
        if (!sections.has(s)) sections.set(s, []);
        sections.get(s)!.push(f.id);
      }
      const built = list.filter((f) => f.status === 'done' || f.status === 'delivered');
      return {
        name,
        summary: summary.get(name) ?? '',
        // Features filed straight under the group (no sub-area) come first.
        sections: [...sections.entries()].sort((a, b) => (a[0] ? 1 : 0) - (b[0] ? 1 : 0)).map(([n, featureIds]) => ({ name: n, featureIds })),
        counts: {
          features: list.length,
          existing: list.filter((f) => f.status === 'existing').length,
          planned: list.filter((f) => f.status === 'planned').length,
          building: list.filter((f) => ['in-progress', 'delivered', 'paused'].includes(f.status)).length,
          done: list.filter((f) => f.status === 'done').length,
          verified: built.filter((f) => f.alignment === 'verified').length,
          gaps: built.filter((f) => f.alignment === 'partial' || f.alignment === 'unverified').length,
        },
      };
    });
}

export function buildProjectSpec(projectId: string): ProjectSpec | null {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!p) return null;
  const goals = db.prepare('SELECT * FROM goals WHERE project_id = ? ORDER BY position, created_at').all(projectId) as Record<string, unknown>[];
  const features = placeColumns(uniqueSlugs(goals.map(specFeature)));
  const repos = [...new Set([...getProjectCartridges(projectId), p.primary_repo as string].filter(Boolean))];
  const count = (st: SpecStatus) => features.filter((f) => f.status === st).length;
  const built = features.filter((f) => f.status === 'done' || f.status === 'delivered');
  return {
    generatedAt: new Date().toISOString(),
    project: {
      id: projectId, name: p.name as string, description: (p.description as string) || '', repos,
      mainRepo: (p.primary_repo as string) || repos[0] || '', color: (p.color as string) || '#a855f7',
    },
    architecture: (p.architecture as string) || '',
    features,
    groups: groupFeatures(features, projectAreas(projectId)),
    totals: {
      features: features.length, existing: count('existing'), planned: count('planned'), inProgress: count('in-progress'),
      delivered: count('delivered'), done: count('done'), paused: count('paused'),
      verified: built.filter((f) => f.alignment === 'verified').length,
      gaps: built.filter((f) => f.alignment === 'partial' || f.alignment === 'unverified').length,
      // Built (delivered or done) with nothing to check it against. A planned feature without criteria is
      // normal — scoping writes them — so it is not counted.
      intentOnly: built.filter((f) => f.alignment === 'intent-only').length,
    },
  };
}

// ── the roadmap: Now / Next / Later / Done ─────────────────────────────────────

export type RoadmapColumn = 'now' | 'next' | 'later' | 'done';

export interface Roadmap {
  now: SpecFeature[];
  next: SpecFeature[];
  later: SpecFeature[];
  done: SpecFeature[];
}

/** How many not-started features count as "Next" — the rest of the list is "Later". */
const NEXT_COUNT = 3;

/**
 * Which column each feature is in — decided here once, so the page, the exports and the published
 * docs agree. Done follows its status (mark done / reopen). Otherwise the person's placement wins;
 * unplaced features go where their state puts them: Now while their pipeline is live, else Next for
 * the top NEXT_COUNT unplaced planned features in list order, Later for the rest. Features that
 * already existed (imported) are not on the roadmap.
 */
function placeColumns(features: SpecFeature[]): SpecFeature[] {
  let autoNext = 0;
  for (const f of features) {
    f.column = f.status === 'existing' ? null
      : f.status === 'done' ? 'done'
      : f.lane ? f.lane
      : f.status !== 'planned' ? 'now'
      : autoNext++ < NEXT_COUNT ? 'next' : 'later';
  }
  return features;
}

export function roadmapOf(spec: ProjectSpec): Roadmap {
  const r: Roadmap = { now: [], next: [], later: [], done: [] };
  for (const f of spec.features) if (f.column) r[f.column].push(f);
  r.done.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  return r;
}

// ── rendering ─────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<SpecStatus, string> = {
  existing: 'Existing', planned: 'Planned', 'in-progress': 'In progress', delivered: 'Delivered — awaiting sign-off',
  done: 'Done', paused: 'Paused — needs a decision',
};

export const ALIGNMENT_LABEL: Record<Alignment, string> = {
  verified: 'Meets every acceptance criterion',
  partial: 'Some acceptance criteria not met',
  unverified: 'Not verified against its criteria',
  'intent-only': 'No acceptance criteria yet',
  pending: 'Criteria set — not built yet',
  documented: 'Documented (existing behaviour)',
};

const RESULT_MARK: Record<SpecCriterion['result'], string> = { met: '✅', 'not-met': '❌', 'not-checked': '⬜' };

const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : '');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cell = (s: string) => oneLine(s).replace(/\|/g, '\\|');
const bullets = (s: string) => s.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).map((l) => `- ${l}`).join('\n');

export const GENERATED_NOTE = 'Generated by NeonCore from the project\'s feature list — change it there; edits here are overwritten.';

/** ARCHITECTURE.md — the project's architecture notes ('' when it has none, unless `placeholder`). */
export function renderArchitectureMarkdown(spec: ProjectSpec, opts: { placeholder?: boolean } = {}): string {
  const body = spec.architecture.trim() || (opts.placeholder ? '_Not written yet._' : '');
  return body ? `# ${spec.project.name} — architecture\n\n> ${GENERATED_NOTE}\n\n${body}\n` : '';
}

/** The architecture page (self-contained HTML, written by Generate with AI) — '' when there is none. */
export function architecturePage(projectId: string): string {
  const r = db.prepare('SELECT architecture_html FROM projects WHERE id = ?').get(projectId) as { architecture_html?: string } | undefined;
  return (r?.architecture_html || '').trim();
}

/** One feature's full record — docs/product/features/<slug>.md. */
export function renderFeatureMarkdown(f: SpecFeature, project: ProjectSpec['project']): string {
  const out: string[] = [
    `# ${f.name}`, '',
    `> ${GENERATED_NOTE}`, '',
    `**Project:** ${project.name} · **Status:** ${STATUS_LABEL[f.status]} · **Against its criteria:** ${ALIGNMENT_LABEL[f.alignment]}`
      + `${f.criteria.length ? ` (${f.criteriaMet}/${f.criteria.length})` : ''}${f.targetDate ? ` · **Target:** ${f.targetDate}` : ''}`
      + `${f.completedAt ? ` · **${f.status === 'delivered' ? 'Delivered' : 'Completed'}:** ${day(f.completedAt)}` : ''}`, '',
    '## Intent', '',
    f.intent.summary || '_No summary yet — it is written when the feature is scoped._', '',
  ];
  if (f.intent.doneWhen) out.push(`**Done when:** ${oneLine(f.intent.doneWhen)}`, '');
  if (f.intent.inScope) out.push('### In scope', '', bullets(f.intent.inScope), '');
  if (f.intent.outOfScope) out.push('### Out of scope', '', bullets(f.intent.outOfScope), '');
  if (f.intent.invariants) out.push('### Must not break', '', bullets(f.intent.invariants), '');
  if (f.intent.assumptions) out.push('### Assumptions', '', bullets(f.intent.assumptions), '');
  out.push('## Acceptance criteria', '');
  if (f.criteria.length === 0) out.push('_None yet. Without criteria there is nothing to verify the delivered work against._', '');
  else {
    out.push('| | Criterion | Expected | Checked by | Evidence |', '|---|---|---|---|---|');
    for (const c of f.criteria) {
      out.push(`| ${RESULT_MARK[c.result]} | **${c.id}** ${cell(c.text)} | ${cell(c.expect)} | ${c.verify === 'test' ? 'locked test' : 'checklist'} | ${cell(c.evidence) || '—'} |`);
    }
    out.push('');
  }
  if (f.delivery) {
    const d = f.delivery;
    out.push('## Delivery', '');
    const facts = [
      d.reportStatus && `**Report:** ${d.reportStatus}`,
      d.startedAt && `**Started:** ${day(d.startedAt)}`,
      d.finishedAt && `**Finished:** ${day(d.finishedAt)}`,
      d.workflows.length && `**Workflows:** ${d.workflows.join(' → ')}`,
      d.costUsd > 0 && `**Cost:** $${d.costUsd.toFixed(2)}`,
    ].filter(Boolean);
    if (facts.length) out.push(facts.join(' · '), '');
    if (d.summary) out.push(d.summary, '');
    if (d.whatChanged.length) out.push('### What changed', '', ...d.whatChanged.map((w) => `- ${oneLine(w)}`), '');
    if (d.openItems.length) out.push('### Still open', '', ...d.openItems.map((w) => `- ${oneLine(w)}`), '');
    if (d.followUps.length) out.push('### Follow-ups', '', ...d.followUps.map((w) => `- ${oneLine(w)}`), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The spec index — docs/product/README.md: every feature, where it stands, and how it measures up. */
export function renderSpecMarkdown(spec: ProjectSpec, opts: { featureLinks?: boolean } = {}): string {
  const t = spec.totals;
  const link = (f: SpecFeature) => (opts.featureLinks ? `[${f.name}](features/${f.slug}.md)` : f.name);
  const out: string[] = [
    `# ${spec.project.name} — product spec`, '',
    `> ${GENERATED_NOTE} Last generated ${day(spec.generatedAt)}.`, '',
  ];
  if (spec.project.description) out.push(spec.project.description, '');
  out.push(
    `**${t.features - t.existing} features on the list** — ${t.done} done, ${t.delivered} delivered awaiting sign-off, `
      + `${t.inProgress + t.paused} in progress, ${t.planned} planned. `
      + `Of those built, ${t.verified} ${t.verified === 1 ? 'meets' : 'meet'} every acceptance criterion${t.gaps ? `, **${t.gaps} ${t.gaps === 1 ? 'does' : 'do'} not yet**` : ''}.`
      + `${t.intentOnly ? ` ${t.intentOnly} ${t.intentOnly === 1 ? 'was' : 'were'} built without acceptance criteria.` : ''}`
      + `${t.existing ? ` Plus ${t.existing} that already existed when the project was taken on.` : ''}`, '',
    '| # | Feature | Status | Against its criteria | Target |', '|---|---|---|---|---|',
    ...spec.features.filter((f) => f.status !== 'existing').map((f, i) => `| ${i + 1} | ${link(f)} | ${STATUS_LABEL[f.status]} | ${ALIGNMENT_LABEL[f.alignment]}`
      + `${f.criteria.length ? ` (${f.criteriaMet}/${f.criteria.length})` : ''} | ${f.targetDate || '—'} |`),
    '',
  );
  const existing = spec.features.filter((f) => f.status === 'existing');
  if (spec.groups.length) {
    // The executive's view: the capabilities, then each one's features under its own heading.
    const byId = new Map(spec.features.map((f) => [f.id, f]));
    out.push('## At a glance', '', '| Capability | Features | What it does |', '|---|---|---|',
      ...spec.groups.map((g) => `| ${g.name} | ${g.counts.features}${g.counts.existing && g.counts.existing < g.counts.features ? ` (${g.counts.existing} existing)` : ''} | ${cell(g.summary || g.sections.map((x) => x.name).filter(Boolean).join(' · ')) || '—'} |`), '');
    out.push('## By capability', '');
    for (const g of spec.groups) {
      out.push(`### ${g.name}`, '');
      if (g.summary) out.push(g.summary, '');
      for (const sec of g.sections) {
        if (sec.name) out.push(`**${sec.name}**`, '');
        out.push('| Feature | Status | What it does |', '|---|---|---|',
          ...sec.featureIds.map((id) => byId.get(id)!).map((f) => `| ${link(f)} | ${STATUS_LABEL[f.status]} | ${cell(f.intent.summary) || '—'} |`), '');
      }
    }
  } else if (existing.length) {
    out.push('## Already in the product', '', '| Feature | What it does |', '|---|---|',
      ...existing.map((f) => `| ${link(f)} | ${cell(f.intent.summary) || '—'} |`), '');
  }
  const gaps = spec.features.filter((f) => (f.status === 'done' || f.status === 'delivered') && (f.alignment === 'partial' || f.alignment === 'unverified'));
  if (gaps.length) {
    out.push('## Where the delivered work does not yet match the intent', '');
    for (const f of gaps) {
      out.push(`- **${f.name}** — ${f.criteria.filter((c) => c.result !== 'met').map((c) => `${c.id} ${c.result === 'not-met' ? 'not met' : 'not checked'}`).join(', ')}`);
    }
    out.push('');
  }
  if (spec.architecture) out.push('## Architecture', '', 'See [ARCHITECTURE.md](ARCHITECTURE.md).', '');
  out.push('Also: [ROADMAP.md](ROADMAP.md) · [CHANGELOG.md](CHANGELOG.md)', '');
  if (!opts.featureLinks) {
    out.push('---', '');
    for (const f of spec.features) out.push(renderFeatureMarkdown(f, spec.project).replace(/^# /, '## ').replace(/\n## /g, '\n### ').replace(/\n### (In scope|Out of scope|Must not break|Assumptions|What changed|Still open|Follow-ups)\n/g, '\n#### $1\n'), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The executive roadmap — outcomes and dates, nothing about how. */
export function renderRoadmapMarkdown(spec: ProjectSpec): string {
  const r = roadmapOf(spec);
  const t = spec.totals;
  const line = (f: SpecFeature) => {
    const bits = [
      f.status === 'paused' ? 'needs a decision' : f.status === 'delivered' ? 'delivered, awaiting sign-off' : '',
      f.criteria.length && f.status !== 'planned' ? `${f.criteriaMet}/${f.criteria.length} criteria met` : '',
      f.targetDate ? `target ${f.targetDate}` : '',
      f.status === 'done' && f.completedAt ? `done ${day(f.completedAt)}` : '',
    ].filter(Boolean);
    return `- **${f.name}**${bits.length ? ` — ${bits.join(' · ')}` : ''}${f.intent.summary ? `\n  ${oneLine(f.intent.summary).slice(0, 220)}` : ''}`;
  };
  const section = (title: string, items: SpecFeature[], empty: string) =>
    [`## ${title}`, '', ...(items.length ? items.map(line) : [`_${empty}_`]), ''];
  return `${[
    `# ${spec.project.name} — roadmap`, '',
    `> ${GENERATED_NOTE} As of ${day(spec.generatedAt)}.`, '',
    `${t.done} of ${t.features - t.existing} planned features done · ${t.inProgress + t.paused + t.delivered} in progress · ${t.planned} to go`
      + `${t.verified ? ` · ${t.verified} verified against their acceptance criteria` : ''}.`, '',
    ...section('Now', r.now, 'Nothing in progress.'),
    ...section('Next', r.next, 'Nothing queued.'),
    ...section('Later', r.later, 'Nothing further on the list.'),
    ...section('Done', r.done, 'Nothing finished yet.'),
  ].join('\n').trimEnd()}\n`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The roadmap as one self-contained HTML page — to send, print or put on a screen. */
export function renderRoadmapHtml(spec: ProjectSpec): string {
  const r = roadmapOf(spec);
  const t = spec.totals;
  const planned = Math.max(0, t.features - t.existing);
  const pct = planned ? Math.round((t.done / planned) * 100) : 0;
  const card = (f: SpecFeature) => {
    const meta = [
      f.status === 'paused' ? '<span class="tag warn">needs a decision</span>' : '',
      f.status === 'delivered' ? '<span class="tag">awaiting sign-off</span>' : '',
      f.criteria.length && f.status !== 'planned'
        ? `<span class="tag ${f.criteriaMet === f.criteria.length ? 'ok' : 'warn'}">${f.criteriaMet}/${f.criteria.length} criteria met</span>` : '',
      f.targetDate ? `<span class="tag">target ${esc(f.targetDate)}</span>` : '',
      f.status === 'done' && f.completedAt ? `<span class="tag ok">done ${esc(day(f.completedAt))}</span>` : '',
    ].join('');
    return `<div class="card"><div class="name">${esc(f.name)}</div>${f.intent.summary ? `<p>${esc(oneLine(f.intent.summary).slice(0, 260))}</p>` : ''}<div class="meta">${meta}</div></div>`;
  };
  const col = (title: string, items: SpecFeature[], empty: string) =>
    `<section><h2>${title} <span>${items.length}</span></h2>${items.length ? items.map(card).join('') : `<p class="empty">${empty}</p>`}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.project.name)} — roadmap</title>
<style>
  body{font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}
  header{background:#fff;border-bottom:1px solid #e3e6eb;padding:28px 40px}
  h1{margin:0 0 4px;font-size:26px} header p{margin:4px 0;color:#5b6372}
  .bar{height:8px;background:#e7e9ee;border-radius:4px;overflow:hidden;max-width:520px;margin-top:14px}
  .bar i{display:block;height:100%;background:#3aa675;width:${pct}%}
  .stats{display:flex;gap:26px;margin-top:14px;flex-wrap:wrap}.stats b{display:block;font-size:22px}
  main{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;padding:26px 40px}
  @media (max-width:1000px){main{grid-template-columns:1fr 1fr}} @media (max-width:640px){main{grid-template-columns:1fr;padding:18px}}
  h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5b6372;margin:0 0 10px}h2 span{color:#9aa1ad}
  .card{background:#fff;border:1px solid #e3e6eb;border-radius:10px;padding:12px 14px;margin-bottom:10px}
  .name{font-weight:600}.card p{margin:6px 0 0;color:#4a5160;font-size:13.5px}
  .meta{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}.tag{font-size:11.5px;background:#eef0f4;border-radius:999px;padding:2px 8px;color:#4a5160}
  .tag.ok{background:#e3f4ea;color:#1f7a4c}.tag.warn{background:#fdf0dc;color:#94600f}.empty{color:#9aa1ad;font-style:italic}
  footer{padding:0 40px 30px;color:#9aa1ad;font-size:12px}
</style></head><body>
<header><h1>${esc(spec.project.name)} — roadmap</h1>${spec.project.description ? `<p>${esc(spec.project.description)}</p>` : ''}
<div class="bar"><i></i></div>
<div class="stats"><div><b>${t.done}/${planned}</b>features done</div><div><b>${t.inProgress + t.paused + t.delivered}</b>in progress</div><div><b>${t.planned}</b>to go</div><div><b>${t.verified}</b>verified against criteria</div></div></header>
<main>${col('Now', r.now, 'Nothing in progress.')}${col('Next', r.next, 'Nothing queued.')}${col('Later', r.later, 'Nothing further.')}${col('Done', r.done, 'Nothing finished yet.')}</main>
<footer>As of ${esc(day(spec.generatedAt))} · generated by NeonCore from the project's feature list.</footer>
</body></html>
`;
}
