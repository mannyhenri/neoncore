/**
 * THE BUG TRIAGE API — docs/plans/bug-triage.md, "API".
 *
 * The Jira webhook (`triageWebhook`) is mounted in index.ts BEFORE the JSON body parser and the
 * fleet auth: it needs the raw body to check the HMAC signature, and Jira cannot hold the fleet
 * token — the signature is its credential.
 */
import { Router, type Request, type Response } from 'express';
import { TriageError } from '../lib/triage/types.js';
import {
  createSource, deleteSource, getIssue, getSettings, getSource, listIssues, listSources, eventsOf, updateSettings, updateSource,
} from '../lib/triage/store.js';
import {
  fromQaFinding, handleWebhook, manualHandOver, markReleased, pollSource, reopenIssue, retryIssue, submitTriageResult, verifyWebhook,
} from '../lib/triage/engine.js';
import { dispatchedToday, requestsOf } from '../lib/triage/dispatch.js';
import { triageMetrics } from '../lib/triage/metrics.js';
import { asyncRoute } from '../lib/async-route.js';

const router = Router();

function handle(fn: (req: Request, res: Response) => unknown) {
  return asyncRoute(async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof TriageError) return res.status(err.status).json({ error: err.message });
      console.error('[triage] route failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
const id = (req: Request, k = 'id') => String(req.params[k] ?? '');
const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? req.query[k] as string : undefined);

// sources
router.get('/sources', handle(() => listSources()));
router.post('/sources', handle((req) => createSource(req.body ?? {})));
router.get('/sources/:id', handle((req) => { const s = getSource(id(req)); if (!s) throw new TriageError('source not found', 404); return s; }));
router.put('/sources/:id', handle((req) => updateSource(id(req), req.body ?? {})));
router.delete('/sources/:id', handle((req) => { deleteSource(id(req)); return { ok: true }; }));
router.post('/sources/:id/poll', handle((req) => pollSource(id(req))));

// issues
router.get('/issues', handle((req) => listIssues({ sourceId: q(req, 'sourceId'), state: q(req, 'state') }).map(withJiraUrl)));
router.get('/issues/:id', handle((req) => {
  const issue = getIssue(id(req));
  if (!issue) throw new TriageError('issue not found', 404);
  return { ...withJiraUrl(issue), events: eventsOf(issue.id), requests: requestsOf(issue.id).map(({ prompt: _p, ...r }) => r) };
}));
router.post('/issues/:id/retry', handle((req) => retryIssue(id(req))));
router.post('/issues/:id/handover', handle((req) => manualHandOver(id(req), String(req.body?.reason ?? ''))));
router.post('/issues/:id/reopen', handle((req) => reopenIssue(id(req))));
router.post('/issues/:id/released', handle((req) => markReleased(id(req))));

// switches, metrics
router.get('/settings', handle(() => ({ ...getSettings(), dispatchesToday: dispatchedToday() })));
router.put('/settings', handle((req) => ({ ...updateSettings(req.body ?? {}), dispatchesToday: dispatchedToday() })));
router.get('/metrics', handle((req) => triageMetrics(q(req, 'sourceId'))));

// a cartridge's answer
router.post('/requests/:id/submit', handle((req) => {
  const body = (req.body ?? {}) as { result?: unknown };
  return submitTriageResult(id(req), body.result !== undefined ? body.result : body);
}));

// the QA section's Explorer → this pipeline
router.post('/from-qa-finding/:findingId', handle((req) => {
  const sourceId = String(req.body?.sourceId ?? q(req, 'sourceId') ?? listSources()[0]?.id ?? '');
  return fromQaFinding(id(req, 'findingId'), sourceId);
}));

export default router;

/** POST /api/triage/webhook/:sourceId — raw body, HMAC-SHA256 in X-Hub-Signature. */
export async function triageWebhook(req: Request, res: Response): Promise<void> {
  const source = getSource(String(req.params.sourceId ?? ''));
  if (!source) { res.status(404).json({ error: 'source not found' }); return; }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
  if (!verifyWebhook(source, raw, req.get('x-hub-signature') ?? undefined)) { res.status(401).json({ error: 'bad or missing signature' }); return; }
  let event: Record<string, unknown>;
  try { event = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { res.status(400).json({ error: 'body is not JSON' }); return; }
  try {
    res.json(await handleWebhook(source.id, event as Record<string, any>));
  } catch (err) {
    res.status(err instanceof TriageError ? err.status : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** The issue's page in Jira, for a client to link to ('' for an issue that did not come from Jira). */
function withJiraUrl<T extends { sourceId: string; issueKey: string; origin: string }>(issue: T): T & { jiraUrl: string } {
  const base = issue.origin === 'jira' ? getSource(issue.sourceId)?.jiraBaseUrl ?? '' : '';
  return { ...issue, jiraUrl: base ? `${base.replace(/\/+$/, '')}/browse/${encodeURIComponent(issue.issueKey)}` : '' };
}
