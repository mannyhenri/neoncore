/**
 * The words for a task-list run's progress (see components/RunProgress.tsx). Pure, so the run
 * card, the progress window and the Goal Pilot stage all say the same thing.
 */
import type { Workflow } from '../types';

type Summary = NonNullable<Workflow['progress']>;

/** "14 of 23 tasks done · 2 blocked" — or "14 done, about 9 left" when the total is an estimate. */
export function progressLine(p: Summary): string {
  const blocked = p.blocked > 0 ? ` · ${p.blocked} blocked` : '';
  if (p.total === null) return `${p.done} task${p.done === 1 ? '' : 's'} done so far${blocked}`;
  if (p.basis === 'claims') {
    const left = Math.max(0, p.total - p.done);
    return `${p.done} task${p.done === 1 ? '' : 's'} done, about ${left} left${blocked}`;
  }
  return `${p.done} of ${p.total} task${p.total === 1 ? '' : 's'} done${blocked}`;
}

/** What the engine did at a coverage check, in a few words. */
export function coverageVerb(verdict: string): string {
  switch (verdict) {
    case 'complete': return 'every task done, the run goes on';
    case 'loop-back': return 'tasks still open — sent back to the work';
    case 'held': return 'no further progress — waiting for you';
    case 'continued': return 'you chose to keep working';
    case 'accepted': return 'you accepted it with tasks open';
    default: return verdict;
  }
}
