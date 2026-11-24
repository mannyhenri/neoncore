/**
 * The roadmap of a project: vision → epics → features on a timeline (lib/roadmap.ts).
 *
 *   GET    /api/roadmap/:projectId                the chart
 *   PUT    /api/roadmap/:projectId/vision         { vision }
 *   POST   /api/roadmap/:projectId/epics          { name, outcome?, icon?, targetDate?, dependsOn? }
 *   PUT    /api/roadmap/:projectId/epics/order    { ids }
 *   PUT    /api/roadmap/epics/:epicId             { name?, outcome?, icon?, targetDate?, dependsOn?, qaPassed? }
 *   DELETE /api/roadmap/epics/:epicId             its features stay, in no epic
 *   PUT    /api/roadmap/features/:featureId       { epicId?, startDate?, targetDate?, dependsOn? }
 *   GET    /api/roadmap/features/:featureId/needs  what it needs first: chosen, still missing, and what can be chosen
 *
 * Every write answers with the project's chart as it now is.
 */
import { Router, type Response } from 'express';
import db from '../db.js';
import {
  chartOf, setVision, createEpic, updateEpic, removeEpic, reorderEpics, planFeature, RoadmapError, setEpicQa,
  unmetNeeds, notYetMessage, needsCandidates,
} from '../lib/roadmap.js';

const router = Router();

function fail(res: Response, err: unknown): void {
  if (err instanceof RoadmapError) { res.status(err.status).json({ error: err.message }); return; }
  console.error('[roadmap]', err);
  res.status(500).json({ error: 'the roadmap could not be changed' });
}
function chart(res: Response, projectId: string): void {
  const c = chartOf(projectId);
  if (!c) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(c);
}
const projectOfEpic = (epicId: string) =>
  (db.prepare('SELECT project_id FROM epics WHERE id = ?').get(epicId) as { project_id?: string } | undefined)?.project_id ?? '';
const projectOfFeature = (goalId: string) =>
  (db.prepare('SELECT project_id FROM goals WHERE id = ?').get(goalId) as { project_id?: string } | undefined)?.project_id ?? '';

router.put('/epics/:epicId', (req, res) => {
  try {
    const p = projectOfEpic(req.params.epicId);
    const { qaPassed, ...rest } = (req.body ?? {}) as Record<string, unknown>;
    if (qaPassed !== undefined) setEpicQa(req.params.epicId, qaPassed);
    if (Object.keys(rest).length > 0) updateEpic(req.params.epicId, rest);
    chart(res, p);
  } catch (err) { fail(res, err); }
});
router.delete('/epics/:epicId', (req, res) => {
  try { const p = projectOfEpic(req.params.epicId); removeEpic(req.params.epicId); chart(res, p); } catch (err) { fail(res, err); }
});
router.get('/features/:featureId/needs', (req, res) => {
  const unmet = unmetNeeds(req.params.featureId);
  if (!unmet) { res.status(404).json({ error: 'feature not found' }); return; }
  const row = db.prepare('SELECT depends_on FROM goals WHERE id = ?').get(req.params.featureId) as { depends_on?: string } | undefined;
  let chosen: string[] = [];
  try { const v = JSON.parse(String(row?.depends_on || '[]')); chosen = Array.isArray(v) ? v.map(String) : []; } catch { chosen = []; }
  res.json({ chosen, unmet, message: notYetMessage(unmet), candidates: needsCandidates(req.params.featureId) });
});
router.put('/features/:featureId', (req, res) => {
  try { planFeature(req.params.featureId, req.body ?? {}); chart(res, projectOfFeature(req.params.featureId)); } catch (err) { fail(res, err); }
});

router.get('/:projectId', (req, res) => chart(res, req.params.projectId));
router.put('/:projectId/vision', (req, res) => {
  try { setVision(req.params.projectId, req.body?.vision); chart(res, req.params.projectId); } catch (err) { fail(res, err); }
});
router.post('/:projectId/epics', (req, res) => {
  try { createEpic(req.params.projectId, req.body ?? {}); chart(res, req.params.projectId); } catch (err) { fail(res, err); }
});
router.put('/:projectId/epics/order', (req, res) => {
  try { reorderEpics(req.params.projectId, req.body?.ids); chart(res, req.params.projectId); } catch (err) { fail(res, err); }
});

export default router;
