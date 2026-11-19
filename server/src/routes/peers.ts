import { Router } from 'express';
import { getServerIdentity } from '../lib/server-url.js';

/**
 * GET /api/peers — this server's identity, and no peers.
 *
 * NeonCore no longer links servers together (gossip, roster, forwarding were removed: the server
 * stays isolated to its own machine). The route stays because clients already installed — the
 * phone app, a dashboard tab left open — read their server's identity here and adopt whatever
 * peers it lists. An empty list is the whole point: they adopt nothing.
 */
const router = Router();

router.get('/', (_req, res) => {
  res.json({ self: getServerIdentity(), peers: [] });
});

export default router;
