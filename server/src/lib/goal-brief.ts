/**
 * The goal, compiled into something an agent can act on, and delivered where every prompt
 * already passes.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * Goals were a billing hierarchy. Cost aggregated UP correctly — cartridge → project → goal
 * (goal-cost.ts) — while intent never flowed DOWN. `sendCommandToAgent` injected attachments,
 * memory and the work standard; the only code reading a goal at dispatch time was the
 * heartbeat budget gate, reading `budget_usd` in order to STOP work. A goal could halt an
 * agent and never direct one.
 *
 * ── WHY IT RIDES THE WORK-STANDARD RAIL ────────────────────────────────────────────────
 * This codebase already solved "a contract that must travel with the work": dispatch offers
 * it in ONE place, and nine call sites inherit — workflow steps, queued tasks, confer turns,
 * epic tasks, recovery replays, dashboard, mobile. The brief goes in beside it rather than
 * being plumbed through each caller, because the second approach is how two of the nine get
 * forgotten.
 *
 * ── WHAT THE FIELDS ARE FOR ────────────────────────────────────────────────────────────
 * Outcome and why-now let an agent make the judgment call you would when the spec runs out.
 * Acceptance criteria are the executive's version of the `verify:` line the work standard
 * already demands. Appetite is a design constraint, not a tripwire discovered by being killed.
 * NO-GOS are the highest-value field in the set and the reason this is not just an OKR form:
 * every other framework describes what to build, and the characteristic failure of a capable
 * agent is helpfully doing three adjacent things nobody asked for.
 */
import db from '../db.js';
import { autonomyBriefLine } from './goal-pm.js';
import { agentIdsForRepo } from './resolve-agent.js';

/**
 * Capped because the brief competes for context with the memory block and the work standard,
 * both already injected at dispatch. An uncapped brief on a goal with a long mission statement
 * would crowd out the memory that makes an agent useful in the repo.
 */
export const GOAL_BRIEF_MAX_CHARS = 2000;
const SECTION_MAX_CHARS = 500;

export interface GoalRow {
  id: string;
  name: string;
  description: string;
  acceptanceCriteria: string;
  noGos: string;
  rabbitHoles: string;
  invariants: string;
  keyResults: string;
  budgetUsd: number | null;
}

function normalize(row: Record<string, unknown>): GoalRow {
  return {
    id: row.id as string,
    name: (row.name as string) || '',
    description: (row.description as string) || '',
    acceptanceCriteria: (row.acceptance_criteria as string) || '',
    noGos: (row.no_gos as string) || '',
    rabbitHoles: (row.rabbit_holes as string) || '',
    invariants: (row.invariants as string) || '',
    keyResults: (row.key_results as string) || '[]',
    budgetUsd: row.budget_usd != null ? (row.budget_usd as number) : null,
  };
}

/**
 * Which goal, if any, is this cartridge working toward?
 *
 * Mirrors the attribution goal-cost.ts already uses so spend and intent resolve the same way —
 * a cartridge whose cost counts against a goal is exactly the one that should be told about it.
 * Both ownership routes are honoured: `project_cartridges` (the explicit set a project owns)
 * and `primary_repo` (the older single-repo link), because projects in the wild use both.
 */
export function goalForAgent(agentId: string): GoalRow | null {
  if (!agentId) return null;
  const agent = db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(agentId) as
    { repo_path?: string } | undefined;
  const repo = agent?.repo_path || '';
  if (!repo) return null;

  const row = db.prepare(`
    SELECT g.* FROM goals g
      JOIN projects p ON p.goal_id = g.id
     WHERE p.id IN (SELECT project_id FROM project_cartridges WHERE repo_path = ?)
        OR p.primary_repo = ?
     LIMIT 1
  `).get(repo, repo) as Record<string, unknown> | undefined;

  return row ? normalize(row) : null;
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > SECTION_MAX_CHARS ? `${t.slice(0, SECTION_MAX_CHARS)}…` : t;
}

