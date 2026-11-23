/**
 * NEEDS YOU — everything waiting on the person right now, from state.
 *
 * REQUESTED: "sometimes where I need to be notified to act on something and have no warnings."
 * The bell was the only surface, and the bell is EVENTS: the last 20 socket messages held in the
 * open tab. A "needs you" sent while the dashboard was closed was never seen; one sent before a
 * reload was gone; twenty routine notices pushed a real ask off the end. Gridlight's sharding
 * feature waited ~23 hours on a decision the person was never shown that way.
 *
 * So the question "what is waiting on me?" is answered from the rows, at any moment, the same way
 * workflow-attention.ts answers it for one run: a feature's phase, its stages, its contract, its
 * workspace, and every run's attention. Nothing here is remembered; a resolved thing leaves the
 * list because its state changed.
 *
 * Only what a PERSON must clear is listed (PERSON_REASONS). What NeonCore settles itself — a
 * feature's template decision with a recommendation, a quiet cartridge it nudges — never is.
 */
import db from '../db.js';
import { pilotsInPhase, stagesOf, type GoalPilot } from './goal-pilot.js';
import { getContract } from './acceptance-contract.js';
import { workflowNeedsAttention, PERSON_REASONS, type Attention } from './workflow-attention.js';
import { featureTakesDecisions, recommendationOf, effectiveAutonomy } from './autonomy.js';
import { personAskFrom } from './workflow-loop.js';

export type NeedsYouKind =
  | 'questions' | 'plan' | 'start' | 'tests' | 'checklist' | 'cartridge' | 'stopped'
  | 'run' | 'mark-done' | 'merge-blocked' | 'merge-yourself';

export interface NeedsYouItem {
  /** Stable while the same thing waits — a surface can tell new from seen. */
  key: string;
  kind: NeedsYouKind;
  /** The feature's (or run's) name. */
  title: string;
  /** What to do, in one line a person can act on. */
  what: string;
  since: string;
  projectId: string;
  goalId: string;
  pilotId: string;
  workflowId: string;
}

/**
 * Every feature announcement that asks the person to act (goal-pilot-runner announcePilot with
 * urgency 'action') → the kind of item that stands for it here. The test reads every
 * announcePilot(…, 'action') in the code and requires it in this map: a new ask that is only an
 * event — and so can be missed — fails there.
 */
export const ASKS_AS_ITEMS: Record<string, NeedsYouKind> = {
  questions: 'questions',
  plan: 'plan',
  'tests-ready': 'tests',
  'approval-blocked': 'tests',
  'checklist-ready': 'checklist',
  'tests-need-cartridge': 'cartridge',
  'review-needs-cartridge': 'cartridge',
  'stage-needs-cartridge': 'cartridge',
  paused: 'stopped',
  'tests-tampered': 'stopped',
  'planner-failed': 'stopped',
  completed: 'mark-done',
  'prs-opened': 'mark-done',
  'merge-blocked': 'merge-blocked',
};

interface GoalRow { name: string; project_id: string; status: string }
const goalOf = (goalId: string) => db.prepare('SELECT name, project_id, status FROM goals WHERE id = ?').get(goalId) as GoalRow | undefined;

/** The newest ask of a person an agent made in this run (its `NEXT: Person: …` line), or ''. */
export function agentAskInRun(workflowId: string): string {
  const rows = db.prepare(`SELECT result FROM workflow_steps WHERE workflow_id = ? AND result IS NOT NULL AND result != ''
                            ORDER BY COALESCE(completed_at, started_at) DESC LIMIT 6`).all(workflowId) as { result: string }[];
  for (const r of rows) { const ask = personAskFrom(r.result); if (ask) return ask; }
  return '';
}

/** A run's attention, when a person must clear it — not what NeonCore settles by itself. */
function personAttention(workflowId: string): Attention | null {
  const a = workflowNeedsAttention(workflowId);
  if (!a || !PERSON_REASONS.includes(a.reason)) return null;
  if (a.reason === 'decision' && effectiveAutonomy(workflowId).level !== 'manual' && featureTakesDecisions(workflowId)) {
    const cfg = db.prepare('SELECT executor_config FROM workflow_steps WHERE id = ?').get(a.stepId) as { executor_config?: string } | undefined;
    if (recommendationOf(cfg?.executor_config ?? '')) return null;   // taken on the next sweep, not asked
  }
  return a;
}

function runLine(workflowId: string, a: Attention): string {
  const ask = agentAskInRun(workflowId);
  return ask ? `${a.detail} The agent asks: ${ask}` : a.detail;
}

