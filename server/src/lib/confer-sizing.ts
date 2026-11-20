/**
 * HOW MANY BUILD ROUNDS A CONFER GETS — from WHAT KIND of work it is, then from how much.
 *
 *   a single feature   → ONE build. Its parts are one piece of work: the participants agree the
 *                         split, each builds its part, and it lands. Counting its parts and
 *                         building in rounds turned a ten-part feature into three build rounds
 *                         (2026-11-19), each a full turn per participant plus the wait for every
 *                         done signal, for work that fits in one.
 *   a Jira epic        → rounds sized from its task count: `tasksPerRound` tasks per participant
 *                         per round, up to MAX_BUILD_ROUNDS (or the step's `maxBuildRounds`). An
 *                         epic really is many separate deliverables, and a round is a batch of them.
 *
 * Which one it is comes from the step named in `buildRoundsFrom` (Confer's "Scope the Work"),
 * which reports `MODE: EPIC <KEY> | TASK` beside its `TASK_COUNT`. When the run has come back to
 * the confer because tasks were still open (lib/coverage-loop.ts), an epic is sized to what is
 * LEFT; a single feature is still one build. A pass for one or two leftover tasks is not a confer
 * at all (LEFTOVER_MAX_TASKS, leftoverOwners).
 *
 * Anything that cannot be read — no mode, no count, no output — is ONE build: a wrong number of
 * rounds is worse than a small one. A confer step with no `buildRoundsFrom` keeps the number it
 * was given (`buildRounds`, the picker on a hand-launched confer).
 */
import { MAX_BUILD_ROUNDS } from './confer-conductor.js';

export const DEFAULT_TASKS_PER_ROUND = 2;

/** How the sizing step says the work is a Jira epic (templates/confer.ts "Scope the Work"). */
export const EPIC_MODE_PATTERN = 'MODE:\\s*EPIC\\b';

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

export interface BuildRoundsFrom {
  step: string;
  /** One capture group: the task count. */
  pattern: string;
  tasksPerRound?: number;
  /** What marks the work as an epic in that step's output. Default EPIC_MODE_PATTERN. */
  epicPattern?: string;
}

export interface BuildRoundsResolution { rounds: number; note: string }

export function resolveBuildRounds(
  cfg: Record<string, unknown>,
  participants: number,
  depResults: Record<string, string>,
): BuildRoundsResolution {
  const from = cfg.buildRoundsFrom as BuildRoundsFrom | undefined;
  // No sizing rule: the number the step was given (a hand-launched confer's picker).
  if (!from?.step || !from?.pattern) {
    const given = clampRounds(typeof cfg.buildRounds === 'number' ? cfg.buildRounds : 1);
    return { rounds: given, note: `Build rounds: ${given} (as set on the step)` };
  }

  const once = (why: string): BuildRoundsResolution => ({ rounds: 1, note: `Build rounds: 1 — ${why}` });
  const source = depResults[from.step];
  if (!source) return once(`"${from.step}" produced no output to read, so it builds once`);

  let isEpic = false;
  try { isEpic = new RegExp(from.epicPattern || EPIC_MODE_PATTERN, 'i').test(source); } catch { /* an authoring error */ }
  if (!isEpic) return once('a single feature builds once (only an epic builds in rounds)');

  const cap = clampRounds(typeof cfg.maxBuildRounds === 'number' && cfg.maxBuildRounds >= 1 ? cfg.maxBuildRounds : MAX_BUILD_ROUNDS);
  const perRound = Math.max(1, Math.floor(Number(from.tasksPerRound) || DEFAULT_TASKS_PER_ROUND));
  const people = Math.max(1, participants);
  const size = (tasks: number, source: string): BuildRoundsResolution => {
    const wanted = Math.ceil(tasks / (people * perRound));
    const rounds = Math.min(cap, clampRounds(wanted));
    return {
      rounds,
      note: `Build rounds: ${rounds} — an epic with ${tasks} task(s) ${source}, ${people} participant(s), ${perRound} per participant per round`
        + (rounds < wanted ? ` (capped at ${rounds}; a coverage pass picks up the rest)` : ''),
    };
  };

  const left = Number(cfg._coverageRemaining);
  if (Number.isFinite(left) && left > 0) return size(left, 'still open');

  let m: RegExpMatchArray | null = null;
  try { m = source.match(new RegExp(from.pattern, 'i')); } catch { /* an authoring error */ }
  const tasks = m ? Number.parseInt(m[1], 10) : NaN;
  if (!Number.isFinite(tasks) || tasks < 1) return once(`an epic, but no task count in "${from.step}", so it builds once`);
  return size(tasks, `in "${from.step}"`);
}

function clampRounds(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_BUILD_ROUNDS);
}
