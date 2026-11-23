/**
 * Project rewards (lib/project-rewards.ts): what each project has earned, counted from its records.
 *   GET /api/rewards              every project
 *   GET /api/rewards/world        the totals over every project, and the new maps they open
 *   GET /api/rewards/:projectId   one project
 */
import { Router } from 'express';
import { allRewards, projectRewards, worldProgress, REWARD_FAMILIES } from '../lib/project-rewards.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ families: REWARD_FAMILIES, projects: allRewards() });
});
/** New maps: what the whole outfit has done towards each, and which are open. */
router.get('/world', (_req, res) => { res.json(worldProgress()); });
router.get('/:projectId', (req, res) => {
  const r = projectRewards(req.params.projectId);
  if (!r) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(r);
});

export default router;
