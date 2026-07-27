/**
 * Peer roster endpoints.
 *
 *   GET  /api/peers        what this server knows — for clients building the merged grid
 *   POST /api/peers/ping   the gossip exchange: you send yours, you get mine back
 *   POST /api/peers        manually seed a peer (the runner installer already takes --server)
 *   DELETE /api/peers      forget one
 *
 * Everything here is behind the fleet token via the global middleware in index.ts.
 */

import { Router } from 'express';
import {
  addPeer,
  listPeers,
  listPeerUrls,
  mergeRoster,
  normalizePeerUrl,
  removePeer,
} from '../lib/federation.js';
import { getServerIdentity, SERVER_VERSION } from '../lib/server-url.js';

const router = Router();

// GET /api/peers — this server's identity plus everything it knows about
router.get('/', (_req, res) => {
  res.json({ self: getServerIdentity(), peers: listPeers() });
});

/**
 * POST /api/peers/ping — one round of gossip.
 *
 * Body:  { me: <caller's url>, serverId?, name?, version?, peers?: string[] }
 * Reply: { you: <url we saw you as>, self: <our identity>, peers: string[] }
 *
 * The caller's own URL comes from the body rather than the socket address: behind
 * Tailscale or a reverse proxy the observed address is not a URL anyone else can dial.
 * The peer tells us how to reach it; we take it at its word, because a wrong URL only
 * costs that peer its own reachability.
 *
 * `you` is echoed back so a peer can discover the URL others actually reach it on.
 */
router.post('/ping', (req, res) => {
  const { me, serverId, name, version, peers } = req.body || {};

  const callerUrl = normalizePeerUrl(me);
  if (callerUrl) {
    // Learn about the caller. addPeer self-excludes, so a server pinging itself (via a
    // loop, a stale roster entry, or its own alias) never lands in its own list.
    addPeer(callerUrl, {
      serverId: typeof serverId === 'string' ? serverId : undefined,
      name: typeof name === 'string' ? name : undefined,
      version: typeof version === 'string' ? version : undefined,
    });
  }

  // Union in whatever the caller knows. This is how a server learns about machines it was
  // never explicitly told about — B introduces A to C without A ever configuring C.
  const learned = mergeRoster(peers);
  if (learned.length > 0) {
    console.log(`[peers] Learned ${learned.length} peer(s) via gossip: ${learned.join(', ')}`);
  }

  if (typeof version === 'string' && version && version !== SERVER_VERSION) {
    // Warn, never block (D8). Refusing to federate on skew would let one un-upgraded
    // laptop partition the fleet, which is strictly worse than a degraded merge.
    console.warn(
      `[peers] Version skew: ${callerUrl ?? 'unknown peer'} reports v${version}, we are v${SERVER_VERSION}`,
    );
  }

  res.json({ you: callerUrl ?? null, self: getServerIdentity(), peers: listPeerUrls() });
});

// POST /api/peers — manually add one
router.post('/', (req, res) => {
  const { url } = req.body || {};
  const normalized = normalizePeerUrl(url);
  if (!normalized) {
    return res.status(400).json({ error: 'A valid http(s) url is required' });
  }
  if (!addPeer(normalized)) {
    return res.status(400).json({ error: 'That URL is this server itself' });
  }
  res.json({ ok: true, url: normalized, peers: listPeers() });
});

// DELETE /api/peers — forget one. It can come back via gossip if another server still
// knows it; that is the intended behaviour of a grow-only set, not a bug.
router.delete('/', (req, res) => {
  const { url } = req.body || {};
  const removed = removePeer(url);
  if (!removed) return res.status(404).json({ error: 'No such peer' });
  res.json({ ok: true, peers: listPeers() });
});

export default router;
