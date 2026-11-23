/**
 * A project's design system (lib/design-system.ts).
 *
 *   GET /api/design-system/:projectId    the exploration (empty when the project has none yet)
 *   PUT /api/design-system/:projectId    { inspirations, rounds, selected } — replaces it, answers with what was kept
 *   POST /api/design-system/:projectId/finalize   the selected direction → the full system (step 2)
 *   POST /api/design-system/:projectId/publish    that system → every repo of the project: written, committed, pushed
 */
import { Router } from 'express';
import { getDesignSystem, saveDesignSystem, DesignSystemError } from '../lib/design-system.js';
import { finalizeProject, publishProject, projectRepos } from '../lib/design-system-publish.js';
import { requestDesign, cancelDesign, submitDesign, designRequestState, designerFor, ensureSweep } from '../lib/design-request.js';

ensureSweep();
/** Everything the page needs beside the exploration: the repos, who designs, and the round being designed. */
const around = (projectId: string) => ({ repos: projectRepos(projectId), designer: designerFor(projectId), designing: designRequestState(projectId) });
const refuse = (res: import('express').Response, err: unknown, what: string) => {
  if (err instanceof DesignSystemError) { res.status(err.status).json({ error: err.message }); return; }
  console.error('[design-system]', err);
  res.status(500).json({ error: what });
};

const router = Router();

router.get('/:projectId', (req, res) => {
  const found = getDesignSystem(req.params.projectId);
  if (!found) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ ...found, ...around(req.params.projectId) });
});

// The designer: Claude's /design, in the project's main repo. Ask for a round; stop waiting for one.
router.post('/:projectId/design', (req, res) => {
  try {
    requestDesign(req.params.projectId, req.body ?? {});
    res.json({ ...getDesignSystem(req.params.projectId)!, ...around(req.params.projectId) });
  } catch (err) { refuse(res, err, 'the design could not be requested'); }
});
router.post('/:projectId/design/cancel', (req, res) => {
  const found = getDesignSystem(req.params.projectId);
  if (!found) { res.status(404).json({ error: 'Project not found' }); return; }
  cancelDesign(req.params.projectId);
  res.json({ ...found, ...around(req.params.projectId) });
});
// The cartridge's answer (neoncore_submit_design): four directions.
router.post('/requests/:requestId/submit', (req, res) => {
  try { res.json(submitDesign(req.params.requestId, (req.body ?? {}).result)); } catch (err) { refuse(res, err, 'the directions could not be kept'); }
});

router.put('/:projectId', (req, res) => {
  try {
    res.json({ ...saveDesignSystem(req.params.projectId, req.body), ...around(req.params.projectId) });
  } catch (err) {
    if (err instanceof DesignSystemError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[design-system]', err);
    res.status(500).json({ error: 'the design system could not be saved' });
  }
});

for (const [step, run] of [['finalize', finalizeProject], ['publish', publishProject]] as const) {
  router.post(`/:projectId/${step}`, (req, res) => {
    try {
      res.json({ ...run(req.params.projectId), ...around(req.params.projectId) });
    } catch (err) {
      if (err instanceof DesignSystemError) { res.status(err.status).json({ error: err.message }); return; }
      console.error('[design-system]', err);
      res.status(500).json({ error: `the design system could not be ${step === 'finalize' ? 'finalized' : 'published'}` });
    }
  });
}

export default router;
