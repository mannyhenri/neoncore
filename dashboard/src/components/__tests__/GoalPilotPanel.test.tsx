import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, within } from '@testing-library/react';
import type { AcceptanceContract, Goal, GoalPilot, GoalReport, PilotPhase } from '../../types';
import { DEMO_PILOT, DEMO_CONTRACT } from '../../lib/demoGoalPilot';

/**
 * The Goal Pilot panel, rendered for EVERY phase the server can report, and driven through the
 * one action each step exists for. The API is mocked; what is asserted is what the panel SENDS —
 * the payloads the server's rules are written against.
 */

const { calls, state, record } = vi.hoisted(() => {
  const calls: Record<string, unknown[][]> = {};
  const state: { current: GoalPilot[] } = { current: [] };
  const record = (name: string, result: unknown = {}) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return Promise.resolve(result);
  };
  return { calls, state, record };
});

vi.mock('../../lib/api', async () => {
  const demo = await import('../../lib/demoGoalPilot');
  return { api: {
    getGoalPilotMeta: () => Promise.resolve(demo.DEMO_PILOT_META),
    getGoalPilots: () => Promise.resolve(state.current),
    getFeatureFiles: () => Promise.resolve([]),
    getGoalPilotCandidates: () => Promise.resolve(demo.DEMO_CANDIDATES),
    getGoalPilotRequest: () => Promise.resolve({ prompt: 'the prompt' }),
    createGoalPilot: record('createGoalPilot', { goalId: 'demo-g1', pilot: null, queued: false, error: null }),
    answerGoalPilot: record('answerGoalPilot'),
    retryGoalPilot: record('retryGoalPilot'),
    acceptGoalPilotPlan: record('acceptGoalPilotPlan'),
    reviseGoalPilotPlan: record('reviseGoalPilotPlan'),
    startGoalPilot: record('startGoalPilot'),
    pauseGoalPilot: record('pauseGoalPilot'),
    resumeGoalPilot: record('resumeGoalPilot'),
    cancelGoalPilot: record('cancelGoalPilot'),
    retryGoalPilotStage: record('retryGoalPilotStage'),
    skipGoalPilotStage: record('skipGoalPilotStage'),
    updateGoal: record('updateGoal'),
    advanceWorkflowStep: record('advanceWorkflowStep'),
    buildGoalPilotReport: record('buildGoalPilotReport'),
    runAcceptanceTests: record('runAcceptanceTests'),
    approveAcceptanceTests: record('approveAcceptanceTests'),
    requestAcceptanceChanges: record('requestAcceptanceChanges'),
    askAgainForAcceptanceTests: record('askAgainForAcceptanceTests'),
    unlockAcceptanceCriterion: record('unlockAcceptanceCriterion'),
    restoreAcceptanceTests: record('restoreAcceptanceTests'),
    acceptAcceptanceTestChange: record('acceptAcceptanceTestChange'),
    confirmAcceptanceChecklist: record('confirmAcceptanceChecklist'),
    verifyGoalPilotStageAgain: record('verifyGoalPilotStageAgain'),
  } };
});
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => ({ connected: true }) }));
// The canvas is React Flow — heavy, and not what is under test. Its mount is.
vi.mock('../WorkflowCanvasEditor', () => ({ WorkflowCanvasEditor: ({ workflowId }: { workflowId: string }) => <div>canvas for {workflowId}</div> }));

import { GoalPilotPanel } from '../GoalPilotPanel';

const goal = {
  id: 'demo-g1', name: 'Ship metered billing by Q3', description: 'why', successMetric: 'first customer', status: 'active',
  noGos: '', invariants: '', targetDate: '', budgetUsd: null, autonomy: '', acceptanceCriteria: '', rabbitHoles: '', keyResults: [],
} as unknown as Goal;
const agents = [{ id: 'a1', agentType: 'claude', status: 'idle', repoName: 'ledger-svc', name: 'demo/ledger-svc', lastSeen: '' }] as never[];

