/**
 * THE WORK THE PHONE KEEPS MOVING — projects, their features and what waits on the person, from
 * every NeonCore server this phone talks to.
 *
 * The phone's role is to keep the ball rolling on ongoing projects: see what needs you and clear
 * it, see where each project stands (its Board and its Route), and start what comes next. Every
 * call here is one the dashboard makes too, against the same server routes.
 */
import type {
  ActiveFeature, GoalPilot, GoalPilotMeta, NeedsYouItem, NeedsYouKind, Project, ProjectRewards, ProjectSpec,
  RoadmapChart, RoadmapEpic, SpecFeature, PilotCandidateRepo,
} from '@neoncore/client';
import { req } from './api';
// The dashboard's own art registries (generated, import-free): the same badges and captain the web shows.
import { FEATURE_BADGES } from '../../dashboard/src/world/milestones';
import { KIT } from '../../dashboard/src/world/kit.generated';
import { DECK_ART } from '../../dashboard/src/world/bridge/bridge.generated';

export type { ActiveFeature, GoalPilot, NeedsYouItem, NeedsYouKind, Project, ProjectRewards, ProjectSpec, RoadmapChart, RoadmapEpic, SpecFeature };

const post = (body?: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) });
const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });

export const work = {
  needsYou: (base: string) => req<NeedsYouItem[]>(base, '/api/needs-you'),
  activeFeatures: (base: string) => req<ActiveFeature[]>(base, '/api/goal-pilots/active'),
  projects: (base: string) => req<Project[]>(base, '/api/projects'),
  rewards: (base: string, projectId: string) => req<ProjectRewards>(base, `/api/rewards/${encodeURIComponent(projectId)}`),
  spec: (base: string, projectId: string) => req<ProjectSpec>(base, `/api/projects/${encodeURIComponent(projectId)}/spec`),
  roadmap: (base: string, projectId: string) => req<RoadmapChart>(base, `/api/roadmap/${encodeURIComponent(projectId)}`),
  pilot: (base: string, pilotId: string) => req<GoalPilot>(base, `/api/goal-pilots/${encodeURIComponent(pilotId)}`),
  pilotsForFeature: (base: string, goalId: string) => req<GoalPilot[]>(base, `/api/goal-pilots?goalId=${encodeURIComponent(goalId)}`),
  meta: (base: string) => req<GoalPilotMeta>(base, '/api/goal-pilots/meta'),
  candidates: (base: string, goalId: string) => req<PilotCandidateRepo[]>(base, `/api/goal-pilots/candidates?goalId=${encodeURIComponent(goalId)}`),

  /** The planner's questions answered; a question "left to the planner" is delegated. */
  answer: (base: string, pilotId: string, answers: Record<string, { value: string | string[]; delegated?: boolean }>) =>
    req<unknown>(base, `/api/goal-pilots/${pilotId}/answers`, post({ answers })),
  acceptPlan: (base: string, pilotId: string) => req<GoalPilot>(base, `/api/goal-pilots/${pilotId}/accept-plan`, post()),
  revisePlan: (base: string, pilotId: string) => req<GoalPilot>(base, `/api/goal-pilots/${pilotId}/revise`, post()),
  approveTests: (base: string, pilotId: string) => req<unknown>(base, `/api/goal-pilots/${pilotId}/acceptance/approve`, post()),
  resume: (base: string, pilotId: string) => req<unknown>(base, `/api/goal-pilots/${pilotId}/resume`, post()),
  merge: (base: string, pilotId: string) => req<unknown>(base, `/api/goal-pilots/${pilotId}/workspace/merge`, post()),
  /** Start the pipeline in these repos (staffing). */
  startPipeline: (base: string, pilotId: string, repos: { repoPath: string; agentType: string }[]) =>
    req<GoalPilot>(base, `/api/goal-pilots/${pilotId}/start`, post({ repos })),
  /** Start a feature: scoping by a planner cartridge, from its intake. */
  startFeature: (base: string, body: { goalId: string; intake: Record<string, string>; plannerAgentId: string }) =>
    req<{ pilot: GoalPilot }>(base, '/api/goal-pilots', post(body)),
  /** Mark a feature done — refused (409) while anything it needs first is not done. */
  markDone: (base: string, goalId: string) => req<unknown>(base, `/api/goals/${goalId}`, put({ status: 'achieved' })),
  /** An epic's work QA'd as a whole: its done features move to Done on the Board. */
  passQa: (base: string, epicId: string) => req<RoadmapChart>(base, `/api/roadmap/epics/${epicId}`, put({ qaPassed: true })),
};

