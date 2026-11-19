/**
 * Demo-mode Goal Pilot — one pilot, mid-pipeline, on "Ship metered billing by Q3" (demo-g1).
 *
 * Shaped exactly like GET /api/goal-pilots/:id so GoalPilotPanel renders the real thing: a
 * finished scoping conversation (one delegated answer), an accepted brief, four stages with the
 * second one running and waiting on a person. Every other goal has no pilot, so the demo also
 * shows the "Pilot this goal" offer — whose intake form needs `DEMO_PILOT_META`.
 */
import type { AcceptanceContract, ContractTest, GoalPilot, GoalPilotMeta, PilotCandidateRepo, PilotCriterion } from '../types';

const t0 = Date.now();
const ago = (mins: number) => new Date(t0 - mins * 60_000).toISOString();

export const DEMO_PILOT_META: GoalPilotMeta = {
  intakeQuestions: [
    { key: 'goal', label: 'What do you want to achieve?', help: 'One sentence. It becomes the goal\'s name.', kind: 'text', required: true, placeholder: 'Add an expenses tracking section to the app' },
    { key: 'context', label: 'What exists today, and what should change?', help: 'A few sentences of background.', kind: 'textarea', required: true },
    {
      key: 'workType', label: 'What kind of work is it?', help: 'Decides which questions get asked and which workflows fit.', kind: 'choice', required: true,
      options: [
        { value: 'feature', label: 'New feature', hint: 'Something users can do that they cannot today' },
        { value: 'bug', label: 'Bug fix', hint: 'Something behaves wrongly and should not' },
        { value: 'improvement', label: 'Improvement / refactor', hint: 'Better code, same behaviour' },
        { value: 'performance', label: 'Performance', hint: 'Faster or cheaper, against a number' },
        { value: 'research', label: 'Research / strategy', hint: 'Answer a question or decide a direction' },
        { value: 'quality', label: 'QA / testing', hint: 'Find out what is broken' },
        { value: 'docs', label: 'Docs / release', hint: 'Documents you ship or keep' },
      ],
    },
    { key: 'audience', label: 'Who is it for?', help: 'The people who will use or notice the result.', kind: 'text', required: false },
    { key: 'done', label: 'How will you know it is done?', help: 'What you would check before calling it finished.', kind: 'textarea', required: true },
    { key: 'constraints', label: 'What must not change, or is off-limits?', help: 'Behaviour that must keep working.', kind: 'textarea', required: false },
    { key: 'deadline', label: 'Target date', help: 'Optional.', kind: 'date', required: false },
    { key: 'budgetUsd', label: 'Budget (USD)', help: 'Optional spend ceiling.', kind: 'number', required: false },
    {
      key: 'involvement', label: 'How involved do you want to be while it runs?', help: 'You can change a single run later.', kind: 'choice', required: true,
      options: [
        { value: 'hands-on', label: 'Hands-on', hint: 'Every gate, decision and held step waits for you.' },
        { value: 'balanced', label: 'Balanced', hint: 'Held steps advance on their own; decisions wait for you.' },
        { value: 'hands-off', label: 'Hands-off', hint: 'Decisions are settled for you too. Only breakage stops it.' },
      ],
    },
  ],
  involvementLevels: [
    { value: 'hands-on', label: 'Hands-on', hint: '' }, { value: 'balanced', label: 'Balanced', hint: '' }, { value: 'hands-off', label: 'Hands-off', hint: '' },
  ],
  workTypes: [],
  briefFields: [
    { key: 'summary', label: 'Summary', guidance: '', onGoal: true },
    { key: 'successMetric', label: 'Done when', guidance: '', onGoal: true },
    { key: 'inScope', label: 'In scope', guidance: '', onGoal: false },
    { key: 'acceptanceCriteria', label: 'Acceptance criteria', guidance: '', onGoal: true },
    { key: 'invariants', label: 'Invariants', guidance: '', onGoal: true },
    { key: 'outOfScope', label: 'Out of scope (no-gos)', guidance: '', onGoal: true },
    { key: 'rabbitHoles', label: 'Rabbit holes', guidance: '', onGoal: true },
    { key: 'assumptions', label: 'Assumptions', guidance: '', onGoal: false },
  ],
  engines: ['claude', 'codex'],
  limits: { maxScopeRounds: 4, maxQuestionsPerRound: 10, maxStages: 8, maxCriteria: 12 },
  verifyMethods: [
    { value: 'test', label: 'Automated test', hint: 'A test written before the work, locked once you approve it, run by NeonCore after every stage.' },
    { value: 'checklist', label: 'Checklist', hint: 'Judged at the end by an independent cartridge; you confirm each verdict.' },
  ],
  defaultVerify: { feature: 'test', bug: 'test', improvement: 'test', performance: 'test', research: 'checklist', quality: 'checklist', docs: 'checklist' },
  contractStageKeys: { acceptance: 'acceptance', review: 'review' },
  templates: [
    { name: 'CE: Phase 2 — Plan', description: '' }, { name: 'CE: Phase 3 — Implement', description: '' },
    { name: 'Super QA', description: '' }, { name: 'Feature Validation', description: '' },
    { name: 'Release Documentation', description: '' },
  ],
};

