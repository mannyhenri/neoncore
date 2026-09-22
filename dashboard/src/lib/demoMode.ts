import { DEMO_TEMPLATES } from './demoTemplates';
/**
 * DEMO MODE — fake data in the app, nothing at all behind it.
 *
 * "It loads fake data and not the live information (everything would still run in the back as
 * if nothing happened) so I can demo the app and interact with it."
 *
 * The second half is what makes this dangerous to build naively. Reading fake data is easy;
 * INTERACTING is where a demo mode goes wrong — pressing Run Workflow in front of an audience
 * must not launch a real run on a real cartridge, and pressing Delete must not delete anything.
 *
 * ── DENY BY DEFAULT ───────────────────────────────────────────────────────────────────
 * This is built as a replacement `fetchImpl` for the API client, NOT as a set of faked
 * endpoints. The real `fetch` is never called, so a route nobody remembered to fake cannot
 * leak: it is absorbed and answered locally. An allowlist would pass every obvious test and
 * still be one forgotten route away from deleting production data mid-demo.
 *
 * ── PURELY CLIENT-SIDE ────────────────────────────────────────────────────────────────
 * The server is not involved and does not know. That is what satisfies "everything would still
 * run in the back as if nothing happened" — cartridges keep working, workflows keep advancing,
 * heartbeats keep firing. The demo is a lie told to one browser tab.
 *
 * ── FAILS CLOSED ──────────────────────────────────────────────────────────────────────
 * If storage throws (private window, blocked site data) the answer is OFF. A demo flag that
 * cannot be read is far better treated as absent than as on, because showing someone fake data
 * they believe is live is the worst outcome this file can produce.
 */

const STORAGE_KEY = 'neoncore.demoMode';

export function isDemoEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false; // fail closed — see the header
  }
}

export function setDemoEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing to do. isDemoEnabled will keep reporting false, which is the safe answer. */
  }
}

// ── The dataset ────────────────────────────────────────────────────────────────────────

const now = Date.now();
const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();

/**
 * Deliberately NOT plausible as production. Repo paths are under /demo, names are invented
 * products, and nothing here matches a real cartridge — so a screenshot taken during a demo
 * cannot later be mistaken for live state.
 */
