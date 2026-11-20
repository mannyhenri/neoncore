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
 * The count is CAPPED (SIZED_ROUNDS_CAP), and a pass for one or two leftover tasks is not a
 * confer at all (LEFTOVER_MAX_TASKS, leftoverOwners).
 *
 * Every failure to read a count falls back to the static `buildRounds`, as loop counts do: a
 * wrong number is worse than a small one.
 */
import { MAX_BUILD_ROUNDS } from './confer-conductor.js';

export const DEFAULT_TASKS_PER_ROUND = 2;

/**
 * THE CAP. A workflow confer builds at most this many rounds, however long the task list.
 *
 * Sizing from the task count gave a 10-task stage three build rounds — each one a full turn per
 * participant plus the wait for every done signal — before the review and landing steps. Two is
 * enough to batch a list; what a pass leaves open the coverage check sends back, and one or two
 * leftover tasks go straight to their owner (LEFTOVER_MAX_TASKS). A step that really wants more
 * says so with `maxBuildRounds`.
 */
export const SIZED_ROUNDS_CAP = 2;

/**
 * At or under this many tasks still open after a coverage check, the run does not go back through
 * a confer: the open tasks are sent, as one milestone, to the cartridge(s) whose repo owns them.
 * (2026-11-19: one task left of ten went through two more five-milestone confers — 91 minutes.)
 */
export const LEFTOVER_MAX_TASKS = 2;

/**
 * Who a leftover pass goes to: the participants whose repo is named on an outstanding line of the
 * coverage feedback ("- <id> <title> — <repo> — <why>", lib/coverage-loop.ts loopBackFeedback).
 * When no line names a repo of this roster, everyone gets it — a task nobody is sent is worse
 * than a short prompt to someone who answers "nothing of mine".
 */
export function leftoverOwners(feedback: string, roster: { id: string; repoName: string }[]): string[] {
  const lines = feedback.split('\n').filter((l) => /^\s*-\s+/.test(l)).map((l) => l.toLowerCase());
  const named = (repo: string) => {
    const r = repo.trim().toLowerCase();
    if (!r) return false;
    const esc = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The whole name, not a prefix of a longer one ("baseback" inside "baseback-admin").
    const re = new RegExp(`(^|[^a-z0-9_-])${esc}($|[^a-z0-9_-])`);
    return lines.some((l) => re.test(l));
  };
  const owners = roster.filter((p) => named(p.repoName)).map((p) => p.id);
  return owners.length ? owners : roster.map((p) => p.id);
}

export interface BuildRoundsFrom { step: string; pattern: string; tasksPerRound?: number }

export interface BuildRoundsResolution { rounds: number; note: string }

export function resolveBuildRounds(
  cfg: Record<string, unknown>,
  participants: number,
  depResults: Record<string, string>,
): BuildRoundsResolution {
  const cap = clampRounds(typeof cfg.maxBuildRounds === 'number' && cfg.maxBuildRounds >= 1 ? cfg.maxBuildRounds : SIZED_ROUNDS_CAP);
  const fallback = Math.min(cap, clampRounds(typeof cfg.buildRounds === 'number' ? cfg.buildRounds : 1));
  const from = cfg.buildRoundsFrom as BuildRoundsFrom | undefined;
  const perRound = Math.max(1, Math.floor(Number(from?.tasksPerRound) || DEFAULT_TASKS_PER_ROUND));
  const people = Math.max(1, participants);
  const size = (tasks: number, source: string): BuildRoundsResolution => {
    const wanted = Math.ceil(tasks / (people * perRound));
    const rounds = Math.min(cap, clampRounds(wanted));
    return {
      rounds,
      note: `Build rounds: ${rounds} — ${tasks} task(s) ${source}, ${people} participant(s), ${perRound} per participant per round`
        + (rounds < wanted ? ` (capped at ${rounds}; a coverage pass picks up the rest)` : ''),
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
