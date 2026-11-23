/**
 * PROJECT REWARDS — what a project has earned, counted from its own records. Nothing here is
 * awarded by hand and nothing is stored: a reward is a threshold a count has passed, so it is
 * always exactly as true as the records are.
 *
 *   features   features delivered                                   1 · 5 · 10 · 25 · 50 · 75 · 100
 *   epics      epics delivered (every feature of the epic)          1 · 5 · 10 · 25
 *   releases   releases shipped (a version cut in the changelog)       1 · 5 · 10 · 25
 *   bugs       bugs fixed through Triage (merged, or released)      1 · 5 · 10 · 25 · 50 · 100
 *   qa         QA runs finished against the project's app           5 · 25 · 50 · 100
 *   clean      features delivered with EVERY acceptance criterion   1 · 5 · 10 · 25
 *              passing on NeonCore's own evidence
 *   streak     the longest run of clean deliveries in a row         3 · 5 · 10
 *   ontime     features delivered on or before their target date    5 · 10 · 25
 *   commend    COMMENDATIONS: epics delivered on or before their date  1 · 2 · 3 · 4 — each one a promotion (RANKS)
 *   fastfix    bugs taken from report to pull request within an     1 · 5 · 10
 *              hour
 *
 * Imported ("already there") features are history, not deliveries: they earn nothing.
 */
import db from '../db.js';
import { chartOf } from './roadmap.js';
import { pilotsForGoal } from './goal-pilot.js';
import { storedGoalReport } from './goal-pilot-report.js';
import { normalizeRepoPath } from './resolve-agent.js';

export const REWARD_FAMILIES = [
  { id: 'features', label: 'Features delivered', one: 'feature delivered', many: 'features delivered', tiers: [1, 5, 10, 25, 50, 75, 100] },
  { id: 'epics', label: 'Epics delivered', one: 'epic delivered', many: 'epics delivered', tiers: [1, 5, 10, 25] },
  { id: 'releases', label: 'Releases shipped', one: 'release shipped', many: 'releases shipped', tiers: [1, 5, 10, 25] },
  { id: 'bugs', label: 'Bugs fixed', one: 'bug fixed', many: 'bugs fixed', tiers: [1, 5, 10, 25, 50, 100] },
  { id: 'qa', label: 'QA runs', one: 'QA run', many: 'QA runs', tiers: [5, 25, 50, 100] },
  { id: 'clean', label: 'Clean deliveries', one: 'clean delivery', many: 'clean deliveries', tiers: [1, 5, 10, 25] },
  { id: 'streak', label: 'Clean streak', one: 'clean delivery in a row', many: 'clean deliveries in a row', tiers: [3, 5, 10] },
  { id: 'ontime', label: 'On time', one: 'feature delivered on time', many: 'features delivered on time', tiers: [5, 10, 25] },
  { id: 'fastfix', label: 'Fast fixes', one: 'bug fixed within the hour', many: 'bugs fixed within the hour', tiers: [1, 5, 10] },
  { id: 'commend', label: 'Commendations', one: 'epic delivered on or before its date', many: 'epics delivered on or before their date', tiers: [1, 2, 3, 4] },
] as const;
export type RewardFamilyId = (typeof REWARD_FAMILIES)[number]['id'];
export const FAST_FIX_MS = 60 * 60_000;

/**
 * THE CAPTAIN'S RANK. Every commendation — an epic delivered on or before its date — promotes the
 * project's captain one rank, up to the last. The rank is the project's own: it is counted from its
 * epics like every other reward, never set by hand, and a project that has earned none has a Captain.
 */
export const RANKS = [
  { id: 'captain', title: 'Captain' },
  { id: 'general', title: 'General' },
  { id: 'commander', title: 'Commander' },
  { id: 'admiral', title: 'Admiral' },
  { id: 'president', title: 'President' },
] as const;
export type RankId = (typeof RANKS)[number]['id'];
export interface ProjectRank {
  /** 0 = Captain. */
  index: number; id: RankId; title: string;
  /** Epics delivered on or before their date. */
  commendations: number;
  /** The next rank and how many commendations it takes, or null at the top. */
  next: { title: string; at: number } | null;
}
export function rankFor(commendations: number): ProjectRank {
  const index = Math.min(Math.max(0, Math.floor(commendations)), RANKS.length - 1);
  return { index, id: RANKS[index].id, title: RANKS[index].title, commendations, next: index < RANKS.length - 1 ? { title: RANKS[index + 1].title, at: index + 1 } : null };
}

