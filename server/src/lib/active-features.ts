/**
 * THE FEATURES ON THE MAP — every running or paused feature, with what the world scene needs to
 * draw it as a team: the agents working on it, how far its pipeline is, whether it needs you, and
 * (for a feature on its own branch) each worktree's real repo, so its agents stand at their repo's
 * building instead of on land nobody claimed.
 */
import db from '../db.js';
import { pilotsInPhase, stagesOf } from './goal-pilot.js';
import { liveCartridge } from './goal-pilot-runner.js';
import { agentIdForRepoAndType } from './resolve-agent.js';
import { workflowNeedsAttention } from './workflow-attention.js';

export interface ActiveFeature {
  pilotId: string;
  goalId: string;
  projectId: string;
  name: string;
  phase: string;
  /** The stage under way (or next), 1-based, of how many. Null before any stage exists. */
  stage: { position: number; total: number; title: string } | null;
  /** Why it is waiting on a person, in a few words; '' when it is not. */
  needsYou: string;
  /** The agents working on it right now. */
  agentIds: string[];
  /** For a feature on its own branch: each worktree and the repo it is a worktree of. */
  worktrees: { worktreePath: string; repoPath: string }[];
  branch: string;
}

const live = (id: string | undefined) => {
  if (!id) return null;
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status?: string } | undefined;
  return row && row.status !== 'offline' ? id : null;
};

export function activeFeatures(): ActiveFeature[] {
  return pilotsInPhase('running', 'paused').map((pilot) => {
    const goal = db.prepare('SELECT name, project_id FROM goals WHERE id = ?').get(pilot.goalId) as { name?: string; project_id?: string } | undefined;
    const stages = stagesOf(pilot.id);
    const current = stages.find((s) => s.status === 'running' || s.status === 'waiting') ?? stages.find((s) => s.status === 'pending') ?? null;
    const attention = current?.runId ? workflowNeedsAttention(current.runId) : null;
    const ws = pilot.workspace;
    const agents = new Set<string>();
    if (ws) {
      // Its own branch: the cartridges in its worktrees are its team, whichever stage is running.
      for (const r of ws.repos) if (!r.removed) { const id = live(agentIdForRepoAndType(r.worktreePath, r.agentType)); if (id) agents.add(id); }
    } else if (current) {
      // In the repos' own checkouts: whoever carries the stage under way.
      const ids = [live(current.agentId), liveCartridge(current.repoPath, current.agentType),
        ...current.participants.map((p) => liveCartridge(p.repoPath, p.agentType))];
      for (const id of ids) if (id) agents.add(id);
    }
    return {
      pilotId: pilot.id,
      goalId: pilot.goalId,
      projectId: goal?.project_id ?? '',
      name: goal?.name ?? '',
      phase: pilot.phase,
      stage: current ? { position: current.position + 1, total: stages.length, title: current.title } : null,
      needsYou: pilot.phase === 'paused' ? (pilot.attention || 'The pipeline stopped and needs you') : attention ? 'A stage needs you' : '',
      agentIds: [...agents],
      worktrees: ws ? ws.repos.filter((r) => !r.removed).map((r) => ({ worktreePath: r.worktreePath, repoPath: r.repoPath })) : [],
      branch: ws?.branch ?? '',
    };
  });
}