function seed() {
  return {
    agents: [
      { id: 'demo-a1', name: 'atlas-api', repoName: 'atlas-api', repoPath: '/demo/atlas-api', machine: 'demo-host', agentType: 'claude', status: 'working', lastSeen: ago(1), sessionId: 'demo-s1', branch: 'main', dismissedAt: '', pendingQuestion: '', agentMode: 'manual' },
      { id: 'demo-a2', name: 'atlas-web', repoName: 'atlas-web', repoPath: '/demo/atlas-web', machine: 'demo-host', agentType: 'claude', status: 'idle', lastSeen: ago(4), sessionId: 'demo-s2', branch: 'main', dismissedAt: '', pendingQuestion: '', agentMode: 'trust' },
      { id: 'demo-a3', name: 'ledger-svc', repoName: 'ledger-svc', repoPath: '/demo/ledger-svc', machine: 'demo-host', agentType: 'codex', status: 'waiting', lastSeen: ago(2), sessionId: 'demo-s3', branch: 'feat/rates', dismissedAt: '', pendingQuestion: '', agentMode: 'manual' },
      { id: 'demo-a4', name: 'pulse-mobile', repoName: 'pulse-mobile', repoPath: '/demo/pulse-mobile', machine: 'demo-host', agentType: 'claude', status: 'idle', lastSeen: ago(11), sessionId: 'demo-s4', branch: 'main', dismissedAt: '', pendingQuestion: '', agentMode: 'manual' },
    ],
    workflows: [
      /**
       * THE TEMPLATE LIBRARY FIRST. `/api/workflows` returns templates and runs in one list —
       * a template is the row with `templateId: null` — so the demo has to do the same or the
       * workflow picker comes up empty, which is what it did. Real names and step sequences,
       * from demoTemplates.ts; see the note there.
       */
      ...DEMO_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        status: 'pending',
        templateId: null as string | null,
        runNumber: 0,
        createdAt: ago(60 * 24 * 30),
        /**
         * `phases` IS REQUIRED and must be an array, even though a template has none. The
         * workflow card falls back to `w.phases.length` for any row that is not a run with a
         * step summary, so omitting it threw "Cannot read properties of undefined (reading
         * 'length')" and blanked the app the moment templates were added — the same failure
         * the autonomy fake had. Mirror normalizeWorkflow (routes/workflows.ts), not a subset.
         */
        phases: [] as unknown[],
        players: [] as unknown[],
        currentPhase: 0,
        iteration: 1,
        maxIterations: 3,
        needsAttention: false,
        jiraTaskId: '',
        sharedContext: '',
        initialContext: '',
        contextLabel: '',
        startedAt: '',
        error: '',
        stepSummary: {
          total: t.stepNames.length,
          completed: 0, running: 0, failed: 0,
          pending: t.stepNames.length,
          stepNames: t.stepNames,
          projects: [] as string[],
        },
      })),

      { phases: [], players: [], currentPhase: 0, needsAttention: false, id: 'demo-w1', name: 'New Feature', description: 'Research → architect → tests → build → verify.', status: 'running', templateId: 'demo-t1', runNumber: 7, createdAt: ago(38), startedAt: ago(38), projectId: 'demo-p1', contextLabel: 'Rate limits on the public API', stepSummary: { total: 8, completed: 5, running: 1, failed: 0, pending: 2, stepNames: ['Research', 'Architecture', 'Define Tests', 'Develop', 'Run Tests', 'Security & Lint', 'Summary', 'Workflow Completion Report'], projects: ['atlas-api'] } },
      { phases: [], players: [], currentPhase: 0, needsAttention: false, id: 'demo-w2', name: 'Full QA Review', description: 'Golden path → edge cases → performance → accessibility.', status: 'completed', templateId: 'demo-t2', runNumber: 3, createdAt: ago(190), startedAt: ago(190), completedAt: ago(120), projectId: 'demo-p1', contextLabel: 'Checkout flow', stepSummary: { total: 9, completed: 9, running: 0, failed: 0, pending: 0, stepNames: ['Golden Path Testing', 'Edge Case Testing', 'QA Report'], projects: ['atlas-web'] } },
      { phases: [], players: [], currentPhase: 0, needsAttention: false, id: 'demo-w3', name: 'Bug Investigation', description: 'Reproduce → root cause → fix → verify.', status: 'waiting', templateId: 'demo-t3', runNumber: 12, createdAt: ago(62), startedAt: ago(62), projectId: 'demo-p2', contextLabel: 'Duplicate ledger entries', stepSummary: { total: 8, completed: 3, running: 0, failed: 0, pending: 5, stepNames: ['Reproduce the Bug', 'Root Cause Analysis', 'Fix Plan'], projects: ['ledger-svc'] } },
    ],
    tasks: [
      { id: 'demo-k1', title: 'Add rate-limit headers to the public API', prompt: '', status: 'in_progress', priority: 2, projectId: 'demo-p1', createdAt: ago(80), dependsOn: [] },
      { id: 'demo-k2', title: 'Reconcile duplicate ledger entries', prompt: '', status: 'queued', priority: 1, projectId: 'demo-p2', createdAt: ago(55), dependsOn: [] },
      { id: 'demo-k3', title: 'Ship the pricing page redesign', prompt: '', status: 'done', priority: 3, projectId: 'demo-p1', createdAt: ago(600), dependsOn: [] },
    ],
    projects: [
      /**
       * `goalId` LIVES ON THE PROJECT, not as `projectIds` on the goal — that is the direction
       * the goals screen resolves (a goal's reach is the projects pointing AT it). Without it
       * every goal rendered "0 projects · reaches nothing" and the page warned that no project
       * had a goal, which is a demo showing the empty state of its own headline feature.
       */
      { id: 'demo-p1', name: 'Atlas', description: 'Customer-facing API and web app.', primaryRepo: '/demo/atlas-api', color: '#a855f7', goalId: 'demo-g2', cartridges: ['/demo/atlas-api', '/demo/atlas-web'], createdAt: ago(9000), updatedAt: ago(30) },
      { id: 'demo-p2', name: 'Ledger', description: 'Billing and reconciliation.', primaryRepo: '/demo/ledger-svc', color: '#38bdf8', goalId: 'demo-g1', cartridges: ['/demo/ledger-svc'], createdAt: ago(9000), updatedAt: ago(60) },
      { id: 'demo-p3', name: 'Pulse', description: 'Field mobile app — visits, offline capture.', primaryRepo: '/demo/pulse-mobile', color: '#34d399', goalId: 'demo-g3', cartridges: ['/demo/pulse-mobile'], createdAt: ago(7000), updatedAt: ago(90) },
    ],
    /**
     * More than one goal, because a goals screen with a single row shows the shape but not the
     * point: goals differ by status, by how many projects they span, and by whether anyone is
     * moving on them. One of these is deliberately stalled and one is done.
     */
    goals: [
      {
        id: 'demo-g1', name: 'Ship metered billing by Q3', status: 'active',
        successMetric: 'First paying customer on a metered plan',
        description: 'Usage is already metered internally; customers still pay a flat fee, so heavy accounts are subsidised by light ones.',
        acceptanceCriteria: 'WHEN a billing period closes THE SYSTEM SHALL invoice on recorded usage within 1%. WHEN usage is disputed THE SYSTEM SHALL show the per-event ledger behind the total.',
        invariants: 'No customer is billed twice for one event. Historical invoices never change after issue.',
        noGos: 'No pricing-page changes. No migration of existing flat-fee contracts in this phase.',
        rabbitHoles: 'Rebuilding the events pipeline. Proration edge cases for mid-cycle plan changes — defer.',
        createdAt: ago(20000),
        updatedAt: ago(60),
        keyResults: [], tokenBudget: null, budgetUsd: null, targetDate: '2026-09-30', owner: 'demo@neoncore.local', investmentCategory: '', autonomy: '',
        projectCount: 1, runCount: 12, reach: 1, tokensUsed: 486_000, costUsd: 7.31,
        progress: { completedSteps: 44, totalSteps: 80, fraction: 0.55, runsCounted: 12 },
        health: null,
        schedule: { targetDate: '2026-09-30', daysRemaining: 8, state: 'due-soon', detail: '8 days to target, 55% complete.' },
      },
      {
        id: 'demo-g2', name: 'Cut p95 checkout latency below 400ms', status: 'active',
        successMetric: 'p95 under 400ms for seven consecutive days',
        description: 'Checkout p95 sits at 1.2s and cart abandonment tracks it closely.',
        acceptanceCriteria: 'WHEN a checkout request completes THE SYSTEM SHALL record server timing per stage.',
        invariants: 'No payment is captured twice. Latency work never weakens the idempotency key.',
        noGos: 'No change to the payment provider. No caching of authorisation responses.',
        rabbitHoles: 'A frontend rewrite. Micro-optimising the JSON serialiser before profiling.',
        createdAt: ago(9000),
        updatedAt: ago(60),
        keyResults: [], tokenBudget: null, budgetUsd: null, targetDate: '', owner: 'demo@neoncore.local', investmentCategory: '', autonomy: '',
        projectCount: 1, runCount: 8, reach: 2, tokensUsed: 312_400, costUsd: 4.88,
        progress: { completedSteps: 18, totalSteps: 45, fraction: 0.4, runsCounted: 8 },
        health: { reason: 'agent-waiting', runId: 'demo-w1', runName: 'Checkout latency sweep', stepName: 'Profile the hot path', detail: 'The cartridge stopped to ask which trace window to use.', blockedRuns: 1 },
        schedule: null,
      },
      {
        id: 'demo-g3', name: 'Offline-first mobile sync', status: 'active',
        successMetric: 'A flight-mode session reconciles with no lost edits',
        description: 'Field users lose connectivity mid-visit and currently lose whatever they typed.',
        acceptanceCriteria: 'WHEN the device reconnects THE SYSTEM SHALL reconcile local edits without prompting the user.',
        invariants: 'A local edit is never silently discarded. Conflicts are surfaced, not resolved by timestamp alone.',
        noGos: 'No new sync engine dependency. No schema change to the visit record.',
        rabbitHoles: 'CRDTs for a case that is last-write-wins in practice.',
        createdAt: ago(4000),
        updatedAt: ago(60),
        keyResults: [], tokenBudget: null, budgetUsd: null, targetDate: '2026-09-05', owner: 'demo@neoncore.local', investmentCategory: '', autonomy: '',
        projectCount: 1, runCount: 5, reach: 1, tokensUsed: 190_200, costUsd: 2.64,
        progress: { completedSteps: 7, totalSteps: 28, fraction: 0.25, runsCounted: 5 },
        health: null,
        schedule: { targetDate: '2026-09-05', daysRemaining: -17, state: 'overdue', detail: '17 days past target, 25% complete.' },
      },
      {
        id: 'demo-g4', name: 'Retire the legacy ledger importer', status: 'paused',
        successMetric: 'No traffic on the v1 import endpoint for 30 days',
        description: 'Two importers exist and the old one has no tests; every ledger bug starts with working out which ran.',
        acceptanceCriteria: 'WHEN a v1 import is attempted THE SYSTEM SHALL redirect it to v2 and log the caller.',
        invariants: 'No historical import is re-run. Ledger balances are unchanged by the migration.',
        noGos: 'No backfill of pre-2024 records.',
        rabbitHoles: 'Chasing the two customers still on v1 before the redirect is in place.',
        createdAt: ago(30000),
        updatedAt: ago(60),
        keyResults: [], tokenBudget: null, budgetUsd: null, targetDate: '2026-08-15', owner: 'demo@neoncore.local', investmentCategory: '', autonomy: '',
        projectCount: 0, runCount: 0, reach: 0, tokensUsed: 0, costUsd: 0,
        progress: { completedSteps: 0, totalSteps: 0, fraction: null, runsCounted: 0 },
        health: null,
        schedule: { targetDate: '2026-08-15', daysRemaining: -38, state: 'overdue', detail: '38 days past target, and no work has run against this goal.' },
      },
      {
        id: 'demo-g5', name: 'SOC 2 evidence automation', status: 'achieved',
        successMetric: 'Quarterly evidence pack generated without manual steps',
        description: 'Evidence collection took nine engineer-days last quarter, mostly screenshots.',
        acceptanceCriteria: 'WHEN a quarter closes THE SYSTEM SHALL produce the pack with no human step.',
        invariants: 'Evidence is generated from source systems, never hand-edited.',
        noGos: 'No new vendor. No access changes to production.',
        rabbitHoles: 'Automating the policy documents, which change once a year.',
        createdAt: ago(60000),
        updatedAt: ago(60),
        keyResults: [], tokenBudget: null, budgetUsd: null, targetDate: '2026-07-01', owner: 'demo@neoncore.local', investmentCategory: '', autonomy: '',
        projectCount: 0, runCount: 21, reach: 0, tokensUsed: 902_800, costUsd: 13.47,
        progress: { completedSteps: 96, totalSteps: 96, fraction: 1, runsCounted: 21 },
        health: null,
        schedule: { targetDate: '2026-07-01', daysRemaining: 3, state: 'met', detail: 'Finished with 3 days to spare.' },
      },
    ],
    activity: [
      { id: 'demo-ac1', agentId: 'demo-a1', eventType: 'PostToolUse', toolName: 'Edit', toolInput: '{"file_path":"/demo/atlas-api/src/rate-limit.ts"}', toolResult: '{}', timestamp: ago(1) },
      { id: 'demo-ac2', agentId: 'demo-a3', eventType: 'ask_user', toolName: 'AskUserQuestion', toolInput: '{"questions":[{"question":"Round half-up or half-even?"}]}', toolResult: '{}', timestamp: ago(2) },
      { id: 'demo-ac3', agentId: 'demo-a2', eventType: 'Stop', toolName: '', toolInput: '', toolResult: '{}', timestamp: ago(5) },
    ],
    reports: [
      {
        id: 'demo-rep1', project: 'atlas-api', workflowId: 'demo-w2', stepId: 'demo-st1',
        workflowName: 'Full QA Review', runNumber: 3, status: 'SUCCESS', createdAt: ago(120),
        htmlUrl: '',
        report: {
          schema: 'neoncore.workflow-report/1',
          header: { project: 'Atlas', overallStatus: 'SUCCESS', runId: 'demo-w2' },
          executiveSummary: 'Walked every checkout flow against staging. All nine flows passed, one accessibility warning on the payment step (missing label on the CVV field) which is filed but not blocking. No regressions found.',
          outcome: { tasksCompleted: 9, tasksTotal: 9, testsPassed: 42, testsTotal: 42, issues: 1, warnings: 1, humanActionsRequired: 0 },
        },
      },
    ],
    permissions: [
      { id: 'demo-perm1', agentId: 'demo-a3', toolName: 'AskUserQuestion', toolInput: '{"questions":[{"question":"Round half-up or half-even?","options":[{"label":"half-up"},{"label":"half-even"}]}]}', description: 'Rounding rule for ledger totals', status: 'pending', createdAt: ago(2), decidedAt: null, response: '' },
    ],
  };
}