const QUESTIONS = DEMO_PILOT.rounds[0].questions;
const PROPOSAL = {
  message: '2 workflows',
  stages: [
    { key: 's1', template: 'CE: Phase 2 — Plan', title: 'Plan it', why: 'plan first', focus: 'focus 1', optional: false },
    { key: 's2', template: 'Release Documentation', title: 'Document it', why: 'docs', focus: 'focus 2', optional: true },
  ],
  alternatives: [{ template: 'Code Review & Audit', why: 'not needed' }],
};

/** A pilot in `phase`, with whatever that phase needs to render. */
function pilotIn(phase: PilotPhase): GoalPilot {
  const base: GoalPilot = { ...DEMO_PILOT, phase, proposal: PROPOSAL, plan: { brief: DEMO_PILOT.brief!, stages: PROPOSAL.stages, criteria: DEMO_PILOT.criteria! } };
  switch (phase) {
    case 'scoping':
    case 'planning':
      return { ...base, stages: [], currentRequest: { id: 'r9', pilotId: base.id, kind: phase === 'scoping' ? 'scope' : 'pipeline', round: 2, status: 'pending', agentId: 'a1', notes: [], error: '', queued: true, createdAt: new Date().toISOString(), completedAt: null } };
    case 'clarifying':
      return { ...base, stages: [], rounds: [{ ...DEMO_PILOT.rounds[0], answers: {}, answeredAt: null }] };
    case 'proposed':
      return { ...base, stages: [], plan: null };
    case 'staffing':
      return { ...base, stages: [] };
    case 'completed':
      return { ...base, stages: base.stages.map((s) => ({ ...s, status: 'completed' as const, attention: null })), report: REPORT };
    case 'cancelled':
      return { ...base, stages: [] };
    default:
      return base;
  }
}

const REPORT: GoalReport = {
  version: 1, generatedAt: '2027-01-01T00:00:00Z', goal: { id: 'demo-g1', name: 'Ship metered billing by Q3', successMetric: 'x' },
  pilotId: 'demo-pilot-1', status: 'PARTIAL', involvement: 'balanced', startedAt: null, finishedAt: null, minutes: 42, costUsd: 3.5,
  outcome: { stagesCompleted: 3, stagesTotal: 4, stagesSkipped: 1, stepsCompleted: 20, stepsTotal: 24, testsPassed: 11, testsTotal: 12, issues: 2 },
  summary: { text: 'Metered billing shipped behind a flag; the ledger view was skipped.', highlights: ['Usage invoices'], followUps: [], source: 'planner' },
  acceptance: {
    version: 1, lockedAt: null, contractStatus: 'locked', total: 4, passing: 3, checks: 4, testsUnchanged: true, tamperEvents: [], amendments: [], reviewIndependent: true, note: '',
    criteria: [],
  },
  brief: null, decisions: [], stages: [], learnings: [],
  openItems: ['Confirm the rounding rule'], files: { html: '/data/reports/goals/g/p/goal-report.html', markdown: '', json: '' },
};

const ALL_PHASES: PilotPhase[] = ['scoping', 'clarifying', 'planning', 'proposed', 'staffing', 'running', 'paused', 'completed', 'cancelled'];
/** What each phase must show — the thing the person needs to act on or know. */
const SHOWS: Record<PilotPhase, RegExp> = {
  scoping: /reading your answers to round 1/,
  clarifying: /Which currency do invoices use\?/,
  planning: /choosing the workflows/,
  proposed: /Accept plan · 2 workflows/,
  staffing: /Which repos build this feature\?/,
  running: /needs you · decision/,
  paused: /Resume/,
  completed: /Mark feature done/,
  cancelled: /cancelled before anything ran/,
};

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  state.current = [];
});

async function mount(p: GoalPilot | null) {
  state.current = p ? [p] : [];
  const view = render(<GoalPilotPanel goal={goal} agents={agents} onGoalChanged={() => {}} />);
  await view.findByText(/Feature pipeline/);
  return view;
}

