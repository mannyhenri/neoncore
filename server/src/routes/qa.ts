/**
 * THE QA SECTION'S API — docs/plans/qa-section.md, "API". All JSON except the report (HTML),
 * the evidence (files) and the recorder script (JS, mounted at /qa/recorder.js in index.ts).
 */
import { Router, type Request, type Response } from 'express';
import { QaError } from '../lib/qa/types.js';
import {
  createTarget, deleteTarget, getTarget, listTargets, updateTarget,
  createTest, deleteTest, getTest, listTests, updateTest,
  getRun, listRuns, resultsOf, listRepairs, decideRepair,
} from '../lib/qa/store.js';
import { listFindings, setFindingStatus } from '../lib/qa/findings.js';
import { startRun, submitQaResult } from '../lib/qa/engine.js';
import { requestsOf, getRequest } from '../lib/qa/dispatch.js';
import { addEvents, coverageOf, recorderKeyMatches, recorderKeyOf, recorderScript, startSession } from '../lib/qa/recorder.js';
import { evidenceFile, evidenceUrl, runReportHtml } from '../lib/qa/report.js';

import { featureQaReport, runFeatureQa, runEpicQa, startFeatureQa } from '../lib/qa/feature-link.js';

startFeatureQa();
const router = Router();

function handle(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof QaError) return res.status(err.status).json({ error: err.message });
      console.error('[qa] route failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}
const id = (req: Request, k = 'id') => String(req.params[k] ?? '');
const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? req.query[k] as string : undefined);

// targets
router.get('/targets', handle(() => listTargets()));
router.post('/targets', handle((req) => createTarget(req.body ?? {})));
router.get('/targets/:id', handle((req) => { const t = getTarget(id(req)); if (!t) throw new QaError('target not found', 404); return t; }));
router.put('/targets/:id', handle((req) => updateTarget(id(req), req.body ?? {})));
router.delete('/targets/:id', handle((req) => { deleteTarget(id(req)); return { ok: true }; }));

// tests
router.get('/tests', handle((req) => listTests(q(req, 'targetId'))));
router.post('/tests', handle((req) => createTest(req.body ?? {})));
router.get('/tests/:id', handle((req) => { const t = getTest(id(req)); if (!t) throw new QaError('test not found', 404); return t; }));
router.put('/tests/:id', handle((req) => updateTest(id(req), req.body ?? {})));
router.delete('/tests/:id', handle((req) => { deleteTest(id(req)); return { ok: true }; }));

// runs
router.post('/runs', handle((req) => startRun(req.body ?? {})));
router.get('/runs', handle((req) => listRuns(q(req, 'targetId'))));
router.get('/runs/:id', handle((req) => {
  const run = getRun(id(req));
  if (!run) throw new QaError('run not found', 404);
  return {
    ...run,
    results: resultsOf(run.id).map((r) => ({ ...withEvidenceLinks(run.id, r), testName: testNameOf(r.testId) })),
    repairs: listRepairs({ runId: run.id }).map((r) => ({ ...r, testName: testNameOf(r.testId) })),
    findings: listFindings(run.targetId).filter((f) => f.runId === run.id).map(findingWithLink),
    requests: requestsOf(run.id).map(({ prompt: _p, ...r }) => r),
  };
}));
router.get('/runs/:id/report.html', handle((req, res) => {
  const html = runReportHtml(id(req));
  res.type('html').send(html);
}));

// findings, repairs
router.get('/findings', handle((req) => listFindings(q(req, 'targetId')).map(findingWithLink)));
router.put('/findings/:id', handle((req) => setFindingStatus(id(req), String(req.body?.status ?? ''))));
router.get('/repairs', handle((req) => listRepairs({ status: q(req, 'status'), targetId: q(req, 'targetId'), runId: q(req, 'runId') })
  .map((r) => ({ ...r, testName: testNameOf(r.testId) }))));
router.post('/repairs/:id/accept', handle((req) => decideRepair(id(req), 'accepted')));
router.post('/repairs/:id/reject', handle((req) => decideRepair(id(req), 'rejected')));

// recorder
router.get('/journeys', handle((req) => {
  const targetId = q(req, 'targetId');
  if (!targetId || !getTarget(targetId)) throw new QaError('targetId is required', 400);
  return coverageOf(targetId);
}));
// Public (lib/auth.ts): the recorder in the app under test proves itself with the target's key.
router.post('/sessions', handle((req) => startSession(String(req.body?.targetId ?? ''), req.body?.key)));
router.post('/sessions/:id/events', handle((req) => {
  // sendBeacon posts text/plain in some browsers: accept a JSON string body too.
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  return addEvents(id(req), body?.events, body?.key);
}));

// a cartridge's answer
router.get('/requests/:id', handle((req) => { const r = getRequest(id(req)); if (!r) throw new QaError('request not found', 404); return r; }));
router.post('/requests/:id/submit', handle((req) => {
  const body = (req.body ?? {}) as { result?: unknown };
  return submitQaResult(id(req), body.result !== undefined ? body.result : body);
}));

// QA follows the feature (lib/qa/feature-link.ts): a feature's criteria are its test, run by itself; the report per project.
router.get('/features', handle(() => featureQaReport()));
router.post('/features/:goalId/run', handle((req) => runFeatureQa(id(req, 'goalId'))));
// The whole epic of this feature, now — whenever the person decides (it also runs by itself when the epic is finished).
router.post('/features/:goalId/run-epic', handle((req) => runEpicQa(id(req, 'goalId'))));

// evidence
router.get('/evidence/:runId/*', handle((req, res) => {
  const rel = String((req.params as Record<string, string>)[0] ?? '');
  res.sendFile(evidenceFile(id(req, 'runId'), decodeURIComponent(rel)));
}));

/**
 * The runner writes evidence as absolute paths in the run's directory; a client can only follow a
 * link this server serves. Same rule as the HTML report (lib/qa/report.ts evidenceUrl): a path
 * outside the run's directory gets no link.
 */
function withEvidenceLinks<T extends { evidence?: unknown }>(runId: string, r: T): T {
  const ev = r.evidence as { steps?: { screenshot?: string }[]; trace?: string } | null | undefined;
  if (!ev || typeof ev !== 'object') return r;
  return {
    ...r,
    evidence: {
      ...ev,
      trace: evidenceUrl(runId, ev.trace),
      steps: (ev.steps ?? []).map((st) => (st.screenshot ? { ...st, screenshot: evidenceUrl(runId, st.screenshot) } : st)),
    },
  };
}
/** A test's name for display, or '' when it was deleted since. */
function testNameOf(testId: string): string { return getTest(testId)?.name ?? ''; }
function findingWithLink<T extends { runId: string; screenshot?: string }>(f: T): T {
  return f.screenshot ? { ...f, screenshot: evidenceUrl(f.runId, f.screenshot) } : f;
}

export default router;

/** GET /qa/recorder.js?target=<id> — the capture script for a staging app. */
export const recorderRouter = Router();
recorderRouter.get('/recorder.js', (req, res) => {
  const targetId = typeof req.query.target === 'string' ? req.query.target : '';
  if (!getTarget(targetId) || !recorderKeyMatches(targetId, req.query.key)) { res.status(404).type('js').send('/* NeonCore QA: unknown target or key */'); return; }
  const origin = `${req.protocol}://${req.get('host')}`;
  res.type('js').setHeader('Cache-Control', 'no-cache');
  res.send(recorderScript(targetId, origin, recorderKeyOf(targetId)));
});
