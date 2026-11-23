/**
 * The logs (lib/log-stream.ts).
 *
 *   GET /api/logs?before=&after=&limit=&kinds=event,terminal,neoncore&problems=1&q=&only=&hide=a,b
 *     → { lines (oldest first), hasMore, sources }
 */
import { Router } from 'express';
import { readLogs, LOG_KINDS, type LogKind } from '../lib/log-stream.js';

const router = Router();
const list = (v: unknown) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

router.get('/', (req, res) => {
  const kinds = list(req.query.kinds).filter((k): k is LogKind => (LOG_KINDS as readonly string[]).includes(k));
  res.json(readLogs({
    before: req.query.before ? String(req.query.before) : undefined,
    after: req.query.after ? String(req.query.after) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    kinds: kinds.length ? kinds : undefined,
    problems: req.query.problems === '1' || req.query.problems === 'true',
    q: req.query.q ? String(req.query.q) : undefined,
    only: req.query.only ? String(req.query.only) : undefined,
    hide: list(req.query.hide),
  }));
});

export default router;
