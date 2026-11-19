import { describe, it, expect } from 'vitest';
import {
  PILOT_STEPS, stepIndexFor, isLivePilot, waitingOnPlanner, suggestionFor, missingRequired, acceptSuggestions,
  isEmptyAnswer, answerLabel, moveItem, draftStagesFrom, includedStages, plannerCandidates, defaultEngine,
  engineStatus, resolveAssignments, intakeFromGoal, pipelineSummary, since, STAGE_TONE, STAGE_ICON,
  draftCriteriaFrom, criteriaProblems, contractAction, contractHeadline, OUTCOME_LABEL, OUTCOME_TONE,
} from '../goalPilot';
import type { Agent, AcceptanceContract, CriterionOutcome, Goal, GoalPilot, PilotPhase, PilotQuestion, PilotStage, PilotCandidateRepo } from '../../types';
import { DEMO_CONTRACT } from '../demoGoalPilot';

/** Every phase the server can report (server/src/lib/goal-pilot.ts → PilotPhase). */
const PHASES: PilotPhase[] = ['scoping', 'clarifying', 'planning', 'proposed', 'staffing', 'running', 'paused', 'completed', 'cancelled'];
const STATUSES: PilotStage['status'][] = ['pending', 'waiting', 'running', 'review', 'verifying', 'completed', 'failed', 'skipped', 'cancelled'];
/** Every criterion outcome (server/src/lib/acceptance-contract.ts → CriterionOutcome). */
const OUTCOMES: CriterionOutcome[] = ['pass', 'fail', 'not-run', 'met', 'not-met', 'unconfirmed', 'not-checked', 'waived'];

const q = (over: Partial<PilotQuestion>): PilotQuestion => ({
  id: 'q', text: 'Q?', why: '', kind: 'choice', options: ['A', 'B'], suggested: 'A', required: true, ...over,
});