function featureItems(pilot: GoalPilot): NeedsYouItem[] {
  const goal = goalOf(pilot.goalId);
  if (!goal) return [];
  const base = { title: goal.name, projectId: goal.project_id ?? '', goalId: pilot.goalId, pilotId: pilot.id, workflowId: '', since: pilot.updatedAt };
  const item = (kind: NeedsYouKind, what: string, extra: Partial<NeedsYouItem> = {}): NeedsYouItem =>
    ({ ...base, key: `${pilot.id}:${kind}:${extra.workflowId ?? ''}`, kind, what, ...extra });
  const out: NeedsYouItem[] = [];

  switch (pilot.phase) {
    case 'clarifying': out.push(item('questions', 'Answer the planner\'s questions so it can scope the feature.')); break;
    case 'proposed': out.push(item('plan', 'Review the plan — its criteria and workflows — and accept it.')); break;
    case 'staffing': out.push(item('start', 'Choose the repos and start the pipeline.')); break;
    case 'paused': out.push(item('stopped', pilot.attention || 'The pipeline stopped and needs you.')); break;
    default: if (pilot.attention && pilot.phase !== 'running' && pilot.phase !== 'completed') out.push(item('stopped', pilot.attention));
  }

  if (pilot.phase === 'running' || pilot.phase === 'paused') {
    const contract = getContract(pilot.id);
    for (const s of stagesOf(pilot.id)) {
      if (s.status === 'review') {
        out.push(s.kind === 'review'
          ? item('checklist', 'Confirm or overrule the reviewer\'s checklist verdicts.')
          : item('tests', contract?.feedback ? `The acceptance tests were not locked: ${contract.feedback}` : 'Review the acceptance tests and approve them.'));
      } else if (s.status === 'waiting' && s.waitReason) {
        out.push(item('cartridge', s.waitReason, { key: `${pilot.id}:cartridge:${s.id}` }));
      } else if (s.status === 'running' && s.runId && pilot.phase === 'running') {
        const a = personAttention(s.runId);
        if (a) out.push(item('run', `Stage ${s.position + 1} (${s.title}): ${runLine(s.runId, a)}`, { workflowId: s.runId, key: `${pilot.id}:run:${a.reason}:${a.stepId}` }));
      }
    }
  }

  const ws = pilot.workspace;
  if (pilot.phase === 'completed') {
    if (goal.status !== 'achieved') out.push(item('mark-done', 'Read the feature report, then mark the feature done.'));
    if (ws && !ws.cleanedAt) {
      const stuck = ws.repos.filter((r) => !r.removed && r.error);
      const open = ws.repos.filter((r) => !r.removed && r.pr?.state === 'open');
      if (stuck.length) out.push(item('merge-blocked', `Not merged: ${stuck.map((r) => r.error).join(' · ')}`));
      else if (goal.status === 'achieved' && ws.mergeMyself && open.length) {
        out.push(item('merge-yourself', `Merge ${open.length === 1 ? 'its PR' : `its ${open.length} PRs`} on GitHub: ${open.map((r) => r.pr!.url).join(' · ')}`));
      }
    }
  }
  return out;
}

/** Everything waiting on the person, most recent first. */
export function needsYou(): NeedsYouItem[] {
  const out: NeedsYouItem[] = [];
  const featureRuns = new Set<string>();
  for (const pilot of pilotsInPhase('scoping', 'clarifying', 'planning', 'proposed', 'staffing', 'running', 'paused', 'completed')) {
    for (const s of stagesOf(pilot.id)) if (s.runId) featureRuns.add(s.runId);
    try { out.push(...featureItems(pilot)); } catch (err) { console.warn(`[needs-you] feature ${pilot.id.slice(0, 8)}:`, err); }
  }
  // Runs that are no feature's stage.
  const runs = db.prepare("SELECT id, name, run_number, project_id, started_at, created_at FROM workflows WHERE status = 'running'").all() as
    { id: string; name: string; run_number: number | null; project_id: string | null; started_at: string | null; created_at: string }[];
  for (const r of runs) {
    if (featureRuns.has(r.id)) continue;
    try {
      const a = personAttention(r.id);
      if (!a) continue;
      out.push({ key: `run:${r.id}:${a.reason}:${a.stepId}`, kind: 'run', title: `${r.name}${r.run_number ? ` #${r.run_number}` : ''}`, what: runLine(r.id, a),
        since: r.started_at ?? r.created_at, projectId: r.project_id ?? '', goalId: '', pilotId: '', workflowId: r.id });
    } catch (err) { console.warn(`[needs-you] run ${r.id.slice(0, 8)}:`, err); }
  }
  return out.sort((a, b) => b.since.localeCompare(a.since));
}