const brief = {
  slug: 'metered-billing',
  summary: 'Bill customers on recorded usage instead of a flat fee, so heavy accounts stop being subsidised by light ones.',
  successMetric: 'First paying customer on a metered plan',
  inScope: 'Each invoice line records: event type, quantity, unit price\nReports: usage per billing period\nAccess: billing admins edit, everyone else reads',
  acceptanceCriteria: 'When a billing period closes, the system shall invoice on recorded usage within 1%.\nWhen usage is disputed, the system shall show the per-event ledger behind the total.',
  invariants: 'No customer is billed twice for one event.\nHistorical invoices never change after issue.',
  outOfScope: 'Pricing-page changes\nMigrating existing flat-fee contracts',
  rabbitHoles: 'Floating-point money — store amounts as integer minor units.',
  assumptions: 'Who can see and change invoices — left to the agents; using: Billing admins edit, everyone else reads',
};

const stage = (i: number, template: string, title: string, status: GoalPilot['stages'][number]['status'], extra: Partial<GoalPilot['stages'][number]> = {}): GoalPilot['stages'][number] => ({
  id: `demo-ps${i}`, position: i, kind: 'workflow', key: `s${i}`, templateId: '', template, title, why: '', focus: '',
  repoPath: '/demo/ledger-svc', agentType: 'claude', projectId: 'demo-p2', runId: '', agentId: '', status,
  waitReason: '', resultSummary: '', attempts: status === 'pending' ? 0 : 1, verifyState: '', requestId: '', startedAt: null, completedAt: null,
  runStatus: '', progress: null, attention: null, agentName: 'Claude Code · ledger-svc', ...extra,
});

// ── the acceptance contract: three tests locked before any work, one checklist item ──

const criteria: PilotCriterion[] = [
  { id: 'AC-1', text: 'When a billing period closes, the system shall invoice on recorded usage.', expect: '1,200 API calls at $0.002 in March → the March invoice line reads 1,200 × $0.002 = $2.40', verify: 'test' },
  { id: 'AC-2', text: 'When the same usage event is recorded twice, the system shall bill it once.', expect: 'event evt_42 recorded twice → one invoice line, quantity 1', verify: 'test' },
  { id: 'AC-3', text: 'When usage is disputed, the system shall show the per-event ledger behind the total.', expect: 'opening the $2.40 line → 1,200 events listed, summing to $2.40', verify: 'test' },
  { id: 'AC-4', text: 'When a billing admin reads the new invoice screen, it shall be clear without training.', expect: 'A billing admin explains each column of the March invoice unaided', verify: 'checklist' },
];

