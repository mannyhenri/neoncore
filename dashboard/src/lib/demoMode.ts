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
      { id: 'demo-w1', name: 'New Feature', description: 'Research → architect → tests → build → verify.', status: 'running', templateId: 'demo-t1', runNumber: 7, createdAt: ago(38), startedAt: ago(38), projectId: 'demo-p1', contextLabel: 'Rate limits on the public API', stepSummary: { total: 8, completed: 5, running: 1, failed: 0, pending: 2, stepNames: ['Research', 'Architecture', 'Define Tests', 'Develop', 'Run Tests', 'Security & Lint', 'Summary', 'Workflow Completion Report'], projects: ['atlas-api'] } },
      { id: 'demo-w2', name: 'Full QA Review', description: 'Golden path → edge cases → performance → accessibility.', status: 'completed', templateId: 'demo-t2', runNumber: 3, createdAt: ago(190), startedAt: ago(190), completedAt: ago(120), projectId: 'demo-p1', contextLabel: 'Checkout flow', stepSummary: { total: 9, completed: 9, running: 0, failed: 0, pending: 0, stepNames: ['Golden Path Testing', 'Edge Case Testing', 'QA Report'], projects: ['atlas-web'] } },
      { id: 'demo-w3', name: 'Bug Investigation', description: 'Reproduce → root cause → fix → verify.', status: 'waiting', templateId: 'demo-t3', runNumber: 12, createdAt: ago(62), startedAt: ago(62), projectId: 'demo-p2', contextLabel: 'Duplicate ledger entries', stepSummary: { total: 8, completed: 3, running: 0, failed: 0, pending: 5, stepNames: ['Reproduce the Bug', 'Root Cause Analysis', 'Fix Plan'], projects: ['ledger-svc'] } },
    ],
    tasks: [
      { id: 'demo-k1', title: 'Add rate-limit headers to the public API', prompt: '', status: 'in_progress', priority: 2, projectId: 'demo-p1', createdAt: ago(80), dependsOn: [] },
      { id: 'demo-k2', title: 'Reconcile duplicate ledger entries', prompt: '', status: 'queued', priority: 1, projectId: 'demo-p2', createdAt: ago(55), dependsOn: [] },
      { id: 'demo-k3', title: 'Ship the pricing page redesign', prompt: '', status: 'done', priority: 3, projectId: 'demo-p1', createdAt: ago(600), dependsOn: [] },
    ],
    projects: [
      { id: 'demo-p1', name: 'Atlas', description: 'Customer-facing API and web app.', primaryRepo: '/demo/atlas-api', color: '#a855f7', createdAt: ago(9000), updatedAt: ago(30) },
      { id: 'demo-p2', name: 'Ledger', description: 'Billing and reconciliation.', primaryRepo: '/demo/ledger-svc', color: '#38bdf8', createdAt: ago(9000), updatedAt: ago(60) },
    ],
    goals: [
      { id: 'demo-g1', title: 'Ship metered billing by Q3', successMetric: 'First paying customer on metered plan', status: 'active', createdAt: ago(20000), projectIds: ['demo-p1', 'demo-p2'] },
    ],
    activity: [
      { id: 'demo-ac1', agentId: 'demo-a1', eventType: 'PostToolUse', toolName: 'Edit', toolInput: '{"file_path":"/demo/atlas-api/src/rate-limit.ts"}', toolResult: '{}', timestamp: ago(1) },
      { id: 'demo-ac2', agentId: 'demo-a3', eventType: 'ask_user', toolName: 'AskUserQuestion', toolInput: '{"questions":[{"question":"Round half-up or half-even?"}]}', toolResult: '{}', timestamp: ago(2) },
      { id: 'demo-ac3', agentId: 'demo-a2', eventType: 'Stop', toolName: '', toolInput: '', toolResult: '{}', timestamp: ago(5) },
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
      switch (seg[0]) {
        case 'agents':      return json(seg.length === 1 ? data.agents : data.agents.find((a) => a.id === seg[1]) ?? null);
        case 'workflows':   return json(demoWorkflows(seg, data));
        case 'tasks':       return json(seg.length === 1 ? data.tasks : data.tasks.find((t) => t.id === seg[1]) ?? null);
        case 'projects':    return json(seg.length === 1 ? data.projects : data.projects.find((p) => p.id === seg[1]) ?? null);
        case 'goals':       return json(seg.length === 1 ? data.goals : data.goals.find((g) => g.id === seg[1]) ?? null);
        case 'activity':    return json(data.activity);
        case 'permissions': return json(seg[1] === 'pending' ? data.permissions : data.permissions);
        // Everything else a screen might read: an empty collection renders as "nothing yet",
        // which is a correct-looking demo rather than an error dialog.
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

function demoWorkflows(seg: string[], data: Dataset): unknown {
  if (seg.length === 1) return data.workflows;
  if (seg[1] === 'v2' && seg[2]) {
    const wf = data.workflows.find((w) => w.id === seg[2]);
    return { workflow: wf ?? null, steps: [] };
  }
  return data.workflows.find((w) => w.id === seg[1]) ?? null;
}