describe('goal pilot panel logic', () => {
  it('every phase maps onto one of the five steps, in order', () => {
    for (const p of PHASES) {
      const i = stepIndexFor(p);
      expect(i, p).toBeGreaterThanOrEqual(1);
      expect(i, p).toBeLessThan(PILOT_STEPS.length);
    }
    const order = ['clarifying', 'proposed', 'staffing', 'running'] as PilotPhase[];
    expect(order.map(stepIndexFor)).toEqual([1, 2, 3, 4]);
    expect(PHASES.filter((p) => isLivePilot({ phase: p }))).toEqual(PHASES.filter((p) => p !== 'completed' && p !== 'cancelled'));
    expect(PHASES.filter((p) => waitingOnPlanner({ phase: p }))).toEqual(['scoping', 'planning']);
  });

  it('every stage status has a tone and an icon', () => {
    for (const s of STATUSES) { expect(STAGE_TONE[s], s).toBeTruthy(); expect(STAGE_ICON[s], s).toBeTruthy(); }
  });

  it('a delegated multi-select splits its suggestion only into real options (same rule as the server)', () => {
    expect(suggestionFor(q({ kind: 'multi', options: ['A', 'B', 'C'], suggested: 'A, C' }))).toEqual(['A', 'C']);
    expect(suggestionFor(q({ kind: 'multi', options: ['Weekly, monthly or yearly', 'X'], suggested: 'Weekly, monthly or yearly' }))).toEqual(['Weekly, monthly or yearly']);
    expect(suggestionFor(q({ kind: 'multi', options: ['A'], suggested: 'A, Z' }))).toEqual(['A, Z']);
    expect(suggestionFor(q({ kind: 'choice', suggested: 'B' }))).toBe('B');
  });

  it('required questions need an answer or a delegation; optional ones never block', () => {
    const qs = [q({ id: 'a' }), q({ id: 'b', kind: 'multi' }), q({ id: 'c', required: false }), q({ id: 'd', kind: 'text' })];
    expect(missingRequired(qs, {}).map((x) => x.id)).toEqual(['a', 'b', 'd']);
    expect(missingRequired(qs, { a: { value: 'A' }, b: { value: [] }, d: { value: '  ' } }).map((x) => x.id)).toEqual(['b', 'd']);
    expect(missingRequired(qs, { a: { value: 'A' }, b: { value: ['A'] }, d: { value: '', delegated: true } })).toEqual([]);
    expect(isEmptyAnswer({ value: '', delegated: true })).toBe(false);
  });

  it('"accept all suggestions" fills only what is still empty', () => {
    const qs = [q({ id: 'a' }), q({ id: 'b', suggested: '' , kind: 'text', options: [] }), q({ id: 'c' })];
    const out = acceptSuggestions(qs, { c: { value: 'B' } });
    expect(out).toEqual({ a: { value: 'A' }, c: { value: 'B' } });
  });

  it('answers read as sentences, delegations say so', () => {
    expect(answerLabel(q({}), { value: ['A', 'B'] })).toBe('A, B');
    expect(answerLabel(q({}), { value: 'A', delegated: true })).toBe('Agents decide → A');
    expect(answerLabel(q({}), undefined)).toBe('—');
  });

  it('stages reorder within bounds, and unticked ones are not accepted', () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
    const drafts = draftStagesFrom([
      { key: 's1', template: 'A', title: 'a', why: '', focus: '', optional: false },
      { key: 's2', template: 'B', title: 'b', why: '', focus: '', optional: true },
    ]);
    drafts[1].include = false;
    expect(includedStages(drafts)).toEqual([{ key: 's1', template: 'A', title: 'a', why: '', focus: '', optional: false }]);
  });

  it('planners: online only, Claude first', () => {
    const a = (id: string, agentType: string, status: string, lastSeen: string) => ({ id, agentType, status, lastSeen } as unknown as Agent);
    const out = plannerCandidates([a('x', 'codex', 'idle', '3'), a('y', 'claude', 'offline', '9'), a('z', 'claude', 'working', '1'), a('w', 'gridlight', 'idle', '5')]);
    expect(out.map((x) => x.id)).toEqual(['z', 'x', 'w']);
  });

  it('repos: the default engine is a live one, Claude among equals; assignments fall back to the first repo', () => {
    const repo: PilotCandidateRepo = { repoPath: '/r', repoName: 'r', machine: '', owned: false, engines: [
      { agentType: 'codex', agentId: '1', status: 'idle', name: '' }, { agentType: 'claude', agentId: '2', status: 'offline', name: '' },
    ] };
    expect(defaultEngine(repo)).toBe('codex');
    expect(engineStatus(repo, 'claude')).toBe('offline');
    expect(engineStatus(repo, 'gridlight')).toBe('none');
    expect(resolveAssignments(['s1', 's2', 's3'], ['/a', '/b'], { s2: '/b', s3: '/gone' })).toEqual({ s1: '/a', s2: '/b', s3: '/a' });
  });

  it('starting an existing feature pre-fills the intake from it — typed as a feature', () => {
    const goal = { name: 'G', description: 'why', successMetric: 'done', noGos: 'no', invariants: 'inv', targetDate: '2027-01-01', budgetUsd: 12, autonomy: 'assisted' } as unknown as Goal;
    expect(intakeFromGoal(goal)).toEqual({ goal: 'G', context: 'why', done: 'done', constraints: 'no\ninv', deadline: '2027-01-01', budgetUsd: '12', involvement: 'hands-off', workType: 'feature' });
  });

  it('the pipeline summary names the stage that matters now', () => {
    const st = (status: PilotStage['status'], title: string, attention = false) => ({ status, title, attention: attention ? { reason: 'decision', stepId: '', stepName: '', detail: '' } : null } as unknown as PilotStage);
    expect(pipelineSummary([st('completed', 'A'), st('running', 'B', true), st('pending', 'C')])).toBe('1 of 3 done · needs you: B');
    expect(pipelineSummary([st('completed', 'A'), st('skipped', 'B')])).toBe('2 of 2 done');
    expect(pipelineSummary([st('waiting', 'A')])).toBe('0 of 1 done · waiting: A');
  });

  it('elapsed time reads at a glance', () => {
    const now = Date.parse('2026-01-01T00:10:00Z');
    expect(since('2026-01-01T00:09:30Z', now)).toBe('30s');
    expect(since('2026-01-01T00:00:00Z', now)).toBe('10m');
    expect(since(null, now)).toBe('');
  });

  it('criteria: what was accepted wins, then the planner\'s, then one per line of the old free text', () => {
    const crit = [{ id: 'AC-1', text: 'T', expect: 'E', verify: 'test' as const }];
    const base = { intake: {}, brief: { acceptanceCriteria: '- AC-1: When a, b.\n- When c, d.' } } as unknown as Pick<GoalPilot, 'plan' | 'criteria' | 'brief' | 'intake'>;
    expect(draftCriteriaFrom({ ...base, plan: { criteria: crit } as never, criteria: null })).toEqual([{ text: 'T', expect: 'E', verify: 'test' }]);
    expect(draftCriteriaFrom({ ...base, plan: null, criteria: crit })).toEqual([{ text: 'T', expect: 'E', verify: 'test' }]);
    expect(draftCriteriaFrom({ ...base, plan: null, criteria: null }, 'checklist')).toEqual([
      { text: 'When a, b.', expect: '', verify: 'checklist' }, { text: 'When c, d.', expect: '', verify: 'checklist' },
    ]);
  });

  it('criteria problems mirror the server: text always, an exact expectation for a test', () => {
    expect(criteriaProblems([])).toHaveLength(1);
    expect(criteriaProblems([{ text: 'x', expect: '', verify: 'test' }])[0]).toMatch(/AC-1 is checked by a test/);
    expect(criteriaProblems([{ text: 'x', expect: '', verify: 'checklist' }])).toEqual([]);
    expect(criteriaProblems([{ text: ' ', expect: 'e', verify: 'test' }])[0]).toMatch(/AC-1 has no text/);
  });

  it('every criterion outcome has a label and a tone', () => {
    for (const o of OUTCOMES) { expect(OUTCOME_LABEL[o], o).toBeTruthy(); expect(OUTCOME_TONE[o], o).toBeTruthy(); }
  });

  it('the contract says when it needs the person — and only then', () => {
    const c = (over: Partial<AcceptanceContract>) => ({ ...DEMO_CONTRACT, ...over });
    const none: PilotStage[] = [];
    expect(contractAction(null, none)).toBeNull();
    expect(contractAction(c({}), none)).toBeNull();
    expect(contractAction(c({ status: 'review' }), none)).toBe('review-tests');
    expect(contractAction(c({ status: 'review', approval: { requestedAt: '', confirmPassing: false, blocked: '' } }), none)).toBeNull();
    expect(contractAction(c({ status: 'review', approval: { requestedAt: '', confirmPassing: false, blocked: 'AC-1 passes' } }), none)).toBe('approval-blocked');
    expect(contractAction(c({ tamper: { stageId: 's', verificationId: 'v', files: [] } }), none)).toBe('tampered');
    expect(contractAction(c({ status: 'drafting', amending: { criterionIds: ['AC-1'], reason: 'r' }, request: { status: 'failed', error: 'x', agentId: '' } }), none)).toBe('ask-again');
    expect(contractAction(c({}), [{ kind: 'review', status: 'review' } as PilotStage])).toBe('confirm-checklist');
    expect(contractHeadline(c({}))).toBe('Locked v1 · 3 tests + 1 checklist item');
    expect(contractHeadline(c({ status: 'waived' }))).toMatch(/skipped/);
  });

  it('the pipeline summary says when a stage needs the person or is being checked', () => {
    const st = (over: Partial<PilotStage>) => ({ title: 'X', status: 'pending', attention: null, verifyState: '', kind: 'workflow', ...over } as PilotStage);
    expect(pipelineSummary([st({ kind: 'acceptance', status: 'review', title: 'Write the acceptance tests' })])).toBe('0 of 1 done · needs you: Write the acceptance tests');
    expect(pipelineSummary([st({ status: 'verifying', verifyState: 'pending' })])).toBe('0 of 1 done · checking: X');
    expect(pipelineSummary([st({ status: 'verifying', verifyState: 'tampered' })])).toBe('0 of 1 done · needs you: X');
  });
});
