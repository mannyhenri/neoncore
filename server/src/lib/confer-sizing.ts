/**
 * HOW MANY BUILD ROUNDS A CONFER GETS — from the work, not from the template.
 *
 * Confer's build rounds were a constant: 3, for a two-task fix and a sixty-task Jira epic alike.
 * Each build round is ONE turn per participant in which it takes the next batch, so a big epic
 * meant each turn carried ten or fifteen tasks — the opposite of Epic: Task by Task, whose loop
 * is sized from the task count and gives each task its own dispatch.
 *
 * A confer step may now say where its task count comes from (`buildRoundsFrom`: an upstream
 * step's name and a pattern with one capture group, like a loop's `loopCountFrom`), and how many
 * tasks one participant should take per round. When the run has come back to the confer because
 * tasks were still open (lib/coverage-loop.ts), the count is what is LEFT, not the epic.
 *
 * Every failure to read a count falls back to the static `buildRounds`, as loop counts do: a
 * wrong number is worse than a small one.
 */
import { MAX_BUILD_ROUNDS } from './confer-conductor.js';

export const DEFAULT_TASKS_PER_ROUND = 2;

export interface BuildRoundsFrom { step: string; pattern: string; tasksPerRound?: number }

export interface BuildRoundsResolution { rounds: number; note: string }

export function resolveBuildRounds(
  cfg: Record<string, unknown>,
  participants: number,
  depResults: Record<string, string>,
): BuildRoundsResolution {
  const fallback = clampRounds(typeof cfg.buildRounds === 'number' ? cfg.buildRounds : 1);
  const from = cfg.buildRoundsFrom as BuildRoundsFrom | undefined;
  const perRound = Math.max(1, Math.floor(Number(from?.tasksPerRound) || DEFAULT_TASKS_PER_ROUND));
  const people = Math.max(1, participants);
  const size = (tasks: number, source: string): BuildRoundsResolution => {
    const wanted = Math.ceil(tasks / (people * perRound));
    const rounds = clampRounds(wanted);
    return {
      rounds,
      note: `Build rounds: ${rounds} — ${tasks} task(s) ${source}, ${people} participant(s), ${perRound} per participant per round`
        + (rounds < wanted ? ` (capped at ${MAX_BUILD_ROUNDS}; a coverage pass picks up the rest)` : ''),
    };
  };

  const left = Number(cfg._coverageRemaining);
  if (Number.isFinite(left) && left > 0) return size(left, 'still open');

  if (!from?.step || !from?.pattern) return { rounds: fallback, note: `Build rounds: ${fallback} (from the template)` };
  const source = depResults[from.step];
  if (!source) return { rounds: fallback, note: `Build rounds: ${fallback} — "${from.step}" produced no output to read, falling back to the template` };
  let m: RegExpMatchArray | null = null;
  try { m = source.match(new RegExp(from.pattern, 'i')); } catch { /* an authoring error */ }
  const tasks = m ? Number.parseInt(m[1], 10) : NaN;
  if (!Number.isFinite(tasks) || tasks < 1) {
    return { rounds: fallback, note: `Build rounds: ${fallback} — no task count in "${from.step}", falling back to the template` };
  }
  return size(tasks, `in "${from.step}"`);
}

function clampRounds(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_BUILD_ROUNDS);
}