const testFile = (id: string, body: string): ContractTest => ({
  criterionId: id,
  command: `npx vitest run tests/acceptance/${id.toLowerCase()}.test.ts`,
  files: [{ path: `tests/acceptance/${id.toLowerCase()}.test.ts`, sha256: `${id.charCodeAt(3)}f3a9c0d2e1b4`.padEnd(64, '0'), bytes: body.length, content: body }],
});
const tests = [
  testFile('AC-1', "import { closePeriod } from '../../src/billing';\n\ntest('AC-1: invoices recorded usage', async () => {\n  await recordUsage('acct_1', 'api_call', 1200, '2024-03');\n  const inv = await closePeriod('acct_1', '2024-03');\n  expect(inv.lines[0]).toEqual({ quantity: 1200, unitPrice: 0.002, total: 2.40 });\n});\n"),
  testFile('AC-2', "test('AC-2: a duplicate event is billed once', async () => {\n  await recordUsage('acct_1', 'api_call', 1, '2024-03', 'evt_42');\n  await recordUsage('acct_1', 'api_call', 1, '2024-03', 'evt_42');\n  const inv = await closePeriod('acct_1', '2024-03');\n  expect(inv.lines).toHaveLength(1);\n  expect(inv.lines[0].quantity).toBe(1);\n});\n"),
  testFile('AC-3', "test('AC-3: the ledger behind a total', async () => {\n  const ledger = await ledgerFor('inv_march', 0);\n  expect(ledger.events).toHaveLength(1200);\n  expect(sum(ledger.events)).toBe(2.40);\n});\n"),
];
const red = (id: string, at: string) => ({ criterionId: id, command: tests.find((t) => t.criterionId === id)!.command, exitCode: 1, passed: false, timedOut: false, output: `FAIL tests/acceptance/${id.toLowerCase()}.test.ts\n  ✕ ${id}: expected the behaviour, got undefined`, durationMs: 1800, at });

export const DEMO_CONTRACT: AcceptanceContract = {
  id: 'demo-contract', pilotId: 'demo-pilot-1', goalId: 'demo-g1', repoPath: '/demo/ledger-svc', agentType: 'claude',
  status: 'locked', version: 1, criteria, criteriaHash: 'demo', draftTests: [], tests,
  testNotes: 'Each test drives the public billing API; none touches the database directly.', feedback: '', amending: null, approval: null,
  baseline: { testsHash: 'demo', at: ago(350), results: ['AC-1', 'AC-2', 'AC-3'].map((id) => red(id, ago(350))), error: '' },
  verifications: [{
    id: 'demo-v1', stageId: 'demo-ps1', stagePosition: 2, stageTitle: 'Plan metered-billing', at: ago(300), version: 1, status: 'failed',
    passing: 0, total: 3, filesChecked: 3, results: ['AC-1', 'AC-2', 'AC-3'].map((id) => red(id, ago(300))), tampered: [], error: '',
  }],
  checklist: null, amendments: [], tamper: null, requestId: '', waitReason: '', lockedAt: ago(348), createdAt: ago(360), updatedAt: ago(300),
  states: criteria.map((c) => {
    const test = tests.find((t) => t.criterionId === c.id);
    const last = test ? red(c.id, ago(300)) : null;
    return {
      ...c, outcome: test ? 'fail' as const : 'not-checked' as const,
      test: test ? { command: test.command, files: test.files.map((f) => f.path) } : null,
      last, lastStage: last ? 'stage 2 (Plan metered-billing)' : '', baseline: test ? red(c.id, ago(350)) : null,
      verdict: null, confirmation: null, reviewer: '',
    };
  }),
  passing: 0, total: 4, activity: null, baselineFresh: false, request: null,
};