export interface RewardFamily {
  id: RewardFamilyId; label: string; count: number;
  /** Every tier, in order: its threshold, whether the count has reached it, and what it says. */
  tiers: { threshold: number; earned: boolean; label: string }[];
  /** The next threshold to reach, or null when every tier is earned. */
  next: number | null;
}
export interface ProjectRewards {
  projectId: string; name: string; color: string;
  families: RewardFamily[];
  earned: number; total: number;
  /** The captain's rank, from the project's commendations (RANKS). */
  rank: ProjectRank;
}

/** "10 features delivered", "1 epic delivered". */
export function rewardLabel(family: (typeof REWARD_FAMILIES)[number], threshold: number): string {
  return `${threshold} ${threshold === 1 ? family.one : family.many}`;
}

/** The counts, from the records. */
export function rewardCounts(projectId: string, now = Date.now()): Record<RewardFamilyId, number> | null {
  const chart = chartOf(projectId, now);
  if (!chart) return null;
  const delivered = [...chart.epics.flatMap((e) => e.features), ...chart.unassigned].filter((f) => f.state === 'delivered');
  // Clean: the feature's newest pipeline finished with every criterion passing (its stored report says SUCCESS).
  const clean = (goalId: string): boolean => {
    const pilots = pilotsForGoal(goalId).filter((p) => p.phase === 'completed').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = pilots[pilots.length - 1];
    return !!last && storedGoalReport(last.id)?.status === 'SUCCESS';
  };
  const inOrder = [...delivered].sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? '') || a.id.localeCompare(b.id));
  const cleanFlags = inOrder.map((f) => clean(f.id));
  let streak = 0; let run = 0;
  for (const ok of cleanFlags) { run = ok ? run + 1 : 0; streak = Math.max(streak, run); }

  // Bugs: Triage issues whose repo is one of the project's.
  const repos = new Set([
    ...(db.prepare('SELECT primary_repo FROM projects WHERE id = ?').all(projectId) as { primary_repo: string }[]).map((r) => r.primary_repo),
    ...(db.prepare('SELECT repo_path FROM project_cartridges WHERE project_id = ?').all(projectId) as { repo_path: string }[]).map((r) => r.repo_path),
  ].filter(Boolean).map(normalizeRepoPath));
  let bugs = 0; let fastfix = 0;
  if (repos.size > 0) {
    const issues = db.prepare(`SELECT id, state, repo_path, pr_url, created_at FROM triage_issues WHERE repo_path != ''`).all() as { id: string; state: string; repo_path: string; pr_url: string; created_at: string }[];
    for (const i of issues) {
      if (!repos.has(normalizeRepoPath(i.repo_path))) continue;
      if (i.state !== 'fixed' && i.state !== 'released') continue;
      bugs++;
      const pr = (db.prepare(`SELECT MIN(at) AS at FROM triage_events WHERE issue_id = ? AND stage = 'pull_request'`).get(i.id) as { at?: string | null }).at;
      if (pr && Date.parse(pr) - Date.parse(i.created_at) <= FAST_FIX_MS) fastfix++;
    }
  }
  const qa = (db.prepare(`SELECT COUNT(*) AS n FROM qa_runs r JOIN qa_targets t ON t.id = r.target_id
                          WHERE t.project_id = ? AND r.kind = 'run' AND r.status IN ('passed', 'passed_with_repair', 'failed')`).get(projectId) as { n: number }).n;

  const releases = (db.prepare(`SELECT COUNT(DISTINCT release) AS n FROM project_changelog WHERE project_id = ? AND release != ''`).get(projectId) as { n: number }).n;

  return {
    features: delivered.length,
    releases,
    epics: chart.epics.filter((e) => e.progress.total > 0 && e.progress.done === e.progress.total).length,
    bugs, qa,
    clean: cleanFlags.filter(Boolean).length,
    streak,
    ontime: delivered.filter((f) => f.targetDate && f.completedAt && f.completedAt.slice(0, 10) <= f.targetDate).length,
    fastfix,
    commend: chart.epics.filter((e) => e.onTime).length,
  };
}