type Dataset = ReturnType<typeof seed>;
let state: Dataset | null = null;

/** The current demo data. Mutated by demo interactions so the app behaves like an app. */
export function demoDataset(): Dataset {
  if (!state) state = seed();
  return state;
}

/** Forget everything the demo did. Called when demo mode is switched off. */
export function resetDemoData(): void {
  state = null;
}

// ── The seam ───────────────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** `/api/workflows/v2/x/start` → ['workflows','v2','x','start'] */
function segments(url: string): string[] {
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0];
  return path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
}

/**
 * A `fetchImpl` that answers everything locally.
 *
 * `realFetch` is taken as an argument ONLY so a test can pass a fetch that throws, proving
 * nothing reaches it. Production passes the real one and it is still never called — which is
 * the property worth testing rather than asserting.
 */
export function createDemoFetch(_realFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const seg = segments(url);
    const data = demoDataset();

    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = {}; }
    }

    // ── Reads ────────────────────────────────────────────────────────────────────────
    if (method === 'GET') {
      const shaped = objectShaped(seg);
      if (shaped !== undefined) return json(shaped);

      switch (seg[0]) {
        case 'agents':      return json(seg.length === 1 ? data.agents : data.agents.find((a) => a.id === seg[1]) ?? null);
        case 'workflows':   return json(demoWorkflows(seg, data));
        case 'tasks':       return json(seg.length === 1 ? data.tasks : data.tasks.find((t) => t.id === seg[1]) ?? null);
        case 'projects':
          if (seg.length === 1) return json(data.projects);
          if (seg.length >= 3) return json([]);   // /projects/:id/learnings and friends
          return json(data.projects.find((pr) => pr.id === seg[1]) ?? null);
        case 'goals':
          // Only /goals/:id is a lookup. Everything deeper — /goals/:id/decompositions,
          // /goals/drafts/... — is a collection of its own.
          if (seg.length === 1) return json(data.goals);
          if (seg.length >= 3 || seg[1] === 'drafts') return json([]);
          return json(data.goals.find((g) => g.id === seg[1]) ?? null);
        case 'activity':    return json(data.activity);
        case 'journal':
          // /journal/projects is the REPO list the journal is keyed by — repo names, not the
          // projects table. An empty answer here demos the journal as if nothing had ever run.
          if (seg[1] === 'projects' && seg.length === 2) {
            return json(data.agents.map((a) => ({
              project: a.repoName, sessionCount: 3 + (a.repoName.length % 5), lastSeen: a.lastSeen,
              lastSession: a.lastSeen,
            })));
          }
          if (seg[1] === 'projects' && seg[3] === 'reports') return json(data.reports);
          return json([]);
        case 'permissions': return json(seg[1] === 'pending' ? data.permissions : data.permissions);
        // Everything else a screen might read is a COLLECTION, and an empty one renders as
        // "nothing yet" — a correct-looking demo rather than an error dialog.
        default:            return json([]);
      }
    }

    // ── Writes ───────────────────────────────────────────────────────────────────────
    // Applied to the local dataset so the demo behaves like an app: things you create appear,
    // things you delete disappear. None of it leaves this tab.
    if (method === 'POST' && seg[0] === 'tasks' && seg.length === 1) {
      const task = {
        id: `demo-k${Date.now()}`, title: String(body.title ?? 'Untitled task'), prompt: String(body.prompt ?? ''),
        status: 'queued', priority: Number(body.priority ?? 2), projectId: String(body.projectId ?? 'demo-p1'),
        createdAt: new Date().toISOString(), dependsOn: [],
      };
      data.tasks.unshift(task as (typeof data.tasks)[number]);
      return json(task, 201);
    }

    if (method === 'POST' && seg[0] === 'workflows' && seg.includes('start')) {
      // Looks like a started run so the UI advances, and starts nothing.
      const run = {
        id: `demo-run-${Date.now()}`, name: 'Demo Run', description: '', status: 'running',
        templateId: seg[2] ?? 'demo-t1', runNumber: 1, createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stepSummary: { total: 6, completed: 0, running: 1, failed: 0, pending: 5, stepNames: [], projects: [] },
      };
      data.workflows.unshift(run as unknown as (typeof data.workflows)[number]);
      return json({ workflow: run, steps: [] }, 201);
    }

    if (method === 'DELETE') {
      const id = seg[seg.length - 1];
      for (const key of ['tasks', 'workflows', 'projects', 'goals'] as const) {
        const list = data[key] as { id: string }[];
        const i = list.findIndex((r) => r.id === id);
        if (i >= 0) { list.splice(i, 1); break; }
      }
      return json({ ok: true });
    }

    // Anything else — a route this file has never heard of. Absorbed with a plausible success
    // rather than passed through. THIS is the line that makes demo mode safe.
    return json({ ok: true, demo: true });
  }) as unknown as typeof fetch;
}