/** Render the key-results JSON as lines a person (or a model) reads without parsing. */
function renderKeyResults(json: string): string {
  try {
    const krs = JSON.parse(json) as {
      metric?: string; baseline?: string; target?: string; measure?: string;
    }[];
    if (!Array.isArray(krs) || krs.length === 0) return '';
    return krs
      .filter((k) => k?.metric)
      .map((k) => {
        const move = k.baseline || k.target ? ` — ${k.baseline || '?'} → ${k.target || '?'}` : '';
        const how = k.measure && k.measure !== 'manual' ? ` (measured: ${k.measure})` : '';
        return `· ${k.metric}${move}${how}`;
      })
      .join('\n');
  } catch {
    // Malformed JSON must not take the whole brief down with it — the rest of the goal is
    // still worth sending, and a silent omission beats a dispatch that throws.
    return '';
  }
}

/**
 * Compile a goal into the block that rides along with a dispatched prompt.
 * Returns '' when there is nothing worth saying — silence, never a placeholder heading.
 */
export function buildGoalBrief(goalId: string): string {
  if (!goalId) return '';
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown> | undefined;
  if (!row) return '';
  const g = normalize(row);

  const sections: string[] = [];
  if (g.name) sections.push(`OUTCOME: ${clip(g.name)}`);
  if (g.description) sections.push(`WHY NOW: ${clip(g.description)}`);

  const krs = renderKeyResults(g.keyResults);
  if (krs) sections.push(`KEY RESULTS:\n${clip(krs)}`);

  if (g.acceptanceCriteria) sections.push(`ACCEPTANCE CRITERIA — this is what "done" is judged against:\n${clip(g.acceptanceCriteria)}`);
  if (g.invariants) sections.push(`INVARIANTS — must not break:\n${clip(g.invariants)}`);
  // Phrased as an instruction rather than a label: a list of excluded work only changes
  // behaviour if it is unambiguous that stopping is the correct response.
  if (g.noGos) sections.push(`NO-GOS — explicitly out of scope. Do NOT do these, and say so if the task seems to require one:\n${clip(g.noGos)}`);
  if (g.rabbitHoles) sections.push(`RABBIT HOLES — known traps, already paid for once:\n${clip(g.rabbitHoles)}`);
  if (g.budgetUsd != null) sections.push(`APPETITE: $${g.budgetUsd} — a constraint on the shape of the solution, not just a cap.`);

  // Autonomy reaches the agent as an INSTRUCTION, not a label: "this goal is Supervised" is a
  // word, and a word changes nothing. Unset stays silent rather than defaulting — a posture
  // nobody chose must not grant latitude nobody granted.
  const autonomy = autonomyBriefLine((row as Record<string, unknown>).autonomy);
  if (autonomy) sections.push(autonomy);

  // The deadline, because it changes how work should be scoped — an agent with two days left
  // should not start a refactor. Owner and investment category deliberately do NOT travel:
  // they are reporting attributes, and nothing an agent does differs because of them.
  const targetDate = String((row as Record<string, unknown>).target_date || '').trim();
  if (targetDate) sections.push(`TARGET DATE: ${targetDate.slice(0, 10)} — scope the work to fit it, and say so if it will not.`);

  if (sections.length === 0) return '';

  const brief = `[NeonCore goal — the work you are doing belongs to this]\n${sections.join('\n')}`;
  return brief.length > GOAL_BRIEF_MAX_CHARS ? `${brief.slice(0, GOAL_BRIEF_MAX_CHARS - 1)}…` : brief;
}

/** The brief for whatever goal owns this cartridge — '' when it is not on one. */
export function goalBriefForAgent(agentId: string): string {
  const g = goalForAgent(agentId);
  return g ? buildGoalBrief(g.id) : '';
}

/** Exported for the cost/attribution symmetry test — same resolution, both directions. */
export { agentIdsForRepo };