describe('GoalPilotPanel', () => {
  it('covers every phase the server reports', () => {
    expect(Object.keys(SHOWS).sort()).toEqual([...ALL_PHASES].sort());
  });

  for (const phase of ALL_PHASES) {
    it(`renders the ${phase} phase with what the person needs`, async () => {
      const view = await mount(pilotIn(phase));
      await view.findByText(SHOWS[phase]);
    });
  }

  it('with no pilot it offers one; the intake pre-fills from the feature, work type included', async () => {
    const view = await mount(null);
    fireEvent.click(await view.findByText('✦ Start this feature'));
    const start = await view.findByText('Start scoping');
    // A feature on a project's list starts typed as a feature (lib/goalPilot intakeFromGoal), so
    // nothing required is missing and scoping can start at once.
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    expect(view.getByText('New feature')).toBeTruthy();
    fireEvent.click(start);
    await waitFor(() => expect(calls.createGoalPilot).toHaveLength(1));
    const sent = calls.createGoalPilot[0][0] as { intake: Record<string, string>; goalId: string; plannerAgentId: string };
    expect(sent.goalId).toBe('demo-g1');
    expect(sent.plannerAgentId).toBe('a1');
    expect(sent.intake).toMatchObject({ goal: goal.name, context: 'why', done: 'first customer', workType: 'feature', involvement: 'balanced' });
  });

  it('clarifying: answers are required until given or delegated; "accept all suggestions" fills them', async () => {
    const view = await mount(pilotIn('clarifying'));
    const send = await view.findByText('Send answers');
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByText('Accept all suggestions'));
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    // Delegate one explicitly.
    const card = view.getByText('Who can see and change invoices?').closest('div.rounded-lg') as HTMLElement;
    fireEvent.click(within(card).getByLabelText(/Let the agents decide/));
    fireEvent.click(send);
    await waitFor(() => expect(calls.answerGoalPilot).toHaveLength(1));
    const answers = calls.answerGoalPilot[0][1] as Record<string, { value: unknown; delegated?: boolean }>;
    expect(Object.keys(answers).sort()).toEqual(QUESTIONS.map((q) => q.id).sort());
    expect(answers.currency).toEqual({ value: 'One currency for the whole account' });
    expect(answers.access.delegated).toBe(true);
  });

  it('proposed: the brief is editable, an unticked workflow is not accepted, order is kept', async () => {
    const view = await mount(pilotIn('proposed'));
    await view.findByText(/Accept plan · 2 workflows/);
    const summary = view.getByDisplayValue(DEMO_PILOT.brief!.summary);
    fireEvent.change(summary, { target: { value: 'Edited summary' } });
    const second = view.getByDisplayValue('Document it').closest('div.rounded-lg') as HTMLElement;
    fireEvent.click(within(second).getByRole('checkbox'));
    fireEvent.click(await view.findByText(/Accept plan · 1 workflow$/));
    await waitFor(() => expect(calls.acceptGoalPilotPlan).toHaveLength(1));
    const body = calls.acceptGoalPilotPlan[0][1] as { brief: { summary: string }; stages: { template: string }[]; criteria: { text: string }[] };
    expect(body.brief.summary).toBe('Edited summary');
    expect(body.stages.map((s) => s.template)).toEqual(['CE: Phase 2 — Plan']);
    expect(body.criteria.map((c) => c.text)).toEqual(DEMO_PILOT.criteria!.map((c) => c.text));
  });

  it('proposed: criteria are numbered rows; a test without an exact expectation blocks accept until fixed', async () => {
    const view = await mount(pilotIn('proposed'));
    await view.findByText(/Acceptance criteria — the contract/);
    expect(view.getAllByTestId('criterion-row')).toHaveLength(4);
    fireEvent.click(view.getByText('+ Add a criterion'));
    fireEvent.change(view.getByLabelText('AC-5 criterion'), { target: { value: 'When an invoice is issued, the system shall email it.' } });
    const accept = view.getByText(/Accept plan · 2 workflows/) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(view.getByText(/AC-5 is checked by a test but does not say exactly what it expects/)).toBeTruthy();
    fireEvent.change(view.getByLabelText('AC-5 expected'), { target: { value: 'issuing inv_1 → one email to the billing contact' } });
    await waitFor(() => expect(accept.disabled).toBe(false));
    // Remove AC-2 — the rest renumber.
    fireEvent.click(within(view.getAllByTestId('criterion-row')[1]).getByTitle('Remove'));
    fireEvent.click(accept);
    await waitFor(() => expect(calls.acceptGoalPilotPlan).toHaveLength(1));
    const body = calls.acceptGoalPilotPlan[0][1] as { criteria: { text: string; expect: string; verify: string }[] };
    expect(body.criteria).toHaveLength(4);
    expect(body.criteria[3]).toEqual({ text: 'When an invoice is issued, the system shall email it.', expect: 'issuing inv_1 → one email to the billing contact', verify: 'test' });
  });

  it('staffing: the goal\'s own repo is preselected with a live engine, and start sends it', async () => {
    const view = await mount(pilotIn('staffing'));
    fireEvent.click(await view.findByText(/Start the pipeline · 2 workflows/));
    await waitFor(() => expect(calls.startGoalPilot).toHaveLength(1));
    const body = calls.startGoalPilot[0][1] as { repos: unknown[]; assignments: Record<string, string> };
    expect(body.repos).toEqual([{ repoPath: '/demo/ledger-svc', agentType: 'claude' }]);
    // The contract's own stages are placed too: the tests live in one repo, the review looks at it.
    expect(body.assignments).toEqual({ acceptance: '/demo/ledger-svc', s1: '/demo/ledger-svc', s2: '/demo/ledger-svc', review: '/demo/ledger-svc' });
    expect(view.getByText(/an agent writes 3 failing tests \(AC-1, AC-2, AC-3\)/)).toBeTruthy();
  });

  it('running: a stage that needs the person opens its run in place', async () => {
    const view = await mount(pilotIn('running'));
    await view.findByText(/2 of 6 done · needs you: Build metered-billing/);
    const buttons = view.getAllByText('Open run');
    fireEvent.click(buttons[1]);
    await view.findByText('canvas for demo-w1');
  });

  it('running: a stage held for a person is advanced from the pipeline, without opening the run', async () => {
    const p = pilotIn('running');
    p.stages[2] = { ...p.stages[2], attention: { reason: 'manual-advance', stepId: 'step-learn', stepName: 'Learn & Final Review', detail: '"Learn & Final Review" finished and is held for you.' } };
    const view = await mount(p);
    fireEvent.click(await view.findByText('Advance'));
    await waitFor(() => expect(calls.advanceWorkflowStep).toEqual([['demo-w1', 'step-learn']]));
  });

  it('completed: the goal report is on the page — summary, numbers, what is still open, and the document', async () => {
    const view = await mount(pilotIn('completed'));
    await view.findByText('Metered billing shipped behind a flag; the ledger view was skipped.');
    expect(view.getByText('PARTIAL')).toBeTruthy();
    expect(view.getByText('11/12 tests passing')).toBeTruthy();
    expect(view.getByText('3/4 criteria pass')).toBeTruthy();
    expect(view.getByText('☐ Confirm the rounding rule')).toBeTruthy();
    expect(view.getByText('Open report').getAttribute('href')).toBe('/api/goal-pilots/demo-pilot-1/report/html');
    expect(view.getByText('Download .md').getAttribute('href')).toBe('/api/goal-pilots/demo-pilot-1/report/markdown');
    expect(view.getByText(/Summary written by the planner/)).toBeTruthy();
  });

  it('completed: while the planner writes the summary, the panel says so', async () => {
    const p = pilotIn('completed');
    p.report = { ...REPORT, summary: { ...REPORT.summary, source: 'compiled' } };
    p.currentRequest = { id: 'r1', pilotId: p.id, kind: 'report', round: 0, status: 'pending', agentId: 'a1', notes: [], error: '', queued: false, createdAt: '', completedAt: null };
    const view = await mount(p);
    await view.findByText(/is writing the summary/);
  });

  it('cancelled part-way: a report of what ran can still be built', async () => {
    const p = { ...pilotIn('running'), phase: 'cancelled' as const };
    const view = await mount(p);
    fireEvent.click(await view.findByText('Build report'));
    await waitFor(() => expect(calls.buildGoalPilotReport).toEqual([['demo-pilot-1']]));
  });

  it('completed: the feature can be marked done', async () => {
    const view = await mount(pilotIn('completed'));
    fireEvent.click(await view.findByText('Mark feature done'));
    await waitFor(() => expect(calls.updateGoal).toEqual([['demo-g1', { status: 'achieved' }]]));
  });
});