export const DEMO_PILOT: GoalPilot = {
  id: 'demo-pilot-1', goalId: 'demo-g1', goalName: 'Ship metered billing by Q3', phase: 'running',
  plannerAgentId: '', plannerName: 'Claude Code · ledger-svc',
  intake: { goal: 'Ship metered billing by Q3', workType: 'feature', involvement: 'balanced' },
  rounds: [{
    round: 1, requestId: 'demo-r1', message: '4 questions so nobody has to guess once work starts.', askedAt: ago(400), answeredAt: ago(380),
    questions: [
      { id: 'currency', text: 'Which currency do invoices use?', why: 'Decides the data model.', kind: 'choice', options: ['One currency for the whole account', 'Per invoice, converted for totals'], suggested: 'One currency for the whole account', required: true },
      { id: 'period', text: 'How long is a billing period?', why: 'Decides when invoices close.', kind: 'choice', options: ['Calendar month', '30 days from signup'], suggested: 'Calendar month', required: true },
      { id: 'access', text: 'Who can see and change invoices?', why: 'Permissions decide queries and tests.', kind: 'choice', options: ['Billing admins edit, everyone else reads', 'Only billing admins'], suggested: 'Billing admins edit, everyone else reads', required: true },
      { id: 'disputes', text: 'Must a customer be able to see the events behind a total?', why: 'Adds a ledger view.', kind: 'boolean', options: ['Yes', 'No'], suggested: 'Yes', required: true },
    ],
    answers: {
      currency: { value: 'One currency for the whole account' }, period: { value: 'Calendar month' },
      access: { value: 'Billing admins edit, everyone else reads', delegated: true }, disputes: { value: 'Yes' },
    },
  }],
  brief,
  proposal: null,
  criteria,
  plan: { brief, stages: [], criteria },
  staffing: { repos: [{ repoPath: '/demo/ledger-svc', agentType: 'claude' }] },
  involvement: 'balanced', currentRequestId: '', currentRequest: null, requests: [], attention: '',
  stages: [
    stage(0, '', 'Write the acceptance tests', 'completed', {
      kind: 'acceptance', key: 'acceptance', startedAt: ago(358), completedAt: ago(348),
      resultSummary: '3 acceptance tests approved and locked (v1). Before any work: 3/3 failing, as they should.',
    }),
    stage(1, 'CE: Phase 2 — Plan', 'Plan metered-billing', 'completed', {
      runId: 'demo-w2', startedAt: ago(345), completedAt: ago(300), runStatus: 'completed', progress: { completed: 7, total: 7 }, verifyState: 'done',
      resultSummary: 'Wrote docs/metered-billing/plan.md — 6 steps, each acceptance criterion mapped to its locked test.\n\nAcceptance check (NeonCore ran the locked tests): 0/3 criteria passing — not yet: AC-1, AC-2, AC-3. Locked test files unchanged.',
    }),
    stage(2, 'CE: Phase 3 — Implement', 'Build metered-billing', 'running', {
      runId: 'demo-w1', startedAt: ago(40), runStatus: 'running', progress: { completed: 4, total: 7 },
      attention: { reason: 'decision', stepId: '', stepName: 'Pick Approach', detail: 'Choose between per-event rows and hourly rollups before the build continues.' },
    }),
    stage(3, 'Super QA', 'Review the change', 'pending'),
    stage(4, 'Feature Validation', 'Validate against the acceptance criteria', 'pending'),
    stage(5, '', 'Independent review of the checklist', 'pending', { kind: 'review', key: 'review', agentName: '' }),
  ],
  acceptance: DEMO_CONTRACT,
  createdAt: ago(420), updatedAt: ago(5), planAcceptedAt: ago(330), startedAt: ago(360), completedAt: null,
  report: null, reportAt: null,
};

export function demoPilotsFor(goalId: string | null): GoalPilot[] {
  if (!goalId) return [DEMO_PILOT];
  return goalId === DEMO_PILOT.goalId ? [DEMO_PILOT] : [];
}

export const DEMO_CANDIDATES: PilotCandidateRepo[] = [
  { repoPath: '/demo/ledger-svc', repoName: 'ledger-svc', machine: 'demo', owned: true, engines: [{ agentType: 'claude', agentId: 'demo-a1', status: 'idle', name: 'demo/ledger-svc' }] },
  { repoPath: '/demo/atlas-api', repoName: 'atlas-api', machine: 'demo', owned: false, engines: [{ agentType: 'codex', agentId: 'demo-a2', status: 'working', name: 'demo/atlas-api' }] },
];
