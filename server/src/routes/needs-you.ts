/**
 * GET /api/needs-you — everything waiting on the person right now (lib/needs-you.ts). Derived from
 * state on every call, so the dashboard shows it whether or not it saw the notification.
 */
import { Router } from 'express';
import { needsYou } from '../lib/needs-you.js';

const router = Router();
router.get('/', (_req, res) => { res.json(needsYou()); });
export default router;
