import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { cartridgeProgress } from '../lib/cartridgeProgress';
import type { ConferSession, Workflow } from '../types';

/**
 * "The progress bars should follow a progress, not just decorate the cartridge/repo agents."
 * Set-based over every source, and over every case where there is NO progress — a meter that
 * appears without a real done/total is the defect this replaces.
 */
const agent = { id: 'a1', repoName: 'gl-dev' };
const ms = (statuses: ('done' | 'active' | 'pending')[], doneIds: string[] = []) =>
  statuses.map((status, idx) => ({ id: `m${idx}`, sessionId: 'c', idx, key: 'k', name: ['Frame', 'Draft', 'Critique', 'Revise', 'Finalize'][idx] ?? `M${idx}`, round: 1, status, doneIds: status === 'active' ? doneIds : [], dispatchedAt: null, completedAt: null }));
const confer = (over: Partial<ConferSession>) => ({ id: 'c', status: 'running', participantIds: ['a1', 'a2'], milestones: ms(['done', 'done', 'done', 'active', 'pending']), ...over }) as unknown as ConferSession;
const run = (over: Partial<Workflow>) => ({ id: 'w', name: 'Super QA', runNumber: 79, status: 'running', stepSummary: { total: 7, completed: 3, running: 1, failed: 0, pending: 3, projects: ['gl-dev'] }, ...over }) as unknown as Workflow;

describe('a cartridge meter is real progress', () => {
  it('a confer it takes part in: milestones done / total, named by the active one', () => {
    expect(cartridgeProgress(agent, [], [confer({})], [])).toEqual({ kind: 'confer', label: 'Confer · Revise', done: 3, total: 5, waitingOnOthers: false });
  });

  it('says when this cartridge has signalled and waits on the others', () => {
    const c = confer({ milestones: ms(['done', 'active', 'pending'], ['a1']) });
    expect(cartridgeProgress(agent, [], [c], [])?.waitingOnOthers).toBe(true);
  });

  it('a sibling engine in the same repo counts as the cartridge', () => {
    expect(cartridgeProgress(agent, ['a9'], [confer({ participantIds: ['a9'] })], [])?.kind).toBe('confer');
  });

  it('a live run on its repo: steps completed / total', () => {
    expect(cartridgeProgress(agent, [], [], [run({})])).toEqual({ kind: 'run', label: 'Super QA #79', done: 3, total: 7 });
  });

  it('a confer outranks a run', () => {
    expect(cartridgeProgress(agent, [], [confer({})], [run({})])?.kind).toBe('confer');
  });

  const NONE: { name: string; confers: ConferSession[]; runs: Workflow[] }[] = [
    { name: 'no work at all', confers: [], runs: [] },
    { name: 'a finished confer', confers: [confer({ status: 'completed' })], runs: [] },
    { name: 'a confer it is not in', confers: [confer({ participantIds: ['zz'] })], runs: [] },
    { name: 'a confer with no milestones', confers: [confer({ milestones: [] })], runs: [] },
    { name: 'a completed run', confers: [], runs: [run({ status: 'completed' })] },
    { name: 'a run on another repo', confers: [], runs: [run({ stepSummary: { total: 7, completed: 3, running: 1, failed: 0, pending: 3, projects: ['other'] } })] },
    { name: 'a run with no steps', confers: [], runs: [run({ stepSummary: { total: 0, completed: 0, running: 0, failed: 0, pending: 0, projects: ['gl-dev'] } })] },
  ];
  it.each(NONE)('$name → no meter', ({ confers, runs }) => {
    expect(cartridgeProgress(agent, [], confers, runs)).toBeNull();
  });

  it('the card no longer counts tool calls into its meter', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../components/CartridgeCard.tsx'), 'utf8');
    expect(src).not.toMatch(/SEG_WINDOW_MS|tool calls? in the last 30 minutes/);
    expect(src).toMatch(/progress && progress\.total > 0/);
  });
});