/**
 * The GETs that return an OBJECT rather than a collection.
 *
 * THIS LIST EXISTS BECAUSE ITS ABSENCE WAS A BLANK SCREEN. Demo mode answered every unknown GET
 * with `[]`, and `useAgents` reads `roster.self.serverId` off GET /peers — so `.self` was
 * undefined and the app died on boot with "Cannot read properties of undefined (reading
 * 'serverId')". Absorbing a request safely is only half the job; the answer has to be usable.
 *
 * Completeness is not maintained by hand: a test reads every `request<T>('/path')` out of the
 * client and fails when a demo answer disagrees with the declared shape, so an endpoint added
 * later is caught there rather than in front of an audience.
 *
 * Returns undefined when the path is not object-shaped, so the caller falls through to the
 * collection default.
 */
function objectShaped(seg: string[]): unknown | undefined {
  const p = seg.join('/');

  // Federation identity — the one that crashed the app.
  if (p === 'peers') {
    return {
      self: { serverId: 'demo-server', name: 'Demo', url: '', version: 'demo' },
      peers: [],
    };
  }
  if (p === 'health') return { status: 'ok', timestamp: new Date().toISOString() };

  /**
   * A run's autonomy posture.
   *
   * `resolutions` IS REQUIRED and must be an array. AutonomyControl declares it non-optional
   * and reads `state.resolutions.length` three times without guarding, so omitting it threw
   * "Cannot read properties of undefined (reading 'length')" and unmounted the whole app —
   * a white screen whose only exit is the ?demo=off URL. The real route returns
   * `{ ...effectiveAutonomy(id), resolutions: listAutoResolutions(id, 10) }`
   * (routes/workflows.ts:1753); this mirrors that, not a subset of it.
   */
  if (seg[0] === 'workflows' && seg[1] === 'v2' && seg[3] === 'autonomy') {
    return { level: 'full', source: 'workflow', expiresAt: null, resolutions: [] };
  }

  // The queue is an object with lanes, not a bare list.
  if (p === 'queue') return { items: [], lanes: [], paused: false };

  if (p === 'activity/burn-rate') return { perHour: 0, perDay: 0, samples: [] };
  if (p === 'activity/usage-series') return { series: [], total: 0, byCartridge: [], byProject: [] };
  if (seg[0] === 'activity' && seg[1] === 'usage') return { totalTokens: 0, totalCostUsd: 0, sessions: [] };

  if (p === 'repos/browse') return { path: '/demo', entries: [] };
  // Git reads are objects: a status and a diff both describe one repo.
  if (seg[0] === 'git' && (seg[2] === 'status' || seg[2] === 'diff' || seg[1] === 'status')) {
    return seg[2] === 'diff'
      ? { diff: '', files: [], additions: 0, deletions: 0 }
      : { branch: 'main', dirty: false, ahead: 0, behind: 0, files: [] };
  }
  if (seg[0] === 'epics' && seg[1] === 'scan') return { epics: [], tasks: [] };
  if (p === 'journal/search') return { sessions: [], knowledge: [] };
  if (seg[0] === 'journal' && seg[1] === 'sessions') return null;

  return undefined;
}

function demoWorkflows(seg: string[], data: Dataset): unknown {
  if (seg.length === 1) return data.workflows;
  // /workflows/v2/:id/runs is the run history — a list, not the run itself.
  if (seg[1] === 'v2' && seg[3] === 'runs') return data.workflows.filter((w) => w.templateId);
  // GET /workflows/v2/:id returns { workflow, steps } — the canvas reads both.
  if (seg[1] === 'v2' && seg[2]) {
    const wf = data.workflows.find((w) => w.id === seg[2]) ?? data.workflows[0] ?? null;
    return { workflow: wf, steps: [] };
  }
  return data.workflows.find((w) => w.id === seg[1]) ?? null;
}
