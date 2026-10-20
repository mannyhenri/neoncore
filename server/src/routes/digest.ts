/**
 * Rendering the morning paper, server-side.
 *
 * The digest step used to hand an agent a prose description of the layout and ask it to write
 * the HTML. That cannot produce the same paper twice — the type, the spacing and the running
 * order drifted between mornings, and "it should look the same every single time" is not
 * something a prompt can promise.
 *
 * So the agent sends DATA and gets the page back. The template lives in lib/digest-template.ts,
 * in this repository, under test, and every run goes through the same function.
 */
import express from 'express';
import { renderDigestHtml, type DigestData } from '../lib/digest-template.js';
import {
  fetchRedditPulse, RedditUnavailable, REDDIT_WINDOWS, SUBREDDIT_NAME, type RedditWindow,
} from '../lib/reddit-pulse.js';

const router = express.Router();

/** Coerce whatever arrived into the shape the renderer expects. A missing list is an empty one. */
function coerce(body: Record<string, unknown>): DigestData {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    ...(body.edition !== undefined ? { edition: body.edition as DigestData['edition'] } : {}),
    date: String(body.date ?? ''),
    throughLine: String(body.throughLine ?? ''),
    itemCount: Number(body.itemCount ?? 0),
    actOnIt: arr(body.actOnIt) as DigestData['actOnIt'],
    worthKnowing: arr(body.worthKnowing) as DigestData['worthKnowing'],
    aiNoise: arr(body.aiNoise) as DigestData['aiNoise'],
    background: arr(body.background) as DigestData['background'],
    dropped: arr(body.dropped) as DigestData['dropped'],
  };
}

/**
 * POST /api/digest/render — digest data in, the finished page out as text/html.
 *
 * Returns HTML rather than JSON so the caller can write the body straight to a file; wrapping
 * it in JSON would mean every caller needs a parser to save a document.
 */
router.post('/render', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!body.date) return res.status(400).json({ error: 'date is required — the paper is dated' });
  try {
    res.type('html').send(renderDigestHtml(coerce(body)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /api/digest/reddit?subs=aivideo,runwayml&t=day&limit=40 — the most popular threads
 * across those subreddits, ranked by Reddit. The digests call this instead of searching for
 * Reddit, which cannot see a score. See lib/reddit-pulse.ts for the two sources.
 */
router.get('/reddit', async (req, res) => {
  const subs = String(req.query.subs ?? '').split(/[,+\s]+/).map((s) => s.replace(/^r\//i, '')).filter(Boolean);
  const bad = subs.filter((s) => !SUBREDDIT_NAME.test(s));
  if (subs.length === 0 || bad.length) {
    return res.status(400).json({ error: `subs must be a comma list of subreddit names${bad.length ? ` — bad: ${bad.join(', ')}` : ''}` });
  }
  const t = String(req.query.t ?? 'day');
  if (!(REDDIT_WINDOWS as readonly string[]).includes(t)) return res.status(400).json({ error: `t must be one of ${REDDIT_WINDOWS.join(', ')}` });
  try {
    res.json(await fetchRedditPulse(subs, t as RedditWindow, Number(req.query.limit ?? 40)));
  } catch (err) {
    const status = err instanceof RedditUnavailable ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