export function projectRewards(projectId: string, now = Date.now()): ProjectRewards | null {
  const project = db.prepare('SELECT id, name, color FROM projects WHERE id = ?').get(projectId) as { id: string; name: string; color: string } | undefined;
  const counts = project ? rewardCounts(projectId, now) : null;
  if (!project || !counts) return null;
  const families: RewardFamily[] = REWARD_FAMILIES.map((f) => {
    const count = counts[f.id];
    return {
      id: f.id, label: f.label, count,
      // A commendation's medal names the rank it brings.
      tiers: f.tiers.map((threshold, i) => ({ threshold, earned: count >= threshold, label: `${project.name} — ${f.id === 'commend' ? `${RANKS[Math.min(i + 1, RANKS.length - 1)].title}: ` : ''}${rewardLabel(f, threshold)}` })),
      next: f.tiers.find((t) => count < t) ?? null,
    };
  });
  return {
    projectId: project.id, name: project.name, color: project.color, families,
    earned: families.reduce((n, f) => n + f.tiers.filter((t) => t.earned).length, 0),
    total: families.reduce((n, f) => n + f.tiers.length, 0),
    rank: rankFor(counts.commend),
  };
}

/** Every project's rewards, oldest project first. */
export function allRewards(now = Date.now()): ProjectRewards[] {
  const ids = db.prepare('SELECT id FROM projects ORDER BY created_at, id').all() as { id: string }[];
  return ids.map((p) => projectRewards(p.id, now)).filter((r): r is ProjectRewards => r !== null);
}

// ── new maps ─────────────────────────────────────────────────────────────────────

/**
 * A NEW MAP OPENS when the whole outfit — every project together — has done enough. Each map
 * names what it takes; it is unlocked the first time ALL of it is true, and stays unlocked (a
 * feature reopened later does not close a place that was discovered).
 */
export const NEW_MAPS = [
  { id: 'frontier', name: 'The new frontier', requires: { features: 10, epics: 5, qa: 5, releases: 5, ontime: 5, bugs: 5 } },
] as const satisfies readonly { id: string; name: string; requires: Partial<Record<RewardFamilyId, number>> }[];

export interface MapRequirement { family: RewardFamilyId; label: string; count: number; target: number; met: boolean }
export interface MapProgress {
  id: string; name: string; requirements: MapRequirement[];
  met: number; total: number; unlocked: boolean; unlockedAt: string | null;
}

const unlockKey = (id: string) => `world.map.${id}.unlockedAt`;

/** The totals over every project, and where each new map stands. Records the moment a map is first unlocked. */
export function worldProgress(now = Date.now()): { totals: Record<RewardFamilyId, number>; maps: MapProgress[] } {
  const totals = Object.fromEntries(REWARD_FAMILIES.map((f) => [f.id, 0])) as Record<RewardFamilyId, number>;
  for (const p of db.prepare('SELECT id FROM projects').all() as { id: string }[]) {
    const c = rewardCounts(p.id, now);
    if (!c) continue;
    // Across projects a count adds up — except the streak, which is the best any one project has.
    for (const f of REWARD_FAMILIES) totals[f.id] = f.id === 'streak' ? Math.max(totals[f.id], c[f.id]) : totals[f.id] + c[f.id];
  }
  const maps = NEW_MAPS.map((m) => {
    const requirements: MapRequirement[] = (Object.entries(m.requires) as [RewardFamilyId, number][]).map(([family, target]) => {
      const fam = REWARD_FAMILIES.find((f) => f.id === family)!;
      return { family, label: rewardLabel(fam, target), count: totals[family], target, met: totals[family] >= target };
    });
    const all = requirements.every((r) => r.met);
    let unlockedAt = (db.prepare('SELECT value FROM settings WHERE key = ?').get(unlockKey(m.id)) as { value?: string } | undefined)?.value ?? null;
    if (all && !unlockedAt) {
      unlockedAt = new Date(now).toISOString();
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`).run(unlockKey(m.id), unlockedAt, unlockedAt);
    }
    return { id: m.id, name: m.name, requirements, met: requirements.filter((r) => r.met).length, total: requirements.length, unlocked: !!unlockedAt, unlockedAt };
  });
  return { totals, maps };
}