/** What each kind of "needs you" asks, and the one thing the phone can do about it right here. */
export const NEEDS: Record<NeedsYouKind, { label: string; action: string | null }> = {
  questions: { label: 'Questions', action: 'Answer' },
  plan: { label: 'Plan to accept', action: 'Accept the plan' },
  start: { label: 'Ready to start', action: 'Start the pipeline' },
  tests: { label: 'Tests to approve', action: 'Approve the tests' },
  checklist: { label: 'Checklist', action: null },
  cartridge: { label: 'Waiting on an agent', action: null },
  stopped: { label: 'Stopped', action: 'Resume' },
  run: { label: 'A stage asks', action: 'Open' },
  'mark-done': { label: 'Sign-off', action: 'Mark done' },
  'merge-blocked': { label: 'Not merged', action: 'Try the merge again' },
  'merge-yourself': { label: 'Merge on GitHub', action: null },
};

/** Badges earned by a feature (0–7), from where its pipeline stands — the dashboard's rule (world/milestones.ts). */
const PASSED: Record<string, number> = { scoping: 0, clarifying: 1, planning: 2, proposed: 3, staffing: 4, running: 5, paused: 5, completed: 6 };
export const BADGES = FEATURE_BADGES;
export function stepsEarned(phase: string, done = false): number {
  return done ? FEATURE_BADGES.length : PASSED[phase] ?? 0;
}
/** A badge's picture on the server (the theme in use draws it). */
export const badgeUrl = (base: string, sprite: string) => `${base}${(KIT as Record<string, { src: string }>)[sprite]?.src ?? ''}`;

/** The captain's sheet for a rank — the costume — on the server; the plain captain when that rank has none. */
export function captainArt(base: string, rankId?: string | null) {
  const sheet = (rankId && DECK_ART.sheets[`captain-${rankId}`]) || DECK_ART.sheets.captain;
  if (!sheet) return null;
  const rows = Object.values(sheet.rows);
  return {
    source: { uri: `${base}${sheet.src}` }, frameW: sheet.frameW, frameH: sheet.frameH,
    cols: Math.max(...rows.map((r) => r.frames)), rowCount: rows.length, rows: sheet.rows,
  };
}

/** The Board's columns, left to right (server lib/project-spec.ts placeColumns). */
export const COLUMNS = [
  { key: 'todo', title: 'To do' }, { key: 'progress', title: 'In Progress' }, { key: 'qa', title: 'QA' }, { key: 'done', title: 'Done' },
] as const;
export type ColumnKey = (typeof COLUMNS)[number]['key'];
/** Done as a feature, waiting for its epic's QA: on the Board it sits in QA. */
export const waitsOnEpicQa = (f: SpecFeature) => f.status === 'done' && (f.epicQa === 'open' || f.epicQa === 'waiting');
export function columnsOf(features: readonly SpecFeature[]): Record<ColumnKey, SpecFeature[]> {
  const out: Record<ColumnKey, SpecFeature[]> = { todo: [], progress: [], qa: [], done: [] };
  const OLD: Record<string, ColumnKey> = { now: 'progress', next: 'todo', later: 'todo' };
  for (const f of features) {
    if (!f.column) continue;
    (out[(OLD[f.column] ?? f.column) as ColumnKey] ?? out.todo).push(f);
  }
  out.done.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  return out;
}

/** What an epic's card says about its date. */
export function epicDate(e: RoadmapEpic, today: string): { text: string; tone: 'commend' | 'late' | 'due' | 'done' } | null {
  const due = e.targetDate ?? '';
  const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (e.deliveredAt) return e.onTime ? { text: `On time · due ${day(due)}`, tone: 'commend' } : { text: `Delivered ${day(e.deliveredAt)}`, tone: 'done' };
  if (!due) return null;
  if (e.late || due < today) return { text: `Late · was due ${day(due)}`, tone: 'late' };
  return { text: `Due ${day(due)}`, tone: 'due' };
}

/** A good default for starting a feature: its planner (a live cartridge in the project's repos first). */
export function pickPlanner<A extends { id: string; status: string; agentType: string; repoPath: string; mode?: string; lastSeen?: string }>(agents: readonly A[], projectRepos: readonly string[]): A | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const mine = new Set(projectRepos.map(norm));
  const score = (a: A) => (mine.has(norm(a.repoPath)) ? 0 : 10) + (a.mode === 'manual' ? 1 : 0) + (a.agentType === 'claude' ? 0 : 2);
  return [...agents].filter((a) => a.status !== 'offline').sort((x, y) => score(x) - score(y) || String(y.lastSeen ?? '').localeCompare(String(x.lastSeen ?? '')))[0] ?? null;
}

/** The repos to start a pipeline in: those the feature owns, each with its live engine (Claude first). */
export function defaultStaffing(candidates: readonly PilotCandidateRepo[], featureRepos: readonly string[] = []): { repoPath: string; agentType: string }[] {
  const want = new Set(featureRepos.map((p) => p.toLowerCase()));
  const chosen = candidates.filter((c) => (want.size ? want.has(c.repoPath.toLowerCase()) : c.owned));
  return chosen.map((c) => {
    const live = c.engines.filter((e) => e.status !== 'offline');
    const pool = live.length ? live : c.engines;
    return { repoPath: c.repoPath, agentType: (pool.find((e) => e.agentType === 'claude') ?? pool[0])?.agentType ?? 'claude' };
  });
}
