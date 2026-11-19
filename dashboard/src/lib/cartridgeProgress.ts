/**
 * How far along a cartridge's CURRENT piece of work is — the number a cartridge card's meter shows.
 *
 * Asked for (2026-11-18): "the progress bars should follow a progress, not just decorate the
 * cartridge/repo agents". The card used to light one cell per recent tool call, which measures
 * busyness, not progress. A meter now shows only a real fraction of real work, and nothing at all
 * when there is none (docs/DESIGN.md: meters never invent progress).
 *
 * Sources, most specific first:
 *   1. A running CONFER the cartridge takes part in → milestones done / milestones total, with the
 *      active milestone's name (and whether this cartridge has already signalled it).
 *   2. A running WORKFLOW RUN whose assigned repos include the cartridge's repo → steps completed /
 *      steps total, with the run's name.
 */
import type { Agent, ConferSession, Workflow } from '../types';

export interface CartridgeProgress {
  /** What the work is, e.g. "Confer · Revise" or "Super QA #79". */
  label: string;
  done: number;
  total: number;
  /** Where the work lives, for the tooltip. */
  kind: 'confer' | 'run';
  /** Confer only: this cartridge has already signalled the active milestone and waits for the others. */
  waitingOnOthers?: boolean;
}

const LIVE_RUN = new Set(['running', 'paused']);

export function cartridgeProgress(
  agent: Pick<Agent, 'id' | 'repoName'>,
  siblingIds: string[],
  confers: ConferSession[],
  runs: Workflow[],
): CartridgeProgress | null {
  const ids = new Set([agent.id, ...siblingIds]);

  const confer = confers.find((c) => c.status === 'running' && c.participantIds.some((p) => ids.has(p)) && (c.milestones?.length ?? 0) > 0);
  if (confer) {
    const ms = confer.milestones!;
    const done = ms.filter((m) => m.status === 'done').length;
    const active = ms.find((m) => m.status === 'active');
    return {
      kind: 'confer',
      label: `Confer · ${active?.name ?? ms[Math.min(done, ms.length - 1)].name}`,
      done,
      total: ms.length,
      waitingOnOthers: !!active && active.doneIds.some((d) => ids.has(d)),
    };
  }

  const repo = (agent.repoName || '').toLowerCase();
  const run = repo
    ? runs.find((r) => LIVE_RUN.has(r.status) && (r.stepSummary?.total ?? 0) > 0
        && (r.stepSummary?.projects ?? []).some((p) => p.toLowerCase() === repo))
    : undefined;
  if (run) {
    return {
      kind: 'run',
      label: `${run.name}${run.runNumber ? ` #${run.runNumber}` : ''}`,
      done: run.stepSummary!.completed,
      total: run.stepSummary!.total,
    };
  }
  return null;
}