// ── the acceptance contract ─────────────────────────────────────────────────────

/** The running demo pilot with its contract replaced by `c`. */
function withContract(c: Partial<AcceptanceContract>, stages?: GoalPilot['stages']): GoalPilot {
  const p = pilotIn('running');
  return { ...p, acceptance: { ...DEMO_CONTRACT, ...c }, stages: stages ?? p.stages };
}

describe('GoalPilotPanel — the acceptance contract', () => {
  it('locked: every criterion shows its evidence — failing tests with their command, the checklist item unchecked', async () => {
    const view = await mount(withContract({}));
    const card = await view.findByTestId('acceptance-contract');
    expect(within(card).getByText(/Locked v1 · 3 tests \+ 1 checklist item/)).toBeTruthy();
    expect(within(card).getByText('0/4 passing')).toBeTruthy();
    expect(within(view.getByTestId('criterion-AC-1')).getByText('failing')).toBeTruthy();
    expect(within(view.getByTestId('criterion-AC-4')).getByText('not checked yet')).toBeTruthy();
    expect(within(view.getByTestId('criterion-AC-1')).getByText('npx vitest run tests/acceptance/ac-1.test.ts')).toBeTruthy();
  });

  it('review: the person sees criterion ↔ test ↔ file contents, runs them, asks for changes, approves', async () => {
    const review = withContract({ status: 'review', draftTests: DEMO_CONTRACT.tests, version: 0, tests: [] });
    const view = await mount(review);
    await view.findByText(/3 tests \+ 1 checklist item written — waiting for your approval/);
    expect(within(view.getByTestId('acceptance-contract')).getByText('needs you')).toBeTruthy();
    expect(view.getAllByText('tests/acceptance/ac-2.test.ts', { exact: false }).length).toBeGreaterThan(0);
    expect(view.getByText(/each test drives the public billing API/i)).toBeTruthy();
    fireEvent.click(view.getByText('Run them now'));
    await waitFor(() => expect(calls.runAcceptanceTests).toEqual([['demo-pilot-1']]));
    fireEvent.click(view.getByText('Ask for changes'));
    const box = view.getByLabelText('What should change');
    const send = view.getByText('Send to the test writer') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'AC-2 must also check a third duplicate' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.requestAcceptanceChanges).toEqual([['demo-pilot-1', 'AC-2 must also check a third duplicate']]));
    fireEvent.click(await view.findByText('Approve & lock'));
    await waitFor(() => expect(calls.approveAcceptanceTests).toEqual([['demo-pilot-1']]));
  });

  it('review: a test that already passes blocks the lock; "approve anyway" is an explicit choice', async () => {
    const green = { ...DEMO_CONTRACT.baseline!.results[0], passed: true, exitCode: 0 };
    const view = await mount(withContract({
      status: 'review', draftTests: DEMO_CONTRACT.tests, tests: [], version: 0, baselineFresh: true,
      baseline: { ...DEMO_CONTRACT.baseline!, results: [green, ...DEMO_CONTRACT.baseline!.results.slice(1)] },
      approval: { requestedAt: '', confirmPassing: false, blocked: 'AC-1 already passes before any work — a test that passes now proves nothing about this work.' },
    }));
    await view.findByText(/AC-1 already passes before any work/);
    expect(view.getByText(/already passes before any work$/)).toBeTruthy();
    fireEvent.click(view.getByText(/Approve anyway — AC-1/));
    await waitFor(() => expect(calls.approveAcceptanceTests).toEqual([['demo-pilot-1', true]]));
  });

  it('tampered: the changed files are named; restore is one click, accepting needs a reason', async () => {
    const stages = pilotIn('running').stages.map((s) => (s.id === 'demo-ps2' ? { ...s, status: 'verifying' as const, verifyState: 'tampered' as const } : s));
    const view = await mount(withContract({
      tamper: { stageId: 'demo-ps2', verificationId: 'v9', files: [{ path: 'tests/acceptance/ac-2.test.ts', criterionId: 'AC-2', expected: 'aaaaaaaaaaaa', actual: 'bbbbbbbbbbbb' }] },
    }, stages));
    const alert = await view.findByRole('alert');
    expect(within(alert).getByText(/during stage 3 \(Build metered-billing\)/)).toBeTruthy();
    expect(within(alert).getByText(/tests\/acceptance\/ac-2\.test\.ts \(AC-2\)/)).toBeTruthy();
    expect(view.getByText(/Its run changed locked acceptance tests/)).toBeTruthy();
    fireEvent.click(within(alert).getByText('Accept the change…'));
    const accept = within(alert).getByText('Accept the change as v2') as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.change(within(alert).getByLabelText('Why accept the change'), { target: { value: 'The extra assertion is right.' } });
    fireEvent.click(accept);
    await waitFor(() => expect(calls.acceptAcceptanceTestChange).toEqual([['demo-pilot-1', 'The extra assertion is right.']]));
  });

  it('tampered: restore the approved version', async () => {
    const view = await mount(withContract({ tamper: { stageId: 'demo-ps2', verificationId: 'v9', files: [{ path: 'x.test.ts', criterionId: 'AC-1', expected: 'a', actual: null }] } }));
    const alert = await view.findByRole('alert');
    expect((within(alert).getByText('Accept the change…') as HTMLButtonElement).disabled).toBe(true);   // a deleted test cannot be accepted
    fireEvent.click(within(alert).getByText('Restore the approved version'));
    await waitFor(() => expect(calls.restoreAcceptanceTests).toEqual([['demo-pilot-1']]));
  });

  it('locked: only the person unlocks a criterion — with a reason, optionally new wording', async () => {
    const view = await mount(withContract({}));
    const row = await view.findByTestId('criterion-AC-2');
    fireEvent.click(within(row).getByText('Unlock…'));
    const go = within(row).getByText('Unlock AC-2') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(row).getByLabelText('Why unlock AC-2'), { target: { value: 'Refunds must be excluded too' } });
    fireEvent.change(within(row).getByLabelText('AC-2 new expected'), { target: { value: 'evt_42 twice and a refund → quantity 1, total 0' } });
    fireEvent.click(go);
    await waitFor(() => expect(calls.unlockAcceptanceCriterion).toHaveLength(1));
    expect(calls.unlockAcceptanceCriterion[0]).toEqual(['demo-pilot-1', 'AC-2', { reason: 'Refunds must be excluded too', text: DEMO_CONTRACT.criteria[1].text, expect: 'evt_42 twice and a refund → quantity 1, total 0' }]);
    // A checklist item has no test to unlock.
    expect(within(view.getByTestId('criterion-AC-4')).queryByText('Unlock…')).toBeNull();
  });

  it('checklist: the reviewer\'s verdicts are confirmed by the person; overruling needs a note', async () => {
    const stages = pilotIn('running').stages.map((s) => (s.kind === 'review' ? { ...s, status: 'review' as const } : { ...s, status: 'completed' as const, attention: null }));
    const view = await mount(withContract({
      checklist: {
        requestId: 'rq', reviewerAgentId: 'a2', reviewerName: 'Codex · ledger-svc', at: '', independent: true, confirmations: {}, confirmedAt: null,
        verdicts: [{ criterionId: 'AC-4', verdict: 'not-met', evidence: 'The "qty" column is unlabelled.' }],
      },
    }, stages));
    await view.findByText('Checklist verdicts to confirm');
    expect(view.getByText(/Codex · ledger-svc, which did not do the work/)).toBeTruthy();
    fireEvent.click(view.getByText('Met'));
    const confirmBtn = view.getByText('Confirm verdicts') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.change(view.getByLabelText('AC-4 note'), { target: { value: 'Labelled in the latest build' } });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(calls.confirmAcceptanceChecklist).toEqual([['demo-pilot-1', { 'AC-4': { accepted: true, note: 'Labelled in the latest build' } }]]));
  });

  it('a stage whose check could not run offers "Check again"', async () => {
    const stages = pilotIn('running').stages.map((s) => (s.id === 'demo-ps2' ? { ...s, status: 'verifying' as const, verifyState: 'error' as const, waitReason: 'the runner did not answer' } : s));
    const view = await mount({ ...withContract({}, stages), phase: 'paused' });
    await view.findByText(/could not be checked: the runner did not answer/);
    fireEvent.click(view.getByText('Check again'));
    await waitFor(() => expect(calls.verifyGoalPilotStageAgain).toEqual([['demo-pilot-1', 'demo-ps2']]));
  });
});
